import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { getGameDb } from "@/lib/gameEngine";
import {
  getPluginData,
  setPluginData,
} from "@/lib/plugins/PluginSessionDataService";

const router = express.Router();

/**
 * ★ P3 事件推送（2026-11-01，网络通信机制 v2 §4）——插件事件队列
 *
 *   POST /plugin/events { sessionId, pluginId, op: "push"|"pop", events? }
 *
 * 语义（S4 事件推送 + T1 低频拉取）：
 *   - push：后端编排器 / 定时器投递「唤醒事件」到队列（如 wake_sms：
 *     "该角色到了主动发消息的时间"）。**只投事件，不做 AI 决策**——
 *     AI 上下文（性格/记忆/感知）在插件前端 aiStates，后端拿不到（v2 §4 方案 A）。
 *   - pop：插件前端低频轮询（30s+，挂机/后台也不发 tick 的形态）拉走全部事件并清空队列。
 *
 * 存储：t_plugin_session_data 的 dataKey="__plugin_events__"（队列 JSON，上限 64 条，
 *       溢出丢最旧）。跨会话共享（sessionId="all"）不适用——事件必须绑定具体会话。
 *
 * 事件结构：{ id, type, at, payload? }
 *   - type 现约定 "wake_sms"（唤醒短信决策）；未来可扩展成就/离线收益等。
 *
 * 注：当前 push 的唯一生产者是编排器钩子（未来接）；本路由先打通队列语义，
 *     插件端轮询消费链路（P3 骨架）随之落地。
 */
const EVENTS_KEY = "__plugin_events__";
const MAX_EVENTS = 64;

export async function pushPluginEvent(
  userId: number,
  sessionId: string,
  pluginId: string,
  evt: { type: string; payload?: Record<string, unknown> },
): Promise<boolean> {
  try {
    const scope = { userId, sessionId, pluginId };
    const stored = await getPluginData(scope, EVENTS_KEY);
    const list = Array.isArray(stored?.dataValue?.list) ? stored.dataValue.list : [];
    list.push({
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: String(evt.type || "unknown"),
      at: Date.now(),
      ...(evt.payload && typeof evt.payload === "object" ? { payload: evt.payload } : {}),
    });
    const trimmed = list.slice(-MAX_EVENTS); // 溢出丢最旧
    await setPluginData(scope, EVENTS_KEY, { list: trimmed });
    return true;
  } catch (e) {
    console.error("[plugin/events] push 失败:", e);
    return false;
  }
}

export default router.post(
  "/",
  validateFields({
    sessionId: z.string(),
    pluginId: z.string(),
    op: z.enum(["push", "pop"]),
    events: z.any().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }
      const sessionId = String(req.body.sessionId || "").trim();
      const pluginId = String(req.body.pluginId || "").trim();
      const op = String(req.body.op || "").trim();
      if (!sessionId || !pluginId) {
        return res.status(400).send(error("sessionId/pluginId 必填"));
      }
      if (sessionId === "all") {
        return res.status(400).send(error("事件队列必须绑定具体会话，不支持 all"));
      }

      const db = getGameDb();
      const session = await db("t_gameSession").where({ sessionId, userId }).first();
      if (!session) return res.status(404).send(error("会话不存在"));

      const scope = { userId, sessionId, pluginId };

      if (op === "push") {
        const events = Array.isArray(req.body.events) ? req.body.events : [];
        if (events.length === 0) {
          return res.status(400).send(error("push 需要 events 数组"));
        }
        let ok = 0;
        for (const evt of events.slice(0, 32)) {
          if (evt && typeof evt === "object" && await pushPluginEvent(userId, sessionId, pluginId, evt)) ok++;
        }
        return res.status(200).send(success({ pushed: ok }));
      }

      // op === "pop"：拉走全部事件并清空（原子性：单进程串行锁由 SQLite 单写者保证）
      const stored = await getPluginData(scope, EVENTS_KEY);
      const list = Array.isArray(stored?.dataValue?.list) ? stored.dataValue.list : [];
      if (list.length > 0) {
        await setPluginData(scope, EVENTS_KEY, { list: [] });
      }
      return res.status(200).send(success({ events: list }));
    } catch (e: any) {
      return res.status(500).send(error(e?.message || "插件事件队列操作失败"));
    }
  },
);
