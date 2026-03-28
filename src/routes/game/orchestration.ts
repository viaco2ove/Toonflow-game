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
  allowPlayerTurn,
  applyNarrativeMemoryHintsToState,
  applyOrchestratorResultToState,
  canPlayerSpeakNow,
  evaluateDebugChapterOutcome,
  runNarrativePlan,
  RuntimeMessageInput,
  setRuntimeTurnState,
} from "@/modules/game-runtime/engines/NarrativeOrchestrator";
import { handleMiniGameTurn } from "@/modules/game-runtime/engines/MiniGameController";
import {
  asDebugMessage,
  buildDebugFreePlotMessage,
  buildDebugRecentMessages,
  buildOpeningRuntimeMessage,
  cacheAndBuildDebugStateSnapshot,
  debugMessageSchema,
  getPendingDebugChapterId,
  isDebugFreePlotActive,
  loadCachedDebugRuntimeState,
  resolveNextChapter,
  setPendingDebugChapterId,
} from "./debugRuntimeShared";
import u from "@/utils";

const router = express.Router();

function buildPlanResult(plan: ({
  role: string;
  roleType: string;
  motive: string;
  awaitUser: boolean;
  nextRole: string;
  nextRoleType: string;
  chapterOutcome: "continue" | "success" | "failed";
  nextChapterId: number | null;
  source: "ai" | "fallback";
  memoryHints?: string[];
  stateDelta?: Record<string, unknown>;
  eventType?: string;
  presetContent?: string;
}) | null) {
  if (!plan) return null;
  return {
    role: String(plan.role || "").trim(),
    roleType: String(plan.roleType || "").trim(),
    motive: String(plan.motive || "").trim(),
    awaitUser: Boolean(plan.awaitUser),
    nextRole: String(plan.nextRole || "").trim(),
    nextRoleType: String(plan.nextRoleType || "").trim(),
    chapterOutcome: plan.chapterOutcome || "continue",
    nextChapterId: typeof plan.nextChapterId === "number" && plan.nextChapterId > 0 ? plan.nextChapterId : null,
    source: plan.source || "ai",
    eventType: String(plan.eventType || "on_orchestrated_reply").trim() || "on_orchestrated_reply",
    presetContent: String(plan.presetContent || "").trim() || null,
  };
}

function buildOrchestrationPayload(params: {
  userId: number;
  worldId: number;
  state: Record<string, any>;
  chapterId: number;
  chapterTitle: string;
  endDialog?: string | null;
  plan?: ReturnType<typeof buildPlanResult>;
}) {
  return {
    chapterId: params.chapterId,
    chapterTitle: params.chapterTitle,
    state: cacheAndBuildDebugStateSnapshot({
      userId: params.userId,
      worldId: params.worldId,
      state: params.state,
    }),
    endDialog: params.endDialog || null,
    plan: params.plan || null,
  };
}

