import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { getGameDb } from "@/lib/gameEngine";
import {
  getPluginData,
  setPluginData,
  listPluginDataKeys,
  removePluginData,
} from "@/lib/plugins/PluginSessionDataService";

const router = express.Router();

/**
 * 插件会话数据接口（前端 toonflowJsApi 的 pluginData 走这里）：
 *
 *   POST /plugin/data { sessionId, pluginId, op: get|set|list|remove, dataKey?, value? }
 *
 * 数据存 t_plugin_session_data（userId × sessionId × pluginId × dataKey），
 * 与故事动态数据（stateJson）解耦——编排复写 stateJson 不影响插件数据。
 */
export default router.post(
  "/",
  validateFields({
    sessionId: z.string(),
    pluginId: z.string(),
    op: z.enum(["get", "set", "list", "remove"]),
    dataKey: z.string().optional().nullable(),
    value: z.any().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }
      const sessionId = String(req.body.sessionId || "").trim();
      const pluginId = String(req.body.pluginId || "").trim();
      const op = String(req.body.op || "").trim();
      const dataKey = String(req.body.dataKey || "").trim();
      const value = req.body.value;

      if (!sessionId || !pluginId) {
        return res.status(400).send(error("sessionId/pluginId 必填"));
      }

      // 会话归属校验（防跨会话读写）
      const db = getGameDb();
      const session = await db("t_gameSession").where({ sessionId, userId }).first();
      if (!session) return res.status(404).send(error("会话不存在"));

      const scope = { userId, sessionId, pluginId };

      if (op === "get") {
        if (!dataKey) return res.status(400).send(error("dataKey 必填"));
        const entry = await getPluginData(scope, dataKey);
        return res.status(200).send(
          success({ dataKey, value: entry ? entry.dataValue : null, updatedAt: entry?.updatedAt || 0 })
        );
      }
      if (op === "set") {
        if (!dataKey) return res.status(400).send(error("dataKey 必填"));
        await setPluginData(scope, dataKey, value);
        return res.status(200).send(success({ dataKey, value: null, ok: true }));
      }
      if (op === "list") {
        const keys = await listPluginDataKeys(scope);
        return res.status(200).send(success({ keys, dataKey: "", value: null }));
      }
      if (op === "remove") {
        if (!dataKey) return res.status(400).send(error("dataKey 必填"));
        await removePluginData(scope, dataKey);
        return res.status(200).send(success({ dataKey, value: null, ok: true }));
      }
      return res.status(400).send(error("未知 op"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || "插件数据操作失败");
      return res.status(500).send(error(message));
    }
  },
);