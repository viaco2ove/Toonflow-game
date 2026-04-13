import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  getGameDb,
  normalizeChapterOutput,
  parseJsonSafe,
  normalizeRolePair,
  normalizeSessionState,
  readDefaultRuntimeEventViewState,
  toJsonText,
} from "@/lib/gameEngine";
import {
  buildEffectiveDebugChapter,
  buildOpeningRuntimeMessage,
  cacheAndBuildDebugStateSnapshot,
  debugMessageSchema,
  loadCachedDebugRuntimeState,
  setDebugOpeningTurnState,
  syncDebugChapterRuntime,
  isDebugFreePlotActive,
} from "./debugRuntimeShared";

const router = express.Router();

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

function buildOrchestrationPayload(params: {
  userId: number;
  worldId: number;
  state: Record<string, any>;
  chapterId: number;
  chapterTitle: string;
  endDialog?: string | null;
  plan?: ReturnType<typeof buildPlanResult>;
}) {
  const stateSnapshot = cacheAndBuildDebugStateSnapshot({
    userId: params.userId,
    worldId: params.worldId,
    state: params.state,
  });
  if (String(process.env.LOG_LEVEL || "").trim().toUpperCase() === "DEBUG") {
    console.log("[story:introduction:plan]", JSON.stringify({
      planSource: String(params.plan?.planSource || "").trim(),
      awaitUser: Boolean(params.plan?.awaitUser),
      roleType: String(params.plan?.roleType || "").trim(),
      role: String(params.plan?.role || "").trim(),
    }));
  }
  return {
    chapterId: params.chapterId,
    chapterTitle: params.chapterTitle,
    // 开场编排和正式编排一致，只回调试缓存锚点，不返回整份运行态。
    state: {
      debugRuntimeKey: String(stateSnapshot.debugRuntimeKey || ""),
    },
    currentEventDigest: stateSnapshot.currentEventDigest || null,
    eventDigestWindow: Array.isArray(stateSnapshot.eventDigestWindow) ? stateSnapshot.eventDigestWindow : [],
    eventDigestWindowText: String(stateSnapshot.eventDigestWindowText || ""),
    endDialog: params.endDialog || null,
    // 开场编排也不携带“下一位是谁”，避免前端提前切换回合。
    plan: params.plan
      ? {
        ...params.plan,
        nextRole: "",
        nextRoleType: "",
      }
      : null,
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

      const sessionId = String(req.body.sessionId || "").trim();
      const requestWorldId = Number(req.body.worldId || 0);
      const requestChapterId = Number(req.body.chapterId || 0);
      let worldId = requestWorldId;
      let chapter: any = null;
      let world: any = null;
      let state: Record<string, any> = {};

      if (sessionId) {
        // 正式游玩模式：开场白必须基于已创建的 session 生成，避免再把开场白塞回 initStory。
        const sessionRow = await db("t_gameSession").where({ sessionId, userId }).first();
        if (!sessionRow) {
          return res.status(404).send(error("会话不存在"));
        }
        worldId = Number(sessionRow.worldId || 0);
        world = await db("t_storyWorld").where({ id: worldId }).first();
        if (!world) {
          return res.status(404).send(error("未找到故事"));
        }
        const sessionState = parseJsonSafe<Record<string, any>>(sessionRow.stateJson, {});
        // 兼容旧 session：历史数据里 chapterId 可能没写入 t_gameSession，
        // 这里优先读 session.chapterId，其次回退到 stateJson.chapterId，最后再回退首章。
        const sessionChapterId = Number(sessionRow.chapterId || sessionState.chapterId || 0);
        if (sessionChapterId > 0) {
          chapter = await db("t_storyChapter").where({ id: sessionChapterId, worldId }).first();
        }
        if (!chapter) {
          chapter = await db("t_storyChapter").where({ worldId }).orderBy("sort", "asc").orderBy("id", "asc").first();
        }
        chapter = normalizeChapterOutput(chapter);
        if (!chapter) {
          return res.status(404).send(error("当前没有章节可游玩"));
        }
        const rolePair = normalizeRolePair(world.playerRole, world.narratorRole);
        state = normalizeSessionState(
          sessionRow.stateJson,
          worldId,
          Number(chapter.id || 0),
          rolePair,
          world,
        );
      } else {
        if (!worldId) {
          return res.status(400).send(error("worldId 不能为空"));
        }
        world = await db("t_storyWorld as w")
          .leftJoin("t_project as p", "w.projectId", "p.id")
          .where("w.id", worldId)
          .where("p.userId", userId)
          .select("w.*")
          .first();
        if (!world) {
          return res.status(404).send(error("未找到故事"));
        }
        if (requestChapterId > 0) {
          chapter = await db("t_storyChapter").where({ id: requestChapterId, worldId }).first();
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
        state = normalizeSessionState(
          cachedRuntimeState || req.body.state,
          worldId,
          Number(chapter.id || 0),
          rolePair,
          world,
        );
      }

      const rolePair = normalizeRolePair(world.playerRole, world.narratorRole);
      const debugFreePlotActive = isDebugFreePlotActive(state);
      const effectiveChapter = buildEffectiveDebugChapter(chapter, debugFreePlotActive);
      syncDebugChapterRuntime(effectiveChapter, state);
      const openingMessage = buildOpeningRuntimeMessage(world, chapter, String(rolePair.narratorRole.name || "旁白"));
      setDebugOpeningTurnState(state, world, String(openingMessage.role || rolePair.narratorRole.name || "旁白"), String(openingMessage.roleType || "narrator"));
      if (sessionId) {
        await db("t_gameSession").where({ sessionId }).update({
          stateJson: toJsonText(state, {}),
        });
      }
      if (!String(openingMessage.content || "").trim()) {
        if (sessionId) {
          const eventView = readDefaultRuntimeEventViewState(state);
          return res.status(200).send(success({
            sessionId,
            status: "active",
            chapterId: Number(chapter.id || 0),
            expectedRole: String(rolePair.narratorRole.name || "旁白"),
            expectedRoleType: "narrator",
            plan: null,
            currentEventDigest: eventView.currentEventDigest,
            eventDigestWindow: eventView.eventDigestWindow,
            eventDigestWindowText: eventView.eventDigestWindowText,
          }));
        }
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
      if (sessionId) {
        const eventView = readDefaultRuntimeEventViewState(state);
        return res.status(200).send(success({
          sessionId,
          status: "active",
          chapterId: Number(chapter.id || 0),
          expectedRole: String(rolePair.narratorRole.name || "旁白"),
          expectedRoleType: "narrator",
          plan: buildPresetPlan(openingMessage, {
            awaitUser: false,
            nextRole: String(rolePair.narratorRole.name || "旁白"),
            nextRoleType: "narrator",
          }),
          currentEventDigest: eventView.currentEventDigest,
          eventDigestWindow: eventView.eventDigestWindow,
          eventDigestWindowText: eventView.eventDigestWindowText,
        }));
      }
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
        }),
      })));
    } catch (e: any) {
      console.error("[story:introduction:error]", e);
      return res.status(500).send(error(e?.message || "生成开场白失败"));
    }
  },
);
