/**
 * 任务推进判定器 Agent (TaskProgressAgent)
 *
 * 三层判定：静态条件 → 关键词匹配 → AI 辅助判断
 */

import u from "@/utils";
import { z } from "zod";
import { IntentType } from "../intentAnalyzer/IntentClassifier";
import { loadTaskPrompt } from "./loadTaskPrompt";

const FALLBACK_SYSTEM = `你是任务推进判定器。输出严格JSON。

# 等级
- 强力推进：关键线索/重大决策
- 正常推进：有效推进条件
- 微弱推进：意愿但缺实质
- 维持：需更多信息
- 放弃：放弃任务

# tier: 静态条件/关键词匹配/AI辅助判断

# 输出
{"level":"等级","tier":"判定层级","reason":"理由","needClarify":true/false,"clarifyContent":"追问"}

level只允许：强力推进/正常推进/微弱推进/维持/放弃`;

export type ProgressLevel = "strong" | "normal" | "weak" | "maintain" | "abandon";
export type ProgressTier = "static" | "keyword" | "ai";

export interface ProgressResult {
  level: ProgressLevel;
  tier: ProgressTier;
  reason: string;
  needClarify: boolean;
  clarifyContent?: string;
}

const AI_SCHEMA = z.object({
  level: z.enum(["强力推进", "正常推进", "微弱推进", "维持", "放弃"]),
  tier: z.enum(["静态条件", "关键词匹配", "AI辅助判断"]),
  reason: z.string(),
  needClarify: z.boolean().optional(),
  clarifyContent: z.string().optional(),
});

const LEVEL_MAP: Record<string, ProgressLevel> = {
  "强力推进": "strong",
  "正常推进": "normal",
  "微弱推进": "weak",
  "维持": "maintain",
  "放弃": "abandon",
};

const TIER_MAP: Record<string, ProgressTier> = {
  "静态条件": "static",
  "关键词匹配": "keyword",
  "AI辅助判断": "ai",
};

const QUERY_KW = ["进度", "状态", "规则", "目标", "怎么样了", "完成了多少", "还差什么"];
const DOWN_QUERY = ["问问", "想了解", "说说", "怎么回事"];
const DOWN_ABANDON = ["跳过", "不管了", "算了", "不做了", "放弃"];

function evalStatic(intent: IntentType): ProgressResult | null {
  if (intent === "exit_task") {
    return { level: "abandon", tier: "static", reason: "意图为放弃，直接触发任务放弃", needClarify: false };
  }
  if (intent === "normal_dialog") {
    return { level: "maintain", tier: "static", reason: "普通对话不推进", needClarify: false };
  }
  return null;
}

function evalKeyword(intent: IntentType, msg: string): ProgressResult | null {
  const m = String(msg || "").toLowerCase();
  if (intent === "query_progress" && QUERY_KW.some(k => m.includes(k))) {
    return { level: "maintain", tier: "keyword", reason: "查询任务状态，不推进", needClarify: false };
  }
  if (intent === "create_task" || intent === "game_action") {
    if (DOWN_ABANDON.some(k => m.includes(k))) {
      return { level: "abandon", tier: "keyword", reason: "包含放弃关键词", needClarify: false };
    }
    if (DOWN_QUERY.some(k => m.includes(k))) {
      return { level: "maintain", tier: "keyword", reason: "降级为查询", needClarify: true, clarifyContent: "你想了解什么？" };
    }
    return { level: "normal", tier: "keyword", reason: "有效任务意图可推进", needClarify: false };
  }
  return null;
}

async function evalAi(
  intent: IntentType,
  confidence: number,
  reasoning: string,
  objective: string,
  progress: string,
  dialogue: string,
  message: string,
  userId: number,
): Promise<ProgressResult> {
  const systemPrompt = await loadTaskPrompt("task-progress-agent", FALLBACK_SYSTEM);

  const userPrompt = `意图：${intent} 置信度：${confidence} 理由：${reasoning}
目标：${objective}
进度：${progress}
历史：${dialogue || "无"}
输入：${message}`;

  try {
    const modelConfig = await u.getPromptAi("storyEventProgressModel", userId);
    const result = await u.ai.text.invoke({
      plainTextOutput: true,
      usageType: "任务推进判定",
      usageRemark: "TaskProgressAgent",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }, modelConfig as any) as any;

    const rawText = String(result?.text || "").trim();
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[TaskProgressAgent] AI 未返回 JSON：", rawText.slice(0, 200));
      return { level: "maintain", tier: "ai", reason: "AI 未返回 JSON", needClarify: false };
    }
    let obj: any;
    try {
      obj = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.warn("[TaskProgressAgent] JSON 解析失败：", e);
      return { level: "maintain", tier: "ai", reason: "AI JSON 解析失败", needClarify: false };
    }
    const parsed = AI_SCHEMA.safeParse(obj);
    if (!parsed.success) {
      console.warn("[TaskProgressAgent] schema 校验失败：", parsed.error);
      return { level: "maintain", tier: "ai", reason: "AI schema 校验失败", needClarify: false };
    }
    const d = parsed.data;
    return {
      level: LEVEL_MAP[d.level] || "maintain",
      tier: TIER_MAP[d.tier] || "ai",
      reason: d.reason,
      needClarify: d.needClarify || false,
      clarifyContent: d.clarifyContent,
    };
  } catch (e) {
    console.error("[TaskProgressAgent] AI调用失败", e);
    return { level: "maintain", tier: "ai", reason: "AI异常", needClarify: false };
  }
}

export async function evaluateTaskProgress(
  intent: { intent: IntentType; confidence: number; reasoning: string },
  task: { objective?: string; process?: string[] } | null,
  dialogue: Array<{ role: string; content: string }>,
  message: string,
  userId: number,
): Promise<ProgressResult> {
  const s = evalStatic(intent.intent);
  if (s) return s;

  const k = evalKeyword(intent.intent, message);
  if (k) return k;

  const hist = dialogue.slice(-10).map(d => `${d.role}:${String(d.content || "").slice(0, 80)}`).join("|");
  return evalAi(
    intent.intent,
    intent.confidence,
    intent.reasoning,
    task?.objective || "无",
    task?.process?.join("→") || "进行中",
    hist,
    message,
    userId,
  );
}