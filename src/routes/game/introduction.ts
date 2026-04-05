import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  getGameDb,
  normalizeChapterOutput,
  normalizeRolePair,
  normalizeSessionState,
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
    currentEventDigest: stateSnapshot.currentEventDigest || null,
    eventDigestWindow: Array.isArray(stateSnapshot.eventDigestWindow) ? stateSnapshot.eventDigestWindow : [],
    eventDigestWindowText: String(stateSnapshot.eventDigestWindowText || ""),
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

      const worldId = Number(req.body.worldId || 0);
      if (!worldId) {
        return res.status(400).send(error("worldId 不能为空"));
      }
      const chapterId = Number(req.body.chapterId || 0);
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
      const debugFreePlotActive = isDebugFreePlotActive(state);
      const effectiveChapter = buildEffectiveDebugChapter(chapter, debugFreePlotActive);
      syncDebugChapterRuntime(effectiveChapter, state);
      const openingMessage = buildOpeningRuntimeMessage(world, chapter, String(rolePair.narratorRole.name || "旁白"));
      setDebugOpeningTurnState(state, world, String(openingMessage.role || rolePair.narratorRole.name || "旁白"), String(openingMessage.roleType || "narrator"));
      if (!String(openingMessage.content || "").trim()) {
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
