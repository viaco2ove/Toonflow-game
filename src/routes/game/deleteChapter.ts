import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { getGameDb, nowTs } from "@/lib/gameEngine";

const router = express.Router();

/**
 * Reorders the remaining chapters of a story after one chapter is removed.
 * Keeping sort values compact makes the editor tabs and "next chapter" fallback predictable.
 */
async function normalizeRemainingChapterSorts(trx: any, worldId: number) {
  const rows = await trx("t_storyChapter")
    .where({ worldId })
    .orderBy("sort", "asc")
    .orderBy("id", "asc")
    .select("id");
  const now = nowTs();
  for (let index = 0; index < rows.length; index += 1) {
    // SQLite has no bulk update with row_number here, so update each small chapter row explicitly.
    await trx("t_storyChapter").where({ id: Number(rows[index].id || 0) }).update({
      sort: index + 1,
      updateTime: now,
    });
  }
}

export default router.post(
  "/",
  validateFields({
    chapterId: z.number(),
  }),
  async (req, res) => {
    try {
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }

      const chapterId = Number(req.body.chapterId || 0);
      if (!Number.isFinite(chapterId) || chapterId <= 0) {
        return res.status(400).send(error("chapterId 无效"));
      }

      const db = getGameDb();
      const chapter = await db("t_storyChapter as c")
        .leftJoin("t_storyWorld as w", "c.worldId", "w.id")
        .leftJoin("t_project as p", "w.projectId", "p.id")
        .where("c.id", chapterId)
        .where("p.userId", userId)
        .select("c.id", "c.worldId")
        .first();

      if (!chapter) {
        return res.status(404).send(error("未找到章节"));
      }

      const worldId = Number(chapter.worldId || 0);
      await db.transaction(async (trx: any) => {
        const sessionRows = await trx("t_gameSession").where({ chapterId }).select("sessionId");
        const sessionIds = sessionRows.map((item: any) => String(item.sessionId || "").trim()).filter(Boolean);

        if (sessionIds.length) {
          // 删除章节后，对应游玩/调试会话已无法继续，需一起清理其消息与快照。
          await trx("t_sessionMessage").whereIn("sessionId", sessionIds).delete();
          await trx("t_sessionStateSnapshot").whereIn("sessionId", sessionIds).delete();
        }

        await trx("t_gameSession").where({ chapterId }).delete();
        await trx("t_chapterTask").where({ chapterId }).delete();
        await trx("t_chapterTrigger").where({ chapterId }).delete();
        await trx("t_storyChapter").where({ id: chapterId }).delete();
        await normalizeRemainingChapterSorts(trx, worldId);
      });

      return res.status(200).send(success(true, "删除章节成功"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || "删除章节失败");
      return res.status(500).send(error(message));
    }
  },
);
