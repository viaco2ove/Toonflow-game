import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  createGameSessionId,
  extractFirstChapterDialogueLine,
  getGameDb,
  normalizeChapterOutput,
  parseJsonSafe,
  normalizeRolePair,
  normalizeSessionState,
  nowTs,
  readDefaultRuntimeEventViewState,
  toJsonText,
} from "@/lib/gameEngine";
import { ensureWorldRolesWithAiParameterCards } from "@/lib/roleParameterCard";
import {
  buildChapterInitialSnapshotVersion,
  prewarmChapterInitialSnapshotCache,
  readChapterInitialSnapshotCache,
} from "@/lib/sessionInitialSnapshot";
import {
  applyMemoryResultToState,
  summarizeNarrativePlan,
  triggerStoryMemoryRefreshInBackground,
  runNarrativePlan,
} from "@/modules/game-runtime/engines/NarrativeOrchestrator";
import { 
  persistSessionMessageRevisitData,
  orchestrateSessionTurn,
} from "@/modules/game-runtime/services/SessionService";
import {
  initializeChapterProgressForState,
  syncChapterProgressWithRuntime,
} from "@/modules/game-runtime/engines/ChapterProgressEngine";
import u from "@/utils";

const router = express.Router();

function isPublishedWorld(row: any): boolean {
  if (!row) return false;
  const publishStatus = String(row.publishStatus || "").trim();
  if (publishStatus === "published") return true;
  const settings = parseJsonSafe<Record<string, any>>(row.settings, {});
  return String(settings?.publishStatus || "").trim() === "published";
}

function normalizeSessionRow(row: any) {
  if (!row) return null;
  return {
    ...row,
    state: parseJsonSafe(row.stateJson, {}),
  };
}

function buildContentVersion(world: any, chapter: any, now: number): string {
  const snapshotVersion = buildChapterInitialSnapshotVersion(world, chapter);
  if (snapshotVersion) {
    return snapshotVersion;
  }
  const worldVersion = Number(world?.updateTime || world?.createTime || now);
  return `w:${Number(world?.id || 0)}@${worldVersion}`;
}

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
}) | null) {
  if (!plan) return null;
  return {
    role: String(plan.role || "").trim(),
    roleType: String(plan.roleType || "").trim(),
    motive: String(plan.motive || "").trim(),
    awaitUser: Boolean(plan.awaitUser),
    nextRole: String(plan.nextRole || "").trim(),
    nextRoleType: String(plan.nextRoleType || "").trim(),
    source: plan.source === "fallback" ? "fallback" : plan.source === "rule" ? "rule" : "ai",
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
      return plan.source === "rule" ? "rule_orchestrator" : plan.source === "fallback" ? "fallback_orchestrator" : "ai_orchestrator";
    })(),
  };
}

/**
 * 统一的游玩模式初始化接口
 * 合并了 startSession + orchestration 两个接口，减少前端请求次数
 */
export default router.post(
  "/",
  validateFields({
    worldId: z.number(),
    chapterId: z.number().optional().nullable(),
    projectId: z.number().optional().nullable(),
    title: z.string().optional().nullable(),
    initialState: z.any().optional().nullable(),
    skipOpening: z.boolean().optional().nullable(), // 是否跳过开场白
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

      const skipOpening = Boolean(req.body.skipOpening);
      const chapterId = Number(req.body.chapterId || 0);

      // 1. 获取故事世界
      const world = await db("t_storyWorld")
        .where({ id: worldId })
        .first();
      if (!world) {
        return res.status(404).send(error("未找到故事"));
      }

      if (!isPublishedWorld(world)) {
        return res.status(403).send(error("故事未发布，无法开始游玩"));
      }

      // 2. 获取章节
      let chapter: any = null;
      if (chapterId > 0) {
        chapter = await db("t_storyChapter").where({ id: chapterId, worldId }).first();
      }
      if (!chapter) {
        chapter = await db("t_storyChapter").where({ worldId }).orderBy("sort", "asc").orderBy("id", "asc").first();
      }
      chapter = normalizeChapterOutput(chapter);
      if (!chapter) {
        return res.status(404).send(error("当前没有章节可游玩"));
      }

      // 3. 创建 session
      const now = nowTs();
      const sessionId = createGameSessionId();
      const rolePair = normalizeRolePair(world.playerRole, world.narratorRole);

      // 4. 初始化状态
      const snapshotCache = readChapterInitialSnapshotCache({ world, chapter });
      let state: Record<string, any>;
      if (snapshotCache) {
        state = parseJsonSafe<Record<string, any>>(snapshotCache.stateJson, {});
      } else {
        state = normalizeSessionState(
          req.body.initialState || {},
          worldId,
          Number(chapter.id || 0),
          rolePair,
          world,
        );
        void prewarmChapterInitialSnapshotCache({
          userId,
          world,
          chapter,
        });
      }

      // 应用初始状态
      initializeChapterProgressForState(state, chapter);
      syncChapterProgressWithRuntime(state, chapter);

      // 5. 创建 session 记录
      const contentVersion = buildContentVersion(world, chapter, now);
      const sessionTitle = String(req.body.title || "").trim() || `游玩 - ${world.title || "未命名故事"}`;
      
      await db("t_gameSession").insert({
        sessionId,
        userId,
        worldId,
        projectId: req.body.projectId || null,
        title: sessionTitle,
        stateJson: toJsonText(state, {}),
        contentVersion,
        createTime: now,
        updateTime: now,
      });

      // 6. initStory 只负责创建正式会话和初始化运行态，不再内嵌开场白/第一章编排。
      await db("t_gameSession").where({ sessionId }).update({
        stateJson: toJsonText(state, {}),
        updateTime: nowTs(),
      });

      // 7. 返回初始化结果，后续由 /game/introduction 和 /game/orchestration 分步推进。
      const eventView = readDefaultRuntimeEventViewState(state);
      const result = {
        sessionId,
        worldId,
        chapterId: Number(chapter.id || 0),
        chapterTitle: String(chapter.title || ""),
        state,
        opening: null,
        firstChapter: null,
        currentEventDigest: eventView.currentEventDigest,
        eventDigestWindow: eventView.eventDigestWindow,
        eventDigestWindowText: eventView.eventDigestWindowText,
      };

      return res.status(200).send(success(result));
    } catch (e: any) {
      console.error("[game:initStory:error]", e);
      return res.status(500).send(error(e?.message || "初始化游玩失败"));
    }
  },
);
