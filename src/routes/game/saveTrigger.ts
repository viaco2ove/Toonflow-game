import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  getGameDb,
  normalizeTriggerOutput,
  nowTs,
  toJsonText,
} from "@/lib/gameEngine";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    triggerId: z.number().optional().nullable(),
    chapterId: z.number(),
    triggerEvent: z.string().optional().nullable(),
    conditionExpr: z.any().optional().nullable(),
    actionExpr: z.any().optional().nullable(),
    enabled: z.boolean().optional().nullable(),
    sort: z.number().optional().nullable(),
    name: z.string().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const { triggerId, chapterId, triggerEvent, conditionExpr, actionExpr, enabled, sort, name } = req.body;
      const db = getGameDb();
      const now = nowTs();

      const chapter = await db("t_storyChapter").where({ id: chapterId }).first();
      if (!chapter) {
        return res.status(404).send(error("chapterId 不存在"));
      }

      const triggerIdNum = Number(triggerId);
      const sortNum = Number(sort);
      const payload = {
        chapterId,
        name: String(name || "未命名触发器").trim(),
        triggerEvent: String(triggerEvent || "on_message").trim() || "on_message",
        conditionExpr: toJsonText(conditionExpr, { type: "always" }),
        actionExpr: toJsonText(actionExpr, []),
        enabled: enabled === false ? 0 : 1,
        sort: Number.isFinite(sortNum) ? sortNum : 0,
        updateTime: now,
      };

      let existed: any = null;
      let id = 0;
      if (Number.isFinite(triggerIdNum) && triggerIdNum > 0) {
        existed = await db("t_chapterTrigger").where({ id: triggerIdNum }).first();
      }

      if (existed?.id) {
        id = Number(existed.id);
        await db("t_chapterTrigger").where({ id }).update(payload);
      } else {
        let nextSort = payload.sort;
        if (!nextSort) {
          const maxSortRow = await db("t_chapterTrigger").where({ chapterId }).max({ maxSort: "sort" }).first();
          nextSort = Number((maxSortRow as any)?.maxSort || 0) + 1;
        }
        const insertResult = await db("t_chapterTrigger").insert({
          ...payload,
          sort: nextSort,
          createTime: now,
        });
        id = Number(Array.isArray(insertResult) ? insertResult[0] : insertResult);
      }

      const row = await db("t_chapterTrigger").where({ id }).first();
      res.status(200).send(success(normalizeTriggerOutput(row), existed ? "更新触发器成功" : "创建触发器成功"));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
