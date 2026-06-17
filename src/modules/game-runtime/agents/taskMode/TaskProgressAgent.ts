/**
 * 任务推进判定器 Agent (TaskProgressAgent)
 *
 * 三层判定：静态条件 → 关键词匹配 → AI 辅助判断
 * 判定结果同时生成对 process 数组的修改指令，交由调用方写回 state
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
{"level":"等级","tier":"判定层级","reason":"理由","needClarify":true/false,"clarifyContent":"追问","processUpdate":{"action":"none"|"mark_complete"|"mark_failed"|"insert"|"none","phaseIndex":数字|null,"newPhase":"新阶段文本(仅insert时)"}}

level只允许：强力推进/正常推进/微弱推进/维持/放弃`;

export type ProgressLevel = "strong" | "normal" | "weak" | "maintain" | "abandon";
export type ProgressTier = "static" | "keyword" | "ai";

/** process 数组修改指令 */
export type ProcessUpdateAction = "none" | "mark_complete" | "mark_failed" | "insert" | "skip";
export interface ProcessUpdate {
  action: ProcessUpdateAction;
  /** 要标记的阶段下标（mark_complete / mark_failed / skip 时） */
  phaseIndex: number | null;
  /** 要插入的新阶段文本（insert 时） */
  newPhase: string | null;
}

export interface ProgressResult {
  level: ProgressLevel;
  tier: ProgressTier;
  reason: string;
  needClarify: boolean;
  clarifyContent?: string;
  /** 推进过程修改指令 */
  processUpdate: ProcessUpdate;
}

