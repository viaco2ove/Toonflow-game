/**
 * PluginTickCore —— 插件 tick 执行核心（2026-11-14，网络通信机制 v3.1 §5.1）
 *
 * 从 tick.ts 原样抽出的「一次插件动作执行」全流程：
 *   会话加载 + 指针自愈 → entry.handle_action（经 PluginStateExecutor，内存态权威）→
 *   writeback/结算消费（hostState）→ sessionNode 同步 → stateJson 写回 → 响应构造。
 *
 * 为什么抽：v3.1 的 WS TickDriver（PluginRealtimeHub）与 HTTP /plugin/tick 必须共用
 * 这**同一段**逻辑——只换「谁在什么时候调它」，不改任何语义。
 *  - HTTP 路由（回退通道 / dev-host / 回归测试）：调本函数，status+payload 原样回给客户端；
 *  - TickDriver（服务端权威循环）：每 100ms 调一次 action="tick"；
 *  - WS 动作（玩家技能/普攻）：动作到达即调一次（与会话锁天然串行）。
 *
 * ⚠️ 行为不变性是硬性要求：改本文件 = 同时改 HTTP 与 WS 两条通道，回归脚本照跑。
 */
import { error, success } from "@/lib/responseFormat";
import { getGameDb, toJsonText } from "@/lib/gameEngine";
import {
  executePluginActionWithState,
  withSessionLock,
  withSlowLock,
  PLUGIN_STATE_KEY,
} from "@/lib/plugins/PluginStateExecutor";
import {
  preparePluginExecutionContext,
  PluginSessionMissingError,
} from "@/lib/plugins/PluginExecutionContext";
import {
  getPluginData,
  // ★ BUG-2 修复（2026-11-12）：plugin_state 内存态（权威）——DB 退化为快照。
  getHotPluginState,
} from "@/lib/plugins/PluginSessionDataService";

/** 一次 tick/动作执行的完整结果（HTTP 语义字段原样保留，WS 侧按需取用） */
export interface PluginTickCoreResult {
  /** 建议的 HTTP status（WS 侧仅用于区分成功/失败日志） */
  status: number;
  /** 建议的响应体（success()/error() 信封；WS 侧取其中的 state/actions/response） */
  payload: any;
  /** O1 304 语义：true 时 state 为 null（前端已有同内容快照） */
  stateUnchanged: boolean;
  /** 执行后的权威状态（stateUnchanged 时为 null，与 payload.state 一致） */
  state: Record<string, any> | null;
  /** entry 回执文案（用于 WS ack） */
  response: string;
  /** entry 业务 code */
  code: number;
}

export interface PluginTickCoreOptions {
  userId: number;
  sessionId: string;
  pluginId: string;
  action?: string;
  params?: Record<string, any>;
}

/**
 * 执行一次插件动作（= 原.HTTP /plugin/tick handler 全流程，含锁）。
 * 永不抛错——失败通过 { status:4xx/5xx, payload: error(...) } 表达。
 */
