import { NextFunction, Request, Response } from "express";
import { gzip } from "zlib";

const DEFAULT_JSON_GZIP_MIN_BYTES = 4 * 1024;
const JSON_GZIP_ROUTE_PREFIXES = [
  "/assets/",
  "/game/",
  "/novel/",
  "/other/",
  "/outline/",
  "/project/",
  "/prompt/",
  "/script/",
  "/setting/",
  "/storyboard/",
  "/task/",
  "/user/",
  "/video/",
  "/voice/",
];

/**
 * 读取 JSON gzip 的最小压缩阈值。
 *
 * 用途：
 * - 允许通过环境变量按部署环境调整压缩触发点；
 * - 当配置缺失、非法或过小的时候，自动回退到稳定默认值，避免线上行为失控。
 */
function getJsonGzipMinBytes(): number {
  const rawValue = Number(process.env.JSON_GZIP_MIN_BYTES);
  if (!Number.isFinite(rawValue)) {
    return DEFAULT_JSON_GZIP_MIN_BYTES;
  }
  const normalizedValue = Math.floor(rawValue);
  if (normalizedValue < 256) {
    return DEFAULT_JSON_GZIP_MIN_BYTES;
  }
  return normalizedValue;
}

/**
 * 判断当前请求是否声明支持 gzip 压缩。
 *
 * 用途：
 * - 只在客户端显式声明 `Accept-Encoding: gzip` 时启用压缩；
 * - 避免对不支持 gzip 的调用方返回不可解析的响应体。
 */
function acceptsGzip(req: Request): boolean {
  const acceptEncoding = String(req.headers["accept-encoding"] || "").toLowerCase();
  return acceptEncoding.includes("gzip");
}

/**
 * 判断当前响应是否适合进行 JSON gzip 压缩。
 *
 * 用途：
 * - 跳过已经带有 Content-Encoding 的响应，避免重复压缩；
 * - 跳过流式、文件、二进制等非 JSON 响应，避免破坏原始输出格式；
 * - 仅对 `/game/*` 等 API 请求启用，避免影响静态资源与 HTML 页面。
 */
function shouldHandleJsonCompression(req: Request, res: Response): boolean {
  if (req.method.toUpperCase() === "HEAD") {
    return false;
  }
  if (!acceptsGzip(req)) {
    return false;
  }
  if (res.getHeader("Content-Encoding")) {
    return false;
  }
  return JSON_GZIP_ROUTE_PREFIXES.some((prefix) => req.path.startsWith(prefix));
}

/**
 * 把对象序列化为和 Express JSON 响应尽量一致的文本。
 *
 * 用途：
 * - 兼容现有大量 `res.send(success(...))` 的写法；
 * - 在进入 gzip 前先稳定得到 JSON 文本长度，以便统一判断是否值得压缩。
 */
function serializeJsonBody(res: Response, body: unknown): string {
  const jsonReplacer = res.app.get("json replacer");
  const jsonSpaces = res.app.get("json spaces");
  return JSON.stringify(body, jsonReplacer, jsonSpaces);
}

/**
 * 尝试从响应内容中抽取可压缩的 JSON 文本。
 *
 * 用途：
 * - 对 `res.send(object)`、`res.json(object)` 统一处理；
 * - 对已经是 JSON 字符串的响应，在 Content-Type 明确为 JSON 时继续复用。
 */
function getJsonPayload(res: Response, body: unknown): string | null {
  if (body === null || body === undefined) {
    return null;
  }
  if (Buffer.isBuffer(body)) {
    return null;
  }
  if (typeof body === "object") {
    return serializeJsonBody(res, body);
  }
  if (typeof body !== "string") {
    return null;
  }

  const contentType = String(res.getHeader("Content-Type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    return body;
  }
  return null;
}

/**
 * 为大体积 JSON API 响应追加 gzip 压缩。
 *
 * 用途：
 * - 优先覆盖 `/game/getSession` 这类消息量大的接口；
 * - 统一覆盖其他大型 JSON API，降低传输体积和前端等待时间；
 * - 仅在响应体达到阈值后压缩，避免小包体因压缩反而增加 CPU 开销。
 */
export function jsonGzipMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!shouldHandleJsonCompression(req, res)) {
    return next();
  }

  const originalSend = res.send.bind(res);
  const jsonGzipMinBytes = getJsonGzipMinBytes();
  /**
   * 压缩并发送 JSON 响应。
   *
   * 用途：
   * - 复用同一套压缩判断逻辑，避免 `send/json` 两条分支行为不一致；
   * - 在压缩失败时回退原始响应，保证接口可用性优先。
   */
  function sendCompressedJson(body: unknown) {
    const payload = getJsonPayload(res, body);
    if (payload === null) {
      return originalSend(body as any);
    }

    const payloadBuffer = Buffer.from(payload, "utf8");
    if (payloadBuffer.byteLength < jsonGzipMinBytes) {
      if (!res.getHeader("Content-Type")) {
        res.type("application/json; charset=utf-8");
      }
      return originalSend(payload);
    }

    res.setHeader("Vary", "Accept-Encoding");
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    gzip(payloadBuffer, (gzipError, compressedBuffer) => {
      if (res.headersSent) {
        return;
      }
      if (gzipError || !compressedBuffer) {
        console.warn("[jsonGzip] gzip failed, fallback to plain json", {
          path: req.path,
          message: gzipError?.message || "unknown gzip error",
        });
        originalSend(payload);
        return;
      }

      // 发送压缩体前移除旧长度，避免沿用未压缩内容长度导致客户端截断读取。
      res.removeHeader("Content-Length");
      res.setHeader("Content-Encoding", "gzip");
      originalSend(compressedBuffer);
    });

    return res;
  }

  res.send = ((body: unknown) => sendCompressedJson(body)) as typeof res.send;
  res.json = ((body: unknown) => sendCompressedJson(body)) as typeof res.json;
  return next();
}
