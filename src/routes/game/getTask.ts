import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { getGameDb, normalizeTaskOutput } from "@/lib/gameEngine";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    chapterId: z.number(),
  }),
  async (req, res) => {
    try {
      const { chapterId } = req.body;
      const db = getGameDb();

      const rows = await db("t_chapterTask").where({ chapterId }).orderBy("sort", "asc").orderBy("id", "asc");
      res.status(200).send(success(rows.map((item: any) => normalizeTaskOutput(item))));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
