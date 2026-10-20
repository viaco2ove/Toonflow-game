/**
 * ★ AI_TEXT_DEBUG_HTTP_REQ=1 的共享「HTTP 请求体落盘」工具（text / image 全厂商通用）。
 *
 * 背景：原来只有 text 路径（src/utils/ai/text/index.ts 的 createDebugFetch）在
 * AI_TEXT_DEBUG_HTTP_REQ=1 时 dump 请求体，且仅对「openai 兼容厂商」生效；
 * 生图路径（u.ai.image，axios / ai-sdk 直连）完全没接，导致调试插件
 * 「AI 生成实体形象」时看不到任何请求体。
 *
 * 本模块统一提供三个能力：
 *   ① reqDumpEnabled()           —— 环境变量开关
 *   ② dumpAiHttpRequest(label, …) —— 直接落盘一条请求（任意 HTTP 客户端通用）
 *   ③ createDebugFetchDump(…)     —— fetch 包装器（ai-sdk 各家厂商构造时注入 fetch 用）
 *
 * 落盘位置：AI_TEXT_DEBUG_HTTP_REQ_LOG_PATH（一个请求一个 JSON 文件）。
 * 注意：进程启动时读取环境变量（.env.local），改代码后需重启后端进程才生效。
 */
import fs from "fs";
import path from "path";

/** AI_TEXT_DEBUG_HTTP_REQ=1 且配置了 LOG_PATH 才落盘 */
export function reqDumpEnabled(): boolean {
  return (process.env.AI_TEXT_DEBUG_HTTP_REQ || "").trim() === "1"
    && !!String(process.env.AI_TEXT_DEBUG_HTTP_REQ_LOG_PATH || "").trim();
}

/** 控制台开关（沿用 text 路径的语义：LOG_LEVEL=DEBUG 或 AI_TEXT_DEBUG_HTTP=1） */
function consoleHttpDebugEnabled(): boolean {
  if ((process.env.AI_TEXT_DEBUG_HTTP || "").trim() === "1") return true;
  const debugEnv = (process.env.DEBUG_AI_TEXT || "").trim() === "1";
  const auto = (process.env.AI_TEXT_DEBUG_HTTP_AUTO || "1").trim() === "1";
  const logLevel = (process.env.LOG_LEVEL || "").trim().toUpperCase();
  return logLevel === "DEBUG" && debugEnv && auto;
}

function consoleVerbose(): boolean {
  return (process.env.AI_TEXT_DEBUG_HTTP_VERBOSE || "").trim() === "1";
}

/** 文件名安全化：路径分隔符/冒号等替换为下划线 */
function sanitizeLabel(label: string): string {
  return String(label || "unknown").replace(/[/:\\?%*|"<>]/g, "_").slice(0, 120);
}

/** Authorization 等敏感头脱敏（保留前缀，值打码） */
export function sanitizeHeaders(headers?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lower = k.toLowerCase();
    if (lower === "authorization" || lower === "api-key" || lower === "x-api-key") {
      out[k] = typeof v === "string" && v.length > 12 ? `${v.slice(0, 12)}***` : "***";
    } else {
      out[k] = v;
    }
  }
  return out;
}

function trimPreview(input: string, size = 4000): string {
  return input.length > size ? `${input.slice(0, size)}…[+${input.length - size} chars]` : input;
}

/** body 快照（用于 console 日志，避免直接打印超大二进制） */
function bodyPreview(body: unknown): string {
  if (body == null) return "";
  if (typeof body === "string") return trimPreview(body, 2000);
  if (body instanceof URLSearchParams) return trimPreview(body.toString(), 2000);
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(body)) return `[Buffer ${body.length}B] ${trimPreview(body.toString("utf8"), 2000)}`;
  if (body instanceof ArrayBuffer) return `[ArrayBuffer ${body.byteLength}B]`;
  if (ArrayBuffer.isView(body)) return `[TypedArray ${(body as any).byteLength}B]`;
  if (body instanceof FormData) return "[FormData]";
  try {
    return trimPreview(JSON.stringify(body), 2000);
  } catch {
    return "[unserializable body]";
  }
}

