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
  canPlayerSpeakNow,
  evaluateDebugChapterOutcome,
  resolveOpeningMessage,
  setRuntimeTurnState,
  runNarrativeOrchestrator,
  RuntimeMessageInput,
} from "@/modules/game-runtime/engines/NarrativeOrchestrator";
import { handleMiniGameTurn } from "@/modules/game-runtime/engines/MiniGameController";
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
  messages?: unknown[];
}) {
  const normalizedMessages = (params.messages || []).filter((item): item is Record<string, any> =>
    Boolean(item && typeof item === "object" && !Array.isArray(item)));
  const debugRuntimeKey = cacheDebugRuntimeState(
    params.state,
    params.userId,
    params.worldId,
    readDebugRuntimeKey(params.state),
  );
  return {
    chapterId: params.chapterId,
    chapterTitle: params.chapterTitle,
    state: buildDebugStateSnapshot(params.state, debugRuntimeKey),
    endDialog: params.endDialog || null,
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
      );
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
      const recentMessages = buildDebugRecentMessages(messages, String(rolePair.playerRole.name || "用户"), playerContent);

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
          const openingRuntimeMessage = buildOpeningRuntimeMessage(world, chapter, String(rolePair.narratorRole.name || "旁白"));
          setRuntimeTurnState(state, world, {
            canPlayerSpeak: false,
            expectedRoleType: "narrator",
            expectedRole: String(rolePair.narratorRole.name || "旁白"),
            lastSpeakerRoleType: String(openingRuntimeMessage.roleType || "narrator"),
            lastSpeaker: String(openingRuntimeMessage.role || rolePair.narratorRole.name || "旁白"),
          });
          return res.status(200).send(success(buildDebugSuccessPayload({
            userId,
            worldId,
            chapterId: Number(chapter.id || 0),
            chapterTitle: String(chapter.title || ""),
            state,
            endDialog: null,
            messages: [asDebugMessage(openingRuntimeMessage)],
          })));
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

        if (!debugFreePlotActive && orchestrator.chapterOutcome === "failed") {
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
            messages: emittedMessage ? [emittedMessage] : [],
          })));
        }

        if (!debugFreePlotActive && orchestrator.chapterOutcome === "success") {
          const nextChapter = await resolveNextChapter(db, worldId, chapter, orchestrator.nextChapterId);
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

        const shouldYieldToPlayer = orchestrator.awaitUser || String(orchestrator.nextRoleType || "").trim().toLowerCase() === "player";
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

      const outcome = debugFreePlotActive ? { result: "continue" as const, nextChapterId: null } : evaluateDebugChapterOutcome(chapter, playerContent, recentMessages);
      if (outcome.result === "failed") {
        return res.status(200).send(success(buildDebugSuccessPayload({
          userId,
          worldId,
          chapterId: Number(chapter.id || 0),
          chapterTitle: String(chapter.title || ""),
          state,
          endDialog: "已失败",
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

      if (!debugFreePlotActive && orchestrator.chapterOutcome === "failed") {
        return res.status(200).send(success(buildDebugSuccessPayload({
          userId,
          worldId,
          chapterId: Number(chapter.id || 0),
          chapterTitle: String(chapter.title || ""),
          state,
          endDialog: "已失败",
          messages: emittedMessage ? [emittedMessage] : [],
        })));
      }

      if (!debugFreePlotActive && orchestrator.chapterOutcome === "success") {
        const nextChapter = await resolveNextChapter(db, worldId, chapter, orchestrator.nextChapterId);
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

      const shouldYieldToPlayer = orchestrator.awaitUser || String(orchestrator.nextRoleType || "").trim().toLowerCase() === "player";
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
