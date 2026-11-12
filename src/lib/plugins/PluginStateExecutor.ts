/**
 * PluginStateExecutor —— 插件状态执行器（网络通信机制 v3 §5.1 / §10 M2，2026-11-12）
 *
 * 把「读内存态 → 执行 entry.handle_action → 宿主 writeback/结算消费 → 写内存态 →
 * DB 快照按 O2 节流落盘」抽成 tick 路由与 MCP 路由共用的唯一入口。
 *
 * 为什么必须共用（v3 §5.1；即时交互测试报告 2026-11-12 附注）：
 *   entry.handle_action 无状态（每次拿传入 state 重建、只推进一次 step），
 *   权威状态是本模块协同 PluginSessionDataService 管理的**内存态**。
 *   若 MCP 另写一套读写，AI 刚写入的状态会被下一个帧 tick 用旧快照覆盖
 *   （AI 刚杀掉的怪被"复活"）→ 必须强制走同一份内存态 + 同一把会话锁。
 *
 * 职责边界：
 *   - 本模块管「插件状态」：t_plugin_session_data.plugin_state 的读（内存态优先）
 *     / 写（内存态每次、DB 按 O2 节流）/ forceSync 判定 / O1 无变化判定 / 会话串行锁。
 *   - 宿主会话节点（t_gameSession.stateJson 的 miniGame.session 指针自愈、
 *     public_state 同步、玩家动态卡快照兜底）仍由调用方负责；
 *     本模块只把 writeback 增量补丁与 over 结算奖励「消费」到调用方给的 hostState 上
 *     （消费逻辑与 tick 原实现逐行等价，2026-11-12 重构）。
 *
 * 锁（★ M2-2）：会话串行锁注册表在本模块，tick 与 MCP 共用同一把锁。
 *   - fast：帧 tick / MCP tool 写操作（毫秒级，互斥防覆盖）；
 *   - slow：sys_* 慢命令（LLM 1-5s，不与帧 tick 抢锁，O4 拆分，v2 §3.4）；
 *   - none：调用方已持锁。tick 路由整段 handler 包锁（writeback 落 stateJson
 *     也必须串行——锁域若只盖状态执行，「卖了还在」的覆盖竞态会回来），
 *     此时传 none，本模块不再叠加加锁（同一把锁重入会死锁）。
 */
import { executePluginAction, type PluginGameContext } from "@/lib/PluginExecutor";
import { applyFieldSurvivalWriteback, applyPlayerCardPatch } from "@/lib/pluginWriteback";
import {
  getPluginData,
  setPluginData,
  getHotPluginState,
  setHotPluginState,
  pluginScopeKey,
  type PluginDataScope,
} from "./PluginSessionDataService";

/** 插件运行时状态在 t_plugin_session_data 里的 dataKey */
export const PLUGIN_STATE_KEY = "plugin_state";

// ── 会话串行锁（★ M2-2：注册表从 tick.ts 下沉，tick 与 MCP 共用）──
/** session 级串行锁：防止高频游戏 tick 与一次性系统命令（使用物品/卖出/排序等）
 *  并发读写 plugin_state 互相覆盖，导致「点了没反应」「卖了还在」等表现。
 *  ★ O4 快慢锁拆分（2026-11-01，网络通信机制 v2 §3.4）：
 *    sys_brain/sys_chat 等慢命令（LLM 1-5s）与帧 tick 共用一把锁时，
 *    AI 决策期间所有帧 tick 被堵（游戏画面冻结、坐标不上报）。
 *    拆两把锁：fastLock=帧 tick（10Hz 高频），slowLock=sys_* 慢命令。
 *    读写一致性：两者都走 entry.handle_action（内含 O2 的节流记账），
 *    chatResult 通过 plugin_state 回流不依赖帧锁；残余竞争窗口 ≤2s（O2 节流）。 */
const tickLocks = new Map<string, Promise<void>>();
const slowLocks = new Map<string, Promise<void>>();

/** 帧锁：帧 tick / MCP tool 写操作 */
export function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = tickLocks.get(sessionId) || Promise.resolve();
  let next: Promise<T>;
  const run = async () => fn();
  next = prev.then(run, run).finally(() => {
    if (tickLocks.get(sessionId) === next) tickLocks.delete(sessionId);
  });
  tickLocks.set(sessionId, next as Promise<void>);
  return next;
}

