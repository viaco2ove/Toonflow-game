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
  applyPlayerProfileFromMessageToState,
  canPlayerSpeakNow,
  runNarrativePlan,
  RuntimeMessageInput,
  setRuntimeTurnState,
  triggerStoryMemoryRefreshInBackground,
} from "@/modules/game-runtime/engines/NarrativeOrchestrator";
import { handleMiniGameTurn } from "@/modules/game-runtime/engines/MiniGameController";
import {
  orchestrateSessionTurn,
  isSessionServiceError,
} from "@/modules/game-runtime/services/SessionService";
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
  syncDebugChapterRuntime,
  applyDebugUserMessageProgress,
  buildEffectiveDebugChapter,
  evaluateDebugRuntimeOutcome,
  buildDebugEndDialogDetail,
  saveDebugRevisitPoint,
} from "./debugRuntimeShared";
import u from "@/utils";

const router = express.Router();

// 把编排器/兜底返回统一收口成前端稳定可消费的计划结构。
function buildPlanResult(plan: ({
  role: string;
  roleType: string;
  motive: string;
  awaitUser: boolean;
  nextRole: string;
  nextRoleType: string;
  source: "ai" | "fallback" | "rule";
  memoryHints?: string[];
  triggerMemoryAgent?: boolean;
  stateDelta?: Record<string, unknown>;
  eventType?: string;
  presetContent?: string;
  eventAdjustMode?: "keep" | "update" | "waiting_input" | "completed";
  eventIndex?: number;
  eventKind?: "opening" | "scene" | "user" | "fixed" | "ending";
  eventSummary?: string;
  eventFacts?: string[];
  eventStatus?: "idle" | "active" | "waiting_input" | "completed";
  speakerMode?: "template" | "fast" | "premium";
  speakerRouteReason?: string;
  planSource?: string;
  orchestratorRuntime?: {
    modelKey?: unknown;
    manufacturer?: unknown;
    model?: unknown;
    reasoningEffort?: unknown;
    payloadMode?: unknown;
    payloadModeSource?: unknown;
  };
}) | null) {
  if (!plan) return null;
  return {
    role: String(plan.role || "").trim(),
    roleType: String(plan.roleType || "").trim(),
    motive: String(plan.motive || "").trim(),
    awaitUser: Boolean(plan.awaitUser),
    nextRole: String(plan.nextRole || "").trim(),
    nextRoleType: String(plan.nextRoleType || "").trim(),
    source: plan.source === "fallback"
      ? "fallback"
      : plan.source === "rule"
        ? "rule"
        : "ai",
    triggerMemoryAgent: Boolean(plan.triggerMemoryAgent),
    eventType: String(plan.eventType || "on_orchestrated_reply").trim() || "on_orchestrated_reply",
    presetContent: String(plan.presetContent || "").trim() || null,
    eventAdjustMode: plan.eventAdjustMode === "update"
      ? "update"
      : plan.eventAdjustMode === "waiting_input"
        ? "waiting_input"
        : plan.eventAdjustMode === "completed"
          ? "completed"
          : plan.eventAdjustMode === "keep"
            ? "keep"
            : undefined,
    eventIndex: Number.isFinite(Number(plan.eventIndex)) ? Math.max(1, Number(plan.eventIndex)) : undefined,
    eventKind: plan.eventKind === "opening"
      ? "opening"
      : plan.eventKind === "user"
        ? "user"
        : plan.eventKind === "fixed"
          ? "fixed"
          : plan.eventKind === "ending"
            ? "ending"
          : plan.eventKind === "scene"
            ? "scene"
            : undefined,
    eventSummary: String(plan.eventSummary || "").trim(),
    eventFacts: Array.isArray(plan.eventFacts)
      ? plan.eventFacts.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
    eventStatus: plan.eventStatus === "active"
      ? "active"
      : plan.eventStatus === "waiting_input"
        ? "waiting_input"
        : plan.eventStatus === "completed"
          ? "completed"
          : plan.eventStatus === "idle"
            ? "idle"
            : undefined,
    speakerMode: plan.speakerMode === "template"
      ? "template"
      : plan.speakerMode === "fast"
        ? "fast"
        : plan.speakerMode === "premium"
          ? "premium"
          : undefined,
    speakerRouteReason: String(plan.speakerRouteReason || "").trim(),
    planSource: (() => {
      const explicit = String(plan.planSource || "").trim();
      if (explicit) return explicit;
      if (String(plan.eventType || "").trim() === "on_opening" && String(plan.presetContent || "").trim()) {
        return "opening_preset";
      }
      return plan.source === "rule"
        ? "rule_orchestrator"
        : plan.source === "fallback"
          ? "fallback_orchestrator"
          : "ai_orchestrator";
    })(),
    orchestratorRuntime: plan.orchestratorRuntime
      ? {
        modelKey: String(plan.orchestratorRuntime.modelKey || "").trim(),
        manufacturer: String(plan.orchestratorRuntime.manufacturer || "").trim(),
        model: String(plan.orchestratorRuntime.model || "").trim(),
        reasoningEffort: (() => {
          const value = String(plan.orchestratorRuntime?.reasoningEffort || "").trim().toLowerCase();
          return value === "minimal" || value === "low" || value === "medium" || value === "high" ? value : "";
        })(),
        payloadMode: String(plan.orchestratorRuntime.payloadMode || "").trim().toLowerCase() === "advanced" ? "advanced" : "compact",
        payloadModeSource: String(plan.orchestratorRuntime.payloadModeSource || "").trim().toLowerCase() === "explicit" ? "explicit" : "inferred",
      }
      : undefined,
  };
}

