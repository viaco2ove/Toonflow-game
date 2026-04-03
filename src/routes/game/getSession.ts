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
  normalizeMessageOutput,
  normalizeWorldOutput,
} from "@/lib/gameEngine";
import { ensureWorldRolesWithAiParameterCards } from "@/lib/roleParameterCard";
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
      const currentUserId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(currentUserId) || currentUserId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }
      const sessionIdValue = String(sessionId || "").trim();

      const row = await db("t_gameSession").where({ sessionId: sessionIdValue, userId: currentUserId }).first();
      if (!row) {
        return res.status(404).send(error("会话不存在"));
      }

      let world = await db("t_storyWorld as w")
        .leftJoin("t_project as p", "w.projectId", "p.id")
        .where("w.id", Number(row.worldId || 0))
        .select("w.*", "p.userId as ownerUserId")
        .first();
      const ownerUserId = Number(world?.ownerUserId || 0);
      if (world) {
        // 会话打开优先返回已保存的世界数据，缺卡补齐放后台做，避免继续聊时被慢模型阻塞。
        void ensureWorldRolesWithAiParameterCards({
          userId: ownerUserId > 0 ? ownerUserId : currentUserId,
          world,
          persist: ownerUserId > 0 && ownerUserId === currentUserId,
        }).catch((asyncErr) => {
          console.warn("[getSession] async role parameter card generation failed", {
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
      const messageLimitNum = Number(messageLimit);
      const limit = Number.isFinite(messageLimitNum) && messageLimitNum > 0 ? Math.min(messageLimitNum, 200) : 50;
      const eventView = readDefaultRuntimeEventViewState(state);

      const chapter = activeChapterId ? await db("t_storyChapter").where({ id: activeChapterId }).first() : null;
      const snapshot = await db("t_sessionStateSnapshot").where({ sessionId: sessionIdValue }).orderBy("id", "desc").first();
      const rawMessages = await db("t_sessionMessage").where({ sessionId: sessionIdValue }).orderBy("id", "desc").limit(limit);
      const messages = rawMessages.reverse().map((item: any) => normalizeMessageOutput(item));

      res.status(200).send(
        success({
          ...row,
          chapterId: activeChapterId,
          state,
          currentEventDigest: eventView.currentEventDigest,
          eventDigestWindow: eventView.eventDigestWindow,
          eventDigestWindowText: eventView.eventDigestWindowText,
          world: normalizeWorldOutput(world),
          chapter: normalizeChapterOutput(chapter),
          latestSnapshot: snapshot
            ? {
                ...snapshot,
                state: normalizeSessionState(
                  snapshot.stateJson,
                  Number(row.worldId || 0),
                  activeChapterId,
                  rolePair,
                  world,
                ),
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
