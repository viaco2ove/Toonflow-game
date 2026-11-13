/**
 * MCP endpoint —— AI agent 接入面（2026-11-12，网络通信机制 v3 §3 / §4 / §10 M1）
 *
 *   POST /plugin/mcp   （JSON-RPC over Streamable HTTP，MCP 2026-07-28）
 *
 * 规范要点（v3 §3，全部落实）：
 *   - 每条 JSON-RPC 消息一次 POST；响应为单个 JSON 对象（本实现不出 SSE）
 *   - 强制 header：MCP-Protocol-Version / Mcp-Method / Mcp-Name（tools/call 等）
 *     缺失 → 400；header↔body 不一致 → 400 + -32020 HeaderMismatch
 *   - initialize 走 body.params.protocolVersion 协商（header 可缺省——协商起点）
 *   - 未知方法 → 404 + -32601；GET / DELETE（旧 client 的 SSE/会话语义）→ 405
 *   - 通知（无 id 的请求，如 notifications/initialized）→ 202，无响应体
 *   - Mcp-Session-Id：协议级 session 已移除 → 收到即忽略
 *
 * 安全（M1-3 / M1-4）：
 *   - 鉴权复用 app 级 JWT 中间件（无 token → 401，见 app.ts 全局 auth）
 *   - 本 endpoint 只允许本机回环地址访问（AI client 全在本机）
 *   - Origin 校验：默认拒绝一切带 Origin 的请求（浏览器页面不是本 endpoint 的用户）；
 *     env MCP_ALLOWED_ORIGINS（逗号分隔）可放行指定来源
 *
 * 状态安全（v3 §5.1 红线）：tools/call 一律经 src/lib/mcp/tools.ts →
 *   PluginStateExecutor（与 /plugin/tick 共用内存态 + 会话串行锁），绝不在本层改 state。
 */
import express from "express";
import { getGameDb } from "@/lib/gameEngine";
import {
  rpcError,
  rpcResult,
  parseJsonRpcRequest,
  validateProtocolHeaders,
  validateOrigin,
  McpProtocolError,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  JSON_RPC_ERRORS,
  type JsonRpcRequest,
} from "@/lib/mcp/protocol";
import {
  listMcpTools,
  findMcpTool,
  runMcpTool,
  ToolBusinessError,
} from "@/lib/mcp/tools";
import {
  preparePluginExecutionContext,
  PluginSessionMissingError,
} from "@/lib/plugins/PluginExecutionContext";

const router = express.Router();

/** MCP server 标识（tools/list 与 initialize 返回） */
const SERVER_INFO = { name: "toonflow-plugin-mcp", title: "Toonflow 插件 MCP", version: "1.0.0" };

const SERVER_INSTRUCTIONS =
  "Toonflow 插件（野外生存）的 AI 接入面。先 tools/list 查看工具；" +
  "调用工具时 arguments.sessionId 填游戏会话 id（形如 gs_*）。" +
  "典型链路：query_state 感知世界 → kill_mob / spawn_entity / clear_effect 操作 → 再 query_state 确认。" +
  "所有写操作与玩家点击走同一条权威结算链，玩家画面会实时看到你的操作结果。";

