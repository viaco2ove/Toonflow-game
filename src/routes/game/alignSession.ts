import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  alignSessionWithAi,
  isSessionServiceError,
} from "@/modules/game-runtime/services/SessionService";

const router = express.Router();

/**
 * 方向2：AI 智能对齐接口。
 *
 * 前端"聊过"面板的"智能对齐"按钮调用。
 * 流程：确定性对齐 -> 若有 phase 改名歧义，调 AI agent 语义匹配 + 重生成 eventSummary -> 写回 session。
 *
 * 入参：{ sessionId: string }
 * 出参：{ ok: boolean, report: ProgressAlignReport | null, source: "ai"|"deterministic"|"noop", message: string }
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
    const userId = Number((req as any)?.user?.id || 0);
    try {
      const result = await alignSessionWithAi(sessionId, userId);
      return res.status(200).send(success(result));
    } catch (err) {
      if (isSessionServiceError(err)) {
        return res.status(err.status).send(error(err.message));
      }
      console.error("[alignSession] 失败", err);
      return res.status(500).send(error(String((err as Error)?.message || "智能对齐失败")));
    }
  },
);