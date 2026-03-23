import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { getGameDb, normalizeMessageOutput } from "@/lib/gameEngine";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    sessionId: z.string(),
    limit: z.number().optional().nullable(),
    beforeId: z.number().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const { sessionId, limit, beforeId } = req.body;
      const db = getGameDb();
      const currentUserId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(currentUserId) || currentUserId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }
      const sessionIdValue = String(sessionId || "").trim();
      const session = await db("t_gameSession").where({ sessionId: sessionIdValue, userId: currentUserId }).first("id");
      if (!session) {
        return res.status(404).send(error("会话不存在"));
      }

      const limitNum = Number(limit);
      const beforeIdNum = Number(beforeId);
      const safeLimit = Number.isFinite(limitNum) && limitNum > 0 ? Math.min(limitNum, 200) : 50;

      let query = db("t_sessionMessage").where({ sessionId: sessionIdValue });
      if (Number.isFinite(beforeIdNum) && beforeIdNum > 0) {
        query = query.andWhere("id", "<", beforeIdNum);
      }

      const rows = await query.orderBy("id", "desc").limit(safeLimit);
      const list = rows.reverse().map((item: any) => normalizeMessageOutput(item));
      res.status(200).send(success(list));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