function buildPresetPlan(message: {
  role?: unknown;
  roleType?: unknown;
  eventType?: unknown;
  content?: unknown;
} | null, next: {
  awaitUser?: boolean;
  nextRole?: string;
  nextRoleType?: string;
  chapterOutcome?: "continue" | "success" | "failed";
  nextChapterId?: number | null;
}) {
  return buildPlanResult({
    role: String(message?.role || "旁白"),
    roleType: String(message?.roleType || "narrator"),
    motive: "",
    awaitUser: Boolean(next.awaitUser),
    nextRole: String(next.nextRole || ""),
    nextRoleType: String(next.nextRoleType || ""),
    chapterOutcome: next.chapterOutcome || "continue",
    nextChapterId: next.nextChapterId ?? null,
    source: "fallback",
    memoryHints: [],
    stateDelta: {},
    eventType: String(message?.eventType || "on_debug"),
    presetContent: String(message?.content || ""),
  });
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
            return res.status(200).send(success(buildOrchestrationPayload({
              userId,
              worldId,
              chapterId: Number(chapter.id || 0),
              chapterTitle: String(chapter.title || ""),
              state,
              endDialog: null,
              plan: null,
            })));
          }
          state.chapterId = Number(nextChapter.id || 0);
          const openingMessage = buildOpeningRuntimeMessage(world, nextChapter, String(rolePair.narratorRole.name || "旁白"));
          setRuntimeTurnState(state, world, {
            canPlayerSpeak: false,
            expectedRoleType: "narrator",
            expectedRole: String(rolePair.narratorRole.name || "旁白"),
            lastSpeakerRoleType: String(openingMessage.roleType || "narrator"),
            lastSpeaker: String(openingMessage.role || rolePair.narratorRole.name || "旁白"),
          });
          return res.status(200).send(success(buildOrchestrationPayload({
            userId,
            worldId,
            chapterId: Number(nextChapter.id || 0),
            chapterTitle: String(nextChapter.title || ""),
            state,
            endDialog: null,
            plan: buildPresetPlan(openingMessage, {
              awaitUser: false,
              nextRole: String(rolePair.narratorRole.name || "旁白"),
              nextRoleType: "narrator",
              chapterOutcome: "continue",
            }),
          })));
        }

        if (!messages.length) {
          const openingMessage = buildOpeningRuntimeMessage(world, chapter, String(rolePair.narratorRole.name || "旁白"));
          setRuntimeTurnState(state, world, {
            canPlayerSpeak: false,
            expectedRoleType: "narrator",
            expectedRole: String(rolePair.narratorRole.name || "旁白"),
            lastSpeakerRoleType: String(openingMessage.roleType || "narrator"),
            lastSpeaker: String(openingMessage.role || rolePair.narratorRole.name || "旁白"),
          });
          return res.status(200).send(success(buildOrchestrationPayload({
            userId,
            worldId,
            chapterId: Number(chapter.id || 0),
            chapterTitle: String(chapter.title || ""),
            state,
            endDialog: null,
            plan: buildPresetPlan(openingMessage, {
              awaitUser: false,
              nextRole: String(rolePair.narratorRole.name || "旁白"),
              nextRoleType: "narrator",
              chapterOutcome: "continue",
            }),
          })));
        }

        if (canPlayerSpeakNow(state, world)) {
          return res.status(200).send(success(buildOrchestrationPayload({
            userId,
            worldId,
            chapterId: Number(chapter.id || 0),
            chapterTitle: String(chapter.title || ""),
            state,
            endDialog: null,
            plan: null,
          })));
        }

        const plan = await runNarrativePlan({
          userId,
          world,
          chapter: effectiveChapter,
          state,
          recentMessages,
          playerMessage: "",
          maxRetries: 0,
        });
        applyOrchestratorResultToState(state, plan);
        applyNarrativeMemoryHintsToState(state, plan.memoryHints);

        if (!debugFreePlotActive && plan.chapterOutcome === "failed") {
          setRuntimeTurnState(state, world, {
            canPlayerSpeak: false,
            expectedRoleType: String(plan.nextRoleType || "narrator"),
            expectedRole: String(plan.nextRole || plan.role || rolePair.narratorRole.name || "旁白"),
            lastSpeakerRoleType: String(plan.roleType || "narrator"),
            lastSpeaker: String(plan.role || rolePair.narratorRole.name || "旁白"),
          });
          return res.status(200).send(success(buildOrchestrationPayload({
            userId,
            worldId,
            chapterId: Number(chapter.id || 0),
            chapterTitle: String(chapter.title || ""),
            state,
            endDialog: "已失败",
            plan: buildPlanResult({ ...plan, eventType: "on_orchestrated_reply" }),
          })));
        }

        if (!debugFreePlotActive && plan.chapterOutcome === "success") {
          const nextChapter = normalizeChapterOutput(await resolveNextChapter(db, worldId, chapter, plan.nextChapterId));
          if (!nextChapter) {
            (state as any).debugFreePlot = {
              active: true,
              fromChapterId: Number(chapter.id || 0),
              unlockedAt: nowTs(),
            };
            return res.status(200).send(success(buildOrchestrationPayload({
              userId,
              worldId,
              chapterId: Number(chapter.id || 0),
              chapterTitle: String(chapter.title || ""),
              state,
              endDialog: null,
              plan: buildPlanResult({ ...plan, eventType: "on_orchestrated_reply" }),
            })));
          }
          if (plan.role) {
            setPendingDebugChapterId(state, Number(nextChapter.id || 0));
            setRuntimeTurnState(state, world, {
              canPlayerSpeak: false,
              expectedRoleType: "narrator",
              expectedRole: String(rolePair.narratorRole.name || "旁白"),
              lastSpeakerRoleType: String(plan.roleType || "narrator"),
              lastSpeaker: String(plan.role || rolePair.narratorRole.name || "旁白"),
            });
            return res.status(200).send(success(buildOrchestrationPayload({
              userId,
              worldId,
              chapterId: Number(chapter.id || 0),
              chapterTitle: String(chapter.title || ""),
              state,
              endDialog: null,
              plan: buildPlanResult({ ...plan, eventType: "on_orchestrated_reply" }),
            })));
          }
          state.chapterId = Number(nextChapter.id || 0);
          const openingMessage = buildOpeningRuntimeMessage(world, nextChapter, String(rolePair.narratorRole.name || "旁白"));
          setRuntimeTurnState(state, world, {
            canPlayerSpeak: false,
            expectedRoleType: "narrator",
            expectedRole: String(rolePair.narratorRole.name || "旁白"),
            lastSpeakerRoleType: String(openingMessage.roleType || "narrator"),
            lastSpeaker: String(openingMessage.role || rolePair.narratorRole.name || "旁白"),
          });
          return res.status(200).send(success(buildOrchestrationPayload({
            userId,
            worldId,
            chapterId: Number(nextChapter.id || 0),
            chapterTitle: String(nextChapter.title || ""),
            state,
            endDialog: null,
            plan: buildPresetPlan(openingMessage, {
              awaitUser: false,
              nextRole: String(rolePair.narratorRole.name || "旁白"),
              nextRoleType: "narrator",
              chapterOutcome: "continue",
            }),
          })));
        }

        const shouldYieldToPlayer = plan.awaitUser || String(plan.nextRoleType || "").trim().toLowerCase() === "player";
        if (shouldYieldToPlayer) {
          allowPlayerTurn(state, world, String(plan.roleType || "narrator"), String(plan.role || rolePair.narratorRole.name || "旁白"));
        } else {
          setRuntimeTurnState(state, world, {
            canPlayerSpeak: false,
            expectedRoleType: String(plan.nextRoleType || "narrator"),
            expectedRole: String(plan.nextRole || plan.role || rolePair.narratorRole.name || "旁白"),
            lastSpeakerRoleType: String(plan.roleType || "narrator"),
            lastSpeaker: String(plan.role || rolePair.narratorRole.name || "旁白"),
          });
        }
        return res.status(200).send(success(buildOrchestrationPayload({
          userId,
          worldId,
          chapterId: Number(chapter.id || 0),
          chapterTitle: String(chapter.title || ""),
          state,
          endDialog: null,
          plan: buildPlanResult({ ...plan, eventType: "on_orchestrated_reply" }),
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
        const presetMessage = miniGameResult.message
          ? {
            role: miniGameResult.message.role,
            roleType: miniGameResult.message.roleType,
            eventType: miniGameResult.message.eventType,
            content: miniGameResult.message.content,
            createTime: nowTs(),
          }
          : null;
        return res.status(200).send(success(buildOrchestrationPayload({
          userId,
          worldId,
          chapterId: Number(chapter.id || 0),
          chapterTitle: String(chapter.title || ""),
          state,
          endDialog: null,
          plan: presetMessage ? buildPresetPlan(presetMessage, {
            awaitUser: false,
            nextRole: "",
            nextRoleType: "",
            chapterOutcome: "continue",
          }) : null,
        })));
      }

      const outcome = debugFreePlotActive ? { result: "continue" as const, nextChapterId: null } : evaluateDebugChapterOutcome(chapter, playerContent, recentMessages);
      if (outcome.result === "failed") {
        const message = {
          role: String(rolePair.narratorRole.name || "旁白"),
          roleType: "narrator",
          eventType: "on_debug_failed",
          content: `章节《${String(chapter.title || "当前章节")}》判定失败，调试结束。`,
          createTime: nowTs(),
        };
        return res.status(200).send(success(buildOrchestrationPayload({
          userId,
          worldId,
          chapterId: Number(chapter.id || 0),
          chapterTitle: String(chapter.title || ""),
          state,
          endDialog: "已失败",
          plan: buildPresetPlan(message, {
            awaitUser: false,
            nextRole: "",
            nextRoleType: "",
            chapterOutcome: "failed",
          }),
        })));
      }

      if (outcome.result === "success") {
        const nextChapter = normalizeChapterOutput(await resolveNextChapter(db, worldId, chapter, outcome.nextChapterId));
        if (!nextChapter) {
          (state as any).debugFreePlot = {
            active: true,
            fromChapterId: Number(chapter.id || 0),
            unlockedAt: nowTs(),
          };
          const freePlotMessage = buildDebugFreePlotMessage(String(rolePair.narratorRole.name || "旁白"), String(chapter.title || "当前章节"));
          return res.status(200).send(success(buildOrchestrationPayload({
            userId,
            worldId,
            chapterId: Number(chapter.id || 0),
            chapterTitle: String(chapter.title || ""),
            state,
            endDialog: null,
            plan: buildPresetPlan(freePlotMessage, {
              awaitUser: false,
              nextRole: String(rolePair.narratorRole.name || "旁白"),
              nextRoleType: "narrator",
              chapterOutcome: "continue",
            }),
          })));
        }
        state.chapterId = Number(nextChapter.id || 0);
        const openingMessage = buildOpeningRuntimeMessage(world, nextChapter, String(rolePair.narratorRole.name || "旁白"));
        setRuntimeTurnState(state, world, {
          canPlayerSpeak: false,
          expectedRoleType: "narrator",
          expectedRole: String(rolePair.narratorRole.name || "旁白"),
          lastSpeakerRoleType: String(openingMessage.roleType || "narrator"),
          lastSpeaker: String(openingMessage.role || rolePair.narratorRole.name || "旁白"),
        });
        return res.status(200).send(success(buildOrchestrationPayload({
          userId,
          worldId,
          chapterId: Number(nextChapter.id || 0),
          chapterTitle: String(nextChapter.title || ""),
          state,
          endDialog: null,
          plan: buildPresetPlan(openingMessage, {
            awaitUser: false,
            nextRole: String(rolePair.narratorRole.name || "旁白"),
            nextRoleType: "narrator",
            chapterOutcome: "continue",
          }),
        })));
      }

      const plan = await runNarrativePlan({
        userId,
        world,
        chapter: effectiveChapter,
        state,
        recentMessages,
        playerMessage: playerContent,
        maxRetries: 0,
      });
      applyOrchestratorResultToState(state, plan);
      applyNarrativeMemoryHintsToState(state, plan.memoryHints);

      if (!debugFreePlotActive && plan.chapterOutcome === "failed") {
        return res.status(200).send(success(buildOrchestrationPayload({
          userId,
          worldId,
          chapterId: Number(chapter.id || 0),
          chapterTitle: String(chapter.title || ""),
          state,
          endDialog: "已失败",
          plan: buildPlanResult({ ...plan, eventType: "on_orchestrated_reply" }),
        })));
      }

      if (!debugFreePlotActive && plan.chapterOutcome === "success") {
        const nextChapter = normalizeChapterOutput(await resolveNextChapter(db, worldId, chapter, plan.nextChapterId));
        if (!nextChapter) {
          (state as any).debugFreePlot = {
            active: true,
            fromChapterId: Number(chapter.id || 0),
            unlockedAt: nowTs(),
          };
          return res.status(200).send(success(buildOrchestrationPayload({
            userId,
            worldId,
            chapterId: Number(chapter.id || 0),
            chapterTitle: String(chapter.title || ""),
            state,
            endDialog: null,
            plan: buildPlanResult({ ...plan, eventType: "on_orchestrated_reply" }),
          })));
        }
        if (plan.role) {
          setPendingDebugChapterId(state, Number(nextChapter.id || 0));
          setRuntimeTurnState(state, world, {
            canPlayerSpeak: false,
            expectedRoleType: "narrator",
            expectedRole: String(rolePair.narratorRole.name || "旁白"),
            lastSpeakerRoleType: String(plan.roleType || "narrator"),
            lastSpeaker: String(plan.role || rolePair.narratorRole.name || "旁白"),
          });
          return res.status(200).send(success(buildOrchestrationPayload({
            userId,
            worldId,
            chapterId: Number(chapter.id || 0),
            chapterTitle: String(chapter.title || ""),
            state,
            endDialog: null,
            plan: buildPlanResult({ ...plan, eventType: "on_orchestrated_reply" }),
          })));
        }
        state.chapterId = Number(nextChapter.id || 0);
        const openingMessage = buildOpeningRuntimeMessage(world, nextChapter, String(rolePair.narratorRole.name || "旁白"));
        setRuntimeTurnState(state, world, {
          canPlayerSpeak: false,
          expectedRoleType: "narrator",
          expectedRole: String(rolePair.narratorRole.name || "旁白"),
          lastSpeakerRoleType: String(openingMessage.roleType || "narrator"),
          lastSpeaker: String(openingMessage.role || rolePair.narratorRole.name || "旁白"),
        });
        return res.status(200).send(success(buildOrchestrationPayload({
          userId,
          worldId,
          chapterId: Number(nextChapter.id || 0),
          chapterTitle: String(nextChapter.title || ""),
          state,
          endDialog: null,
          plan: buildPresetPlan(openingMessage, {
            awaitUser: false,
            nextRole: String(rolePair.narratorRole.name || "旁白"),
            nextRoleType: "narrator",
            chapterOutcome: "continue",
          }),
        })));
      }

      const shouldYieldToPlayer = plan.awaitUser || String(plan.nextRoleType || "").trim().toLowerCase() === "player";
      if (shouldYieldToPlayer) {
        allowPlayerTurn(state, world, String(plan.roleType || "narrator"), String(plan.role || rolePair.narratorRole.name || "旁白"));
      } else {
        setRuntimeTurnState(state, world, {
          canPlayerSpeak: false,
          expectedRoleType: String(plan.nextRoleType || "narrator"),
          expectedRole: String(plan.nextRole || plan.role || rolePair.narratorRole.name || "旁白"),
          lastSpeakerRoleType: String(plan.roleType || "narrator"),
          lastSpeaker: String(plan.role || rolePair.narratorRole.name || "旁白"),
        });
      }

      return res.status(200).send(success(buildOrchestrationPayload({
        userId,
        worldId,
        chapterId: Number(chapter.id || 0),
        chapterTitle: String(chapter.title || ""),
        state,
        endDialog: null,
        plan: buildPlanResult({ ...plan, eventType: "on_orchestrated_reply" }),
      })));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
