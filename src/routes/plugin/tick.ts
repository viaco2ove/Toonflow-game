import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { getGameDb, parseJsonSafe, toJsonText } from "@/lib/gameEngine";
import { getPluginDir, loadPluginManifestFromFile } from "@/lib/pluginRegistry";
import { executePluginAction, type PluginGameContext } from "@/lib/PluginExecutor";
import { applyFieldSurvivalWriteback } from "@/lib/pluginWriteback";
import {
  getPluginData,
  setPluginData,
} from "@/lib/plugins/PluginSessionDataService";

const router = express.Router();

/** 插件运行时状态在 t_plugin_session_data 里的 dataKey */
const PLUGIN_STATE_KEY = "plugin_state";

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
    try {
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }
      const sessionId = String(req.body.sessionId || "").trim();
      const pluginId = String(req.body.pluginId || "").trim();
      const action = String(req.body.action || "tick").trim() || "tick";
      const params = (req.body.params && typeof req.body.params === "object")
        ? req.body.params
        : {};

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
        return res.status(409).send(error("当前没有进行中的该插件小游戏"));
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
      const ctx: PluginGameContext = {
        pluginId,
        pluginDir: getPluginDir(userId, pluginId),
        manifest: (manifest || {}) as any,
        userId,
        sessionId,
        roles: Array.isArray(publicState.roles) ? publicState.roles : [],
        playerCard: (publicState.player_card && typeof publicState.player_card === "object")
          ? publicState.player_card
          : undefined,
      };

      const result = await executePluginAction(ctx as any, action, params, prev as any);

      // ★ 结算写回：退出 / 死亡时把奖励写入用户与参展角色参数卡（只写一次）
      const resultState: any = result?.state ?? prev;
      if (resultState && resultState.phase === "over" && resultState.result && !resultState.result.written) {
        applyFieldSurvivalWriteback(state, resultState.result, resultState.selections);
        resultState.result = { ...resultState.result, written: true };
        // 写回动了 state.player/npcs（故事动态数据），这次必须落 stateJson
      }

      // ── 写 plugin_state：进插件数据表（不再塞 stateJson，根治 clobber）──
      await setPluginData(scope, PLUGIN_STATE_KEY, resultState);

      // ★ 始终写 session 节点：让前端 hasActiveMiniGameInRuntimeState() 能感知游戏进行中
      //   （依赖 session.status === "active" && session.game_type 存在判断）
      //   独立于 public_state 同步策略
      if (!sessionNode.status || sessionNode.status === "preparing") {
        sessionNode.status = "active";
      }
      sessionNode.phase = resultState?.phase ?? "playing";
      if (!sessionNode.game_type) sessionNode.game_type = "field-survival";

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

      return res.status(200).send(success({
        state: resultState,
        actions: Array.isArray(result?.actions) ? result.actions : (publicState.plugin_actions || []),
        response: publicState.plugin_response || "",
        code: result?.code ?? 0,
        message: result?.message ?? "",
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || "插件推进失败");
      return res.status(500).send(error(message));
    }
  },
);