/** 慢命令锁：sys_* 类 action 专用，与帧 tick 并行不互相阻塞 */
export function withSlowLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = slowLocks.get(sessionId) || Promise.resolve();
  let next: Promise<T>;
  const run = async () => fn();
  next = prev.then(run, run).finally(() => {
    if (slowLocks.get(sessionId) === next) slowLocks.delete(sessionId);
  });
  slowLocks.set(sessionId, next as Promise<void>);
  return next;
}

// ── O2 落盘节流记账（★ 从 tick.ts 下沉；键用 pluginScopeKey 统一，M2-4）──
/** ★ O1+O2（2026-11-01）：plugin_state 落盘节流与无变化跳过。
 *  帧 tick 10Hz 旧逻辑每秒 UPSERT 10 次 ~48KB JSON（SQLite 单写者锁，多会话互相排队）。
 *  plugin_state 落库的意义只是「崩溃/刷新恢复」，不需要帧级实时：
 *   - PLUGIN_STATE_FLUSH_MS 内的重复写直接跳过；
 *   - 与上次落盘版本相同的 state（挂机空转）不写；
 *   - phase 变化 / over 结算 / 非 tick 命令 / forceSync 仍立即落盘。 */
const PLUGIN_STATE_FLUSH_MS = 2000;
const pluginStateLastJson = new Map<string, string>();
const pluginStateFlushAt = new Map<string, number>();

export interface ExecutePluginActionWithStateOptions {
  /** 插件执行上下文（manifest / roles / playerCard / worldBookDigest 等，调用方构建） */
  ctx: PluginGameContext;
  /** 插件数据 scope（userId × sessionId × pluginId） */
  scope: PluginDataScope;
  /** 插件 action（tick / attack / skill / sys_* / MCP tool 转发的 action 等） */
  action: string;
  params?: Record<string, any>;
  /** 老会话一次性迁移源：stateJson.miniGame.session.public_state.plugin_state（仅 tick 路由有） */
  legacyState?: Record<string, any>;
  /** 宿主会话 stateJson 根对象：writeback 增量补丁 / over 结算奖励消费到这里。
   *  不传则跳过消费（只读场景）；**写场景（tick / MCP tool）必须传**，
   *  否则奖励/背包改动会静默丢失。 */
  hostState?: Record<string, any>;
  /** 锁模式（见文件头）：fast（默认）| slow | none（调用方已持锁） */
  lock?: "fast" | "slow" | "none";
}

export interface ExecutePluginActionWithStateResult {
  /** entry.handle_action 原始返回（response / actions / code / message） */
  result: any;
  /** 执行后的权威状态（= 内存态新值） */
  resultState: Record<string, any>;
  /** 执行前状态（调用方极少用，保留诊断用） */
  prev: Record<string, any>;
  /** 本次是否强制落库（非 tick 命令 / phase 变化 / over / state.forceSync）★ M2-3 下沉 */
  forceSync: boolean;
  /** ★ O1 增量回传判定：true 时响应可省略全量 state（前端已有同内容快照） */
  stateUnchanged: boolean;
}

/**
 * 统一入口：读内存态 → 执行 entry → 宿主消费 → 写内存态 → DB 节流落盘。
 * tick 路由与 MCP 路由都走这里；任何旁路读写都会造成状态互相覆盖（v3 §5.1 红线）。
 */
