/**
 * WS /game/realtimeClock —— 世界时钟推送通道（2026-11-16，用户需求「getWorldClock 改 WS，不要高频请求」）
 *
 *   up:   {type:"ping", ts}                    保活
 *   down: {type:"clock", timeMode, weatherMode, worldClock, serverTime, isFreeMode, ts}
 *         连接建立立即推一次；此后仅在值变化时推（见 worldClockHub）
 *
 * 准入与 /plugin/realtime 同模式：全局 JWT（query token）+ Origin 白名单。
 * 前端 WS 不可用时回退 HTTP /game/getWorldClock 轮询（ScenePlay 现有逻辑保留为兜底）。
 */
import express from "express";
import expressWs from "express-ws";
import { WebSocket } from "ws";
import { addClockConnection, removeClockConnection, clockHubStats } from "@/lib/worldClockHub";

const router = express.Router();
expressWs(router as unknown as express.Application);

function originAllowed(origin: string | undefined, reqHost: string | undefined): boolean {
  if (!origin) return true; // 非浏览器客户端无 Origin
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

  const deny = (code: number, reason: string) => {
    try { ws.close(code, reason); } catch { /* ignore */ }
  };

  if (!Number.isFinite(userId) || userId <= 0) {
    deny(4001, "未登录"); return;
  }
  if (!sessionId) {
    deny(4002, "缺少 sessionId"); return;
  }
  if (!originAllowed(req.headers.origin as string, req.headers.host as string)) {
    deny(4003, "Origin 不在白名单"); return;
  }

  addClockConnection(userId, sessionId, ws);
  console.log(`[game/realtimeClock] 连接建立 session=${sessionId} origin=${req.headers.origin || "(无)"} stats=${JSON.stringify(clockHubStats())}`);

  ws.on("message", (raw: unknown) => {
    let m: any;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m?.type === "ping") {
      try { ws.send(JSON.stringify({ type: "pong", ts: Date.now() })); } catch { /* ignore */ }
    }
  });

  ws.on("close", () => {
    removeClockConnection(userId, sessionId, ws);
    console.log(`[game/realtimeClock] 连接关闭 session=${sessionId} stats=${JSON.stringify(clockHubStats())}`);
  });
  ws.on("error", () => {
    try { ws.close(); } catch { /* ignore */ }
  });
});

/** HTTP 调试端点：看订阅规模 */
router.get("/stats", (_req: any, res: any) => {
  res.send({ code: 200, data: clockHubStats(), message: "ok" });
});

export default router;
