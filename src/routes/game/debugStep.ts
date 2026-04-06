import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  getGameDb,
  normalizeChapterOutput,
  normalizeRolePair,
  normalizeSessionState,
  nowTs,
} from "@/lib/gameEngine";
import {
  applyNarrativeMemoryHintsToState,
  allowPlayerTurn,
  applyOrchestratorResultToState,
  applyPlayerProfileFromMessageToState,
  canPlayerSpeakNow,
  setRuntimeTurnState,
  runNarrativeOrchestrator,
  RuntimeMessageInput,
  triggerStoryMemoryRefreshInBackground,
} from "@/modules/game-runtime/engines/NarrativeOrchestrator";
import { handleMiniGameTurn } from "@/modules/game-runtime/engines/MiniGameController";
import { initializeChapterProgressForState } from "@/modules/game-runtime/engines/ChapterProgressEngine";
import {
  asDebugMessage,
  buildDebugFreePlotMessage,
  buildDebugRecentMessages,
  buildDebugStateSnapshot,
  buildOpeningRuntimeMessage,
  cacheDebugRuntimeState,
  debugMessageSchema,
  getPendingDebugChapterId,
  isDebugFreePlotActive,
  loadCachedDebugRuntimeState,
  readDebugRuntimeKey,
  resolveNextChapter,
  setPendingDebugChapterId,
  syncDebugChapterRuntime,
  applyDebugUserMessageProgress,
  applyDebugNarrativeMessageProgress,
  evaluateDebugRuntimeOutcome,
  buildDebugEndDialogDetail,
  saveDebugRevisitPoint,
  buildDebugMessageWithRevisitData,
} from "./debugRuntimeShared";
import u from "@/utils";

const router = express.Router();

