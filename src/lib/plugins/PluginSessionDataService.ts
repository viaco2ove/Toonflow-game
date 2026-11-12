/**
 * PluginSessionDataService — 插件会话数据存储
 *
 * 插件运行时数据（如 field-survival 的地图数据、plugin_state）独立保存到
 * t_plugin_session_data，维度：userId × sessionId × pluginId × dataKey。
 *
 * 为什么不用 session.stateJson：
 *  - stateJson 是「故事的动态数据」，由编排流程持续复写（叙事轮次会整体重建
 *    miniGame 节点）；插件实时状态塞在里面会被 clobber（游戏进行中被清空）。
 *  - 独立表后，编排怎么写 stateJson 都不影响插件游戏；两边解耦。
 *
 * 后端入口：
 *  - 路由层：POST /plugin/data { sessionId, pluginId, op: get|set|list|remove }
 *  - 插件 entry.ts：ctx.tsApi.pluginData.get/set（toonflowTsApi 的一部分）
 */
import { getGameDb } from "@/lib/gameEngine";

export interface PluginDataScope {
  userId: number;
  sessionId: string;
  pluginId: string;
}

/** 单条数据的返回结构 */
export interface PluginDataEntry {
  dataKey: string;
  dataValue: any;
  updatedAt: number;
}

function now(): number {
  return Date.now();
}

/**
 * ★ BUG-2 修复（2026-11-12，网络通信机制 v2 §3.1 O2 副作用）：
 *   plugin_state 的**内存态缓存**。
 *
 * 背景（实测见 md/test/toonflow-field-survival/即时交互测试报告_2026-11-12.md）：
 *   O2「写库降频」把 plugin_state 落盘节流到 2s 一次，本意是省 SQLite 写；
 *   但 entry.js 的 handle_action 是**无状态**的（每次请求拿 state 重建、只推进一次 step），
 *   而 /plugin/tick 每次都从 DB 读 state → 未落库的中间状态被整体丢弃 →
 *   **游戏世界推进速率从 10Hz 掉到 0.36Hz**（= 落库速率 1/2s），
 *   连带技能 CD 递减 2.7 倍、野怪 AI 变慢、死亡渐隐卡住、
 *   以及「玩家已贴近野怪但 attack 说附近没有敌人」（服务端拿 2s 前的位置判 4m 范围）。
 *
 * 解法：**内存态是权威，DB 退化为快照**。
 *   - 读：命中内存态直接用（不查 DB）→ 世界按请求频率推进，与落库频率解耦；
 *   - 写：每次请求后更新内存态；DB 落盘仍按 O2 节流（保留省写的收益）；
 *   - 删除：removePluginData / clearPluginDataBySession 必须同步清内存态，
 *     否则 #退出 删了 DB 行、内存态还在 → /plugin/tick 的 heal 守卫会认为
 *     「游戏仍在进行」而复活面板（关了又重开）。
 *
 * 重启安全性：进程重启后内存态为空，首次请求回落读 DB（DB 有 ≤2s 内的快照），
 * 损失可接受；不需要额外的恢复流程。
 */
const HOT_STATE_KEY = "plugin_state";
type HotStateEntry = { dataValue: any; updatedAt: number };
/** 内存态上限（超出按插入顺序淘汰最旧的）——单条 state 可达 ~48KB，64 条 ≈ 3MB */
const HOT_STATE_MAX = 64;
const hotStateCache = new Map<string, HotStateEntry>();

/**
 * ★ M2-4（v3 §10，2026-11-12）：scope 规范键 `userId:sessionId:pluginId`。
 * 模块级记账 Map（O2 落盘节流、会话锁等）必须与 hotKey 用同一格式派生键，
 * 否则 tick 与 MCP 会读到不同的内存态/记账（等于没有共用）。
 */
export function pluginScopeKey(scope: PluginDataScope): string {
  return `${scope.userId}:${scope.sessionId}:${scope.pluginId}`;
}

function hotKey(scope: PluginDataScope, dataKey: string): string {
  return `${pluginScopeKey(scope)}:${dataKey}`;
}

/** 读内存态（仅 plugin_state 走热路径；其它 key 始终走 DB） */
export function getHotPluginState(scope: PluginDataScope): HotStateEntry | null {
  if (HOT_STATE_KEY !== "plugin_state") return null;
  return hotStateCache.get(hotKey(scope, HOT_STATE_KEY)) || null;
}

/**
 * 只更新内存态（不写库）。
 * tick.ts 每次请求后调用：内存态立即生效，DB 落盘另按 O2 节流决定。
 */
export function setHotPluginState(scope: PluginDataScope, dataValue: any): void {
  const key = hotKey(scope, HOT_STATE_KEY);
  // 已存在则原地更新（保持 Map 插入顺序 = 最近使用顺序），否则插入
  const existing = hotStateCache.get(key);
  if (existing) {
    existing.dataValue = dataValue;
    existing.updatedAt = now();
  } else {
    hotStateCache.set(key, { dataValue, updatedAt: now() });
  }
  while (hotStateCache.size > HOT_STATE_MAX) {
    const oldest = hotStateCache.keys().next();
    if (oldest.done) break;
    hotStateCache.delete(oldest.value);
  }
}

/** 清掉某 scope 的内存态（#退出 / 会话清理时必须调用） */
export function clearHotPluginState(scope: PluginDataScope): void {
  hotStateCache.delete(hotKey(scope, HOT_STATE_KEY));
}

