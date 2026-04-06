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
  cacheAndBuildDebugStateSnapshot,
  debugMessageSchema,
  loadCachedDebugRuntimeState,
  syncDebugChapterRuntime,
  isDebugFreePlotActive,
  cacheDebugRuntimeState,
} from "./debugRuntimeShared";

const router = express.Router();

/**
 * 调试模式初始化接口
 * 只负责初始化调试运行态；开场白与第一章首轮计划由独立接口生成。
 */
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
      
      // 1. 获取故事世界
      const world = await db("t_storyWorld as w")
        .leftJoin("t_project as p", "w.projectId", "p.id")
        .where("w.id", worldId)
        .where("p.userId", userId)
        .select("w.*")
        .first();
      if (!world) {
        return res.status(404).send(error("未找到故事"));
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
        return res.status(404).send(error("当前没有章节可调试"));
      }
      // 3. 初始化状态
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

      // 4. 缓存状态
      cacheDebugRuntimeState(state, userId, worldId, undefined);

      // 5. 构建返回结果
      const stateSnapshot = cacheAndBuildDebugStateSnapshot({
        userId,
        worldId,
        state,
      });

      const result = {
        worldId,
        chapterId: Number(chapter.id || 0),
        chapterTitle: String(chapter.title || ""),
        state: stateSnapshot,
        endDialog: null,
        endDialogDetail: "",
        currentEventDigest: stateSnapshot.currentEventDigest || null,
        eventDigestWindow: Array.isArray(stateSnapshot.eventDigestWindow) ? stateSnapshot.eventDigestWindow : [],
        eventDigestWindowText: String(stateSnapshot.eventDigestWindowText || ""),
      };

      return res.status(200).send(success(result));
    } catch (e: any) {
      console.error("[debug:initDebug:error]", e);
      return res.status(500).send(error(e?.message || "初始化调试失败"));
    }
  },
);
