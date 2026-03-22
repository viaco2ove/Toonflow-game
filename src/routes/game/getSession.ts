import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  getGameDb,
  normalizeChapterOutput,
  normalizeMessageOutput,
  normalizeWorldOutput,
  parseJsonSafe,
} from "@/lib/gameEngine";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    sessionId: z.string(),
    messageLimit: z.number().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const { sessionId, messageLimit } = req.body;
      const db = getGameDb();
      const sessionIdValue = String(sessionId || "").trim();

      const row = await db("t_gameSession").where({ sessionId: sessionIdValue }).first();
      if (!row) {
        return res.status(404).send(error("会话不存在"));
      }

      const state = parseJsonSafe(row.stateJson, {});
      const messageLimitNum = Number(messageLimit);
      const limit = Number.isFinite(messageLimitNum) && messageLimitNum > 0 ? Math.min(messageLimitNum, 200) : 50;

      const world = await db("t_storyWorld").where({ id: Number(row.worldId || 0) }).first();
      const chapter = row.chapterId ? await db("t_storyChapter").where({ id: Number(row.chapterId) }).first() : null;
      const snapshot = await db("t_sessionStateSnapshot").where({ sessionId: sessionIdValue }).orderBy("id", "desc").first();
      const rawMessages = await db("t_sessionMessage").where({ sessionId: sessionIdValue }).orderBy("id", "desc").limit(limit);
      const messages = rawMessages.reverse().map((item: any) => normalizeMessageOutput(item));

      res.status(200).send(
        success({
          ...row,
          state,
          world: normalizeWorldOutput(world),
          chapter: normalizeChapterOutput(chapter),
          latestSnapshot: snapshot
            ? {
                ...snapshot,
                state: parseJsonSafe(snapshot.stateJson, {}),
              }
            : null,
          messages,
        }),
      );
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