/** JSON 安全序列化（对象/数组序列化为 JSON 字符串，标量原样） */
function serialize(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 反序列化（存的是 JSON 字符串则解析，解析失败原样返回） */
function deserialize(text: string): any {
  if (!text) return null;
  const t = String(text).trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return text;
  }
}

/** 读取一个 dataKey（不存在返回 null） */
export async function getPluginData(
  scope: PluginDataScope,
  dataKey: string
): Promise<PluginDataEntry | null> {
  const db = getGameDb();
  const row = await db("t_plugin_session_data")
    .where({
      userId: scope.userId,
      sessionId: scope.sessionId,
      pluginId: scope.pluginId,
      dataKey: String(dataKey || ""),
    })
    .first();
  // ★ 诊断日志：地图模板/会话缓存的读取锚点（map_visual / map_data 前缀）
  if (String(dataKey || "").startsWith("map_")) {
    // eslint-disable-next-line no-console
    console.log(
      `[PluginSessionData] [map-diag] get key=${dataKey} sessionId=${scope.sessionId} pluginId=${scope.pluginId} -> ${row ? "HIT" : "MISS"}`
    );
  }
  if (!row) return null;
  return {
    dataKey: row.dataKey,
    dataValue: deserialize(row.dataValue),
    updatedAt: Number(row.updatedAt || 0),
  };
}

/** 写入（upsert）一个 dataKey */
export async function setPluginData(
  scope: PluginDataScope,
  dataKey: string,
  dataValue: unknown
): Promise<void> {
  const db = getGameDb();
  const key = String(dataKey || "");
  const value = serialize(dataValue);
  const ts = now();
  await db("t_plugin_session_data")
    .insert({
      userId: scope.userId,
      sessionId: scope.sessionId,
      pluginName: "",
      pluginId: scope.pluginId,
      dataKey: key,
      dataValue: value,
      createdAt: ts,
      updatedAt: ts,
    })
    .onConflict(["userId", "sessionId", "pluginId", "dataKey"])
    .merge({ dataValue: value, updatedAt: ts });

  // ★ 上传新地图模板时，自动清掉所有「非 all 会话」里缓存的旧 map_visual / map_data
  //   行。否则：entry.ts 规则 4「本会话已有 map_visual 就跳过注入」会让老会话永远
  //   显示上一次上传的地图（用户已踩坑：上传「赦夜人」后老会话仍显示「通天传授」）。
  //   范围限定：
  //     - 仅在写入「地图模板 key」(map_visual:* / map_data:*) 时触发
  //     - 仅在 sessionId="all"（即模板作用域）时触发
  //     - 只删该 userId × pluginId 下「非 all」会话里匹配的 key，保留 all 模板本身
  //     - 不影响 plugin_state / ai_story_roles 等运行时 key
  if (
    scope.sessionId === "all" &&
    (key.startsWith("map_visual:") || key.startsWith("map_data:"))
  ) {
    try {
      const cleared = await db("t_plugin_session_data")
        .where({
          userId: scope.userId,
          pluginId: scope.pluginId,
        })
        .whereNot("sessionId", "all")
        .whereIn("dataKey", ["map_visual", "map_data"])
        .del();
      // ★ 诊断日志：always 打印（含 cleared=0），否则"清理没生效"和"本来就没缓存"分不清
      // eslint-disable-next-line no-console
      console.log(
        `[PluginSessionData] [map-diag] template ${key} written (scope: userId=${scope.userId} pluginId=${scope.pluginId} sessionId=all); cleared stale session map cache rows=${cleared}`
      );
    } catch (e) {
      // 清理失败不阻断上传主流程；下次开游戏再覆盖即可
      // eslint-disable-next-line no-console
      console.warn(
        `[PluginSessionData] failed to clear session cache after uploading ${key}:`,
        e
      );
    }
  }
}

/** 列出该插件在某会话下的全部 dataKey（不回传 value，避免大负载） */
export async function listPluginDataKeys(scope: PluginDataScope): Promise<string[]> {
  const db = getGameDb();
  const rows = await db("t_plugin_session_data")
    .where({
      userId: scope.userId,
      sessionId: scope.sessionId,
      pluginId: scope.pluginId,
    })
    .select("dataKey");
  return rows.map((r: any) => String(r.dataKey));
}

/** 删除一个 dataKey */
export async function removePluginData(scope: PluginDataScope, dataKey: string): Promise<void> {
  const db = getGameDb();
  await db("t_plugin_session_data")
    .where({
      userId: scope.userId,
      sessionId: scope.sessionId,
      pluginId: scope.pluginId,
      dataKey: String(dataKey || ""),
    })
    .del();
  // ★ BUG-2：DB 行删了，内存态也必须删——否则 #退出 后 /plugin/tick 的 heal 守卫
  //   读到内存态里的「游戏仍在进行」，会复活已关闭的面板（关了又重开）。
  if (String(dataKey || "") === HOT_STATE_KEY) clearHotPluginState(scope);
}

/** 会话维度清理（会话删除/插件卸载时用） */
export async function clearPluginDataBySession(scope: {
  userId: number;
  sessionId: string;
}): Promise<void> {
  const db = getGameDb();
  await db("t_plugin_session_data")
    .where({ userId: scope.userId, sessionId: scope.sessionId })
    .del();
  // ★ BUG-2：同步清掉该会话下所有 plugin 的 plugin_state 内存态
  for (const key of Array.from(hotStateCache.keys())) {
    if (key.startsWith(`${scope.userId}:${scope.sessionId}:`)) hotStateCache.delete(key);
  }
}
