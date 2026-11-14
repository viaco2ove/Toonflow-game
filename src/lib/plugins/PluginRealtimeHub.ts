/**
 * PluginRealtimeHub —— 插件实时通道中枢（2026-11-14，网络通信机制 v3.1）
 *
 * 职责（设计文档 §5）：
 *   1. 连接注册表：scope(userId:sessionId:pluginId) → WS 连接集
 *   2. 服务端权威 TickDriver：phase=playing 且有连接在线时，100ms 自推进一步世界
 *      （调 performPluginTickCore，与 HTTP tick / MCP 共用同一把会话串行锁）
 *   3. 推送策略：无变化不推（复用 executor O1b 304 判定）+ 50ms 节流
 *      + 慢消费者 latest-wins（socket 积压即丢帧，绝不排队）
 *   4. 动作即时执行：WS action 到达即执行（会话锁串行），ack 回执带 actionId
 *
 * 不变式（硬性要求）：
 *   - entry.ts 零改动：本模块只是「换一个人在正确的时间调 performPluginTickCore」
 *   - HTTP /plugin/tick 行为不变（回退通道 / dev-host / 回归测试依赖）
 *   - 所有执行都经 PluginTickCore（指针自愈/writeback 消费/sessionNode 同步不旁路）
 */
import { WebSocket } from "ws";
import { runWithRequestContext } from "@/lib/requestContext";
import { performPluginTickCore } from "@/lib/plugins/PluginTickCore";
import { readPluginStateSnapshot } from "@/lib/plugins/PluginStateExecutor";

/** 单个会话的实时通道聚合态 */
interface HubSession {
  /** 在线 WS 连接（允许同 scope 多连接：多开标签页各自收推送） */
  conns: Set<WebSocket>;
  /** 玩家帧 tick 参数整包 latest-wins 缓存（WS tickParams 消息覆写；tick 边界由 driver 消费）
   *  ★ 含 {input, player, localEnemies?, walkGrid?, levelName} 五件套——
   *    localEnemies/walkGrid 是事件型低频字段（仅世代变化/切图那帧携带），
   *    覆写时保留、消费成功后剥离（见 updateRealtimeParams / driverTickOnce） */
  latestParams: Record<string, any> | null;
  /** 最近一次已知的插件 phase（driver 门闸：仅 playing 时自推进） */
  lastPhase: string;
  /** 最近一次缓存的完整 state（sync/重连重同步用；null 态时保留旧值） */
  lastState: Record<string, any> | null;
  lastActions: any[];
  lastResponse: string;
  /** driver 定时器与在途标志（防止 interval 回调堆积） */
  tickTimer: ReturnType<typeof setInterval> | null;
  driverBusy: boolean;
  /** 推送节流：上次推送时刻 + 待推尾帧 */
  lastPushAt: number;
  trailingTimer: ReturnType<typeof setTimeout> | null;
}

const registry = new Map<string, HubSession>();

/** tick 循环周期（毫秒）：与前端 10Hz 上报等价 */
const DRIVER_TICK_MS = 100;
/** 推送最小间隔（毫秒）：同会话推送节流下限 */
const PUSH_MIN_INTERVAL_MS = 50;
/** 慢消费者判定：socket 发送缓冲超过该字节数即丢弃本帧 state（下一帧覆盖） */
const SOCKET_BACKPRESSURE_BYTES = 128 * 1024;
/** 上行限流：每连接每秒消息数上限（防失控循环） */
const UPLINK_RATE_LIMIT = 50;

const scopeKeyOf = (userId: number, sessionId: string, pluginId: string) =>
  `${userId}:${sessionId}:${pluginId}`;

function getSession(scope: { userId: number; sessionId: string; pluginId: string }): HubSession {
  const key = scopeKeyOf(scope.userId, scope.sessionId, scope.pluginId);
  let s = registry.get(key);
  if (!s) {
    s = {
      conns: new Set(),
      latestParams: null,
      lastPhase: "",
      lastState: null,
      lastActions: [],
      lastResponse: "",
      tickTimer: null,
      driverBusy: false,
      lastPushAt: 0,
      trailingTimer: null,
    };
    registry.set(key, s);
  }
  return s;
}

/** 安全发送（连接可能已半关闭） */
function wsSend(ws: WebSocket, data: string): boolean {
  try {
    if (ws.readyState !== 1) return false;
    ws.send(data);
    return true;
  } catch {
    return false;
  }
}

