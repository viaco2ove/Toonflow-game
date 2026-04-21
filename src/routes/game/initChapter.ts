import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  initSessionChapter,
  isSessionServiceError,
} from "@/modules/game-runtime/services/SessionService";
import u from "@/utils";

const router = express.Router();

/**
 * 显式初始化正式会话的下一章节。
 *
 * 用途：
 * - 当前一章已经结束时，前端必须先调用该接口；
 * - 该接口只负责切换运行态到下一章并装载章节事件图；
 * - 真正的下一章开场白/首轮编排仍由后续 `/game/orchestration` 单独触发。
 */
export default router.post(
  "/",
  validateFields({
    sessionId: z.string(),
    chapterId: z.number().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const result = await initSessionChapter(
        String(req.body.sessionId || ""),
        Number(req.body.chapterId || 0) || null,
      );
      return res.status(200).send(success(result));
    } catch (err) {
      if (isSessionServiceError(err)) {
        return res.status(err.status).send(error(err.message));
      }
      return res.status(500).send(error(u.error(err).message));
    }
  },
);
