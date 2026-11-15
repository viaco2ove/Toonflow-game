import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { interruptSessionSpeech } from "@/modules/game-runtime/services/SessionService";

const router = express.Router();

/**
 * 插嘴：用户在旁白/NPC 连续推进时主动要求发言。
 * 把会话的"连续未涉及用户发言"计数顶到编排师兜底阈值，
 * 下一轮编排会强制安排用户发言（awaitUser=true → 发言权交还用户）。
 */
router.post("/", validateFields({
  sessionId: z.string().min(1),
}), async (req: any, res: any) => {
  try {
    const currentUserId = Number(req?.user?.id || 0);
    if (!Number.isFinite(currentUserId) || currentUserId <= 0) {
      return res.status(401).send(error("用户未登录"));
    }
    const sessionId = String(req.body.sessionId || "").trim();
    const result = await interruptSessionSpeech(sessionId, currentUserId);
    res.send(success(result));
  } catch (err: any) {
    const status = Number(err?.status || err?.statusCode || 0);
    if (status > 0) {
      return res.status(status).send(error(err?.message || String(err)));
    }
    res.status(500).send(error(err?.message || String(err)));
  }
});

export default router;