export async function executePluginActionWithState(
  opts: ExecutePluginActionWithStateOptions,
): Promise<ExecutePluginActionWithStateResult> {
  const { ctx, scope, action, params = {}, legacyState, hostState } = opts;
  const lock = opts.lock || "fast";

  const run = async (): Promise<ExecutePluginActionWithStateResult> => {
    // ── 读 plugin_state：内存态优先（权威）；miss → DB 快照 → legacy 一次性迁移 ──
    // ★ BUG-2 修复（2026-11-12）：entry.handle_action 无状态，若每请求都从 DB 读，
    //   O2 的 2s 写库节流会把「未落库的中间状态」整体丢弃 → 世界推进速率掉到 0.36Hz。
    //   内存态为权威，DB 退化为快照（落盘仍按 O2 节流，省写的收益不变）。
    let prev: Record<string, any> = {};
    const hot = getHotPluginState(scope);
    if (hot && hot.dataValue && typeof hot.dataValue === "object") {
      prev = hot.dataValue;
    } else {
      const stored = await getPluginData(scope, PLUGIN_STATE_KEY);
      if (stored && stored.dataValue && typeof stored.dataValue === "object") {
        prev = stored.dataValue;
      } else if (legacyState && Object.keys(legacyState).length > 0) {
        // 老会话迁移：stateJson 里的 plugin_state 写入插件数据表（一次性）
        await setPluginData(scope, PLUGIN_STATE_KEY, legacyState);
        prev = legacyState;
      }
      // 从 DB/legacy 冷启动后立刻灌入内存态（本次请求即生效）
      if (prev && Object.keys(prev).length > 0) setHotPluginState(scope, prev);
    }

    // ── 执行（entry.handle_action：拿 prev 重建、推进一次、返回新 state）──
    const result = await executePluginAction(ctx, action, params, prev as any);
    const resultState: any = result?.state ?? prev;

    // ── 宿主消费（原 tick.ts 逐行等价）： ──
    // ① writeback 增量补丁：插件对用户动态参数卡（背包/技能/金钱）的改动写回 stateJson，
    //    宿主消费后清空，避免重复消费。
    const wbPatch = (result as any)?.state?.writeback;
    if (hostState && wbPatch && typeof wbPatch === "object" && Object.keys(wbPatch).length > 0) {
      applyPlayerCardPatch(hostState, wbPatch);
      (result as any).state.writeback = null;
    }
    // ② 结算写回：退出 / 死亡时把奖励写入用户与参展角色参数卡（只写一次）
    if (hostState && resultState && resultState.phase === "over" && resultState.result && !resultState.result.written) {
      applyFieldSurvivalWriteback(hostState, resultState.result, resultState.selections);
      resultState.result = { ...resultState.result, written: true };
      // 写回动了 hostState.player/npcs（故事动态数据），调用方需据此落 stateJson
    }

    // ── 写：内存态每次请求立即更新（权威）+ DB 快照按 O2 节流落盘 ──
    // ★ M2-3：forceSync 判定下沉——非 tick 命令（sys_* / MCP tool）返回即落库，
    //   MCP 写操作对「崩溃恢复」立即可见，不随 2s 窗口漂移。
    const forceSync = action !== "tick"
      || resultState?.phase !== prev?.phase
      || resultState?.phase === "over"
      || !!(resultState as any)?.forceSync;
    const scopeKey = pluginScopeKey(scope);
    const serializedNow = JSON.stringify(resultState);
    const nowMs = Date.now();
    const lastFlushAt = pluginStateFlushAt.get(scopeKey) || 0;
    const changed = pluginStateLastJson.get(scopeKey) !== serializedNow;
    // ★ 内存态：每次请求后立即更新（权威状态），与落盘解耦
    setHotPluginState(scope, resultState);
    if (forceSync || (changed && nowMs - lastFlushAt >= PLUGIN_STATE_FLUSH_MS)) {
      await setPluginData(scope, PLUGIN_STATE_KEY, resultState);
      pluginStateLastJson.set(scopeKey, serializedNow);
      pluginStateFlushAt.set(scopeKey, nowMs);
    }
    // ★ O1 增量回传（304 语义，2026-11-01）：与上次落盘快照一致 → 前端已有同内容
    //   state（~48KB → ~1KB），响应不携带全量。sys_* 命令 / phase 变化 / forceSync
    //   永远带全量（前端消费路径不受影响）。
    const stateUnchanged = !forceSync && pluginStateLastJson.get(scopeKey) === serializedNow;

    return { result, resultState, prev, forceSync, stateUnchanged };
  };

  if (lock === "none") return run();
  if (lock === "slow") return withSlowLock(scope.sessionId, run);
  return withSessionLock(scope.sessionId, run);
}

/**
 * ★ M2-5：只读快照（MCP query_state 等读操作用）——
 * 优先内存态，miss 才查 DB 快照；不加锁（只读，容忍与帧 tick 的毫秒级竞态）、
 * 不执行 entry、不落盘、不回灌内存态。
 */
export async function readPluginStateSnapshot(
  scope: PluginDataScope,
): Promise<Record<string, any> | null> {
  const hot = getHotPluginState(scope);
  if (hot && hot.dataValue && typeof hot.dataValue === "object") {
    return hot.dataValue as Record<string, any>;
  }
  const stored = await getPluginData(scope, PLUGIN_STATE_KEY);
  if (stored && stored.dataValue && typeof stored.dataValue === "object") {
    return stored.dataValue as Record<string, any>;
  }
  return null;
}
