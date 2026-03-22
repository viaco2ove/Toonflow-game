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

      const limitNum = Number(limit);
      const beforeIdNum = Number(beforeId);
      const safeLimit = Number.isFinite(limitNum) && limitNum > 0 ? Math.min(limitNum, 200) : 50;

      let query = db("t_sessionMessage").where({ sessionId: String(sessionId || "").trim() });
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
