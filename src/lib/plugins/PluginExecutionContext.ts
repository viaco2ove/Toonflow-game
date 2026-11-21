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
  /** ★ 2026-11-21 影子缓存配套：本行读取时的 updateTime（cachedRow 快路径下为 null——
   *  调用方影子缓存里已有自己的值）。TickCore 用它做「外部写入方探测」的基准。 */
  rowUpdateTime: number | null;
  /** 本行 worldId（cachedRow 快路径下来自缓存） */
  rowWorldId: number | null;
  /** ★ 2026-11-21：玩家卡 dirty 自愈本轮清洗过 state.player（行内容变了，调用方需落库） */
  playerCardCleaned: boolean;
}

/** ★ 2026-11-21 影子缓存配套：TickCore 传来的「本会话故事行」复用包——
 *  带 it 时跳过 t_gameSession 全行 SELECT+parse（351KB）与 worldName 两次查询。
 *  一致性由 TickCore 的 updateTime 探测保证（外部写入方必然带 updateTime → 失配 → 全量重读）。 */
export interface CachedStoryRow {
  state: Record<string, any>;
  worldId: number | null;
  worldName: string;
}

/** manifest TTL 缓存（key: userId:pluginId）：见 preparePluginExecutionContext 内注释 */
const manifestCache = new Map<string, { manifest: any; at: number }>();

/**
 * ★ v5：把当前世界（worldId）的常驻世界书条目拼成摘要文本，
 * 供插件 agent（商城生成）参考故事世界观与物资设定。
 */
async function buildWorldBookDigest(db: any, worldId: number): Promise<string> {
  if (!Number.isFinite(worldId) || worldId <= 0) return "";
  // ★ 2026-11-21：每 tick 都查 80 行世界书太贵（实测单拍 90~280ms 的组成之一）。
  //   世界书编辑是低频操作 → 摘要按 worldId 做 60s TTL 缓存（商城生成引用的是
  //   世界观设定，分钟级陈旧无感知）。
  const nowMs = Date.now();
  const hit = worldBookDigestCache.get(worldId);
  if (hit && nowMs - hit.at < 60_000) return hit.text;
  try {
    const rows = await db("t_worldBook").where({ worldId }).orderBy("sort", "asc").limit(80);
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return "";
    const line = (r: any) =>
      `- ${String(r?.title || "").slice(0, 30)}：${String(r?.content || "").replace(/\s+/g, " ").slice(0, 200)}`;
    const constant = list.filter((r: any) => Number(r?.constant) === 1);
    const picked = (constant.length ? constant : list).slice(0, 12);
    const text = picked.map(line).join("\n").slice(0, 2000);
    worldBookDigestCache.set(worldId, { text, at: nowMs });
    if (worldBookDigestCache.size > 32) {
      const oldest = worldBookDigestCache.keys().next().value;
      if (oldest !== undefined) worldBookDigestCache.delete(oldest);
    }
    return text;
  } catch {
    return "";
  }
}
const worldBookDigestCache = new Map<number, { text: string; at: number }>();

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
    /** ★ 2026-11-21 影子缓存快路径（见 CachedStoryRow）；MCP 路由不传，行为不变 */
    cachedRow?: CachedStoryRow;
  },
): Promise<PluginExecutionContextBundle> {
  const db = opts.db || getGameDb();
  const { userId, sessionId } = opts;
  const cached = opts.cachedRow;
  // ★ 2026-11-21：快路径跳过 t_gameSession 全行 SELECT+parse（351KB 实测读一次 367ms）。
  //   行存在性由调用方（TickCore 影子缓存）在本拍 cheap 探测列时确认。
  let state: Record<string, any>;
  let sessionRow: any = null;
  let rowWorldId: number | null = null;
  let rowUpdateTime: number | null = null;
  let playerCardCleaned = false;
  if (cached) {
    state = cached.state;
    rowWorldId = cached.worldId;
    sessionRow = { worldId: rowWorldId };   // 最小占位：消费方只读 worldId（map-diag 日志）
  } else {
    sessionRow = await db("t_gameSession").where({ sessionId, userId }).first();
    if (!sessionRow) throw new PluginSessionMissingError("会话不存在");
    state = parseJsonSafe<Record<string, any>>(sessionRow.stateJson, {}) || {};
    rowWorldId = Number((sessionRow as any)?.worldId) || null;
    rowUpdateTime = Number((sessionRow as any)?.updateTime) || null;
  }
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

  // ★ 2026-11-21：manifest 每拍读盘缓存（t_plugin SELECT + manifest.json readFile）。
  //   ARM 盒实测影子缓存落地后单拍仍 ~150ms——manifest 读盘是剩余大头之一。
  //   TTL 30s：插件安装/更新后最多 30s 才被 tick 路径感知（install 流程直读文件不走此缓存）。
  const manifestKey = `${userId}:${resolvedPluginId}`;
  const nowMs0 = Date.now();
  const mHit = manifestCache.get(manifestKey);
  const manifest = (mHit && nowMs0 - mHit.at < 30_000)
    ? mHit.manifest
    : await loadPluginManifestFromFile(userId, resolvedPluginId).then((m) => {
      manifestCache.set(manifestKey, { manifest: m, at: nowMs0 });
      if (manifestCache.size > 32) {
        const oldest = manifestCache.keys().next().value;
        if (oldest !== undefined) manifestCache.delete(oldest);
      }
      return m;
    });
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
      playerCardCleaned = true;
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
  //   ★ 2026-11-21：快路径直接用影子缓存里的 worldName（worldId 会话内不变，无需每拍两次查询）。
  let worldName = "";
  if (cached && cached.worldName) {
    worldName = cached.worldName;
  } else
  try {
    const wId = Number(rowWorldId || 0);
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
    // ★ v5：常驻世界书条目摘要（商城 agent 生成物资时参考；内置 60s TTL 缓存）
    worldBookDigest: await buildWorldBookDigest(db, Number(rowWorldId || 0)),
    // ★ v6：当前世界身份（故事绑定视觉地图模板）
    worldId: Number(rowWorldId || 0) || undefined,
    worldName: worldName || undefined,
  };

  return {
    session: sessionRow,
    state,
    root,
    sessionNode,
    publicState,
    statePluginId,
    resolvedPluginId,
    ctx,
    worldName,
    rowUpdateTime,
    rowWorldId,
    playerCardCleaned,
  };
}
