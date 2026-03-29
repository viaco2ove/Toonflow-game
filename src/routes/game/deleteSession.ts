import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { getGameDb } from "@/lib/gameEngine";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    sessionId: z.string(),
  }),
  async (req, res) => {
    try {
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }

      const sessionId = String(req.body.sessionId || "").trim();
      if (!sessionId) {
        return res.status(400).send(error("sessionId 不能为空"));
      }

      const db = getGameDb();
      const session = await db("t_gameSession")
        .where({ sessionId, userId })
        .select("id", "sessionId")
        .first();

      if (!session) {
        return res.status(404).send(error("未找到会话"));
      }

      await db.transaction(async (trx: any) => {
        await trx("t_sessionMessage").where({ sessionId }).delete();
        await trx("t_sessionStateSnapshot").where({ sessionId }).delete();
        await trx("t_gameSession").where({ sessionId, userId }).delete();
      });

      return res.status(200).send(success(true, "删除会话成功"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || "删除会话失败");
      return res.status(500).send(error(message));
    }
  },
);
