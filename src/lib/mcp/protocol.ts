/**
 * MCP 协议基础层（2026-11-12，网络通信机制 v3 §3 / §10 M1）
 *
 * 依据 MCP 规范 2026-07-28（Streamable HTTP）：
 *   - 传输：每条 JSON-RPC 消息一次 POST；响应为 JSON 对象或 request-scoped SSE 流
 *   - 强制 header：MCP-Protocol-Version / Mcp-Method / Mcp-Name
 *   - body↔header 不一致 → 400 + JSON-RPC error（-32020 HeaderMismatch）
 *   - 缺失协议版本 header → 400 + UnsupportedProtocolVersionError
 *   - 未知方法 → 404 + JSON-RPC error（-32601）
 *   - GET / DELETE 旧 client → 405
 *   - Mcp-Session-Id：2026-07-28 已移除协议级 session → 忽略
 *
 * 本模块只做「协议层」：帧解析、header 校验、错误构造。
 * 业务（tools）见 mcp/tools.ts。
 */

/** 本实现支持的协议版本 */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"] as const;

/** 本实现声明的最新版本（用于 initialize 返回） */
export const LATEST_PROTOCOL_VERSION = "2026-07-28";

/** JSON-RPC 错误码 */
export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** 协议定义的：header ↔ body 不一致 */
  HEADER_MISMATCH: -32020,
} as const;

/** JSON-RPC 请求（客户端 → 服务端） */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 响应体 */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** 协议校验失败 → 带 HTTP 状态码与 JSON-RPC error */
export class McpProtocolError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly rpcCode: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpProtocolError";
  }
}

/** 构造 JSON-RPC error 响应 */
export function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/** 构造 JSON-RPC 成功响应 */
export function rpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

/**
 * 解析请求体 → JSON-RPC 请求。
 * 批量请求（数组）按规范应支持，但本实现只处理单条（AI client 都是单条）。
 */
export function parseJsonRpcRequest(body: unknown): JsonRpcRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new McpProtocolError(
      400,
      JSON_RPC_ERRORS.INVALID_REQUEST,
      "请求体必须是单个 JSON-RPC 请求对象",
    );
  }
  const raw = body as Record<string, unknown>;
  if (raw.jsonrpc !== "2.0") {
    throw new McpProtocolError(400, JSON_RPC_ERRORS.INVALID_REQUEST, "jsonrpc 字段必须是 \"2.0\"");
  }
  if (typeof raw.method !== "string" || !raw.method) {
    throw new McpProtocolError(400, JSON_RPC_ERRORS.INVALID_REQUEST, "缺少 method 字段");
  }
  const id =
    typeof raw.id === "string" || typeof raw.id === "number" ? raw.id : raw.id === null ? null : undefined;
  return {
    jsonrpc: "2.0",
    // id 缺省 = JSON-RPC 通知（notifications/*）→ 路由层回 202，不构造 JSON-RPC 响应；
    // id: null 是合法请求 → 必须保留 null 以便响应能带回 id:null。
    ...(id === undefined ? {} : { id }),
    method: raw.method,
    params:
      raw.params && typeof raw.params === "object" && !Array.isArray(raw.params)
        ? (raw.params as Record<string, unknown>)
        : undefined,
  };
}

/**
 * 校验协议 header（2026-07-28 §Request Metadata / §Server Validation）。
 *
 * @param headers  原始 header（已小写化由调用方保证）
 * @param body     已解析的请求体（用于 header↔body 一致性比对）
 */
