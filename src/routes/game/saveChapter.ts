import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  getGameDb,
  normalizeChapterFields,
  normalizeChapterOutput,
  nowTs,
  toJsonText,
} from "@/lib/gameEngine";
import { prewarmChapterInitialSnapshotCache } from "@/lib/sessionInitialSnapshot";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    chapterId: z.number().optional().nullable(),
    worldId: z.number(),
    chapterKey: z.string().optional().nullable(),
    backgroundPath: z.string().optional().nullable(),
    openingRole: z.string().optional().nullable(),
    openingText: z.string().optional().nullable(),
    bgmPath: z.string().optional().nullable(),
    showCompletionCondition: z.boolean().optional().nullable(),
    title: z.string(),
    content: z.string().optional().nullable(),
    entryCondition: z.any().optional().nullable(),
    completionCondition: z.any().optional().nullable(),
    sort: z.number().optional().nullable(),
    status: z.string().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const {
        chapterId,
        worldId,
        chapterKey,
        backgroundPath,
        openingRole,
        openingText,
        bgmPath,
        showCompletionCondition,
        title,
        content,
        entryCondition,
        completionCondition,
        sort,
        status,
      } = req.body;
      const normalizedChapter = normalizeChapterFields({
        content,
        openingRole,
        openingText,
        entryCondition,
        completionCondition,
      });
      const db = getGameDb();
      const now = nowTs();
      const currentUserId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(currentUserId) || currentUserId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }

      const world = await db("t_storyWorld as w")
        .leftJoin("t_project as p", "w.projectId", "p.id")
        .where("w.id", worldId)
        .where("p.userId", currentUserId)
        .select("w.*")
        .first();
      if (!world) {
        return res.status(404).send(error("worldId 不存在，请先创建世界观"));
      }

      const chapterIdNum = Number(chapterId);
      const sortNum = Number(sort);
      const payload = {
        worldId,
        chapterKey: String(chapterKey || "").trim(),
        backgroundPath: String(backgroundPath || "").trim(),
        openingRole: normalizedChapter.openingRole,
        openingText: normalizedChapter.openingText,
        bgmPath: String(bgmPath || "").trim(),
        showCompletionCondition: showCompletionCondition ? 1 : 0,
        title: String(title || "").trim(),
        content: normalizedChapter.content,
        entryCondition: toJsonText(normalizedChapter.entryCondition, null),
        completionCondition: toJsonText(normalizedChapter.completionCondition, null),
        sort: Number.isFinite(sortNum) ? sortNum : 0,
        status: String(status || "draft").trim() || "draft",
        updateTime: now,
      };

      let id = 0;
      let existed: any = null;
      if (Number.isFinite(chapterIdNum) && chapterIdNum > 0) {
        existed = await db("t_storyChapter as c")
          .leftJoin("t_storyWorld as w", "c.worldId", "w.id")
          .leftJoin("t_project as p", "w.projectId", "p.id")
          .where("c.id", chapterIdNum)
          .where("p.userId", currentUserId)
          .select("c.*")
          .first();
      }

      if (existed?.id) {
        id = Number(existed.id);
        await db("t_storyChapter").where({ id }).update(payload);
      } else {
        let nextSort = payload.sort;
        if (!nextSort) {
          const maxSortRow = await db("t_storyChapter").where({ worldId }).max({ maxSort: "sort" }).first();
          nextSort = Number((maxSortRow as any)?.maxSort || 0) + 1;
        }
        const insertResult = await db("t_storyChapter").insert({
          ...payload,
          sort: nextSort,
          createTime: now,
        });
        id = Number(Array.isArray(insertResult) ? insertResult[0] : insertResult);
      }

      const row = await db("t_storyChapter").where({ id }).first();
      // 保存章节后预热该章节的初始快照，减少首次进入或切章时的同步等待。
      void prewarmChapterInitialSnapshotCache({
        userId: currentUserId,
        world: world,
        chapter: normalizeChapterOutput(row),
      }).catch((asyncErr) => {
        console.warn("[saveChapter] async initial snapshot prewarm failed", {
          worldId: Number(worldId || 0),
          chapterId: id,
          userId: currentUserId,
          message: (asyncErr as any)?.message || String(asyncErr),
        });
      });
      res.status(200).send(success(normalizeChapterOutput(row), existed ? "更新章节成功" : "创建章节成功"));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