/** 允许的 Origin 白名单（env MCP_ALLOWED_ORIGINS，逗号分隔；默认空 = 拒绝一切带 Origin 的请求） */
function allowedOrigins(): string[] {
  return String(process.env.MCP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** M1-3：只面向本机回环地址（AI client 全在本机；跨机访问直接 403） */
function isLoopback(req: express.Request): boolean {
  const ip = String((req.socket as any)?.remoteAddress || "");
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function sendRpc(res: express.Response, status: number, payload: unknown): void {
  res.status(status).json(payload);
}

function sendProtocolError(res: express.Response, err: McpProtocolError, id: string | number | null): void {
  sendRpc(res, err.httpStatus, rpcError(id, err.rpcCode, err.message, err.data));
}

/** M1-7：旧 client 的 GET（SSE 长流）/ DELETE（会话关闭）在 2026-07-28 已移除 → 405 */
function rejectLegacyTransport(req: express.Request, res: express.Response): void {
  res
    .status(405)
    .set("Allow", "POST")
    .json(rpcError(
      null,
      JSON_RPC_ERRORS.INVALID_REQUEST,
      `MCP 2026-07-28 不支持 ${req.method}（GET 长流与协议级 session 已移除）；请使用 POST 发送 JSON-RPC`,
    ));
}

router.get("/", (req, res) => rejectLegacyTransport(req, res));
router.delete("/", (req, res) => rejectLegacyTransport(req, res));
// 其余 HTTP 动词一律 405（本 endpoint 只有 POST 有意义）
router.all("/", (req, res, next) => {
  if (req.method === "POST") return next();
  return rejectLegacyTransport(req, res);
});

router.post("/", async (req, res) => {
  // ① M1-3：本机限定
  if (!isLoopback(req)) {
    return sendRpc(res, 403, rpcError(null, JSON_RPC_ERRORS.INVALID_REQUEST, "MCP endpoint 只允许本机（127.0.0.1）访问"));
  }
  // ② M1-4：Origin 校验（spec 强制项，防 DNS rebinding；AI client 不带 Origin → 放行）
  try {
    validateOrigin(req.headers.origin, allowedOrigins());
  } catch (e) {
    if (e instanceof McpProtocolError) return sendProtocolError(res, e, null);
    throw e;
  }
  // ③ Content-Type：spec 要求 application/json
  const ctype = String(req.headers["content-type"] || "");
  if (!/^application\/json/i.test(ctype.trim())) {
    return sendRpc(res, 415, rpcError(null, JSON_RPC_ERRORS.INVALID_REQUEST, "Content-Type 必须是 application/json"));
  }
  // ④ JSON-RPC 帧解析（-32600 / 形状校验）；JSON 语法错误在 app 级已回 -32700
  let rpc: JsonRpcRequest;
  try {
    rpc = parseJsonRpcRequest(req.body);
  } catch (e) {
    if (e instanceof McpProtocolError) return sendProtocolError(res, e, null);
    throw e;
  }
  // ⑤ 通知（无 id）→ 202：不回 JSON-RPC 响应（spec 要求；notifications/initialized 等）
  if (rpc.id === undefined) {
    return res.status(202).end();
  }
  // ⑥ M1-5 / M1-6：强制 header 校验（缺失 → 400；header↔body 不一致 → 400 + -32020）
  try {
    validateProtocolHeaders((req.headers as any) as Record<string, string | undefined>, rpc as any);
  } catch (e) {
    if (e instanceof McpProtocolError) return sendProtocolError(res, e, rpc.id ?? null);
    throw e;
  }

  // ── M1-8：方法分发 ──
  switch (rpc.method) {
    case "initialize": {
      // 版本协商：客户端请求版本在支持清单内 → 原样返回；否则返回服务端最新版本
      const requested = String((rpc.params as any)?.protocolVersion || "").trim();
      const negotiated = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;
      return sendRpc(res, 200, rpcResult(rpc.id ?? null, {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      }));
    }

    case "ping": {
      return sendRpc(res, 200, rpcResult(rpc.id ?? null, {}));
    }

    case "tools/list": {
      // ★ 工具来自注册表：宿主内置 + 各插件 manifest.contributes.mcpTools 声明
      //   （插件业务留在插件里，宿主零硬编码）
      const userId = Number((req as any)?.user?.id || 0);
      const reg = Number.isFinite(userId) && userId > 0
        ? await listMcpTools(userId)
        : [];
      return sendRpc(res, 200, rpcResult(rpc.id ?? null, {
        tools: reg.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      }));
    }

    case "tools/call": {
      const name = String((rpc.params as any)?.name || "").trim();
      const argsRaw = (rpc.params as any)?.arguments;
      const args = (argsRaw && typeof argsRaw === "object" && !Array.isArray(argsRaw))
        ? (argsRaw as Record<string, any>)
        : {};
      const userIdHint = Number((req as any)?.user?.id || 0);
      const tool = await findMcpTool(userIdHint, name, String(args.pluginId || "").trim() || undefined);
      if (!tool) {
        const reg = Number.isFinite(userIdHint) && userIdHint > 0 ? await listMcpTools(userIdHint) : [];
        const known = reg.map((t) => t.name).join(", ");
        return sendRpc(res, 400, rpcError(
          rpc.id ?? null,
          JSON_RPC_ERRORS.INVALID_PARAMS,
          `未知 tool：${name}（可用：${known}）`,
        ));
      }
      // M3-7：协议级参数校验 → JSON-RPC error（不是文本）
      const missing = tool.required.filter((k) => {
        const v = args[k];
        return v === undefined || v === null || (typeof v === "string" && !v.trim());
      });
      if (missing.length) {
        return sendRpc(res, 400, rpcError(
          rpc.id ?? null,
          JSON_RPC_ERRORS.INVALID_PARAMS,
          `缺少必填参数：${missing.join(", ")}`,
          { tool: tool.name, required: tool.required },
        ));
      }
      const sessionId = String(args.sessionId || args.session_id || "").trim();
      if (!sessionId) {
        return sendRpc(res, 400, rpcError(
          rpc.id ?? null,
          JSON_RPC_ERRORS.INVALID_PARAMS,
          "缺少必填参数：sessionId（游戏会话 id，形如 gs_*）",
        ));
      }
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return sendRpc(res, 401, rpcError(rpc.id ?? null, JSON_RPC_ERRORS.INVALID_REQUEST, "用户未登录（缺少有效 token）"));
      }

      // 业务执行：bootstrap（与 tick 同一份上下文构建）→ tool handler
      try {
        const boot = await preparePluginExecutionContext({
          userId,
          sessionId,
          pluginId: String(args.pluginId || "").trim(),
          db: getGameDb(),
        });
        // 指针守卫：会话正在进行的是另一个插件 → 拒绝（防跨插件注入操作）
        if (boot.statePluginId && boot.statePluginId !== boot.resolvedPluginId) {
          return sendRpc(res, 200, rpcResult(rpc.id ?? null, {
            content: [{ type: "text", text:
              `该会话进行中的小游戏是 ${boot.statePluginId}，不是 ${boot.resolvedPluginId}；` +
              `请先结束当前小游戏再操作，或换一个会话。` }],
            isError: true,
          }));
        }
        // ★ 工具归属检查：插件声明的工具只能在该插件的会话里调
        //   （host 内置工具不受限；pluginId 取会话解析结果）
        if (tool.owner !== "host" && tool.owner !== boot.resolvedPluginId) {
          return sendRpc(res, 200, rpcResult(rpc.id ?? null, {
            content: [{ type: "text", text:
              `工具 ${tool.name} 属于插件 ${tool.owner}，当前会话进行中的小游戏是 ${boot.resolvedPluginId}；` +
              `请先结束当前小游戏再操作，或换一个会话。` }],
            isError: true,
          }));
        }
        const out = await runMcpTool(
          { userId, sessionId, pluginId: boot.resolvedPluginId, boot, db: getGameDb() },
          tool,
          args,
        );
        return sendRpc(res, 200, rpcResult(rpc.id ?? null, {
          content: [{ type: "text", text: out.text }],
          ...(out.isError ? { isError: true } : {}),
          ...(out.data !== undefined ? { structuredContent: out.data } : {}),
        }));
      } catch (e) {
        // 会话不存在 → 业务失败（AI 可读），不是协议错误
        if (e instanceof PluginSessionMissingError) {
          return sendRpc(res, 200, rpcResult(rpc.id ?? null, {
            content: [{ type: "text", text: `会话 ${sessionId} 不存在：请确认 sessionId 是否来自当前故事会话。` }],
            isError: true,
          }));
        }
        if (e instanceof ToolBusinessError) {
          return sendRpc(res, 200, rpcResult(rpc.id ?? null, {
            content: [{ type: "text", text: e.message }],
            isError: true,
          }));
        }
        throw e;
      }
    }

    default: {
      // M1-9：未知方法 → 404 + -32601
      return sendRpc(res, 404, rpcError(
        rpc.id ?? null,
        JSON_RPC_ERRORS.METHOD_NOT_FOUND,
        `未知方法：${rpc.method}（支持：initialize / tools/list / tools/call / ping）`,
      ));
    }
  }
});

// Express 5 会把 async handler 的 rejection 交给错误处理中间件；这里兜一层，
// 把非预期异常转成 JSON-RPC -32603（而不是 HTML 错误页）。
router.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  return sendRpc(res, 500, rpcError(null, JSON_RPC_ERRORS.INTERNAL_ERROR, err?.message || "MCP 内部错误"));
});

export default router;
