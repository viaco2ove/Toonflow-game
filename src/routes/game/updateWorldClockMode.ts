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
  toJsonText,
  nowTs,
} from "@/lib/gameEngine";

const router = express.Router();

/**
 * 更新会话的时间/天气模式。
 * 写到 state.vars.timeMode / state.vars.weatherMode，落库 t_gameSession.stateJson。
 * 鉴权：currentUserId 必须匹配 session.userId。
 */
router.post("/", validateFields({
  sessionId: z.string().min(1),
  timeMode: z.enum(["tick", "narrative", "realtime"]).optional(),
  weatherMode: z.enum(["slot", "narrative", "manual"]).optional(),
}), async (req: any, res: any) => {
  try {
    const { sessionId, timeMode, weatherMode } = req.body;
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
    if (!state.vars || typeof state.vars !== "object") {
      state.vars = {};
    }
    if (timeMode) {
      state.vars.timeMode = timeMode;
    }
    if (weatherMode) {
      state.vars.weatherMode = weatherMode;
    }

    const stateJson = toJsonText(state, {});
    await db("t_gameSession").where({ sessionId: sessionIdValue, userId: currentUserId }).update({
      stateJson,
      updateTime: nowTs(),
    });

    res.send(success({
      timeMode: readTimeMode(state),
      weatherMode: readWeatherMode(state),
      worldClock: readWorldClock(state),
      serverTime: nowTs(),
    }));
  } catch (err: any) {
    res.status(500).send(error(err?.message || String(err)));
  }
});

export default router;