/** body 的落盘形态：JSON 优先解析为对象；FormData/Buffer 等降级为文本摘要 */
function normalizeDumpBody(body: unknown): unknown {
  if (body == null) return null;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return trimPreview(body, 20000);
    }
  }
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(body)) return trimPreview(body.toString("utf8"), 20000);
  if (body instanceof FormData) {
    const entries: Record<string, unknown> = {};
    for (const [k, v] of (body as any).entries()) entries[k] = v instanceof Blob ? `[Blob ${(v as Blob).size}B]` : String(v).slice(0, 500);
    return entries;
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const len = body instanceof ArrayBuffer ? body.byteLength : (body as any).byteLength;
    return `[binary ${len}B]`;
  }
  try {
    JSON.stringify(body);
    return body;
  } catch {
    return "[unserializable body]";
  }
}

export interface DumpEntry {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** 额外上下文（厂商 / 模型 / 调用来源等） */
  extra?: Record<string, unknown>;
}

/**
 * 落盘一条 HTTP 请求。AI_TEXT_DEBUG_HTTP_REQ=1 时有效，一个请求一个 JSON 文件：
 *   req_<timestamp>_<label>.json
 * 写失败只 console.error，不阻断业务。
 */
export function dumpAiHttpRequest(label: string, entry: DumpEntry): void {
  if (!reqDumpEnabled()) return;
  const dir = String(process.env.AI_TEXT_DEBUG_HTTP_REQ_LOG_PATH || "").trim();
  if (!dir) return;
  const file = path.join(dir, `req_${Date.now()}_${sanitizeLabel(label)}.json`);
  const dumpData = {
    _meta: {
      env: { AI_TEXT_DEBUG_HTTP_REQ: "1" },
      label,
      method: entry.method || "POST",
      url: entry.url || "",
      dumpedAt: new Date().toISOString(),
    },
    headers: sanitizeHeaders(entry.headers || {}),
    body: normalizeDumpBody(entry.body),
    ...(entry.extra ? { extra: entry.extra } : {}),
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(dumpData, null, 2), "utf-8");
  } catch (e: any) {
    console.error("[ai:req_dump] error:", e?.message || e);
  }
}

function headersToObject(headers?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (typeof (headers as Headers)?.forEach === "function" && !Array.isArray(headers)) {
    (headers as Headers).forEach((v, k) => { out[k] = v; });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) out[String(k)] = String(v);
    return out;
  }
  for (const [k, v] of Object.entries(headers as Record<string, string>)) out[String(k)] = String(v);
  return out;
}

/**
 * fetch 包装器：请求前落盘 + console 预览（开关与落盘开关独立）。
 * 用法：ai-sdk 厂商构造时 { fetch: createDebugFetchDump(label, agentName) }。
 */
export function createDebugFetchDump(label: string, agentName?: string): typeof fetch {
  const consoleDebug = consoleHttpDebugEnabled();
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const requestMethod =
      init?.method || (typeof input !== "string" && !(input instanceof URL) ? (input as Request).method : undefined) || "GET";
    const requestHeaders = headersToObject(
      init?.headers || (typeof input !== "string" && !(input instanceof URL) ? (input as Request).headers : undefined),
    );

    // AI_TEXT_DEBUG_HTTP_REQ=1：dump 真实 HTTP 请求体到文件（包含 URL/headers/body）
    dumpAiHttpRequest(`${label}${agentName ? `_${agentName}` : ""}`, {
      method: requestMethod,
      url: requestUrl,
      headers: requestHeaders,
      body: init?.body ?? (typeof input !== "string" && !(input instanceof URL) ? (input as Request).body : undefined),
      extra: { label, agent: agentName || "" },
    });

    if (consoleDebug) {
      console.log("[ai:http] request", {
        label,
        method: requestMethod,
        url: requestUrl,
        headers: requestHeaders,
        body: consoleVerbose() ? bodyPreview(init?.body) : bodyPreview(init?.body).slice(0, 2000),
      });
    }

    return fetch(input as any, init);
  };
}
