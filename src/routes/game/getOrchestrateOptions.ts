import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  generateOrchestrateOptionsForSession,
  isSessionServiceError,
} from "@/modules/game-runtime/services/SessionService";

const router = express.Router();

/**
 * 编排选项生成器接口。
 *
 * 每次点击 orchestrate-tio-fab 调用一次，返回 3 条编排选项 [{ role, motive }]。
 * refresh=true 表示"换一换"，温度略高避免重复。
 *
 * 入参：{ sessionId: string, refresh?: boolean }
 * 出参：{ options: Array<{ role, motive }>, source: "ai" | "fallback" }
 */
export default router.post(
  "/",
  validateFields({
    sessionId: z.string().min(1),
    refresh: z.boolean().optional(),
  }),
  async (req, res) => {
    const sessionId = String(req.body.sessionId || "").trim();
    const refresh = Boolean(req.body.refresh);
    if (!sessionId) {
      return res.status(400).send(error("sessionId 不能为空"));
    }
    try {
      const result = await generateOrchestrateOptionsForSession(sessionId, refresh);
      return res.status(200).send(success(result));
    } catch (err) {
      if (isSessionServiceError(err)) {
        return res.status(err.status).send(error(err.message));
      }
      console.error("[getOrchestrateOptions] 失败", err);
      return res.status(500).send(error(String((err as Error)?.message || "获取编排选项失败")));
    }
  },
);
