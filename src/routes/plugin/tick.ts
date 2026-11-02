import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { getGameDb, parseJsonSafe, toJsonText } from "@/lib/gameEngine";
import { getPluginDir, loadPluginManifestFromFile } from "@/lib/pluginRegistry";
import { executePluginAction, type PluginGameContext } from "@/lib/PluginExecutor";
import { applyFieldSurvivalWriteback, applyPlayerCardPatch } from "@/lib/pluginWriteback";
// ★ 2026-10-26：ctx.roles 改用故事运行时角色（与 MiniGameController.setup 同源），
//   修复「首次进入小游戏选人面板没有角色」。
import { buildMiniGameRoleOptions } from "@/modules/game-runtime/engines/MiniGameController";
import {
  getPluginData,
  setPluginData,
} from "@/lib/plugins/PluginSessionDataService";

const router = express.Router();

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

function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
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
function withSlowLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = slowLocks.get(sessionId) || Promise.resolve();
  let next: Promise<T>;
  const run = async () => fn();
  next = prev.then(run, run).finally(() => {
    if (slowLocks.get(sessionId) === next) slowLocks.delete(sessionId);
  });
  slowLocks.set(sessionId, next as Promise<void>);
  return next;
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

/** 插件运行时状态在 t_plugin_session_data 里的 dataKey */
const PLUGIN_STATE_KEY = "plugin_state";

/** ★ O1+O2（2026-11-01）：plugin_state 落盘节流与无变化跳过。
 *  帧 tick 10Hz 旧逻辑每秒 UPSERT 10 次 ~48KB JSON（SQLite 单写者锁，多会话互相排队）。
 *  plugin_state 落库的意义只是「崩溃/刷新恢复」，不需要帧级实时：
 *   - PLUGIN_STATE_FLUSH_MS 内的重复写直接跳过；
 *   - 与上次落盘版本相同的 state（挂机空转）不写；
 *   - phase 变化 / over 结算 / 非 tick 命令 / forceSync 仍立即落盘。 */
const PLUGIN_STATE_FLUSH_MS = 2000;
const pluginStateLastJson = new Map<string, string>();
const pluginStateFlushAt = new Map<string, number>();

/**
 * 插件实时推进接口（轻量）：
 *
 *   POST /plugin/tick { sessionId, pluginId, action, params }
 *
 * 与 addMessage 的区别：
 *   - 不落 t_sessionMessage，**不会刷屏对话**
 *   - 不走编排 / 不触发 AI / 不生成台词
 *   - **plugin_state 存取在 t_plugin_session_data（插件数据表），不再写 stateJson.miniGame**
 *     → 编排复写 stateJson（clobber 竞态）不再影响进行中的游戏
 *
 * 实时类插件（如 2.5D 动作小游戏）每帧/每个操作都调它；
 * 只有在「退出 / 死亡」这种需要旁白结算时，才走 addMessage 让编排产出结语并写回奖励。
 *
 * 兼容：老会话的 plugin_state 还在 stateJson.miniGame.public_state 里——首次 tick
 * 自动迁移（读出来 → 写入插件数据表 → stateJson 里只留 plugin_id 指针）。
 */