// 调试态不落库，前端每轮都回传 state，这里把快照重新缓存并回填给客户端。
function buildOrchestrationPayload(params: {
  userId: number;
  worldId: number;
  state: Record<string, any>;
  chapterId: number;
  chapterTitle: string;
  endDialog?: string | null;
  endDialogDetail?: string | null;
  plan?: ReturnType<typeof buildPlanResult>;
  messages?: RuntimeMessageInput[];
}) {
  const stateSnapshot = cacheAndBuildDebugStateSnapshot({
    userId: params.userId,
    worldId: params.worldId,
    state: params.state,
  });

  // 保存回溯点（用于台词回溯功能）
  const debugRuntimeKey = stateSnapshot.debugRuntimeKey as string;
  if (debugRuntimeKey && params.messages) {
    saveDebugRevisitPoint(
      debugRuntimeKey,
      params.state,
      params.messages,
      params.chapterId
    );
  }

  if (String(process.env.LOG_LEVEL || "").trim().toUpperCase() === "DEBUG") {
    const planSource = String(params.plan?.planSource || "").trim();
    const tag = planSource === "opening_preset"
      ? "story:introduction:plan"
      : "story:orchestrator:plan";
    console.log(`[${tag}]`, JSON.stringify({
      planSource,
      awaitUser: Boolean(params.plan?.awaitUser),
      nextRoleType: String(params.plan?.nextRoleType || "").trim(),
      roleType: String(params.plan?.roleType || "").trim(),
      nextRole: String(params.plan?.nextRole || "").trim(),
      role: String(params.plan?.role || "").trim(),
    }));
  }
  return {
    chapterId: params.chapterId,
    chapterTitle: params.chapterTitle,
    state: stateSnapshot,
    // 调试快照本身已经携带裁剪后的事件视图，不能再按缺失 chapterProgress 的精简快照重新计算，
    // 否则顶层会退回默认的 scene/idle，并把真正的当前事件覆盖掉。
    currentEventDigest: stateSnapshot.currentEventDigest || null,
    eventDigestWindow: Array.isArray(stateSnapshot.eventDigestWindow) ? stateSnapshot.eventDigestWindow : [],
    eventDigestWindowText: String(stateSnapshot.eventDigestWindowText || ""),
    endDialog: params.endDialog || null,
    endDialogDetail: String(params.endDialogDetail || "").trim() || null,
    plan: params.plan || null,
  };
}

// 对固定消息（开场白、失败提示、小游戏返回等）套一层与 AI 编排相同的 plan 外形。
function buildPresetPlan(message: {
  role?: unknown;
  roleType?: unknown;
  eventType?: unknown;
  content?: unknown;
} | null, next: {
  awaitUser?: boolean;
  nextRole?: string;
  nextRoleType?: string;
}) {
  return buildPlanResult({
    role: String(message?.role || "旁白"),
    roleType: String(message?.roleType || "narrator"),
    motive: "",
    awaitUser: Boolean(next.awaitUser),
    nextRole: String(next.nextRole || ""),
    nextRoleType: String(next.nextRoleType || ""),
    source: "fallback",
    planSource: String(message?.eventType || "").trim() === "on_opening" ? "opening_preset" : "preset",
    memoryHints: [],
    triggerMemoryAgent: false,
    stateDelta: {},
    eventType: String(message?.eventType || "on_debug"),
    presetContent: String(message?.content || ""),
  });
}

