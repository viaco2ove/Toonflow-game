/**
 * 任务完成评估器 Agent (TaskCompletionAgent)
 *
 * 每轮编排都调用一次。它自己决定 decision: success | failed | continue。
 * - success：任务真正完成（即使阶段未全 [s]，AI 也可以判完成）
 * - failed：任务失败（玩家死亡、放弃、无法继续）
 * - continue：任务还在进行中
 *
 * 关键信号：
 * - 玩家输入"完成任务""提交任务""结算" → 强烈倾向判 success（如果上下文支持）
 * - 玩家输入"放弃""退出""不做了" → 强烈倾向判 failed
 * - 其他情况 → 综合上下文决定
 */

import u from "@/utils";
import { z } from "zod";
import { loadTaskPrompt } from "./loadTaskPrompt";

const FALLBACK_SYSTEM = `你是任务完成评估器。输出严格JSON。

# 决策（必填）
- decision: "success" | "failed" | "continue"
  - success: 任务核心目标已达成（玩家明确完成、提交、达成成功条件）
  - failed: 任务无法继续（玩家放弃、死亡、触发失败条件）
  - continue: 任务仍在进行

# 完成度评级（仅在 decision=success/failed 时使用）
- 完美完成：达成核心目标，无重大失误
- 良好完成：达成核心目标，有小瑕疵
- 基本完成：完成主要目标，偏离计划
- 未完成：未达成核心目标
- 失败：主动放弃或无法继续

# 重要规则
1. 玩家输入"完成任务""提交任务""结算""任务结束""收工""交差" → 倾向 success（必须实际剧情已完成）
2. 玩家输入"放弃""退出""不做了""算了""撤退" → 判 failed
3. 任务核心目标已达成（如找到目标 NPC、击败 BOSS、获取关键物品）→ 判 success
4. 仅闲聊、探索、推进 → 判 continue
5. narration 末尾必须包含 @用户名/@NPC 名 关系/状态变化陈述，让记忆管理器写回参数卡

# 输出格式（严格 JSON）
{"decision":"success|failed|continue","level":"评级","statement":"结果","analysis":"分析","highlights":["亮点1"],"lessons":["教训1"],"suggestion":"建议","narration":"完整旁白"}

continue 时 level/narration/statement 可以填空字符串。`;

export type CompletionDecision = "success" | "failed" | "continue";
export type CompletionLevel = "perfect" | "good" | "basic" | "incomplete" | "failed";

export interface CompletionResult {
  decision: CompletionDecision;
  level: CompletionLevel;
  statement: string;
  analysis: string;
  highlights: string[];
  lessons: string[];
  suggestion: string;
  narration: string;
}

const AI_SCHEMA = z.object({
  decision: z.enum(["success", "failed", "continue"]).optional(),
  level: z.enum(["完美完成", "良好完成", "基本完成", "未完成", "失败"]).optional(),
  statement: z.string().optional(),
  analysis: z.string().optional(),
  highlights: z.array(z.string()).optional(),
  lessons: z.array(z.string()).optional(),
  suggestion: z.string().optional(),
  narration: z.string().optional(),
});

const LEVEL_MAP: Record<string, CompletionLevel> = {
  "完美完成": "perfect",
  "良好完成": "good",
  "基本完成": "basic",
  "未完成": "incomplete",
  "失败": "failed",
};

