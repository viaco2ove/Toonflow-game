import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { getGameDb } from "@/lib/gameEngine";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    worldId: z.number(),
  }),
  async (req, res) => {
    try {
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }

      const worldId = Number(req.body.worldId || 0);
      if (!Number.isFinite(worldId) || worldId <= 0) {
        return res.status(400).send(error("worldId 无效"));
      }

      const db = getGameDb();
      const world = await db("t_storyWorld as w")
        .leftJoin("t_project as p", "w.projectId", "p.id")
        .where("w.id", worldId)
        .where("p.userId", userId)
        .select("w.id")
        .first();

      if (!world) {
        return res.status(404).send(error("未找到故事"));
      }

      await db.transaction(async (trx: any) => {
        const chapterRows = await trx("t_storyChapter").where({ worldId }).select("id");
        const chapterIds = chapterRows.map((item: any) => Number(item.id || 0)).filter((id: number) => id > 0);

        if (chapterIds.length) {
          await trx("t_chapterTask").whereIn("chapterId", chapterIds).delete();
          await trx("t_chapterTrigger").whereIn("chapterId", chapterIds).delete();
        }

        const sessionRows = await trx("t_gameSession").where({ worldId }).select("sessionId");
        const sessionIds = sessionRows.map((item: any) => String(item.sessionId || "").trim()).filter(Boolean);

        if (sessionIds.length) {
          await trx("t_sessionMessage").whereIn("sessionId", sessionIds).delete();
          await trx("t_sessionStateSnapshot").whereIn("sessionId", sessionIds).delete();
        }

        await trx("t_gameSession").where({ worldId }).delete();
        await trx("t_storyChapter").where({ worldId }).delete();
        await trx("t_storyWorld").where({ id: worldId }).delete();
      });

      return res.status(200).send(success(true, "删除故事成功"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || "删除故事失败");
      return res.status(500).send(error(message));
    }
  },
);