function buildDebugSuccessPayload(params: {
  userId: number;
  worldId: number;
  state: Record<string, any>;
  chapterId: number;
  chapterTitle: string;
  endDialog?: string | null;
  endDialogDetail?: string | null;
  messages?: unknown[];
  saveRevisit?: boolean;
}) {
  const rawMessages = params.messages || [];
  const normalizedMessages = rawMessages
    .filter((item): item is Record<string, any> =>
      Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((msg, index) => ({
      ...msg,
      canRevisit: index < rawMessages.length - 1, // 除了最后一条，其他都支持回溯
    }));
  const debugRuntimeKey = cacheDebugRuntimeState(
    params.state,
    params.userId,
    params.worldId,
    readDebugRuntimeKey(params.state),
  );

  // 保存回溯点
  if (params.saveRevisit !== false && rawMessages.length > 0) {
    saveDebugRevisitPoint(
      debugRuntimeKey,
      params.state,
      rawMessages as RuntimeMessageInput[],
      params.chapterId || null,
    );
  }

  return {
    chapterId: params.chapterId,
    chapterTitle: params.chapterTitle,
    state: buildDebugStateSnapshot(params.state, debugRuntimeKey),
    endDialog: params.endDialog || null,
    endDialogDetail: String(params.endDialogDetail || "").trim() || null,
    messages: normalizedMessages,
  };
}

export default router.post(
  "/",
  validateFields({
    worldId: z.number(),
    chapterId: z.number().optional().nullable(),
    playerContent: z.string().optional().nullable(),
    state: z.any().optional().nullable(),
    messages: z.array(debugMessageSchema).optional().nullable(),
  }),
  async (req, res) => {
    try {
      const db = getGameDb();
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }

      const worldId = Number(req.body.worldId || 0);
      const chapterId = Number(req.body.chapterId || 0);
      const playerContent = String(req.body.playerContent || "").trim();
      const inputMessages = (Array.isArray(req.body.messages) ? req.body.messages : []) as RuntimeMessageInput[];

      const world = await db("t_storyWorld as w")
        .leftJoin("t_project as p", "w.projectId", "p.id")
        .where("w.id", worldId)
        .where("p.userId", userId)
        .select("w.*")
        .first();
      if (!world) {
        return res.status(404).send(error("未找到故事"));
      }

      let chapter: any = null;
      if (chapterId > 0) {
        chapter = await db("t_storyChapter").where({ id: chapterId, worldId }).first();
      }
      if (!chapter) {
        chapter = await db("t_storyChapter").where({ worldId }).orderBy("sort", "asc").orderBy("id", "asc").first();
      }
      chapter = normalizeChapterOutput(chapter);
      if (!chapter) {
        return res.status(404).send(error("当前没有章节可调试"));
      }

      const rolePair = normalizeRolePair(world.playerRole, world.narratorRole);
      const cachedRuntimeState = loadCachedDebugRuntimeState(req.body.state, userId, worldId);
      const state = normalizeSessionState(
        cachedRuntimeState || req.body.state,
        worldId,
        Number(chapter.id || 0),
        rolePair,
        world,
      );
      if (playerContent) {
        applyPlayerProfileFromMessageToState(state, world, playerContent);
      }
      syncDebugChapterRuntime(chapter, state);
      // 确保章节进度已初始化（eventIndex 等）
      initializeChapterProgressForState(chapter, state);
      const debugFreePlotActive = isDebugFreePlotActive(state);
      const effectiveChapter = debugFreePlotActive
        ? {
          ...chapter,
          content: "",
          openingText: "",
          completionCondition: null,
        }
        : chapter;
      const messages = inputMessages.map((item) => ({
        role: String(item.role || ""),
        roleType: String(item.roleType || ""),
        eventType: String(item.eventType || ""),
        content: String(item.content || ""),
        createTime: Number(item.createTime || 0),
      }));
      const recentMessages = buildDebugRecentMessages(messages, String(state.player?.name || rolePair.playerRole.name || "用户"), playerContent);

      if (!playerContent) {
        const pendingChapterId = getPendingDebugChapterId(state);
        if (pendingChapterId) {
          const nextChapter = normalizeChapterOutput(await db("t_storyChapter").where({ id: pendingChapterId, worldId }).first());
          setPendingDebugChapterId(state, null);
          if (!nextChapter) {
            return res.status(200).send(success(buildDebugSuccessPayload({
              userId,
              worldId,
              chapterId: Number(chapter.id || 0),
              chapterTitle: String(chapter.title || ""),
              state,
              endDialog: null,
              messages: [],
            })));
          }
          state.chapterId = Number(nextChapter.id || 0);
          syncDebugChapterRuntime(nextChapter, state);
          const nextOpeningRuntimeMessage = buildOpeningRuntimeMessage(world, nextChapter, String(rolePair.narratorRole.name || "旁白"));
          setRuntimeTurnState(state, world, {
            canPlayerSpeak: false,
            expectedRoleType: "narrator",
            expectedRole: String(rolePair.narratorRole.name || "旁白"),
            lastSpeakerRoleType: String(nextOpeningRuntimeMessage.roleType || "narrator"),
            lastSpeaker: String(nextOpeningRuntimeMessage.role || rolePair.narratorRole.name || "旁白"),
          });
          return res.status(200).send(success(buildDebugSuccessPayload({
            userId,
            worldId,
            chapterId: Number(nextChapter.id || 0),
            chapterTitle: String(nextChapter.title || ""),
            state,
            endDialog: null,
            messages: [asDebugMessage(nextOpeningRuntimeMessage)],
          })));
        }

        if (!messages.length) {
          // 使用 /introduction 接口生成开场白，而不是内部处理
          syncDebugChapterRuntime(chapter, state);
          const openingRuntimeMessage = buildOpeningRuntimeMessage(world, chapter, String(rolePair.narratorRole.name || "旁白"));
          setRuntimeTurnState(state, world, {
            canPlayerSpeak: false,
            expectedRoleType: "narrator",
            expectedRole: String(rolePair.narratorRole.name || "旁白"),
            lastSpeakerRoleType: String(openingRuntimeMessage.roleType || "narrator"),
            lastSpeaker: String(openingRuntimeMessage.role || rolePair.narratorRole.name || "旁白"),
          });
          // 如果有开场白内容，设置等待用户输入状态
          // 如果没有开场白，直接进入编排流程
          if (String(openingRuntimeMessage.content || "").trim()) {
            return res.status(200).send(success(buildDebugSuccessPayload({
              userId,
              worldId,
              chapterId: Number(chapter.id || 0),
              chapterTitle: String(chapter.title || ""),
              state,
              endDialog: null,
              messages: [asDebugMessage(openingRuntimeMessage)],
              saveRevisit: true, // 保存回溯点
            })));
          }
          // 没有开场白，继续进入编排流程（跳过等待用户输入）
        }

        if (canPlayerSpeakNow(state, world)) {
          return res.status(200).send(success(buildDebugSuccessPayload({
            userId,
            worldId,
            chapterId: Number(chapter.id || 0),
            chapterTitle: String(chapter.title || ""),
            state,
            endDialog: null,
            messages: [],
          })));
        }

        const orchestrator = await runNarrativeOrchestrator({
          userId,
          world,
          chapter: effectiveChapter,
          state,
          recentMessages,
          playerMessage: "",
          maxRetries: 0,
          allowControlHints: false,
          allowStateDelta: false,
        });
        applyOrchestratorResultToState(state, orchestrator);
        const emittedMessage = orchestrator.role && orchestrator.content
          ? asDebugMessage({
            role: orchestrator.role,
            roleType: orchestrator.roleType,
            eventType: "on_orchestrated_reply",
            content: orchestrator.content,
            createTime: nowTs(),
          })
          : null;
        applyNarrativeMemoryHintsToState(state, orchestrator.memoryHints);
        if (orchestrator.triggerMemoryAgent) {
          triggerStoryMemoryRefreshInBackground({
            userId,
            world,
            chapter: effectiveChapter,
            state,
            recentMessages: emittedMessage ? [...recentMessages, emittedMessage] : recentMessages,
          });
        }
        const phaseAdvance = emittedMessage
          ? applyDebugNarrativeMessageProgress({
            chapter,
            state,
            role: emittedMessage.role,
            roleType: emittedMessage.roleType,
            content: emittedMessage.content,
          })
          : { enteredUserPhase: false };
        const outcome = evaluateDebugRuntimeOutcome({
          chapter,
          state,
          messageContent: String(emittedMessage?.content || ""),
          eventType: String(emittedMessage?.eventType || "on_orchestrated_reply"),
          meta: {},
          debugFreePlotActive,
        });

        if (outcome.result === "failed") {
          setRuntimeTurnState(state, world, {
            canPlayerSpeak: false,
            expectedRoleType: String(orchestrator.nextRoleType || "narrator"),
            expectedRole: String(orchestrator.nextRole || orchestrator.role || rolePair.narratorRole.name || "旁白"),
            lastSpeakerRoleType: String(orchestrator.roleType || "narrator"),
            lastSpeaker: String(orchestrator.role || rolePair.narratorRole.name || "旁白"),
          });
          return res.status(200).send(success(buildDebugSuccessPayload({
            userId,
            worldId,
            chapterId: Number(chapter.id || 0),
            chapterTitle: String(chapter.title || ""),
            state,
            endDialog: "已失败",
            endDialogDetail: buildDebugEndDialogDetail({
              endDialog: "已失败",
              chapterTitle: String(chapter.title || ""),
              matchedBy: outcome.matchedBy,
              matchedRule: outcome.matchedRule,
            }),
            messages: emittedMessage ? [emittedMessage] : [],
          })));
        }

        if (outcome.result === "success") {
          const nextChapter = await resolveNextChapter(db, worldId, chapter, outcome.nextChapterId);
          if (!nextChapter) {
            (state as any).debugFreePlot = {
              active: true,
              fromChapterId: Number(chapter.id || 0),
              unlockedAt: nowTs(),
            };
            return res.status(200).send(success(buildDebugSuccessPayload({
              userId,
              worldId,
              chapterId: Number(chapter.id || 0),
              chapterTitle: String(chapter.title || ""),
              state,
              endDialog: "进入自由剧情",
              messages: emittedMessage ? [emittedMessage] : [],
            })));
          }
          if (emittedMessage) {
            setPendingDebugChapterId(state, Number(nextChapter.id || 0));
            setRuntimeTurnState(state, world, {
              canPlayerSpeak: false,
              expectedRoleType: "narrator",
              expectedRole: String(rolePair.narratorRole.name || "旁白"),
              lastSpeakerRoleType: String(orchestrator.roleType || "narrator"),
              lastSpeaker: String(orchestrator.role || rolePair.narratorRole.name || "旁白"),
            });
            return res.status(200).send(success(buildDebugSuccessPayload({
              userId,
              worldId,
              chapterId: Number(chapter.id || 0),
              chapterTitle: String(chapter.title || ""),
              state,
              endDialog: null,
              messages: [emittedMessage],
            })));
          }
          state.chapterId = Number(nextChapter.id || 0);
          syncDebugChapterRuntime(nextChapter, state);
          const nextOpeningRuntimeMessage = buildOpeningRuntimeMessage(world, nextChapter, String(rolePair.narratorRole.name || "旁白"));
          setRuntimeTurnState(state, world, {
            canPlayerSpeak: false,
            expectedRoleType: "narrator",
            expectedRole: String(rolePair.narratorRole.name || "旁白"),
            lastSpeakerRoleType: String(nextOpeningRuntimeMessage.roleType || "narrator"),
            lastSpeaker: String(nextOpeningRuntimeMessage.role || rolePair.narratorRole.name || "旁白"),
          });
          return res.status(200).send(success(buildDebugSuccessPayload({
            userId,
            worldId,
            chapterId: Number(nextChapter.id || 0),
            chapterTitle: String(nextChapter.title || ""),
            state,
            endDialog: null,
            messages: [asDebugMessage(nextOpeningRuntimeMessage)],
          })));
        }

        const shouldYieldToPlayer = phaseAdvance.enteredUserPhase
          || orchestrator.awaitUser
          || String(orchestrator.nextRoleType || "").trim().toLowerCase() === "player";
        if (shouldYieldToPlayer) {
          allowPlayerTurn(state, world, String(orchestrator.roleType || "narrator"), String(orchestrator.role || rolePair.narratorRole.name || "旁白"));
        } else {
          setRuntimeTurnState(state, world, {
            canPlayerSpeak: false,
            expectedRoleType: String(orchestrator.nextRoleType || "narrator"),
            expectedRole: String(orchestrator.nextRole || orchestrator.role || rolePair.narratorRole.name || "旁白"),
            lastSpeakerRoleType: String(orchestrator.roleType || "narrator"),
            lastSpeaker: String(orchestrator.role || rolePair.narratorRole.name || "旁白"),
          });
        }
        return res.status(200).send(success(buildDebugSuccessPayload({
          userId,
          worldId,
          chapterId: Number(chapter.id || 0),
          chapterTitle: String(chapter.title || ""),
          state,
          endDialog: null,
          messages: emittedMessage ? [emittedMessage] : [],
        })));
      }

      if (!canPlayerSpeakNow(state, world)) {
        return res.status(409).send(error("当前还没轮到用户发言"));
      }

      const miniGameResult = await handleMiniGameTurn({
        userId,
        world,
        chapter,
        state,
        recentMessages,
        playerMessage: playerContent,
        mode: "debug",
      });
      if (miniGameResult?.intercepted) {
        return res.status(200).send(success(buildDebugSuccessPayload({
          userId,
          worldId,
          chapterId: Number(chapter.id || 0),
          chapterTitle: String(chapter.title || ""),
          state,
          endDialog: null,
          messages: miniGameResult.message ? [asDebugMessage({
            role: miniGameResult.message.role,
            roleType: miniGameResult.message.roleType,
            eventType: miniGameResult.message.eventType,
            content: miniGameResult.message.content,
            createTime: nowTs(),
          })] : [],
        })));
      }

      applyDebugUserMessageProgress({
        chapter,
        state,
        messageContent: playerContent,
        eventType: "on_message",
        meta: {},
      });
      const outcome = evaluateDebugRuntimeOutcome({
        chapter,
        state,
        messageContent: playerContent,
        eventType: "on_message",
        meta: {},
        debugFreePlotActive,
      });
      if (outcome.result === "failed") {
        return res.status(200).send(success(buildDebugSuccessPayload({
          userId,
          worldId,
          chapterId: Number(chapter.id || 0),
          chapterTitle: String(chapter.title || ""),
          state,
          endDialog: "已失败",
          endDialogDetail: buildDebugEndDialogDetail({
            endDialog: "已失败",
            chapterTitle: String(chapter.title || ""),
            matchedBy: outcome.matchedBy,
            matchedRule: outcome.matchedRule,
          }),
          messages: [asDebugMessage({
            role: String(rolePair.narratorRole.name || "旁白"),
            roleType: "narrator",
            eventType: "on_debug_failed",
            content: `章节《${String(chapter.title || "当前章节")}》判定失败，调试结束。`,
          })],
        })));
      }

      if (outcome.result === "success") {
        const nextChapter = await resolveNextChapter(db, worldId, chapter, outcome.nextChapterId);
        if (!nextChapter) {
          (state as any).debugFreePlot = {
            active: true,
            fromChapterId: Number(chapter.id || 0),
            unlockedAt: nowTs(),
          }
          return res.status(200).send(success(buildDebugSuccessPayload({
            userId,
            worldId,
            chapterId: Number(chapter.id || 0),
            chapterTitle: String(chapter.title || ""),
            state,
            endDialog: "进入自由剧情",
            messages: [buildDebugFreePlotMessage(String(rolePair.narratorRole.name || "旁白"), String(chapter.title || "当前章节"))],
          })));
        }
        state.chapterId = Number(nextChapter.id || 0);
        syncDebugChapterRuntime(nextChapter, state);
        const nextOpeningRuntimeMessage = buildOpeningRuntimeMessage(world, nextChapter, String(rolePair.narratorRole.name || "旁白"));
        setRuntimeTurnState(state, world, {
          canPlayerSpeak: false,
          expectedRoleType: "narrator",
          expectedRole: String(rolePair.narratorRole.name || "旁白"),
          lastSpeakerRoleType: String(nextOpeningRuntimeMessage.roleType || "narrator"),
          lastSpeaker: String(nextOpeningRuntimeMessage.role || rolePair.narratorRole.name || "旁白"),
        });
        return res.status(200).send(success(buildDebugSuccessPayload({
          userId,
          worldId,
          chapterId: Number(nextChapter.id || 0),
          chapterTitle: String(nextChapter.title || ""),
          state,
          endDialog: null,
          messages: [asDebugMessage(nextOpeningRuntimeMessage)],
        })));
      }

      const orchestrator = await runNarrativeOrchestrator({
        userId,
        world,
        chapter: effectiveChapter,
        state,
        recentMessages,
        playerMessage: playerContent,
        maxRetries: 0,
        allowControlHints: false,
        allowStateDelta: false,
      });
      applyOrchestratorResultToState(state, orchestrator);
      const emittedMessage = orchestrator.role && orchestrator.content
        ? asDebugMessage({
          role: orchestrator.role,
          roleType: orchestrator.roleType,
          eventType: "on_orchestrated_reply",
          content: orchestrator.content,
          createTime: nowTs(),
        })
        : null;
      applyNarrativeMemoryHintsToState(state, orchestrator.memoryHints);
      if (orchestrator.triggerMemoryAgent) {
        triggerStoryMemoryRefreshInBackground({
          userId,
          world,
          chapter: effectiveChapter,
          state,
          recentMessages: emittedMessage ? [...recentMessages, emittedMessage] : recentMessages,
        });
      }
      const phaseAdvance = emittedMessage
        ? applyDebugNarrativeMessageProgress({
          chapter,
          state,
          role: emittedMessage.role,
          roleType: emittedMessage.roleType,
          content: emittedMessage.content,
        })
        : { enteredUserPhase: false };
      const narratedOutcome = evaluateDebugRuntimeOutcome({
        chapter,
        state,
        messageContent: String(emittedMessage?.content || ""),
        eventType: String(emittedMessage?.eventType || "on_orchestrated_reply"),
        meta: {},
        debugFreePlotActive,
      });

      if (narratedOutcome.result === "failed") {
        return res.status(200).send(success(buildDebugSuccessPayload({
          userId,
          worldId,
          chapterId: Number(chapter.id || 0),
          chapterTitle: String(chapter.title || ""),
          state,
          endDialog: "已失败",
          endDialogDetail: buildDebugEndDialogDetail({
            endDialog: "已失败",
            chapterTitle: String(chapter.title || ""),
            matchedBy: narratedOutcome.matchedBy,
            matchedRule: narratedOutcome.matchedRule,
          }),
          messages: emittedMessage ? [emittedMessage] : [],
        })));
      }

      if (narratedOutcome.result === "success") {
        const nextChapter = await resolveNextChapter(db, worldId, chapter, narratedOutcome.nextChapterId);
        if (!nextChapter) {
          (state as any).debugFreePlot = {
            active: true,
            fromChapterId: Number(chapter.id || 0),
            unlockedAt: nowTs(),
          };
          return res.status(200).send(success(buildDebugSuccessPayload({
            userId,
            worldId,
            chapterId: Number(chapter.id || 0),
            chapterTitle: String(chapter.title || ""),
            state,
            endDialog: "进入自由剧情",
            messages: emittedMessage ? [emittedMessage] : [],
          })));
        }
        if (emittedMessage) {
          setPendingDebugChapterId(state, Number(nextChapter.id || 0));
          setRuntimeTurnState(state, world, {
            canPlayerSpeak: false,
            expectedRoleType: "narrator",
            expectedRole: String(rolePair.narratorRole.name || "旁白"),
            lastSpeakerRoleType: String(orchestrator.roleType || "narrator"),
            lastSpeaker: String(orchestrator.role || rolePair.narratorRole.name || "旁白"),
          });
          return res.status(200).send(success(buildDebugSuccessPayload({
            userId,
            worldId,
            chapterId: Number(chapter.id || 0),
            chapterTitle: String(chapter.title || ""),
            state,
            endDialog: null,
            messages: [emittedMessage],
          })));
        }
        state.chapterId = Number(nextChapter.id || 0);
        syncDebugChapterRuntime(nextChapter, state);
        const nextOpeningRuntimeMessage = buildOpeningRuntimeMessage(world, nextChapter, String(rolePair.narratorRole.name || "旁白"));
        setRuntimeTurnState(state, world, {
          canPlayerSpeak: false,
          expectedRoleType: "narrator",
          expectedRole: String(rolePair.narratorRole.name || "旁白"),
          lastSpeakerRoleType: String(nextOpeningRuntimeMessage.roleType || "narrator"),
          lastSpeaker: String(nextOpeningRuntimeMessage.role || rolePair.narratorRole.name || "旁白"),
        });
        return res.status(200).send(success(buildDebugSuccessPayload({
          userId,
          worldId,
          chapterId: Number(nextChapter.id || 0),
          chapterTitle: String(nextChapter.title || ""),
          state,
          endDialog: null,
          messages: [asDebugMessage(nextOpeningRuntimeMessage)],
        })));
      }

      const shouldYieldToPlayer = phaseAdvance.enteredUserPhase
        || orchestrator.awaitUser
        || String(orchestrator.nextRoleType || "").trim().toLowerCase() === "player";
      if (shouldYieldToPlayer) {
        allowPlayerTurn(state, world, String(orchestrator.roleType || "narrator"), String(orchestrator.role || rolePair.narratorRole.name || "旁白"));
      } else {
        setRuntimeTurnState(state, world, {
          canPlayerSpeak: false,
          expectedRoleType: String(orchestrator.nextRoleType || "narrator"),
          expectedRole: String(orchestrator.nextRole || orchestrator.role || rolePair.narratorRole.name || "旁白"),
          lastSpeakerRoleType: String(orchestrator.roleType || "narrator"),
          lastSpeaker: String(orchestrator.role || rolePair.narratorRole.name || "旁白"),
        });
      }

      return res.status(200).send(success(buildDebugSuccessPayload({
        userId,
        worldId,
        chapterId: Number(chapter.id || 0),
        chapterTitle: String(chapter.title || ""),
        state,
        endDialog: null,
        messages: emittedMessage ? [emittedMessage] : [],
      })));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
