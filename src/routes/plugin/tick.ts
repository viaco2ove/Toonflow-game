import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { performPluginTickCore } from "@/lib/plugins/PluginTickCore";

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
 *
 * ★ v3.1（2026-11-14）：handler 全流程抽到 PluginTickCore.performPluginTickCore()——
 *   本路由与 WS TickDriver（PluginRealtimeHub）/ WS 动作共用**同一段**执行逻辑
 *   （指针自愈 / writeback 消费 / sessionNode 同步 / O1b 304 语义全部一致）。
 *   本文件只剩「HTTP 语义：校验 → 执行 → 回包」。行为不变性由回归脚本 R1~R5 把守。
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
    const userId = Number((req as any)?.user?.id || 0);
    const { status, payload } = await performPluginTickCore({
      userId,
      sessionId: String(req.body.sessionId || "").trim(),
      pluginId: String(req.body.pluginId || "").trim(),
      action: req.body.action,
      params: (req.body.params && typeof req.body.params === "object") ? req.body.params : {},
    });
    return res.status(status).send(payload);
  },
);
