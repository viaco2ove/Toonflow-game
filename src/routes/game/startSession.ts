import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  createGameSessionId,
  getGameDb,
  parseJsonSafe,
  normalizeRolePair,
  normalizeSessionState,
  nowTs,
  toJsonText,
} from "@/lib/gameEngine";
import u from "@/utils";

const router = express.Router();

function normalizeSessionRow(row: any) {
  if (!row) return null;
  return {
    ...row,
    state: parseJsonSafe(row.stateJson, {}),
  };
}

export default router.post(
  "/",
  validateFields({
    worldId: z.number(),
    chapterId: z.number().optional().nullable(),
    projectId: z.number().optional().nullable(),
    userId: z.number().optional().nullable(),
    title: z.string().optional().nullable(),
    initialState: z.any().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const { worldId, chapterId, projectId, userId, title, initialState } = req.body;
      const currentUserId = Number((req as any)?.user?.id || 0) || Number(userId || 0);
      if (!Number.isFinite(currentUserId) || currentUserId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }
      const db = getGameDb();
      const now = nowTs();

      const world = await db("t_storyWorld").where({ id: worldId }).first();
      if (!world) {
        return res.status(404).send(error("worldId 不存在，请先创建世界观"));
      }

      let chapter: any = null;
      const chapterIdNum = Number(chapterId);
      if (Number.isFinite(chapterIdNum) && chapterIdNum > 0) {
        chapter = await db("t_storyChapter").where({ id: chapterIdNum, worldId }).first();
      }
      if (!chapter) {
        chapter = await db("t_storyChapter").where({ worldId }).orderBy("sort", "asc").orderBy("id", "asc").first();
      }

      const rolePair = normalizeRolePair(world.playerRole, world.narratorRole);
      const state = normalizeSessionState(initialState, worldId, chapter ? Number(chapter.id) : null, rolePair);

      const sessionId = createGameSessionId();
      const payload = {
        sessionId,
        worldId,
        projectId: Number.isFinite(Number(projectId)) ? Number(projectId) : Number(world.projectId || 0),
        chapterId: chapter ? Number(chapter.id) : null,
        title: String(title || `${String(world.name || "世界")}-会话`).trim(),
        status: "active",
        stateJson: toJsonText(state, {}),
        userId: currentUserId,
        createTime: now,
        updateTime: now,
      };

      await db("t_gameSession").insert(payload);

      await db("t_sessionStateSnapshot").insert({
        sessionId,
        stateJson: payload.stateJson,
        reason: "session_start",
        round: Number(state.round || 0),
        createTime: now,
      });

      if (chapter) {
        await db("t_sessionMessage").insert({
          sessionId,
          role: String(state.narrator?.name || "旁白"),
          roleType: "narrator",
          content: `进入章节《${String(chapter.title || "未命名章节")}》`,
          eventType: "on_enter_chapter",
          meta: toJsonText({ chapterId: Number(chapter.id) }, {}),
          createTime: now,
        });
      }

      const row = await db("t_gameSession").where({ sessionId }).first();
      res.status(200).send(success(normalizeSessionRow(row), "开始游玩会话成功"));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
