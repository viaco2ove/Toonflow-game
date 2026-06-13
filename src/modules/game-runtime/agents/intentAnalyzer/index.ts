/**
 * 意图分析 Agent — 主入口
 *
 * 流程：
 *  1) fast path: detectCommand() 正则匹配 (T1.1, < 5ms)
 *  2) slow path: AI 兜底 (T3.x 后续阶段，未命中命令时调用)
 *
 * 第一阶段只实现 fast path。第二阶段补 AI 兜底链。
 */

import { detectCommand, type IntentCommand, type IntentLabel } from "./commandPatterns";

// 重新导出便于上层使用
export { detectCommand, INTENT_PATTERNS } from "./commandPatterns";
export type { IntentCommand, IntentLabel } from "./commandPatterns";

/**
 * 意图分析的统一入参。
 * 第一阶段只用 playerMessage，其他字段留作 AI 兜底阶段使用。
 */
export interface IntentContext {
  userId: number;
  playerMessage: string;
  /** 最近的对话历史（AI 兜底阶段用） */
  recentMessages?: Array<{ role?: string | null; content?: string | null }>;
  /** 当前活跃任务（context aware 用） */
  activeTaskId?: string | null;
  /** 章节信息（context aware 用） */
  chapterTitle?: string | null;
}

/**
 * 意图分析统一返回。
 * 第一阶段只可能返回 confidence = 1.0（命令命中）；AI 兜底阶段会返回 0~1 的置信度。
 */
export interface IntentResult extends IntentCommand {}

/**
 * 第一阶段实现的 fast path 意图分析。
 *
 * 命中命令：返回 { intent, confidence: 1.0, params }
 * 未命中命令：返回 null（第二阶段会接 AI 兜底链）
 */
export function analyzeIntent(ctx: IntentContext): IntentResult | null {
  const message = String(ctx.playerMessage || "").trim();
  if (!message) return null;
  return detectCommand(message);
}

/**
 * 第二阶段预留入口：AI 兜底链。
 * 暂未实现，返回 null 表示"不确定，按 normal_dialog 处理"。
 */
export async function analyzeIntentWithAi(ctx: IntentContext): Promise<IntentResult | null> {
  // TODO(T3.x): 接入 m3e-small / Qwen2.5-1.5B / 3B 兜底
  void ctx;
  return null;
}