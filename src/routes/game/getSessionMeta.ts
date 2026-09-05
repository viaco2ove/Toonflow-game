/**
 * /game/getSessionMeta
 *
 * 仅返回会话元数据（state + world minimal + chapter + snapshot 元数据），不拉 messages。
 * 用于：
 *   - refreshCurrentSession：不重新拉历史消息
 *   - debug 场景
 *   - 任何"我已经知道 messages，只需要当前运行态"的调用
 *
 * 与 /game/getSession 的区别：
 *   - /game/getSession 走 NDJSON 流式（先发 meta，再逐条 message，最后 done）
 *   - /game/getSessionMeta 是单 envelope 响应，只发 meta
 */
import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  getGameDb,
  normalizeChapterOutput,
  readDefaultRuntimeEventViewState,
  normalizeRolePair,
  normalizeSessionState,
  normalizeWorldOutput,
  toJsonText,
} from "@/lib/gameEngine";
import { ensureWorldRolesWithAiParameterCards } from "@/lib/roleParameterCard";
import {
  loadPublishedChapter,
  loadPublishedWorld,
} from "@/modules/game-runtime/services/publishedRuntime";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    sessionId: z.string(),
  }),
  async (req, res) => {
    try {
      const { sessionId } = req.body;
      const db = getGameDb();
      const currentUserId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(currentUserId) || currentUserId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }
      const sessionIdValue = String(sessionId || "").trim();

      const row = await db("t_gameSession").where({ sessionId: sessionIdValue, userId: currentUserId }).first();
      if (!row) {
        return res.status(404).send(error("会话不存在"));
      }

      const wpId = Number(row.worldPublishId || 0);
      let world = wpId > 0 ? await loadPublishedWorld(wpId, db) : null;
      if (!world) {
        world = await db("t_storyWorld as w")
          .leftJoin("t_project as p", "w.projectId", "p.id")
          .where("w.id", Number(row.worldId || 0))
          .select("w.*", "p.userId as ownerUserId")
          .first();
      }
      const ownerUserId = Number(world?.ownerUserId || 0);
      if (world) {
        void ensureWorldRolesWithAiParameterCards({
          userId: ownerUserId > 0 ? ownerUserId : currentUserId,
          world,
          persist: ownerUserId > 0 && ownerUserId === currentUserId,
        }).catch((asyncErr) => {
          console.warn("[getSessionMeta] async role parameter card generation failed", {
            sessionId: sessionIdValue,
            worldId: Number(world?.id || 0),
            userId: currentUserId,
            message: (asyncErr as any)?.message || String(asyncErr),
          });
        });
      }

      const rolePair = normalizeRolePair(world?.playerRole, world?.narratorRole);
      const provisionalChapterId = Number(row.chapterId || 0) || null;
      const state = normalizeSessionState(
        row.stateJson,
        Number(row.worldId || 0),
        provisionalChapterId,
        rolePair,
        world,
      );
      const activeChapterId = Number(state.chapterId || provisionalChapterId || 0) || null;
      const eventView = readDefaultRuntimeEventViewState(state);

      const chapter = activeChapterId
        ? (wpId > 0
          ? await loadPublishedChapter(wpId, activeChapterId, db)
          : normalizeChapterOutput(await db("t_storyChapter").where({ id: activeChapterId }).first()))
        : null;

      const snapshot = await db("t_sessionStateSnapshot")
        .where({ sessionId: sessionIdValue })
        .orderBy("id", "desc")
        .first();

      // 修正 chapterTitle（与 getSession 流式路径一致）
      state.chapterId = activeChapterId || 0;
      state.chapterTitle = String(chapter?.title || "").trim() || String(state.chapterTitle || "").trim();

      const meta = {
        sessionId: String(row.sessionId || ""),
        worldId: Number(row.worldId || 0),
        projectId: Number(row.projectId || 0) || null,
        chapterId: activeChapterId,
        title: String(row.title || ""),
        status: String(row.status || ""),
        contentVersion: String(row.contentVersion || ""),
        worldPublishId: Number(row.worldPublishId || 0) || null,
        worldVersion: Number(row.worldVersion || 0) || null,
        state,
        currentEventDigest: eventView.currentEventDigest,
        eventDigestWindow: eventView.eventDigestWindow,
        eventDigestWindowText: eventView.eventDigestWindowText,
        world: normalizeWorldOutput(world, { minimal: true }),
        chapter: normalizeChapterOutput(chapter),
        latestSnapshot: snapshot
          ? {
              id: Number(snapshot.id || 0),
              sessionId: String(snapshot.sessionId || ""),
              createTime: Number(snapshot.createTime || 0),
              reason: String(snapshot.reason || ""),
              round: Number(snapshot.round || 0),
            }
          : null,
      };
      res.status(200).send(success(meta));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);