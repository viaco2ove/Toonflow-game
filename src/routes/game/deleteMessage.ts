import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { getGameDb, parseJsonSafe, toJsonText } from "@/lib/gameEngine";

const router = express.Router();

function normalizeStateForPlayerRetry(state: Record<string, any>, previousMessage: any | null) {
  const turnState = typeof state.turnState === "object" && state.turnState !== null
    ? { ...state.turnState }
    : {};
  const playerName = String(state.player?.name || "用户").trim() || "用户";
  turnState.canPlayerSpeak = true;
  turnState.expectedRoleType = "player";
  turnState.expectedRole = playerName;
  turnState.lastSpeakerRoleType = String(previousMessage?.roleType || "").trim();
  turnState.lastSpeaker = String(previousMessage?.role || "").trim();
  state.turnState = turnState;
  const round = Number(state.round || 0);
  state.round = Number.isFinite(round) ? Math.max(0, round - 1) : 0;
  if (Array.isArray(state.recentEvents) && state.recentEvents.length) {
    state.recentEvents = state.recentEvents.slice(0, -1);
  }
}

export default router.post(
  "/",
  validateFields({
    sessionId: z.string(),
    messageId: z.number(),
  }),
  async (req, res) => {
    try {
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }

      const sessionId = String(req.body.sessionId || "").trim();
      const messageId = Number(req.body.messageId || 0);
      if (!sessionId || !Number.isFinite(messageId) || messageId <= 0) {
        return res.status(400).send(error("参数不完整"));
      }

      const db = getGameDb();
      const session = await db("t_gameSession").where({ sessionId, userId }).first();
      if (!session) {
        return res.status(404).send(error("会话不存在"));
      }

      const targetMessage = await db("t_sessionMessage").where({ sessionId, id: messageId }).first();
      if (!targetMessage) {
        return res.status(404).send(error("消息不存在"));
      }

      const latestMessage = await db("t_sessionMessage").where({ sessionId }).orderBy("id", "desc").first();
      if (!latestMessage || Number(latestMessage.id || 0) !== messageId) {
        return res.status(409).send(error("当前只支持删除最后一条台词"));
      }
      if (String(targetMessage.roleType || "").trim() !== "player") {
        return res.status(409).send(error("当前只支持删除最后一条玩家台词"));
      }

      const previousMessage = await db("t_sessionMessage")
        .where({ sessionId })
        .andWhere("id", "<", messageId)
        .orderBy("id", "desc")
        .first();

      const state = parseJsonSafe<Record<string, any>>(session.stateJson, {});
      normalizeStateForPlayerRetry(state, previousMessage);

      await db.transaction(async (trx: any) => {
        await trx("t_sessionMessage").where({ sessionId, id: messageId }).delete();
        await trx("t_gameSession")
          .where({ sessionId, userId })
          .update({
            stateJson: toJsonText(state, {}),
            updateTime: Date.now(),
          });
      });

      return res.status(200).send(success(true, "删除台词成功"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || "删除台词失败");
      return res.status(500).send(error(message));
    }
  },
);