const AI_SCHEMA = z.object({
  level: z.enum(["强力推进", "正常推进", "微弱推进", "维持", "放弃"]),
  tier: z.enum(["静态条件", "关键词匹配", "AI辅助判断"]),
  reason: z.string(),
  needClarify: z.boolean().optional(),
  clarifyContent: z.string().optional(),
  // 新增：AI 返回 processUpdate
  processUpdate: z.object({
    action: z.enum(["none", "mark_complete", "mark_failed", "insert"]),
    phaseIndex: z.number().nullable().optional(),
    newPhase: z.string().nullable().optional(),
  }).optional(),
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

/** 解析带标记的阶段文本，返回 { text, status } */
function parsePhase(text: string): { text: string; status: "idle" | "active" | "complete" | "failed" } {
  const m = text.match(/^\[([isaf])\]\s*(.*)$/s);
  if (!m) return { text, status: "idle" };
  const statusMap: Record<string, "idle" | "active" | "complete" | "failed"> = {
    i: "active", s: "complete", f: "failed", "": "idle",
  };
  return { text: m[2].trim(), status: statusMap[m[1]] || "idle" };
}

/** 带标记渲染阶段文本 */
function renderPhase(text: string, status: "idle" | "active" | "complete" | "failed"): string {
  const tag = status === "active" ? "[i]" : status === "complete" ? "[s]" : status === "failed" ? "[f]" : "[]";
  return `${tag}${text}`;
}

/**
 * 将 ProcessUpdate 应用到 process 数组，返回新的 process 数组。
 * 如果 update.action === "none" 或 process 为空，返回原数组。
 */
export function applyProcessUpdateToPhases(
  process: string[],
  update: ProcessUpdate,
): string[] {
  if (update.action === "none" || !Array.isArray(process) || process.length === 0) {
    return process;
  }

  const phases = process.map(p => parsePhase(p));

  if (update.action === "mark_complete") {
    const idx = update.phaseIndex ?? phases.findIndex(p => p.status === "idle" || p.status === "active");
    if (idx >= 0 && idx < phases.length) {
      phases[idx] = { ...phases[idx], status: "complete" };
    }
  } else if (update.action === "mark_failed") {
    const idx = update.phaseIndex ?? phases.findIndex(p => p.status === "idle" || p.status === "active");
    if (idx >= 0 && idx < phases.length) {
      phases[idx] = { ...phases[idx], status: "failed" };
    }
  } else if (update.action === "skip") {
    const idx = update.phaseIndex ?? phases.findIndex(p => p.status === "idle");
    if (idx >= 0 && idx < phases.length) {
      phases[idx] = { ...phases[idx], status: "complete" };
    }
  } else if (update.action === "insert" && update.newPhase) {
    const idx = update.phaseIndex ?? phases.findIndex(p => p.status === "idle" || p.status === "active");
    const insertIdx = idx >= 0 ? idx + 1 : phases.length;
    phases.splice(insertIdx, 0, { text: update.newPhase, status: "idle" });
  }

  return phases.map(p => renderPhase(p.text, p.status));
}

function evalStatic(intent: IntentType, currentPhases: string[]): ProgressResult {
  if (intent === "exit_task") {
    return {
      level: "abandon", tier: "static",
      reason: "意图为放弃，直接触发任务放弃",
      needClarify: false,
      processUpdate: { action: "none", phaseIndex: null, newPhase: null },
    };
  }
  if (intent === "normal_dialog") {
    return {
      level: "maintain", tier: "static",
      reason: "普通对话不推进",
      needClarify: false,
      processUpdate: { action: "none", phaseIndex: null, newPhase: null },
    };
  }
  return (null as any);
}

function evalKeyword(intent: IntentType, msg: string, currentPhases: string[]): ProgressResult | null {
  const m = String(msg || "").toLowerCase();
  if (intent === "query_progress" && QUERY_KW.some(k => m.includes(k))) {
    return {
      level: "maintain", tier: "keyword",
      reason: "查询任务状态，不推进",
      needClarify: false,
      processUpdate: { action: "none", phaseIndex: null, newPhase: null },
    };
  }
  if (intent === "create_task" || intent === "game_action") {
    if (DOWN_ABANDON.some(k => m.includes(k))) {
      return {
        level: "abandon", tier: "keyword",
        reason: "包含放弃关键词",
        needClarify: false,
        processUpdate: { action: "none", phaseIndex: null, newPhase: null },
      };
    }
    if (DOWN_QUERY.some(k => m.includes(k))) {
      return {
        level: "maintain", tier: "keyword",
        reason: "降级为查询",
        needClarify: true, clarifyContent: "你想了解什么？",
        processUpdate: { action: "none", phaseIndex: null, newPhase: null },
      };
    }
    // 有效任务意图 → 推进，标记第一个未完成阶段为进行中
    const firstIdle = currentPhases.findIndex(p => {
      const { status } = parsePhase(p);
      return status === "idle" || status === "active";
    });
    return {
      level: "normal", tier: "keyword",
      reason: "有效任务意图，推进阶段",
      needClarify: false,
      processUpdate: {
        action: firstIdle >= 0 ? "mark_complete" : "none",
        phaseIndex: firstIdle >= 0 ? firstIdle : null,
        newPhase: null,
      },
    };
  }
  return (null as any);
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
当前推进过程：${progress}
历史对话：${dialogue || "无"}
玩家本轮输入：${message}

请根据以上信息判断任务推进等级，并决定如何更新推进过程。

推进更新规则：
- mark_complete：玩家完成了当前阶段，标记为完成 [s]
- mark_failed：玩家该阶段失败，标记为失败 [f]
- insert：玩家行为需要新阶段，插入到当前阶段之后
- none：不更新推进过程

请输出严格JSON：
{"level":"等级","tier":"判定层级","reason":"理由","needClarify":true/false,"clarifyContent":"追问","processUpdate":{"action":"none|mark_complete|mark_failed|insert","phaseIndex":数字|null,"newPhase":"新阶段文本(仅insert时)"}}`;

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
      return { level: "maintain", tier: "ai", reason: "AI 未返回 JSON", needClarify: false, processUpdate: { action: "none", phaseIndex: null, newPhase: null } };
    }
    let obj: any;
    try {
      obj = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.warn("[TaskProgressAgent] JSON 解析失败：", e);
      return { level: "maintain", tier: "ai", reason: "AI JSON 解析失败", needClarify: false, processUpdate: { action: "none", phaseIndex: null, newPhase: null } };
    }
    const parsed = AI_SCHEMA.safeParse(obj);
    if (!parsed.success) {
      console.warn("[TaskProgressAgent] schema 校验失败：", parsed.error);
      return { level: "maintain", tier: "ai", reason: "AI schema 校验失败", needClarify: false, processUpdate: { action: "none", phaseIndex: null, newPhase: null } };
    }
    const d = parsed.data;
    const update = d.processUpdate;
    return {
      level: LEVEL_MAP[d.level] || "maintain",
      tier: TIER_MAP[d.tier] || "ai",
      reason: d.reason,
      needClarify: d.needClarify || false,
      clarifyContent: d.clarifyContent,
      processUpdate: {
        action: update?.action || "none",
        phaseIndex: update?.phaseIndex ?? null,
        newPhase: update?.newPhase ?? null,
      },
    };
  } catch (e) {
    console.error("[TaskProgressAgent] AI调用失败", e);
    return { level: "maintain", tier: "ai", reason: "AI异常", needClarify: false, processUpdate: { action: "none", phaseIndex: null, newPhase: null } };
  }
}

export async function evaluateTaskProgress(
  intent: { intent: IntentType; confidence: number; reasoning: string },
  task: { objective?: string; process?: string[] } | null,
  dialogue: Array<{ role: string; content: string }>,
  message: string,
  userId: number,
): Promise<ProgressResult> {
  const phases = task?.process ?? [];

  const s = evalStatic(intent.intent, phases);
  if (s) return s;

  const k = evalKeyword(intent.intent, message, phases);
  if (k) return k;

  const hist = dialogue.slice(-10).map(d => `${d.role}:${String(d.content || "").slice(0, 80)}`).join("|");
  return evalAi(
    intent.intent,
    intent.confidence,
    intent.reasoning,
    task?.objective || "无",
    phases.map(p => parsePhase(p).text).join("→"),
    hist,
    message,
    userId,
  );
}
