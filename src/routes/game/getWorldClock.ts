import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  getGameDb,
  parseJsonSafe,
  readWorldClock,
  readTimeMode,
  readWeatherMode,
  nowTs,
} from "@/lib/gameEngine";

const router = express.Router();

/**
 * 轻量接口：读当前会话的 worldClock + 模式状态。
 * 供前端 play-head__env 展示 + 模式切换。
 * 不触发角色卡补齐、不读消息列表、不读快照，保持轻量。
 */
router.post("/", validateFields({
  sessionId: z.string().min(1),
}), async (req: any, res: any) => {
  try {
    const { sessionId } = req.body;
    const db = getGameDb();
    const currentUserId = Number(req?.user?.id || 0);
    if (!Number.isFinite(currentUserId) || currentUserId <= 0) {
      return res.status(401).send(error("用户未登录"));
    }
    const sessionIdValue = String(sessionId || "").trim();
    const row = await db("t_gameSession").where({ sessionId: sessionIdValue, userId: currentUserId }).first();
    if (!row) {
      return res.status(404).send(error("会话不存在"));
    }

    const state = parseJsonSafe<Record<string, any>>(row.stateJson, {}) || {};
    const worldClock = readWorldClock(state);
    const timeMode = readTimeMode(state);
    const weatherMode = readWeatherMode(state);
    // 自由模式判定：phaseId 为空即自由模式
    const progress = (state as any)?.chapterProgress || {};
    const isFreeMode = !String(progress?.phaseId || "").trim();

    res.send(success({
      timeMode,
      weatherMode,
      worldClock,
      serverTime: nowTs(),
      isFreeMode,
    }));
  } catch (err: any) {
    res.status(500).send(error(err?.message || String(err)));
  }
});

export default router;
