import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  applyOrchestrateOptionForSession,
  isSessionServiceError,
} from "@/modules/game-runtime/services/SessionService";

const router = express.Router();

/**
 * 应用编排选项接口。
 *
 * 点击某条编排选项后，把 { role, motive } 直接构造成 pending narrative plan，
 * 跳过编排师，前端随后走 /game/streamlines 调角色发言器生成台词。
 *
 * 入参：{ sessionId: string, role: string, motive: string }
 * 出参：SessionNarrativePlanResult
 */
export default router.post(
  "/",
  validateFields({
    sessionId: z.string().min(1),
    role: z.string().min(1),
    motive: z.string().min(1),
  }),
  async (req, res) => {
    const sessionId = String(req.body.sessionId || "").trim();
    const role = String(req.body.role || "").trim();
    const motive = String(req.body.motive || "").trim();
    if (!sessionId || !role || !motive) {
      return res.status(400).send(error("参数不完整"));
    }
    try {
      const result = await applyOrchestrateOptionForSession(sessionId, role, motive);
      return res.status(200).send(success(result));
    } catch (err) {
      if (isSessionServiceError(err)) {
        return res.status(err.status).send(error(err.message));
      }
      console.error("[applyOrchestrateOption] 失败", err);
      return res.status(500).send(error(String((err as Error)?.message || "应用编排选项失败")));
    }
  },
);