export default router.post(
  "/",
  validateFields({
    sessionId: z.string().optional().nullable(),
    worldId: z.number().optional().nullable(),
    chapterId: z.number().optional().nullable(),
    playerContent: z.string().optional().nullable(),
    state: z.any().optional().nullable(),
    messages: z.array(debugMessageSchema).optional().nullable(),
  }),
  async (req, res) => {
    try {
      const sessionId = String(req.body.sessionId || "").trim();
      if (sessionId) {
        const result = await orchestrateSessionTurn(sessionId);
        return res.status(200).send(success(result));
      }

      const db = getGameDb();
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }

      const worldId = Number(req.body.worldId || 0);
      if (!worldId) {
        return res.status(400).send(error("worldId 不能为空"));
      }
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
      const debugFreePlotActive = isDebugFreePlotActive(state);
      let effectiveChapter = buildEffectiveDebugChapter(chapter, debugFreePlotActive);
      syncDebugChapterRuntime(effectiveChapter, state);
      const messages = inputMessages.map((item) => ({
        role: String(item.role || ""),
        roleType: String(item.roleType || ""),
        eventType: String(item.eventType || ""),
        content: String(item.content || ""),
        createTime: Number(item.createTime || 0),
      }));
      const recentMessages = buildDebugRecentMessages(messages, String(state.player?.name || rolePair.playerRole.name || "用户"), playerContent);

      function applyPlanTurnState(plan: {
        awaitUser?: boolean;
        nextRole?: string;
        nextRoleType?: string;
        role?: string;
        roleType?: string;
      }) {
        // 调试编排也复用正式会话的 turn-state 规则，保证“该轮到谁说”在前后端一致。
        const shouldYieldToPlayer = Boolean(plan.awaitUser) || String(plan.nextRoleType || "").trim().toLowerCase() === "player";
        if (shouldYieldToPlayer) {
          allowPlayerTurn(state, world, String(plan.roleType || "narrator"), String(plan.role || rolePair.narratorRole.name || "旁白"));
          return;
        }
        setRuntimeTurnState(state, world, {
          canPlayerSpeak: false,
          expectedRoleType: String(plan.nextRoleType || "narrator"),
          expectedRole: String(plan.nextRole || plan.role || rolePair.narratorRole.name || "旁白"),
          lastSpeakerRoleType: String(plan.roleType || "narrator"),
          lastSpeaker: String(plan.role || rolePair.narratorRole.name || "旁白"),
        });
      }

      async function buildChapterStartPlan(targetChapter: any) {
        state.chapterId = Number(targetChapter.id || 0);
        const targetEffectiveChapter = buildEffectiveDebugChapter(targetChapter, debugFreePlotActive);
        syncDebugChapterRuntime(targetEffectiveChapter, state);
        const openingMessage = buildOpeningRuntimeMessage(world, targetChapter, String(rolePair.narratorRole.name || "旁白"));
        setRuntimeTurnState(state, world, {
          canPlayerSpeak: false,
          expectedRoleType: "narrator",
          expectedRole: String(rolePair.narratorRole.name || "旁白"),
          lastSpeakerRoleType: String(openingMessage.roleType || "narrator"),
          lastSpeaker: String(openingMessage.role || rolePair.narratorRole.name || "旁白"),
        });
        // 有显式章节开场词时，先把这一句完整返回给前端；没有时再直接跑一次编排器。
        if (String(openingMessage.content || "").trim()) {
        return {
          chapterId: Number(targetChapter.id || 0),
          chapterTitle: String(targetChapter.title || ""),
          plan: buildPresetPlan(openingMessage, {
              awaitUser: false,
              nextRole: String(rolePair.narratorRole.name || "旁白"),
              nextRoleType: "narrator",
            }),
          };
        }
        effectiveChapter = targetEffectiveChapter;
        // 调用大模型进行编排
        const start = Date.now();
        const targetPlan = await runNarrativePlan({
          userId,
          world,
          chapter: targetEffectiveChapter,
          state,
          recentMessages,
          playerMessage: "",
          maxRetries: 0,
          allowControlHints: false,
          allowStateDelta: false,
        });
        const cost = Date.now() - start;
        console.log(
          `[runNarrativePlan] userId=${userId} chapter=${targetEffectiveChapter.id} 耗时=${cost}ms`
        );
        applyOrchestratorResultToState(state, targetPlan);
        applyNarrativeMemoryHintsToState(state, targetPlan.memoryHints);
        if (targetPlan.triggerMemoryAgent) {
          triggerStoryMemoryRefreshInBackground({
            userId,
            world,
            chapter: targetEffectiveChapter,
            state,
            recentMessages,
          });
        }
        applyPlanTurnState(targetPlan);
        return {
          chapterId: Number(targetChapter.id || 0),
          chapterTitle: String(targetChapter.title || ""),
          plan: buildPlanResult({ ...targetPlan, eventType: "on_orchestrated_reply", planSource: "ai_orchestrator" }),
        };
      }

      if (!playerContent) {
        const pendingChapterId = getPendingDebugChapterId(state);
        if (pendingChapterId) {
          // 上一轮已经宣告章节完成，但前端还没请求下一轮时，用 pending 标记串起新章节开场。
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
              messages: inputMessages,
            })));
          }
          chapter = nextChapter;
          const nextChapterStart = await buildChapterStartPlan(nextChapter);
          return res.status(200).send(success(buildOrchestrationPayload({
            userId,
            worldId,
            chapterId: nextChapterStart.chapterId,
            chapterTitle: nextChapterStart.chapterTitle,
            state,
            endDialog: null,
            plan: nextChapterStart.plan,
            messages: inputMessages,
          })));
        }

        if (!messages.length) {
          // 首次进入调试页时没有历史消息，直接生成当前章节开场。
          const chapterStart = await buildChapterStartPlan(chapter);
          return res.status(200).send(success(buildOrchestrationPayload({
            userId,
            worldId,
            chapterId: chapterStart.chapterId,
            chapterTitle: chapterStart.chapterTitle,
            state,
            endDialog: null,
            plan: chapterStart.plan,
            messages: inputMessages,
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
          messages: inputMessages,
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
          allowControlHints: false,
          allowStateDelta: false,
        });
        applyOrchestratorResultToState(state, plan);
        applyNarrativeMemoryHintsToState(state, plan.memoryHints);
        if (plan.triggerMemoryAgent) {
          triggerStoryMemoryRefreshInBackground({
            userId,
            world,
            chapter: effectiveChapter,
            state,
            recentMessages,
          });
        }

        applyPlanTurnState(plan);
        return res.status(200).send(success(buildOrchestrationPayload({
          userId,
          worldId,
          chapterId: Number(chapter.id || 0),
          chapterTitle: String(chapter.title || ""),
          state,
          endDialog: null,
          plan: buildPlanResult({ ...plan, eventType: "on_orchestrated_reply", planSource: "ai_orchestrator" }),
          messages: inputMessages,
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
        // 小游戏命中了自己的状态机时，剧情编排本轮直接让位给小游戏结果。
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
          }) : null,
          messages: inputMessages,
        })));
      }

      applyDebugUserMessageProgress({
        chapter,
        state,
        messageContent: playerContent,
        eventType: "on_message",
        meta: {},
      });
      const outcome = await evaluateDebugRuntimeOutcome({
        chapter,
        state,
        messageContent: playerContent,
        eventType: "on_message",
        meta: {},
        recentMessages,
        debugFreePlotActive,
      });
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
          }),
          endDialogDetail: buildDebugEndDialogDetail({
            endDialog: "已失败",
            chapterTitle: String(chapter.title || ""),
            matchedBy: outcome.matchedBy,
            matchedRule: outcome.matchedRule,
          }),
          messages: inputMessages,
        })));
      }

      if (outcome.result === "success") {
        const nextChapter = normalizeChapterOutput(await resolveNextChapter(db, worldId, chapter, outcome.nextChapterId));
        if (!nextChapter) {
          // 没有下一章时，调试态自动转入自由剧情，方便继续压编排与角色发言。
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
            }),
            messages: inputMessages,
          })));
        }
        chapter = nextChapter;
        const nextChapterStart = await buildChapterStartPlan(nextChapter);
      return res.status(200).send(success(buildOrchestrationPayload({
        userId,
        worldId,
        chapterId: nextChapterStart.chapterId,
        chapterTitle: nextChapterStart.chapterTitle,
        state,
        endDialog: null,
        plan: nextChapterStart.plan,
        messages: inputMessages,
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
        allowControlHints: false,
        allowStateDelta: false,
      });
      applyOrchestratorResultToState(state, plan);
      applyNarrativeMemoryHintsToState(state, plan.memoryHints);
      if (plan.triggerMemoryAgent) {
        triggerStoryMemoryRefreshInBackground({
          userId,
          world,
          chapter: effectiveChapter,
          state,
          recentMessages,
        });
      }

      applyPlanTurnState(plan);

      return res.status(200).send(success(buildOrchestrationPayload({
        userId,
        worldId,
        chapterId: Number(chapter.id || 0),
        chapterTitle: String(chapter.title || ""),
        state,
        endDialog: null,
        plan: buildPlanResult({ ...plan, eventType: "on_orchestrated_reply", planSource: "ai_orchestrator" }),
        messages: inputMessages,
      })));
    } catch (err) {
      if (isSessionServiceError(err)) {
        return res.status(err.status).send(error(err.message));
      }
      res.status(500).send(error(u.error(err).message));
    }
  },
);
