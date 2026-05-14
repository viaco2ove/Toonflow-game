import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { buildChapterRuntimeOutline, normalizeChapterFields } from "@/lib/gameEngine";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    openingRole: z.string().optional().nullable(),
    openingText: z.string().optional().nullable(),
    content: z.string().optional().nullable(),
    entryCondition: z.any().optional().nullable(),
    completionCondition: z.any().optional().nullable(),
    runtimeOutline: z.any().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const {
        openingRole,
        openingText,
        content,
        entryCondition,
        completionCondition,
        runtimeOutline,
      } = req.body;
      const normalizedChapter = normalizeChapterFields({
        content,
        openingRole,
        openingText,
        entryCondition,
        completionCondition,
      });
      const outline = buildChapterRuntimeOutline({
        openingRole: normalizedChapter.openingRole,
        openingText: normalizedChapter.openingText,
        content: normalizedChapter.content,
        completionCondition: normalizedChapter.completionCondition,
        runtimeOutline,
      });
      res.status(200).send(success(outline, "生成章节运行模板成功"));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
