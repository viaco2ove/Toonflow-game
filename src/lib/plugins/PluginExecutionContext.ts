/**
 * PluginExecutionContext —— 插件执行上下文构建（2026-11-12，网络通信机制 v3 §10 M1/M3）
 *
 * 从 tick.ts 原样抽出的「宿主侧上下文组装」：会话加载 → stateJson 解析 →
 * manifest / 实时动态卡 / 世界名 / 角色清单 → PluginGameContext。
 *
 * 为什么抽：MCP 路由（routes/plugin/mcp.ts）必须与 tick 用**同一份 ctx 构建**
 * （同一张动态卡、同一批角色、同一个世界），否则 AI 视角与玩家视角不一致。
 * 本模块只做「读与组装」，不改任何存储；状态读写走 PluginStateExecutor（v3 §5.1）。
 *
 * ⚠️ 与 tick.ts 的 heal（指针自愈）/ 409 语义无关——那是路由职责，留在各自路由。
 */
import { getGameDb, parseJsonSafe } from "@/lib/gameEngine";
import { getPluginDir, loadPluginManifestFromFile } from "@/lib/pluginRegistry";
import { type PluginGameContext } from "@/lib/PluginExecutor";
// ★ 2026-10-26：ctx.roles 改用故事运行时角色（与 MiniGameController.setup 同源），
//   修复「首次进入小游戏选人面板没有角色」。
import { buildMiniGameRoleOptions } from "@/modules/game-runtime/engines/MiniGameController";

/** 默认插件：MCP 工具未指定 pluginId 且会话指针为空时的兜底（野外生存） */
export const DEFAULT_MCP_PLUGIN_ID = "com.toonflow.minigame-field-survival";

/** 会话不存在（HTTP 404 / MCP tool error） */
export class PluginSessionMissingError extends Error {
  constructor(message = "会话不存在") {
    super(message);
    this.name = "PluginSessionMissingError";
  }
}

/** 上下文组装产物（tick / MCP 共用） */
export interface PluginExecutionContextBundle {
  session: any;
  /** 会话 stateJson 根对象（writeback / 结算消费落到这里 → hostState） */
  state: Record<string, any>;
  root: Record<string, any>;
  sessionNode: Record<string, any>;
  publicState: Record<string, any>;
  /** 指针里的插件 id（可能为空——编排 clobber 或从未进过游戏） */
  statePluginId: string;
  /** 实际采用的插件 id（调用方传入 || 指针 || DEFAULT_MCP_PLUGIN_ID） */
  resolvedPluginId: string;
  ctx: PluginGameContext;
  worldName: string;
}

/**
 * ★ v5：把当前世界（worldId）的常驻世界书条目拼成摘要文本，
 * 供插件 agent（商城生成）参考故事世界观与物资设定。
 */
async function buildWorldBookDigest(db: any, worldId: number): Promise<string> {
  if (!Number.isFinite(worldId) || worldId <= 0) return "";
  try {
    const rows = await db("t_worldBook").where({ worldId }).orderBy("sort", "asc").limit(80);
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return "";
    const line = (r: any) =>
      `- ${String(r?.title || "").slice(0, 30)}：${String(r?.content || "").replace(/\s+/g, " ").slice(0, 200)}`;
    const constant = list.filter((r: any) => Number(r?.constant) === 1);
    const picked = (constant.length ? constant : list).slice(0, 12);
    return picked.map(line).join("\n").slice(0, 2000);
  } catch {
    return "";
  }
}

/**
 * 会话加载 + 插件执行上下文组装（tick 路由与 MCP 路由的唯一入口）。
 *
 * @param opts.pluginId 允许为空 → 依次回退「stateJson 指针 → DEFAULT_MCP_PLUGIN_ID」
 * @throws PluginSessionMissingError 会话不存在
 */