export async function performPluginTickCore(opts: PluginTickCoreOptions): Promise<PluginTickCoreResult> {
  const sessionId = String(opts.sessionId || "").trim();
  const userId = Number(opts.userId || 0);
  const pluginId = String(opts.pluginId || "").trim();
  const action = String(opts.action || "tick").trim() || "tick";
  const params = (opts.params && typeof opts.params === "object") ? opts.params : {};

  if (!Number.isFinite(userId) || userId <= 0) {
    return { status: 401, payload: error("用户未登录"), stateUnchanged: false, state: null, response: "用户未登录", code: -1 };
  }
  if (!sessionId || !pluginId) {
    return { status: 400, payload: error("缺少 sessionId 或 pluginId"), stateUnchanged: false, state: null, response: "缺少参数", code: -1 };
  }

  try {
    // ★ O4：sys_* 慢命令（LLM 决策/对话/商城生成，1-5s）走独立慢锁——
    //   不与 10Hz 帧 tick 抢锁（AI 决策期间游戏帧照常推进）。
    const isSlowCmd = action.startsWith("sys_");
    const lockFn = isSlowCmd ? withSlowLock : withSessionLock;

    // 串行化同一 session 的 tick 请求，防止并发读写 plugin_state 覆盖
    const outcome = await lockFn(sessionId, async (): Promise<{ status: number; body: any; stateUnchanged: boolean; state: Record<string, any> | null; response: string; code: number }> => {
      const db = getGameDb();

      // ── 会话加载 + 插件执行上下文（与 MCP 共用）──
      let boot;
      try {
        boot = await preparePluginExecutionContext({ userId, sessionId, pluginId, db });
      } catch (e) {
        if (e instanceof PluginSessionMissingError) {
          return { status: 404, body: error(e.message), stateUnchanged: false, state: null, response: e.message, code: -1 };
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
        //   里完好。若该插件在此会话有活跃状态 → 判定「游戏仍在进行，只是指针被 clobber」，
        //   就地重建指针继续 tick，而不是 409。over 仍不放行（防僵尸局复活）。
        const healScope = { userId, sessionId, pluginId };
        const hotHeal = getHotPluginState(healScope);
        // ★ 内存态优先、DB 兜底（进程重启后内存态空，指针自愈仍要能读到 DB 快照）
        const heal = hotHeal ? { dataValue: hotHeal.dataValue } : await getPluginData(healScope, PLUGIN_STATE_KEY);
        const healState = heal?.dataValue;
        const healPhase = String((healState as any)?.phase || "");
        // ★ 2026-11-15 修正：healState 完全缺失（legacy 老会话从未落 plugin_state /
        //   数据丢失）→ 放行。此前一律 409 会让老会话刷新页面后连开局都被挡死
        //   （「当前没有进行中的小游戏」）。entry 自身有 phase 门闸：select 阶段
        //   tick 直接空响应不推进，sys_party/ai_command 等操作在选人界面合法；
        //   start 可全新开局（restoreSys 会找回背包/技能/队伍等库数据）。
        //   仅 phase=over 的残留局仍 409（防僵尸局复活）。
        const healActive = !healState
          || (typeof healState === "object" && healPhase !== "over");
        if (!healActive) {
          return {
            status: 409,
            body: error(`当前没有进行中的该插件小游戏,statePluginId:${statePluginId},pluginId:${pluginId}`),
            stateUnchanged: false,
            state: null,
            response: "当前没有进行中的小游戏",
            code: -1,
          };
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

      // ── 执行 + 状态读写统一（M2）：本函数已持会话锁（须覆盖下方 stateJson 写回）→ lock:"none"
      const { result, resultState, stateUnchanged } = await executePluginActionWithState({
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
      if (!sessionNode.status || sessionNode.status === "preparing") {
        sessionNode.status = "active";
      }
      sessionNode.phase = resultState?.phase ?? "playing";
      // canonical game_type = "plugin"（#退出 拦截依赖）
      if (!sessionNode.game_type) sessionNode.game_type = "plugin";

      // stateJson 只在「状态引用变更」时同步完整 public_state（指针语义）
      const needSync = action !== "tick" || resultState?.phase === "over";
      if (needSync) {
        if (resultState?.phase === "over") {
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

      const response = publicState.plugin_response || String(result?.response || "");
      const code = Number(result?.code ?? 0);
      return {
        status: 200,
        body: success({
          state: stateUnchanged ? null : resultState,
          actions: Array.isArray(result?.actions) ? result.actions : (publicState.plugin_actions || []),
          response: publicState.plugin_response || "",
          code: result?.code ?? 0,
          message: result?.message ?? "",
        }),
        stateUnchanged,
        state: stateUnchanged ? null : (resultState as Record<string, any>),
        response,
        code,
      };
    });

    return {
      status: outcome.status,
      payload: outcome.body,
      stateUnchanged: outcome.stateUnchanged,
      state: outcome.state,
      response: outcome.response,
      code: outcome.code,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err || "插件推进失败");
    console.error(`[plugin/tick-core] 执行失败 action=${action} session=${sessionId}:`, message);
    return { status: 500, payload: error(message), stateUnchanged: false, state: null, response: message, code: -1 };
  }
}