async function evalAi(
  triggerHint: string,
  objective: string,
  processText: string,
  dialogue: string,
  message: string,
  npcCards: string,
  originalGlobalBackground: string,
  dynamicGlobalBackground: string,
  userId: number,
): Promise<CompletionResult> {
  const systemPrompt = await loadTaskPrompt("task-completion-agent", FALLBACK_SYSTEM);

  const userPrompt = `任务目标：${objective}

当前推进过程：
${processText || "（无）"}

历史对话：${dialogue || "无"}

玩家本轮输入：${message}

触发提示：${triggerHint || "（常规每轮评估）"}

角色动态参数卡列表：
${npcCards || "（无可用角色参数卡）"}

故事初始全局背景描述：
${originalGlobalBackground || "（无）"}

故事动态全局背景描述：
${dynamicGlobalBackground || "（无）"}

请综合判断 decision：
- 如果"玩家本轮输入"明确表达完成/提交/结算 → 倾向 success
- 如果明确表达放弃/退出 → judge failed
- 否则根据剧情综合判断
- 大多数普通推进 → continue

请输出严格JSON：
{"decision":"success|failed|continue","level":"评级","statement":"结果","analysis":"分析","highlights":["亮点1"],"lessons":["教训1"],"suggestion":"建议","narration":"完整旁白文本（success/failed 时末尾要带 @用户/@NPC 关系陈述）"}`;

  console.log("[story:mini_game:task:completion:runtime] request", JSON.stringify({
    userId,
    triggerHint,
    objective: String(objective || "").slice(0, 200),
    messagePreview: String(message || "").slice(0, 100),
    systemPromptChars: systemPrompt.length,
    userPromptChars: userPrompt.length,
  }));
  console.log("[story:mini_game:task:completion:runtime] full_user_prompt:", userPrompt.replace(/\n/g, "↩"));

  const startedAt = Date.now();
  try {
    const modelConfig = await u.getPromptAi("storyMemoryModel", userId);
    const result = await u.ai.text.invoke({
      plainTextOutput: true,
      usageType: "任务完成评估",
      usageRemark: "TaskCompletionAgent",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }, modelConfig as any) as any;

    const rawText = String(result?.text || "").trim();
    const latencyMs = Date.now() - startedAt;
    console.log("[story:mini_game:task:completion:runtime] response", JSON.stringify({
      rawTextPreview: rawText.slice(0, 200),
      latencyMs,
    }));

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[TaskCompletionAgent] AI 未返回 JSON：", rawText.slice(0, 200));
      console.log(`[story:mini_game:task:completion:stats] status=json_not_found decision=continue latency_ms=${latencyMs}`);
      return buildContinueDefault();
    }
    let obj: any;
    try {
      obj = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.warn("[TaskCompletionAgent] JSON 解析失败：", e);
      console.log(`[story:mini_game:task:completion:stats] status=parse_error decision=continue latency_ms=${latencyMs}`);
      return buildContinueDefault();
    }
    const parsed = AI_SCHEMA.safeParse(obj);
    if (!parsed.success) {
      console.warn("[TaskCompletionAgent] schema 校验失败：", parsed.error);
      console.log(`[story:mini_game:task:completion:stats] status=schema_error decision=continue latency_ms=${latencyMs}`);
      return buildContinueDefault();
    }
    const d = parsed.data;
    const decision: CompletionDecision = (d.decision === "success" || d.decision === "failed" || d.decision === "continue")
      ? d.decision
      : "continue";
    const level: CompletionLevel = (d.level && LEVEL_MAP[d.level]) || (decision === "failed" ? "failed" : decision === "success" ? "good" : "incomplete");

    console.log(`[story:mini_game:task:completion:stats] decision=${decision} level=${level} latency_ms=${latencyMs}`);

    return {
      decision,
      level,
      statement: d.statement || "",
      analysis: d.analysis || "",
      highlights: d.highlights || [],
      lessons: d.lessons || [],
      suggestion: d.suggestion || "",
      narration: d.narration || "",
    };
  } catch (e) {
    console.error("[TaskCompletionAgent] AI调用失败", e);
    console.log(`[story:mini_game:task:completion:stats] status=exception decision=continue error=${(e as Error)?.message}`);
    return buildContinueDefault();
  }
}

function buildContinueDefault(): CompletionResult {
  return {
    decision: "continue",
    level: "incomplete",
    statement: "",
    analysis: "",
    highlights: [],
    lessons: [],
    suggestion: "",
    narration: "",
  };
}

function buildAbandonDefault(objective: string): CompletionResult {
  return {
    decision: "failed",
    level: "failed",
    statement: "任务失败。",
    analysis: "玩家主动放弃。",
    highlights: [],
    lessons: [],
    suggestion: "可以选择新任务重新开始。",
    narration: `你选择了放弃任务【${objective || "进行中的任务"}】。\n并非每一次冒险都必须走到终点，及时止损也是一种智慧。\n接下来可以选择新任务，或继续自由探索。`,
  };
}

/**
 * 每轮编排都调用一次的入口。
 *
 * - triggerHint：调用方可以提示触发原因，如 "用户输入完成任务"，让 AI 偏向判 success。
 * - 调用方根据 result.decision 决定走结算 / 继续推进。
 */
export async function evaluateTaskCompletion(
  finalStatus: "abandon" | "success" | "failed" | "auto",
  task: { title?: string; objective?: string; process?: string | string[] },
  dialogue: Array<{ role: string; content: string }>,
  message: string,
  progressLevel: string,
  userId: number,
  npcCards: string = "",
  originalGlobalBackground: string = "",
  dynamicGlobalBackground: string = "",
): Promise<CompletionResult> {
  const hist = dialogue.slice(-20).map(d => `${d.role}:${String(d.content || "").slice(0, 60)}`).join("|");

  // 主动放弃直接走默认（用户已明确放弃）
  if (finalStatus === "abandon") {
    return buildAbandonDefault(task?.objective || "");
  }

  // 触发提示
  let triggerHint = "";
  if (finalStatus === "success") triggerHint = "调用方提示：玩家可能已完成任务";
  else if (finalStatus === "failed") triggerHint = "调用方提示：任务可能已失败";
  else triggerHint = `每轮自动评估（推进等级：${progressLevel}）`;

  const processText = typeof task?.process === "string"
    ? task.process
    : Array.isArray(task?.process)
      ? task.process.join("；")
      : "";

  return evalAi(
    triggerHint,
    task?.objective || "无",
    processText,
    hist,
    message,
    npcCards,
    originalGlobalBackground,
    dynamicGlobalBackground,
    userId,
  );
}
