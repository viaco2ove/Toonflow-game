import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { getGameDb, normalizeChapterOutput } from "@/lib/gameEngine";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    worldId: z.number().optional().nullable(),
    chapterId: z.number().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const { worldId, chapterId } = req.body;
      const db = getGameDb();

      const chapterIdNum = Number(chapterId);
      const worldIdNum = Number(worldId);

      if (Number.isFinite(chapterIdNum) && chapterIdNum > 0) {
        const row = await db("t_storyChapter").where({ id: chapterIdNum }).first();
        if (!row) return res.status(404).send(error("未找到章节"));
        return res.status(200).send(success(normalizeChapterOutput(row)));
      }

      if (!Number.isFinite(worldIdNum) || worldIdNum <= 0) {
        return res.status(400).send(error("worldId 不能为空"));
      }

      const rows = await db("t_storyChapter").where({ worldId: worldIdNum }).orderBy("sort", "asc").orderBy("id", "asc");
      res.status(200).send(success(rows.map((item: any) => normalizeChapterOutput(item))));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