export function validateProtocolHeaders(
  headers: Record<string, string | undefined>,
  body?: Record<string, unknown>,
): void {
  // ① 协议版本：缺失 → 400 UnsupportedProtocolVersionError。
  //    例外：initialize 是版本协商起点（版本在 body.params.protocolVersion 里声明，
  //    header 可缺省——2026-07-28 只要求 initialize 之后的请求必须带 header）。
  const isInitialize = body?.method === "initialize";
  const version = String(headers["mcp-protocol-version"] || "").trim()
    || (isInitialize
      ? String((body?.params as Record<string, unknown> | undefined)?.["protocolVersion"] || "").trim()
      : "");
  if (!version) {
    throw new McpProtocolError(
      400,
      JSON_RPC_ERRORS.INVALID_PARAMS,
      "缺少 MCP-Protocol-Version header",
      { supported: [...SUPPORTED_PROTOCOL_VERSIONS], error: "UnsupportedProtocolVersionError" },
    );
  }
  // initialize 是协商起点：客户端请求的版本不在支持清单时由 initialize 语义处理
  //（服务端返回自己支持的最新版本，客户端决定是否继续）——不在 header 层 400。
  // 之后的请求 header 版本不在清单内 → 400。
  if (!isInitialize && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    throw new McpProtocolError(
      400,
      JSON_RPC_ERRORS.INVALID_PARAMS,
      `不支持的协议版本：${version}`,
      { supported: [...SUPPORTED_PROTOCOL_VERSIONS], error: "UnsupportedProtocolVersionError" },
    );
  }
  // ② 版本与 body._meta 的协议版本必须一致
  const metaVersion = String(
    (body?.["_meta"] as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/protocolVersion"] ||
      "",
  ).trim();
  if (metaVersion && metaVersion !== version) {
    throw new McpProtocolError(
      400,
      JSON_RPC_ERRORS.HEADER_MISMATCH,
      "MCP-Protocol-Version header 与 body _meta 协议版本不一致",
      { header: version, body: metaVersion },
    );
  }

  // ③ Mcp-Method：必须与 body.method 一致
  const headerMethod = String(headers["mcp-method"] || "").trim();
  if (!headerMethod) {
    throw new McpProtocolError(
      400,
      JSON_RPC_ERRORS.INVALID_REQUEST,
      "缺少 Mcp-Method header",
    );
  }
  if (body && typeof body.method === "string" && headerMethod !== body.method) {
    throw new McpProtocolError(
      400,
      JSON_RPC_ERRORS.HEADER_MISMATCH,
      "Mcp-Method header 与 body.method 不一致",
      { header: headerMethod, body: body.method },
    );
  }

  // ④ Mcp-Name：仅 tools/call / resources/read / prompts/get 必填
  const method = typeof body?.method === "string" ? body.method : headerMethod;
  if (method === "tools/call" || method === "resources/read" || method === "prompts/get") {
    const headerName = String(headers["mcp-name"] || "").trim();
    if (!headerName) {
      throw new McpProtocolError(
        400,
        JSON_RPC_ERRORS.INVALID_REQUEST,
        `${method} 缺少 Mcp-Name header`,
      );
    }
    const bodyName = String(
      (body?.params as Record<string, unknown> | undefined)?.name ||
        (body?.params as Record<string, unknown> | undefined)?.uri ||
        "",
    ).trim();
    if (bodyName && headerName !== bodyName) {
      throw new McpProtocolError(
        400,
        JSON_RPC_ERRORS.HEADER_MISMATCH,
        "Mcp-Name header 与 body 参数不一致",
        { header: headerName, body: bodyName },
      );
    }
  }
}

/**
 * Origin 校验（2026-07-28 §Security & Endpoint）：
 *   Origin 存在且不在白名单 → 403。缺 Origin 放行（非浏览器 client）。
 */
export function validateOrigin(origin: string | undefined, allowed: string[]): void {
  const value = String(origin || "").trim();
  if (!value) return; // 非浏览器 client（AI agent）无 Origin
  const normalized = value.toLowerCase();
  const ok = allowed.some((a) => {
    const al = a.toLowerCase();
    if (al === "*") return true;
    if (al.endsWith("*")) return normalized.startsWith(al.slice(0, -1).toLowerCase());
    return normalized === al;
  });
  if (!ok) {
    throw new McpProtocolError(403, JSON_RPC_ERRORS.INVALID_REQUEST, `不允许的 Origin：${value}`);
  }
}

/**
 * 值编码：把 header 值转成 ASCII 安全形式。
 * 非 ASCII 或含控制字符 → Base64 sentinel（`=?base64?...?=`）。
 */
export function encodeHeaderValue(value: string): string {
  const v = String(value ?? "");
  // eslint-disable-next-line no-control-regex
  const isAsciiSafe = /^[\x20-\x7E]*$/.test(v) && !/^[=]|[?]$/.test(v.trim());
  if (isAsciiSafe) return v;
  return `=?base64?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

/** 值解码：识别并还原 Base64 sentinel */
export function decodeHeaderValue(value: string): string {
  const v = String(value ?? "").trim();
  if (v.startsWith("=?base64?") && v.endsWith("?=")) {
    const b64 = v.slice("=?base64?".length, -2);
    try {
      return Buffer.from(b64, "base64").toString("utf8");
    } catch {
      return v;
    }
  }
  return v;
}