/** 推送一帧（state + actions + response）到会话的全部连接；慢消费者丢帧 */
function pushToSession(session: HubSession, state: Record<string, any> | null): void {
  if (!state) return;
  const msg = JSON.stringify({
    type: "push",
    state,
    actions: session.lastActions,
    response: session.lastResponse,
    ts: Date.now(),
  });
  for (const ws of session.conns) {
    // ★ latest-wins：发送缓冲积压 = 客户端消费不动 → 丢本帧（下一帧必然更新）
    if ((ws as any).bufferedAmount > SOCKET_BACKPRESSURE_BYTES) continue;
    wsSend(ws, msg);
  }
  session.lastPushAt = Date.now();
}

/** 推送节流：间隔不足则挂尾帧（50ms 后用最新状态推一次） */
function schedulePush(scope: { userId: number; sessionId: string; pluginId: string }, session: HubSession, state: Record<string, any> | null): void {
  if (!state) return;
  session.lastState = state;
  const since = Date.now() - session.lastPushAt;
  if (since >= PUSH_MIN_INTERVAL_MS) {
    pushToSession(session, state);
    return;
  }
  if (session.trailingTimer) return; // 已有待推尾帧（最新值已被 lastState 覆盖）
  session.trailingTimer = setTimeout(() => {
    session.trailingTimer = null;
    pushToSession(session, session.lastState);
  }, PUSH_MIN_INTERVAL_MS - since);
}

/** driver 自推进一步 */
async function driverTickOnce(
  scope: { userId: number; sessionId: string; pluginId: string },
  session: HubSession,
): Promise<void> {
  if (session.driverBusy) return; // 上一步还没回来（锁/慢盘）→ 跳过本拍
  if (session.conns.size === 0) return;
  if (session.lastPhase !== "playing") return; // 非 playing 不空转
  session.driverBusy = true;
  try {
    // ★ 2026-11-14 修复：setInterval 回调不在 HTTP 请求上下文里 → tick 内依赖
    //   getCurrentUserId 的链路（AI 调用 getPromptAi 等）拿不到 userId → 显式绑回。
    await runWithRequestContext({ userId: scope.userId }, async () => {
      // ★ 整包透传：params 五件套 {input, player, localEnemies?, walkGrid?, levelName}。
      //   localEnemies/walkGrid 是事件型字段（epoch/切图帧才携带），随本拍送达一次；
      //   执行成功后按「引用相同」剥离缓存——await 期间若新事件帧已覆写则不误删。
      const cached = session.latestParams;
      const params: Record<string, any> = cached ? { ...cached } : {};
      const carriedEnemies = (params as any).localEnemies;
      const carriedWalkGrid = (params as any).walkGrid;
      const r = await performPluginTickCore({
        userId: scope.userId,
        sessionId: scope.sessionId,
        pluginId: scope.pluginId,
        action: "tick",
        params,
      });
      if (r.status === 200 && cached) {
        const cur = session.latestParams as any;
        if (carriedEnemies !== undefined && cur?.localEnemies === carriedEnemies) delete cur.localEnemies;
        if (carriedWalkGrid !== undefined && cur?.walkGrid === carriedWalkGrid) delete cur.walkGrid;
      }
      updateSessionFromResult(session, r);
      if (r.state) schedulePush(scope, session, r.state);
    });
  } finally {
    session.driverBusy = false;
  }
}

/** 从执行结果更新会话缓存（phase 门闸 / actions / response） */
function updateSessionFromResult(session: HubSession, r: { state: Record<string, any> | null; response: string; code: number; payload?: any }): void {
  if (r.state && typeof r.state === "object") {
    const phase = String((r.state as any).phase || "");
    if (phase) session.lastPhase = phase;
    session.lastState = r.state;
  }
  const d = (r.payload && (r.payload as any).data) || {};
  if (Array.isArray(d.actions)) session.lastActions = d.actions;
  if (typeof d.response === "string") session.lastResponse = d.response;
}

/** 确保该会话的 driver 在跑 */
function ensureDriver(scope: { userId: number; sessionId: string; pluginId: string }, session: HubSession): void {
  if (session.tickTimer) return;
  session.tickTimer = setInterval(() => {
    void driverTickOnce(scope, session);
  }, DRIVER_TICK_MS);
  // timer 不阻止进程退出
  (session.tickTimer as any).unref?.();
}

function stopDriverIfIdle(session: HubSession): void {
  if (session.conns.size === 0 && session.tickTimer) {
    clearInterval(session.tickTimer);
    session.tickTimer = null;
  }
}

/* ============================================================
   对路由层（realtime.ts）暴露的连接生命周期 API
   ============================================================ */

export interface RealtimeScope {
  userId: number;
  sessionId: string;
  pluginId: string;
}

