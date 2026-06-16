/**
 * 任务完成评估器 Agent (TaskCompletionAgent)
 *
 * 评估任务完成度并生成总结旁白
 */

import u from "@/utils";
import { z } from "zod";
import { loadTaskPrompt } from "./loadTaskPrompt";

const FALLBACK_SYSTEM = `你是任务完成评估器。输出严格JSON。

# 完成度评级
- 完美完成：达成核心目标，无重大失误
- 良好完成：达成核心目标，有小瑕疵
- 基本完成：完成主要目标，偏离计划
- 未完成：未达成核心目标
- 失败：主动放弃或无法继续

# 旁白结构
1. 结果陈述
2. 原因分析
3. 亮点提取（可选）
4. 教训提取（可选）
5. 后续建议
6. 完整旁白（讲述者视角回顾冒险）

# 输出
{"level":"评级","statement":"结果","analysis":"分析","highlights":["亮点1"],"lessons":["教训1"],"suggestion":"建议","narration":"完整旁白"}`;

export type CompletionLevel = "perfect" | "good" | "basic" | "incomplete" | "failed";

export interface CompletionResult {
  level: CompletionLevel;
  statement: string;
  analysis: string;
  highlights: string[];
  lessons: string[];
  suggestion: string;
  narration: string;
}

const AI_SCHEMA = z.object({
  level: z.enum(["完美完成", "良好完成", "基本完成", "未完成", "失败"]),
  statement: z.string(),
  analysis: z.string(),
  highlights: z.array(z.string()).optional(),
  lessons: z.array(z.string()).optional(),
  suggestion: z.string(),
  narration: z.string(),
});

const LEVEL_MAP: Record<string, CompletionLevel> = {
  "完美完成": "perfect",
  "良好完成": "good",
  "基本完成": "basic",
  "未完成": "incomplete",
  "失败": "failed",
};

async function evalAi(
  finalStatus: string,
  objective: string,
  dialogue: string,
  message: string,
  progressLevel: string,
  userId: number,
): Promise<CompletionResult> {
  const systemPrompt = await loadTaskPrompt("task-completion-agent", FALLBACK_SYSTEM);

  const userPrompt = `最终状态：${finalStatus}
目标：${objective}
历史：${dialogue || "无"}
玩家输入：${message}
推进等级：${progressLevel}`;

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
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[TaskCompletionAgent] AI 未返回 JSON：", rawText.slice(0, 200));
      return buildDefault("failed", objective);
    }
    let obj: any;
    try {
      obj = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.warn("[TaskCompletionAgent] JSON 解析失败：", e);
      return buildDefault("failed", objective);
    }
    const parsed = AI_SCHEMA.safeParse(obj);
    if (!parsed.success) {
      console.warn("[TaskCompletionAgent] schema 校验失败：", parsed.error);
      return buildDefault("failed", objective);
    }
    const d = parsed.data;
    return {
      level: LEVEL_MAP[d.level] || "basic",
      statement: d.statement,
      analysis: d.analysis,
      highlights: d.highlights || [],
      lessons: d.lessons || [],
      suggestion: d.suggestion,
      narration: d.narration,
    };
  } catch (e) {
    console.error("[TaskCompletionAgent] AI调用失败", e);
    return buildDefault("failed", objective);
  }
}

function buildDefault(level: CompletionLevel, objective: string): CompletionResult {
  const templates: Record<CompletionLevel, CompletionResult> = {
    perfect: {
      level: "perfect",
      statement: "任务完美完成！",
      analysis: "玩家出色地完成了所有目标。",
      highlights: [],
      lessons: [],
      suggestion: "继续探索更多精彩内容。",
      narration: `任务完美完成！
${objective}
你出色地达成了所有目标。`,
    },
    good: {
      level: "good",
      statement: "任务完成！",
      analysis: "玩家成功完成了任务目标。",
      highlights: [],
      lessons: [],
      suggestion: "可以继续任务或开始新挑战。",
      narration: `任务完成！
恭喜你完成了：${objective}`,
    },
    basic: {
      level: "basic",
      statement: "任务基本完成。",
      analysis: "玩家完成了主要目标。",
      highlights: [],
      lessons: [],
      suggestion: "总结经验可以做得更好。",
      narration: `任务基本完成。
${objective}`,
    },
    incomplete: {
      level: "incomplete",
      statement: "任务未完成。",
      analysis: "玩家未能达成核心目标。",
      highlights: [],
      lessons: ["下次可以更专注于任务目标"],
      suggestion: "总结教训，重新挑战。",
      narration: `任务未能完成。
不要气馁，总结经验下次会做得更好。`,
    },
    failed: {
      level: "failed",
      statement: "任务失败。",
      analysis: "玩家主动放弃或任务无法继续。",
      highlights: [],
      lessons: [],
      suggestion: "可以选择新任务重新开始。",
      narration: `你选择了放弃任务。
并非每一次冒险都必须走到终点，及时止损也是一种智慧。
接下来可以选择新任务，或继续自由探索。`,
    },
  };
  return templates[level];
}

export async function evaluateTaskCompletion(
  finalStatus: "abandon" | "success" | "failed",
  task: { title?: string; objective?: string },
  dialogue: Array<{ role: string; content: string }>,
  message: string,
  progressLevel: string,
  userId: number,
): Promise<CompletionResult> {
  const statusMap = {
    abandon: "玩家主动放弃任务",
    success: "玩家成功完成任务",
    failed: "任务执行失败",
  };
  const finalStatusText = statusMap[finalStatus] || "任务结束";
  const hist = dialogue.slice(-20).map(d => `${d.role}:${String(d.content || "").slice(0, 60)}`).join("|");

  // 主动放弃用模板（不浪费AI调用）
  if (finalStatus === "abandon") {
    return buildDefault("failed", task?.objective || "无");
  }

  return evalAi(
    finalStatusText,
    task?.objective || "无",
    hist,
    message,
    progressLevel,
    userId,
  );
}