export async function preparePluginExecutionContext(
  opts: {
    userId: number;
    sessionId: string;
    pluginId?: string;
    db?: any;
  },
): Promise<PluginExecutionContextBundle> {
  const db = opts.db || getGameDb();
  const { userId, sessionId } = opts;
  const session = await db("t_gameSession").where({ sessionId, userId }).first();
  if (!session) throw new PluginSessionMissingError("会话不存在");

  const state = parseJsonSafe<Record<string, any>>(session.stateJson, {}) || {};
  const root = (state.miniGame && typeof state.miniGame === "object")
    ? { ...(state.miniGame as Record<string, any>) }
    : {};
  const sessionNode = (root.session && typeof root.session === "object")
    ? { ...(root.session as Record<string, any>) }
    : {};
  const publicState = (sessionNode.public_state && typeof sessionNode.public_state === "object")
    ? { ...(sessionNode.public_state as Record<string, any>) }
    : {};

  const statePluginId = String(publicState.plugin_id || "");
  // 插件 id 解析：显式传入 → 会话指针 → 野外生存兜底
  const resolvedPluginId = String(opts.pluginId || "").trim() || statePluginId || DEFAULT_MCP_PLUGIN_ID;

  const manifest = await loadPluginManifestFromFile(userId, resolvedPluginId);
  // ★ 修复「受伤立刻回满」：publicState.player_card 是 init 时的一次性快照
  //   （MiniGameController 进入小游戏时写入，之后不再更新）。若每 tick 都把
  //   快照喂给插件，插件 syncCardFromContext 会因签名不一致把快照上的满血/
  //   旧等级整卡回灌实体（表现 = 玩家被打掉血下一帧又满）。
  //   这里改用 stateJson 里的实时动态卡（writeback 每帧消费后的最新值），
  //   快照仅作为实时卡缺失时的兜底。
  const livePlayerCard = (() => {
    const p = state.player && typeof state.player === "object" ? state.player : null;
    const card = p ? (p.parameterCardJson ?? p.parameter_card_json) : null;
    if (card && typeof card === "object" && Object.keys(card).length > 0) return card;
    return (publicState.player_card && typeof publicState.player_card === "object")
      ? publicState.player_card
      : undefined;
  })();
  // ★ v5.1 玩家卡脏条目自愈（"[object Object]" 字符串残留）：
  //   历史 String(obj) 把对象变成字面字符串后写入参数卡，syncCardFromContext
  //   不会主动重写（签名未变），脏数据永远卡死。入口主动洗一遍 items：
  //   过滤字面 "[object Object]"，若净化前后数组不同则立即落库到 stateJson.player
  //   （独立于 writeback 机制，下一帧前端就能看到正确背包）。
  if (livePlayerCard && Array.isArray((livePlayerCard as any).items)) {
    const rawList = (livePlayerCard as any).items as any[];
    const cleaned = rawList.filter((x) => !String(x).includes("[object Object]"));
    if (cleaned.length !== rawList.length) {
      (livePlayerCard as any).items = cleaned;
      if (state.player && typeof state.player === "object") {
        if ("parameterCardJson" in state.player) {
          (state.player as any).parameterCardJson = livePlayerCard;
        }
        if ("parameter_card_json" in state.player) {
          (state.player as any).parameter_card_json = livePlayerCard;
        }
      }
      console.log(`[plugin/ctx] 玩家卡 dirty 自愈：清理 ${rawList.length - cleaned.length} 条字面 [object Object]`);
    }
  }
  // ★ v6：当前世界名（故事绑定视觉地图模板用）：
  //   entry.start 按 worldName 读 map_visual:<worldName> 模板（sessionId="all"），
  //   注入本会话 map_visual → 前端 loadLevelByName 优先渲染该故事的视觉世界。
  //   发布快照（t_storyWorld_published）优先，草稿表（t_storyWorld）兜底；缺失不阻断 tick。
  let worldName = "";
  try {
    const wId = Number((session as any)?.worldId || 0);
    if (wId > 0) {
      let wrow: any = null;
      try { wrow = await db("t_storyWorld_published").where({ worldId: wId }).first(); } catch { /* 表缺失忽略 */ }
      if (!wrow) {
        try { wrow = await db("t_storyWorld").where({ id: wId }).first(); } catch { /* 表缺失忽略 */ }
      }
      worldName = String((wrow as any)?.name || (wrow as any)?.title || "").trim();
    }
  } catch { /* 世界名缺失不阻断 tick */ }
  // ★ 2026-10-26 修复「选人面板无角色」：
  //   正确来源：故事运行时的 state.player + state.npcs（与
  //   MiniGameController.setup 里 buildMiniGameRoleOptions(ctx.state) 同源）。
  //   兜底仍保留 publicState.roles（存档里有就直接用）。
  const liveRoles = buildMiniGameRoleOptions(state as any);
  const storedRoles = Array.isArray(publicState.roles) ? publicState.roles : [];
  const ctxRoles = liveRoles.length ? liveRoles : storedRoles;
  if (!liveRoles.length && !storedRoles.length) {
    console.warn(
      `[plugin/ctx] ⚠️ ctx.roles 为空（state.player/npcs 与 publicState.roles 都无角色）` +
      `→ 插件选人面板将没有可选角色（sessionId=${sessionId}）`,
    );
  }
  const ctx: PluginGameContext = {
    pluginId: resolvedPluginId,
    pluginDir: getPluginDir(userId, resolvedPluginId),
    manifest: (manifest || {}) as any,
    userId,
    sessionId,
    roles: ctxRoles,
    playerCard: (livePlayerCard && typeof livePlayerCard === "object")
      ? livePlayerCard
      : undefined,
    // ★ v5：常驻世界书条目摘要（商城 agent 生成物资时参考）
    worldBookDigest: await buildWorldBookDigest(db, Number((session as any)?.worldId || 0)),
    // ★ v6：当前世界身份（故事绑定视觉地图模板）
    worldId: Number((session as any)?.worldId || 0) || undefined,
    worldName: worldName || undefined,
  };

  return { session, state, root, sessionNode, publicState, statePluginId, resolvedPluginId, ctx, worldName };
}
