/**
 * WS /plugin/realtime —— 插件实时全双工通道（2026-11-14，网络通信机制 v3.1）
 *
 * 设计：见 md/curr_design/toonflow-field-survival/网络通信/插件的网络通信机制_v3_1.md
 *   up:   {type:"tickParams", params} / {type:"action", actionId, action, params} / {type:"ping", ts}
 *   down: {type:"sync", state, ...} / {type:"push", state, actions, response, ts}
 *         {type:"ack", actionId, ok, response, serverTick, ts} / {type:"pong", ts}
 *
 * 复用既有模式：upgrade 走全局 JWT 中间件（query token，与 chatStoryboard WS 相同，
 * req.user 在 upgrade 请求上可用）；业务执行全部经 PluginTickCore（与 HTTP tick 同一段）。
 * 执行层/推送策略在 PluginRealtimeHub；本文件只做「连接准入 + 消息分发」。
 */
import express from "express";
import expressWs from "express-ws";
import { WebSocket } from "ws";
import { runWithRequestContext } from "@/lib/requestContext";
import {
  addRealtimeConnection,
  removeRealtimeConnection,
  updateRealtimeParams,
  performRealtimeAction,
  handleRealtimePing,
  checkUplinkRate,
  RealtimeScope,
} from "@/lib/plugins/PluginRealtimeHub";

const router = express.Router();
expressWs(router as unknown as express.Application);

/** Origin 白名单（v3.1 §5.5）：
 *  1) origin 的 hostname 与请求 host 的 hostname 相同（同机部署：web 8088 ↔ backend 60002）→ 放行
 *  2) localhost / 127.0.0.1 任意端口（本地开发）→ 放行
 *  3) env REALTIME_ALLOWED_ORIGINS（逗号分隔完整 origin）→ 放行
 *  其余（带 Origin 的跨站脚本）→ 拒绝（防 DNS rebinding / CSWSH）
 */
function originAllowed(origin: string | undefined, reqHost: string | undefined): boolean {
  if (!origin) return true; // 非浏览器客户端（node 测试脚本 / MCP agent）无 Origin
  try {
    const u = new URL(origin);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return true;
    if (reqHost) {
      const hostName = String(reqHost).split(":")[0];
      if (u.hostname === hostName) return true;
    }
    const extra = String(process.env.REALTIME_ALLOWED_ORIGINS || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    if (extra.includes(origin)) return true;
  } catch { /* 非法 origin */ }
  return false;
}

router.ws("/", (ws: WebSocket, req: any) => {
  const userId = Number(req?.user?.id || 0);
  const sessionId = String(req.query.sessionId || "").trim();
  const pluginId = String(req.query.pluginId || "").trim();

  const deny = (code: number, reason: string) => {
    try { ws.close(code, reason); } catch { /* ignore */ }
  };

  if (!Number.isFinite(userId) || userId <= 0) {
    deny(4001, "未登录"); return;
  }
  if (!sessionId || !pluginId) {
    deny(4002, "缺少 sessionId 或 pluginId"); return;
  }
  if (!originAllowed(req.headers.origin as string, req.headers.host as string)) {
    deny(4003, "Origin 不在白名单"); return;
  }

  const scope: RealtimeScope = { userId, sessionId, pluginId };
  addRealtimeConnection(scope, ws);
  console.log(`[plugin/realtime] 连接建立 session=${sessionId} plugin=${pluginId} origin=${req.headers.origin || "(无)"}`);

  ws.on("message", (raw: unknown) => {
    // ★ 2026-11-14 修复：ws message 回调不在 HTTP 中间件的 requestContext 里
    //   （AsyncLocalStorage 只包住 upgrade 那一次请求）→ getCurrentUserId() 返回 0
    //   → getPromptAi("storyMiniGameModel") 在 strictMode 下返回空配置
    //   → sys_chat 等动作报「请检查模型配置是否正确」。这里显式绑回上下文。
    runWithRequestContext({ userId }, () => {
      if (checkUplinkRate(scope, ws)) {
        deny(4008, "上行超频"); return;
      }
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return; // 非 JSON 忽略
      }
      const type = String(msg?.type || "");
      switch (type) {
        case "tickParams":
          // 帧 tick 参数整包 latest-wins（替代 10Hz HTTP 帧 tick；世界推进由 driver 驱动）
          updateRealtimeParams(scope, (msg.params && typeof msg.params === "object") ? msg.params : {});
          break;
        case "action":
          // 动作即时执行（不排队等帧 tick）；ack 异步回
          console.log(`[plugin/realtime] 动作 action=${String(msg.action || "")} sessionId=${sessionId} actionId=${String(msg.actionId || "")}`);
          void performRealtimeAction(
            scope,
            ws,
            String(msg.actionId || ""),
            String(msg.action || "").trim(),
            (msg.params && typeof msg.params === "object") ? msg.params : {},
          );
          break;
        case "ping":
          handleRealtimePing(ws, Number(msg.ts || Date.now()));
          break;
        default:
          break; // 未知类型静默忽略（向前兼容）
      }
    });
  });

  ws.on("close", () => {
    removeRealtimeConnection(scope, ws);
    console.log(`[plugin/realtime] 连接关闭 session=${sessionId} plugin=${pluginId}`);
  });
  ws.on("error", () => {
    // close 通常会跟随 error；这里只做防御性注销
    removeRealtimeConnection(scope, ws);
  });
});

export default router;