export default router.post(
  "/",
  validateFields({
    sessionId: z.string(),
    pluginId: z.string(),
    action: z.string().optional().nullable(),
    params: z.any().optional().nullable(),
  }),
  async (req, res) => {
    const sessionId = String(req.body.sessionId || "").trim();
    try {
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }
      const pluginId = String(req.body.pluginId || "").trim();
      const action = String(req.body.action || "tick").trim() || "tick";
      const params = (req.body.params && typeof req.body.params === "object")
        ? req.body.params
        : {};

      // ★ O4：sys_* 慢命令（LLM 决策/对话/商城生成，1-5s）走独立慢锁——
      //   不与 10Hz 帧 tick 抢锁（AI 决策期间游戏帧照常推进）。
      //   帧写库与慢命令写库的互斥由 O2 节流记账 + SQLite 单写者兜底。
      const isSlowCmd = action.startsWith("sys_");
      const lockFn = isSlowCmd ? withSlowLock : withSessionLock;

      // 串行化同一 session 的 tick 请求，防止并发读写 plugin_state 覆盖
      return await lockFn(sessionId, async () => {
        const db = getGameDb();
      const session = await db("t_gameSession").where({ sessionId, userId }).first();
      if (!session) return res.status(404).send(error("会话不存在"));

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
      if (!statePluginId || statePluginId !== pluginId) {
        // ★ 自愈（v5.1）：编排器复写 stateJson 可能丢掉 miniGame.session.public_state.plugin_id
        //   指针（AI 故事轮次整体重建 miniGame 节点），但插件真实状态在 t_plugin_session_data
        //   里完好。若该插件在此会话有 phase=playing 的活跃状态 → 判定「游戏仍在进行，
        //   只是指针被 clobber」，就地重建指针继续 tick，而不是 409。
        //   （409 期间 iframe 收不到任何 state → UI 冻结，购买/卖出操作看着「没生效」。）
        const healScope = { userId, sessionId, pluginId };
        const heal = await getPluginData(healScope, PLUGIN_STATE_KEY);
        const healState = heal?.dataValue;
        const healPhase = String((healState as any)?.phase || "");
        // ★ P2 协议分流（2026-11-01，网络通信机制 v2 §4）：
        //   回合/指令型插件有 select/config 等合法非 playing 中间态（选人/布置阶段
        //   玩家要出招交互，却不处于实时对局）——自愈判定从「仅 playing/空」放宽为
        //   「**只要插件状态存在且未 over**」。over 仍不放行：结束的局必须走编排器
        //   正常重开，防止僵尸指针复活已结算的对局。
        const healActive = !!healState && typeof healState === "object"
          && (healPhase === "playing" || healPhase === "" || healPhase !== "over");
        if (!healActive) {
          return res.status(409).send(error(`当前没有进行中的该插件小游戏,statePluginId:${statePluginId},pluginId:${pluginId}`));
        }
        // 重建指针（本次请求内生效；落库见下方 sessionNode 写回）
        publicState.plugin_id = pluginId;
        publicState.plugin_type = publicState.plugin_type || "plugin";
        sessionNode.public_state = publicState;
        root.session = sessionNode;
        state.miniGame = root;
        console.log(`[plugin/tick] 指针自愈：session=${sessionId} plugin=${pluginId}（stateJson 指针丢失但插件状态活跃）`);
      }

      const scope = { userId, sessionId, pluginId };

      // ── 读 plugin_state：优先插件数据表；老数据在 stateJson 里则一次性迁移 ──
      let prev: Record<string, any> = {};
      const stored = await getPluginData(scope, PLUGIN_STATE_KEY);
      if (stored && stored.dataValue && typeof stored.dataValue === "object") {
        prev = stored.dataValue;
      } else {
        const legacy = (publicState.plugin_state && typeof publicState.plugin_state === "object")
          ? publicState.plugin_state
          : {};
        if (legacy && Object.keys(legacy).length > 0) {
          await setPluginData(scope, PLUGIN_STATE_KEY, legacy);
          prev = legacy;
        }
      }

      const manifest = await loadPluginManifestFromFile(userId, pluginId);
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
      //   不会主动重写（签名未变），脏数据永远卡死。tick 入口主动洗一遍 items：
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
          console.log(`[plugin/tick] 玩家卡 dirty 自愈：清理 ${rawList.length - cleaned.length} 条字面 [object Object]`);
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
      // ★ 诊断日志：地图串故事的排查锚点。worldName 决定 entry 读哪个 map_visual:<name> 模板。
      console.log(
        `[plugin/tick] [map-diag] action=${action} sessionId=${sessionId} worldId=${session?.worldId} worldName=${JSON.stringify(worldName)}`,
      );
      // ★ 2026-10-26 修复「选人面板无角色」：
      //   原来 roles 取的是 `publicState.roles`（= 上次存档 state 里的 roles）。
      //   首次进入小游戏时 publicState.roles 为空 → 插件 init 拿到空 roles
      //   → 前端选人面板一个角色都没有（表现为「退出再进一次就好了」，
      //     因为第二次 prev 里已经有 roles 了）。
      //   正确来源：故事运行时的 state.player + state.npcs（与
      //   MiniGameController.setup 里 buildMiniGameRoleOptions(ctx.state) 同源）。
      //   兜底仍保留 publicState.roles（存档里有就直接用）。
      const liveRoles = buildMiniGameRoleOptions(state as any);
      const storedRoles = Array.isArray(publicState.roles) ? publicState.roles : [];
      const ctxRoles = liveRoles.length ? liveRoles : storedRoles;
      if (!liveRoles.length && !storedRoles.length) {
        console.warn(
          `[plugin/tick] ⚠️ ctx.roles 为空（state.player/npcs 与 publicState.roles 都无角色）` +
          `→ 插件选人面板将没有可选角色（sessionId=${sessionId}）`,
        );
      }
      const ctx: PluginGameContext = {
        pluginId,
        pluginDir: getPluginDir(userId, pluginId),
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

      const result = await executePluginAction(ctx as any, action, params, prev as any);

      // ★ v5：插件侧对用户「动态参数卡」的改动（背包物品 / 技能 / 金钱）写回 stateJson
      //   插件在 state.writeback 里给出增量补丁，宿主消费后清空，避免重复写
      const wbPatch = (result as any)?.state?.writeback;
      if (wbPatch && typeof wbPatch === "object" && Object.keys(wbPatch).length > 0) {
        applyPlayerCardPatch(state, wbPatch);
        (result as any).state.writeback = null;
      }

      // ★ 结算写回：退出 / 死亡时把奖励写入用户与参展角色参数卡（只写一次）
      const resultState: any = result?.state ?? prev;
      if (resultState && resultState.phase === "over" && resultState.result && !resultState.result.written) {
        applyFieldSurvivalWriteback(state, resultState.result, resultState.selections);
        resultState.result = { ...resultState.result, written: true };
        // 写回动了 state.player/npcs（故事动态数据），这次必须落 stateJson
      }

      // ── 写 plugin_state：进插件数据表（不再塞 stateJson，根治 clobber）──
      // ★ 性能优化（2026-11-01，O1+O2 合体：脏检查 + 降频落盘）：
      //   帧 tick 10Hz 下，旧逻辑每秒 UPSERT 10 次 ~48KB JSON（SQLite 单写者锁，
      //   多会话互相排队）。plugin_state 落库的意义是「崩溃/刷新恢复」，不需要帧级实时：
      //   ① 快照节流：距上次落盘 < PLUGIN_STATE_FLUSH_MS 直接跳过写库；
      //   ② 无变化跳过：state 与上次落盘版本相同（玩家挂机、敌怪待机）→ 不写。
      //   例外（必须立即落盘）：phase 变化 / over 结算 / 非 tick 命令（sys_* 等）/ forceSync。
      const scopeKey = `${userId}:${sessionId}:${pluginId}`;
      const forceSync = action !== "tick"
        || resultState?.phase !== prev?.phase
        || resultState?.phase === "over"
        || !!(resultState as any)?.forceSync;
      const serializedNow = JSON.stringify(resultState);
      const now2 = Date.now();
      const lastFlushAt = pluginStateFlushAt.get(scopeKey) || 0;
      const changed = pluginStateLastJson.get(scopeKey) !== serializedNow;
      if (forceSync || (changed && now2 - lastFlushAt >= PLUGIN_STATE_FLUSH_MS)) {
        await setPluginData(scope, PLUGIN_STATE_KEY, resultState);
        pluginStateLastJson.set(scopeKey, serializedNow);
        pluginStateFlushAt.set(scopeKey, now2);
      }

      // ★ 始终写 session 节点：让前端 hasActiveMiniGameInRuntimeState() 能感知游戏进行中
      //   （依赖 session.status === "active" && session.game_type 存在判断）
      //   独立于 public_state 同步策略
      if (!sessionNode.status || sessionNode.status === "preparing") {
        sessionNode.status = "active";
      }
      sessionNode.phase = resultState?.phase ?? "playing";
      // ★ 修复「#退出 关不掉、一闪重开」：插件小游戏的 canonical game_type 是 "plugin"
      //   （对应 RULEBOOKS.plugin，#退出 才能被 handleMiniGameTurn 拦截）。
      //   旧代码硬编码 "field-survival"（不在 RULEBOOKS 里）→ #退出 走 null 分支不生效、
      //   tick 又不断把 status=active 写回 → 面板死灰复燃。
      if (!sessionNode.game_type) sessionNode.game_type = "plugin";

      // stateJson 只在「状态引用变更」时同步完整 public_state：
      //   - plugin_state 已迁 t_plugin_session_data，stateJson 里只写 null（指针语义）
      //   - plugin_actions/plugin_response 供选人面板与文本 UI 兜底（tick 时不更新）
      const needSync = action !== "tick" || resultState?.phase === "over";
      if (needSync) {
        if (resultState?.phase === "over") {
          // 游戏结束：整体收尾（前端 iframe 由 /plugin/data 读状态渲染结算）
          publicState.plugin_phase_over = true;
          sessionNode.status = "finished";
        }
        publicState.plugin_state = null; // 指针语义
        if (Array.isArray(result?.actions)) publicState.plugin_actions = result.actions;
        if (typeof result?.response === "string") publicState.plugin_response = result.response;
      }
      sessionNode.public_state = publicState;
      root.session = sessionNode;
      state.miniGame = root;
      await db("t_gameSession")
        .where({ sessionId, userId })
        .update({ stateJson: toJsonText(state, {}), updateTime: Date.now() });

        // ★ O1 增量回传（304 语义，2026-11-01）：纯帧 tick 且状态无变化时，
        //   响应不携带全量 state（state:null，~48KB → ~1KB），前端跳过状态合并。
        //   何为「无变化」：serializedNow 与上次落盘快照一致（O2 记账共享）。
        //   sys_* 命令 / phase 变化 / forceSync 永远带全量（前端消费路径不受影响）。
        const stateUnchanged = !forceSync && pluginStateLastJson.get(scopeKey) === serializedNow;
        return res.status(200).send(success({
          state: stateUnchanged ? null : resultState,
          actions: Array.isArray(result?.actions) ? result.actions : (publicState.plugin_actions || []),
          response: publicState.plugin_response || "",
          code: result?.code ?? 0,
          message: result?.message ?? "",
        }));
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || "插件推进失败");
      return res.status(500).send(error(message));
    }
  },
);