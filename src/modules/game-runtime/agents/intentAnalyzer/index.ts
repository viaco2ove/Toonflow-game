/**
 * 意图分析 Agent — 主入口
 *
 * 流程：
 *  1) fast path: detectCommand() 正则匹配 (T1.1, < 5ms)
 *  2) slow path: AI 分类 (analyzeIntentWithAi, T3.x)
 *
 * T1 阶段只实现 fast path。T3 阶段补 AI 兜底链。
 */

import { detectCommand, INTENT_PATTERNS, type IntentLabel } from "./commandPatterns";
import { analyzeIntentWithAi, type IntentContext, type IntentResult, type IntentType } from "./IntentClassifier";

// 重新导出便于上层使用
export { detectCommand, INTENT_PATTERNS } from "./commandPatterns";
export type { IntentLabel } from "./commandPatterns";
export { analyzeIntentWithAi } from "./IntentClassifier";
export type { IntentContext, IntentResult, IntentType };

/**
 * 意图分析的统一入参。
 * 第一阶段只用 playerMessage，其他字段留作 AI 兜底阶段使用。
 */
export interface IntentAnalyzerContext extends IntentContext {}

/**
 * 意图分析统一返回。
 * 第一阶段只可能返回 confidence = 1.0（命令命中）；AI 兜底阶段会返回 0~1 的置信度。
 */
export interface IntentAnalyzerResult {
  intent: IntentLabel | IntentType;
  confidence: number;
  params: Record<string, string | null | unknown>;
  reasoning?: string;
  path: "command" | "ai" | "fallback";
}

/**
 * 第一阶段实现的 fast path 意图分析。
 *
 * 命中命令：返回 { intent, confidence: 1.0, params }
 * 未命中命令：返回 null（第二阶段会接 AI 兜底链）
 */
export function analyzeIntent(ctx: IntentAnalyzerContext): IntentAnalyzerResult | null {
  const message = String(ctx.playerMessage || "").trim();
  if (!message) return null;
  const result = detectCommand(message);
  if (result) {
    return {
      intent: result.intent as IntentLabel,
      confidence: result.confidence,
      params: result.params,
      path: "command",
    };
  }
  return null;
}

/**
 * T3 阶段实现的 slow path 意图分析（AI 兜底）。
 *
 * 命令未命中 → analyzeIntentWithAi → 用户配置的模型 → normal_dialog 兜底
 */
export async function analyzeIntentWithAiFallback(
  ctx: IntentAnalyzerContext,
): Promise<IntentAnalyzerResult> {
  const result = await analyzeIntentWithAi(ctx);
  return {
    intent: result.intent as IntentLabel | IntentType,
    confidence: result.confidence,
    reasoning: result.reasoning,
    params: result.params as Record<string, string | null>,
    path: result.path,
  };
}