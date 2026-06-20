import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  generatePlayTips,
  isSessionServiceError,
} from "@/modules/game-runtime/services/SessionService";

const router = express.Router();

/**
 * 玩家行动提示器接口。
 *
 * 每次点击 play-tip-fab 都会调用一次，返回 3 条第一人称的可执行行动提示。
 * 失败时由 service 层兜底返回 3 条中性文案，前端永远拿得到非空数组。
 *
 * 入参：{ sessionId: string }
 * 出参：{ tips: string[], source: "ai" | "fallback", latencyMs: number }
 */
export default router.post(
  "/",
  validateFields({
    sessionId: z.string().min(1),
  }),
  async (req, res) => {
    const sessionId = String(req.body.sessionId || "").trim();
    if (!sessionId) {
      return res.status(400).send(error("sessionId 不能为空"));
    }
    try {
      const result = await generatePlayTips(sessionId);
      return res.status(200).send(success(result));
    } catch (err) {
      if (isSessionServiceError(err)) {
        return res.status(err.status).send(error(err.message));
      }
      console.error("[getPlayTips] 失败", err);
      return res.status(500).send(error(String((err as Error)?.message || "获取提示失败")));
    }
  },
);
