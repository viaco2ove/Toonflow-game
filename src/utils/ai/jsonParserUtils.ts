/**
 * AI 返回文本中的 JSON 解析工具
 *
 * 解决三个常见问题：
 *  1. 模型返回 ```json ... ``` 包裹的代码块
 *  2. 模型在 JSON 前后追加解释性文字（如 "下面是结果："）
 *  3. 模型返回的 JSON 不完整或含多余 token
 *
 * 用法：
 *  - parseModelJsonObject(rawText)         → 期望返回 JSON 对象 {}，返回 Record<string, unknown> | null
 *  - parseModelJsonArray(rawText)          → 期望返回 JSON 数组 []，返回 unknown[] | null
 *  - parseModelJson(rawText, "object"|"array") → 通用版
 */
import { parse } from "best-effort-json-parser";

/**
 * 去掉 markdown 代码块包裹，兼容模型偶尔返回 ```json 的情况。
 */
function unwrapMarkdownFence(input: unknown): string {
  return String(input ?? "")
    .replace(/^```[a-zA-Z]*\s*/g, "")
    .replace(/\s*```$/g, "")
    .trim();
}

/**
 * 用括号配平算法提取顶层 JSON 片段，跳过字符串内的括号。
 * 支持对象 {} 和数组 [] 两种顶层。
 */
function extractBalancedJson(
  text: string,
  type: "object" | "array",
): string | null {
  if (!text) return null;
  const openChar = type === "object" ? "{" : "[";
  const closeChar = type === "object" ? "}" : "]";
  const startIdx = text.indexOf(openChar);
  if (startIdx < 0) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = startIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === "\\") {
      escapeNext = true;
      continue;
    }
    if (ch === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === openChar) depth += 1;
    else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIdx, i + 1);
      }
    }
  }
  return null;
}

/**
 * 核心解析：按顺序尝试多种方式，提取一个 JSON 片段。
 *
 * @param type 期望的顶层类型 "object" 或 "array"
 * @returns 解析成功的原始 JSON 字符串，失败返回 null
 */
function tryExtractJsonString(rawText: unknown, type: "object" | "array"): string | null {
  const unwrapped = unwrapMarkdownFence(rawText);
  if (!unwrapped) return null;

  const openChar = type === "object" ? "{" : "[";
  const startsWithExpected = unwrapped.startsWith(openChar);

  // 方式1：直接 JSON.parse（最准确）
  if (startsWithExpected && (unwrapped.endsWith(type === "object" ? "}" : "]"))) {
    try {
      JSON.parse(unwrapped);
      return unwrapped; // 验证通过，原样返回
    } catch {
      // 继续往下
    }
  }

  // 方式2：括号配平算法（处理"前后有废话"的情况）
  const balanced = extractBalancedJson(unwrapped, type);
  if (balanced) {
    try {
      JSON.parse(balanced);
      return balanced;
    } catch {
      // 继续往下
    }
  }

  // 方式3：best-effort-json-parser（处理残缺/多余 token）
  try {
    const parsed = parse(unwrapped);
    if (parsed === null || parsed === undefined) return null;
    const isExpectedType = type === "object"
      ? typeof parsed === "object" && !Array.isArray(parsed)
      : Array.isArray(parsed);
    if (isExpectedType) {
      return JSON.stringify(parsed);
    }
  } catch {
    // 继续往下
  }

  return null;
}

/**
 * 解析模型返回文本为 JSON 对象 {}。
 * 自动剥离 markdown 围栏、忽略前后噪声文字。
 *
 * @returns 解析成功的对象，失败返回 null
 */
export function parseModelJsonObject(rawText: unknown): Record<string, unknown> | null {
  const jsonStr = tryExtractJsonString(rawText, "object");
  if (!jsonStr) return null;
  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * 解析模型返回文本为 JSON 数组 []。
 * 自动剥离 markdown 围栏、忽略前后噪声文字。
 *
 * @returns 解析成功的数组，失败返回 null
 */
export function parseModelJsonArray(rawText: unknown): unknown[] | null {
  const jsonStr = tryExtractJsonString(rawText, "array");
  if (!jsonStr) return null;
  try {
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * 旧名兼容：原 extractSellJsonObject 的行为，等价于 parseModelJsonObject。
 * 保留导出避免破坏外部调用。
 */
export function extractSellJsonObject(rawResponse: string): Record<string, unknown> | null {
  return parseModelJsonObject(rawResponse);
}
