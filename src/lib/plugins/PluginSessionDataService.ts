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
}
