/**
 * worldClockHub —— 世界时钟 WS 推送（2026-11-16，用户需求「getWorldClock 改 WS，不要高频请求」）
 * ==============================================================
 * 此前前端 ScenePlay 每 10s HTTP 轮询 /game/getWorldClock：
 *   - 每次都要整行读 t_gameSession 并 parseJsonSafe(stateJson)（编排器把记忆/参数卡写进
 *     stateJson，行可达数百 KB~MB 级 → 每 10s 一次 JSON.parse 成为持续的事件循环负担）
 *   - 排队叠加会话锁时出现过 65s 的请求（2026-11-16 实测）
 *
 * 本 Hub：会话级订阅表 + 单一共享定时器。
 *   - 同一会话的 N 个订阅者共享一次查询（N 个页面不再放大成 N 次请求）
 *   - 只有值变化才推送（时钟槽位/天气只在编排推进时变，稳态零流量）
 *   - 连接建立立即推一次当前值（替代轮询的「立即跑一次」）
 *   - 无订阅者时定时器停止（空闲零开销）
 */
import { getGameDb, parseJsonSafe, readWorldClock, readTimeMode, readWeatherMode, nowTs } from "@/lib/gameEngine";
import type { WebSocket } from "ws";

/** 推送载荷（与 HTTP /game/getWorldClock 的 data 同构，前端可无缝切换） */
export interface ClockPushPayload {
  type: "clock";
  timeMode: string;
  weatherMode: string;
  worldClock: ReturnType<typeof readWorldClock>;
  serverTime: ReturnType<typeof nowTs>;
  isFreeMode: boolean;
  ts: number;
}

interface SessionSubscribers {
  /** userId:sessionId → 订阅连接集合 */
  sockets: Set<WebSocket>;
  /** 上次推送的时钟快照（比较变化用） */
  lastPushed: string | null;
}

const subscribers = new Map<string, SessionSubscribers>();
let ticker: ReturnType<typeof setInterval> | null = null;

/** 轮询间隔：服务端单次共享查询（非每客户端），10s 足够顺滑 */
const TICK_MS = 10_000;

function key(userId: number, sessionId: string): string {
  return `${userId}:${sessionId}`;
}

function safeSend(ws: WebSocket, payload: ClockPushPayload): void {
  try {
    if ((ws as any).readyState === 1) ws.send(JSON.stringify(payload));
  } catch {
    // 发送失败由 close/error 事件回收
  }
}

/** 读某会话当前时钟（轻量：单行 + parseJsonSafe） */
async function readClockFor(userId: number, sessionId: string): Promise<Omit<ClockPushPayload, "type" | "ts"> | null> {
  const db = getGameDb();
  const row = await db("t_gameSession").where({ sessionId, userId }).first();
  if (!row) return null;
  const state = parseJsonSafe<Record<string, any>>(row.stateJson, {}) || {};
  const progress = (state as any)?.chapterProgress || {};
  return {
    timeMode: readTimeMode(state),
    weatherMode: readWeatherMode(state),
    worldClock: readWorldClock(state),
    serverTime: nowTs(),
    isFreeMode: !String(progress?.phaseId || "").trim(),
  };
}

/** 推一次给某会话全部订阅者（值不变不推；serverTime 每次都带） */
async function pushIfChanged(keyStr: string): Promise<void> {
  const sub = subscribers.get(keyStr);
  if (!sub || sub.sockets.size === 0) return;
  const idx = keyStr.indexOf(":");
  const userId = Number(keyStr.slice(0, idx));
  const sessionId = keyStr.slice(idx + 1);
  let data: Omit<ClockPushPayload, "type" | "ts"> | null;
  try {
    data = await readClockFor(userId, sessionId);
  } catch {
    return; // 读失败静默，下轮再试
  }
  if (!data) return;
  const fingerprint = JSON.stringify([data.timeMode, data.weatherMode, data.worldClock, data.isFreeMode]);
  const firstPush = sub.lastPushed === null;
  if (!firstPush && fingerprint === sub.lastPushed) return; // 未变化不推
  sub.lastPushed = fingerprint;
  const payload: ClockPushPayload = { ...data, type: "clock", ts: Date.now() };
  for (const ws of sub.sockets) safeSend(ws, payload);
}

/** 共享定时器：有订阅者才开 */
function ensureTicker(): void {
  if (ticker) return;
  ticker = setInterval(() => {
    for (const keyStr of subscribers.keys()) {
      void pushIfChanged(keyStr);
    }
  }, TICK_MS);
  // 定时器不阻塞进程退出
  (ticker as any).unref?.();
}

function maybeStopTicker(): void {
  const alive = [...subscribers.values()].some((s) => s.sockets.size > 0);
  if (!alive && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

/** 连接建立：注册 + 立即推一次当前值 */
export function addClockConnection(userId: number, sessionId: string, ws: WebSocket): void {
  const keyStr = key(userId, sessionId);
  let sub = subscribers.get(keyStr);
  if (!sub) {
    sub = { sockets: new Set(), lastPushed: null };
    subscribers.set(keyStr, sub);
  }
  sub.sockets.add(ws);
  ensureTicker();
  void pushIfChanged(keyStr); // 立即推一次（替代轮询的立即跑一次）
}

/** 连接关闭：注销 + 无订阅者时停定时器 */
export function removeClockConnection(userId: number, sessionId: string, ws: WebSocket): void {
  const keyStr = key(userId, sessionId);
  const sub = subscribers.get(keyStr);
  if (!sub) return;
  sub.sockets.delete(ws);
  if (sub.sockets.size === 0) {
    subscribers.delete(keyStr);
  }
  maybeStopTicker();
}

/** 调试/巡检：当前订阅规模 */
export function clockHubStats(): { sessions: number; sockets: number } {
  let sockets = 0;
  for (const s of subscribers.values()) sockets += s.sockets.size;
  return { sessions: subscribers.size, sockets };
}
