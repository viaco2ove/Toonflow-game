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
      const currentUserId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(currentUserId) || currentUserId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }

      const chapterIdNum = Number(chapterId);
      const worldIdNum = Number(worldId);

      if (Number.isFinite(chapterIdNum) && chapterIdNum > 0) {
        const row = await db("t_storyChapter as c")
          .leftJoin("t_storyWorld as w", "c.worldId", "w.id")
          .leftJoin("t_project as p", "w.projectId", "p.id")
          .where("c.id", chapterIdNum)
          .where("p.userId", currentUserId)
          .select("c.*")
          .first();
        if (!row) return res.status(404).send(error("未找到章节"));
        return res.status(200).send(success(normalizeChapterOutput(row)));
      }

      if (!Number.isFinite(worldIdNum) || worldIdNum <= 0) {
        return res.status(400).send(error("worldId 不能为空"));
      }

      const world = await db("t_storyWorld as w")
        .leftJoin("t_project as p", "w.projectId", "p.id")
        .where("w.id", worldIdNum)
        .where("p.userId", currentUserId)
        .select("w.id")
        .first();
      if (!world) {
        return res.status(403).send(error("无权访问该世界"));
      }

      const rows = await db("t_storyChapter").where({ worldId: worldIdNum }).orderBy("sort", "asc").orderBy("id", "asc");
      res.status(200).send(success(rows.map((item: any) => normalizeChapterOutput(item))));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
