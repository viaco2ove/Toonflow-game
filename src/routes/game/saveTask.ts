import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  getGameDb,
  normalizeTaskOutput,
  nowTs,
  toJsonText,
} from "@/lib/gameEngine";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    taskId: z.number().optional().nullable(),
    chapterId: z.number(),
    parentTaskId: z.number().optional().nullable(),
    title: z.string(),
    taskType: z.enum(["main", "side", "hidden"]).optional().nullable(),
    goalType: z.string().optional().nullable(),
    successCondition: z.any().optional().nullable(),
    failCondition: z.any().optional().nullable(),
    rewardAction: z.any().optional().nullable(),
    sort: z.number().optional().nullable(),
    status: z.string().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const {
        taskId,
        chapterId,
        parentTaskId,
        title,
        taskType,
        goalType,
        successCondition,
        failCondition,
        rewardAction,
        sort,
        status,
      } = req.body;

      const db = getGameDb();
      const now = nowTs();

      const chapter = await db("t_storyChapter").where({ id: chapterId }).first();
      if (!chapter) {
        return res.status(404).send(error("chapterId 不存在"));
      }

      const taskIdNum = Number(taskId);
      const sortNum = Number(sort);
      const payload = {
        chapterId,
        parentTaskId: Number.isFinite(Number(parentTaskId)) ? Number(parentTaskId) : null,
        title: String(title || "").trim(),
        taskType: String(taskType || "main").trim(),
        goalType: String(goalType || "dialogue").trim(),
        successCondition: toJsonText(successCondition, null),
        failCondition: toJsonText(failCondition, null),
        rewardAction: toJsonText(rewardAction, null),
        sort: Number.isFinite(sortNum) ? sortNum : 0,
        status: String(status || "todo").trim() || "todo",
        updateTime: now,
      };

      let existed: any = null;
      let id = 0;
      if (Number.isFinite(taskIdNum) && taskIdNum > 0) {
        existed = await db("t_chapterTask").where({ id: taskIdNum }).first();
      }

      if (existed?.id) {
        id = Number(existed.id);
        await db("t_chapterTask").where({ id }).update(payload);
      } else {
        let nextSort = payload.sort;
        if (!nextSort) {
          const maxSortRow = await db("t_chapterTask").where({ chapterId }).max({ maxSort: "sort" }).first();
          nextSort = Number((maxSortRow as any)?.maxSort || 0) + 1;
        }
        const insertResult = await db("t_chapterTask").insert({
          ...payload,
          sort: nextSort,
          createTime: now,
        });
        id = Number(Array.isArray(insertResult) ? insertResult[0] : insertResult);
      }

      const row = await db("t_chapterTask").where({ id }).first();
      res.status(200).send(success(normalizeTaskOutput(row), existed ? "更新任务成功" : "创建任务成功"));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
