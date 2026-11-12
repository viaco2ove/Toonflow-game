import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { getGameDb, toJsonText } from "@/lib/gameEngine";
// ★ M2（2026-11-12，网络通信机制 v3 §5.1 / §10）：状态读写/执行/落盘/会话锁统一下沉到
//   PluginStateExecutor，tick 与 MCP 共用同一份内存态 + 同一把会话锁（防 AI 写入被 tick 覆盖）。
import {
  executePluginActionWithState,
  withSessionLock,
  withSlowLock,
  PLUGIN_STATE_KEY,
} from "@/lib/plugins/PluginStateExecutor";
// ★ 2026-11-12：会话加载 + 插件执行上下文组装抽到 PluginExecutionContext（与 MCP 路由共用），
//   避免 manifest/动态卡/角色/世界名组装逻辑在两个入口各写一份。
import {
  preparePluginExecutionContext,
  PluginSessionMissingError,
} from "@/lib/plugins/PluginExecutionContext";
import {
  getPluginData,
  // ★ BUG-2 修复（2026-11-12）：plugin_state 内存态（权威）——DB 退化为快照，
  //   避免 O2 写库节流把世界推进速率从 10Hz 拖到 0.36Hz。详见 PluginSessionDataService 注释。
  getHotPluginState,
} from "@/lib/plugins/PluginSessionDataService";

const router = express.Router();

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

        // ── 会话加载 + 插件执行上下文（★ 2026-11-12 抽到 PluginExecutionContext，与 MCP 共用）──
        let boot;
        try {
          boot = await preparePluginExecutionContext({ userId, sessionId, pluginId, db });
        } catch (e) {
          if (e instanceof PluginSessionMissingError) {
            return res.status(404).send(error(e.message));
          }
          throw e;
        }
        const { state, root, sessionNode, publicState, session } = boot;
        const ctx = boot.ctx;

        // ★ 诊断日志：地图串故事的排查锚点。worldName 决定 entry 读哪个 map_visual:<name> 模板。
        console.log(
          `[plugin/tick] [map-diag] action=${action} sessionId=${sessionId} worldId=${session?.worldId} worldName=${JSON.stringify(boot.worldName)}`,
        );

      const statePluginId = boot.statePluginId;
      if (!statePluginId || statePluginId !== pluginId) {
        // ★ 自愈（v5.1）：编排器复写 stateJson 可能丢掉 miniGame.session.public_state.plugin_id
        //   指针（AI 故事轮次整体重建 miniGame 节点），但插件真实状态在 t_plugin_session_data
        //   里完好。若该插件在此会话有 phase=playing 的活跃状态 → 判定「游戏仍在进行，
        //   只是指针被 clobber」，就地重建指针继续 tick，而不是 409。
        //   （409 期间 iframe 收不到任何 state → UI 冻结，购买/卖出操作看着「没生效」。）
        const healScope = { userId, sessionId, pluginId };
        // ★ BUG-2 修复（2026-11-12）：内存态优先、DB 兜底。
        //   内存态才是权威（世界按 10Hz 推进）；DB 可能因 O2 节流滞后 2s，
        //   或已被 #退出 清理。两者取「存在且未 over」的那个即可。
        const hotHeal = getHotPluginState(healScope);
        const heal = hotHeal ? { dataValue: hotHeal.dataValue } : await getPluginData(healScope, PLUGIN_STATE_KEY);
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

      // ── 执行 + 状态读写统一下沉（★ M2-1/M2-3，网络通信机制 v3 §10）：
      //    读内存态 → entry.handle_action → writeback/结算消费（hostState）→
      //    写内存态 → DB 按 O2 节流落盘。tick 与 MCP 必须共用（v3 §5.1 红线）。
      //    本路由整段 handler 已持会话锁（须覆盖下方 stateJson 写回，否则
      //    「卖了还在」的覆盖竞态会回来）→ lock:"none"（同锁重入会死锁）。
      const { result, resultState, forceSync, stateUnchanged } = await executePluginActionWithState({
        ctx: ctx as any,
        scope,
        action,
        params,
        legacyState: (publicState.plugin_state && typeof publicState.plugin_state === "object")
          ? (publicState.plugin_state as Record<string, any>)
          : undefined,
        hostState: state,
        lock: "none",
      });

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
        //   何为「无变化」：由 PluginStateExecutor 按 O2 落盘记账判定（M2 下沉）。
        //   sys_* 命令 / phase 变化 / forceSync 永远带全量（前端消费路径不受影响）。
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
