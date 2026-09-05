import express from "express";

/**
 * 刷新流式响应头，确保浏览器能尽快收到 NDJSON 事件。
 *
 * - 用于流式接口（NDJSON）：res.flushHeaders() 触发 socket 立刻把 header 发出去；
 * - 之后 res.flush() 强制把已 write 的 body 推给浏览器，避免 Node 默认的 buffer 行为。
 *
 * 用法：见 writeStreamLine。
 */
export function flushStreamResponse(res: express.Response) {
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
  const anyRes = res as express.Response & { flush?: () => void };
  if (typeof anyRes.flush === "function") {
    anyRes.flush();
  }
}

/**
 * 向前端写入一条 NDJSON 流事件。
 *
 * 每个事件写成一行 JSON，后跟 `\n`，调用 flushStreamResponse 立即刷出 socket。
 * 前端用 fetch + ReadableStream.getReader() + buffer.split("\n") 即可逐行解析。
 */
export function writeStreamLine(res: express.Response, payload: Record<string, unknown>) {
  res.write(`${JSON.stringify(payload)}\n`);
  flushStreamResponse(res);
}

/**
 * 设置 NDJSON 流式响应头。
 *
 * 应在第一个 writeStreamLine 之前调用一次：
 *   - Content-Type: application/x-ndjson; charset=utf-8
 *   - Cache-Control: no-cache, no-transform
 *   - Connection: keep-alive
 *   - X-Accel-Buffering: no  （绕过 nginx 缓冲）
 */
export function setupNdjsonResponseHeaders(res: express.Response) {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
}