/** 连接建立：注册 + 起 driver + 立即 sync（全量状态重同步） */
export function addRealtimeConnection(scope: RealtimeScope, ws: WebSocket): void {
  const session = getSession(scope);
  session.conns.add(ws);
  ensureDriver(scope, session);
  // sync：优先内存缓存（最新），miss 才读快照（进程重启后）
  const syncState = session.lastState || null;
  const msg = JSON.stringify({
    type: "sync",
    state: syncState,
    actions: session.lastActions,
    response: session.lastResponse,
    serverTick: (syncState as any)?.tick ?? null,
    ts: Date.now(),
  });
  wsSend(ws, msg);
  if (!syncState) {
    // 冷启动：异步读快照补一次 sync
    void readPluginStateSnapshot({ userId: scope.userId, sessionId: scope.sessionId, pluginId: scope.pluginId })
      .then((snap) => {
        if (snap && typeof snap === "object") {
          session.lastState = snap as Record<string, any>;
          const phase = String((snap as any).phase || "");
          if (phase) session.lastPhase = phase;
          if (phase === "playing") ensureDriver(scope, session);
          wsSend(ws, JSON.stringify({ type: "sync", state: snap, actions: session.lastActions, response: session.lastResponse, serverTick: (snap as any).tick ?? null, ts: Date.now() }));
        }
      })
      .catch(() => { /* 快照缺失（未开局）：连接保持，等 action/start */ });
  }
}

/** 连接关闭：注销；无人在线时停 driver（省 ARM 盒 CPU） */
export function removeRealtimeConnection(scope: RealtimeScope, ws: WebSocket): void {
  const session = getSession(scope);
  session.conns.delete(ws);
  stopDriverIfIdle(session);
}

/**
 * 帧 tick 参数整包上报：latest-wins 覆写（不产生任何网络回包）。
 * ★ 事件型字段合并保留：iframe 只在「敌怪世代变化/切图」那一帧携带 localEnemies/walkGrid，
 *   若被紧随的普通帧直接覆写会永久丢失（原 HTTP 逐帧串行无此问题，latest-wins 有）——
 *   新帧未携带时保留旧值，直到 driver 消费成功后剥离。
 */
export function updateRealtimeParams(scope: RealtimeScope, params: Record<string, any>): void {
  const session = getSession(scope);
  const p = params && typeof params === "object" ? params : null;
  if (!p) { session.latestParams = null; return; }
  const old = session.latestParams as any;
  const merged: Record<string, any> = { ...p };
  if (merged.localEnemies === undefined && old && old.localEnemies !== undefined) merged.localEnemies = old.localEnemies;
  if (merged.walkGrid === undefined && old && old.walkGrid !== undefined) merged.walkGrid = old.walkGrid;
  session.latestParams = merged;
}

/**
 * 玩家动作即时执行（技能/普攻/物品/sys_*…）：与 driver / HTTP tick 共用会话锁。
 * 完成后：① 向**发起连接**回 ack（含 actionId 与 entry 回执文案）；
 *         ② state 有变化 → 推给该会话全部连接。
 */
export async function performRealtimeAction(
  scope: RealtimeScope,
  ws: WebSocket,
  actionId: string,
  action: string,
  params: Record<string, any>,
): Promise<void> {
  const session = getSession(scope);
  const r = await performPluginTickCore({
    userId: scope.userId,
    sessionId: scope.sessionId,
    pluginId: scope.pluginId,
    action,
    params,
  });
  updateSessionFromResult(session, r);
  // ack（小消息，不丢）
  const ack = JSON.stringify({
    type: "ack",
    actionId,
    action,
    ok: r.status === 200 && r.code === 0,
    httpStatus: r.status,
    response: r.response,
    code: r.code,
    serverTick: (r.state as any)?.tick ?? session.lastState?.tick ?? null,
    ts: Date.now(),
  });
  wsSend(ws, ack);
  // state 变化 → 广播
  if (r.state) schedulePush(scope, session, r.state);
  // phase 变化（如 start→playing）确保 driver 状态正确；over/select 停自推进
  if (session.lastPhase === "playing") ensureDriver(scope, session);
  else stopDriverIfIdle(session);
}

/** 心跳（保活 + RTT 测量）：直接回 pong */
export function handleRealtimePing(ws: WebSocket, ts: number): void {
  wsSend(ws, JSON.stringify({ type: "pong", ts, rttBase: ts }));
}

/** 上行限流检查：超限返回 true（调用方应断开） */
export function checkUplinkRate(scope: RealtimeScope, ws: WebSocket): boolean {
  const anyWs = ws as any;
  const now = Date.now();
  const win = anyWs.__rtRateWindow || 0;
  const cnt = (anyWs.__rtRateCount || 0) + 1;
  if (now - win >= 1000) {
    anyWs.__rtRateWindow = now;
    anyWs.__rtRateCount = 1;
    return false;
  }
  anyWs.__rtRateCount = cnt;
  return cnt > UPLINK_RATE_LIMIT;
}
