import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  createGameSessionId,
  getGameDb,
  normalizeChapterOutput,
  parseJsonSafe,
  normalizeRolePair,
  normalizeSessionState,
  nowTs,
  toJsonText,
} from "@/lib/gameEngine";
import {
  allowPlayerTurn,
  applyMemoryResultToState,
  resolveOpeningMessage,
  runStoryMemoryManager,
  RuntimeMessageInput,
} from "@/modules/game-runtime/engines/NarrativeOrchestrator";
import u from "@/utils";

const router = express.Router();

function normalizeSessionRow(row: any) {
  if (!row) return null;
  return {
    ...row,
    state: parseJsonSafe(row.stateJson, {}),
  };
}

function buildContentVersion(world: any, chapter: any, now: number): string {
  const worldVersion = Number(world?.updateTime || world?.createTime || now);
  const chapterVersion = Number(chapter?.updateTime || chapter?.createTime || 0);
  const worldId = Number(world?.id || 0);
  const chapterId = Number(chapter?.id || 0);

  if (chapterId > 0 && chapterVersion > 0) {
    return `w:${worldId}@${worldVersion};c:${chapterId}@${chapterVersion}`;
  }
  return `w:${worldId}@${worldVersion}`;
}

export default router.post(
  "/",
  validateFields({
    worldId: z.number(),
    chapterId: z.number().optional().nullable(),
    projectId: z.number().optional().nullable(),
    title: z.string().optional().nullable(),
    initialState: z.any().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const { worldId, chapterId, projectId, title, initialState } = req.body;
      const currentUserId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(currentUserId) || currentUserId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }
      const db = getGameDb();
      const now = nowTs();

      const world = await db("t_storyWorld as w")
        .leftJoin("t_project as p", "w.projectId", "p.id")
        .where("w.id", worldId)
        .where("p.userId", currentUserId)
        .select("w.*")
        .first();
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
      chapter = normalizeChapterOutput(chapter);

      const existingSession = await db("t_gameSession")
        .where({
          worldId: Number(worldId),
          userId: currentUserId,
        })
        .orderBy("updateTime", "desc")
        .orderBy("id", "desc")
        .first();
      if (existingSession) {
        return res.status(200).send(success(normalizeSessionRow(existingSession), "已继续现有会话"));
      }

      const rolePair = normalizeRolePair(world.playerRole, world.narratorRole);
      const state = normalizeSessionState(initialState, worldId, chapter ? Number(chapter.id) : null, rolePair);
      const openingMessage = chapter ? resolveOpeningMessage(world, chapter) : null;
      const openingMessages: RuntimeMessageInput[] = [];
      if (chapter && openingMessage) {
        const openingRuntimeMessage: RuntimeMessageInput = {
          role: String(openingMessage.role || state.narrator?.name || "旁白"),
          roleType: String(openingMessage.roleType || "narrator"),
          eventType: String(openingMessage.eventType || "on_enter_chapter"),
          content: String(openingMessage.content || `进入章节《${String(chapter.title || "未命名章节")}》`),
          createTime: now,
        };
        openingMessages.push(openingRuntimeMessage);
        allowPlayerTurn(
          state,
          world,
          String(openingRuntimeMessage.roleType || "narrator"),
          String(openingRuntimeMessage.role || state.narrator?.name || "旁白"),
        );
        const memory = await runStoryMemoryManager({
          userId: currentUserId,
          world,
          chapter,
          state,
          recentMessages: openingMessages,
        });
        applyMemoryResultToState(state, memory);
      }

      const sessionId = createGameSessionId();
      const payload = {
        sessionId,
        worldId,
        projectId: Number.isFinite(Number(projectId)) ? Number(projectId) : Number(world.projectId || 0),
        chapterId: chapter ? Number(chapter.id) : null,
        contentVersion: buildContentVersion(world, chapter, now),
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

      if (chapter && openingMessages.length > 0) {
        await db("t_sessionMessage").insert(
          openingMessages.map((message) => ({
            sessionId,
            role: String(message.role || state.narrator?.name || "旁白"),
            roleType: String(message.roleType || "narrator"),
            content: String(message.content || ""),
            eventType: String(message.eventType || "on_orchestrated_reply"),
            meta: toJsonText({ chapterId: Number(chapter.id) }, {}),
            createTime: Number(message.createTime || now),
          })),
        );
      }

      const row = await db("t_gameSession").where({ sessionId }).first();
      res.status(200).send(success(normalizeSessionRow(row), "开始游玩会话成功"));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
