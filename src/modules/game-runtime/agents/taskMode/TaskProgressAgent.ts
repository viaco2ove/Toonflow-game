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
import { buildWorldKnowledgeText, normalizeWorldBookOutput } from "@/lib/gameEngine";

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
  /** AI 直接返回的完整推进过程文字 */
  processItem?: string;
}

const AI_SCHEMA = z.object({
  level: z.enum(["强力推进", "正常推进", "微弱推进", "维持", "放弃"]),
  tier: z.enum(["静态条件", "关键词匹配", "AI辅助判断"]),
  reason: z.string(),
  needClarify: z.boolean().optional(),
  clarifyContent: z.string().optional(),
  processUpdate: z.object({
    action: z.enum(["none", "mark_complete", "mark_failed", "insert"]),
    phaseIndex: z.number().nullable().optional(),
    newPhase: z.string().nullable().optional(),
  }).optional(),
  /** AI 直接返回的完整推进过程文字，优先级高于 processUpdate */
  processItem: z.string().optional(),
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
  // 防御：即使 text 本身带了 [] 标记，也只保留内容部分，避免出现 [][]text
  const clean = String(text || "").replace(/^\[[isaf]*\]\s*/, "").trim();
  const tag = status === "active" ? "[i]" : status === "complete" ? "[s]" : status === "failed" ? "[f]" : "[]";
  return `${tag}${clean}`;
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
  // 注意：normal_dialog 不能在这里静态短路。
  // 任务模式下，玩家输入即使被意图分类器误判为 normal_dialog，
  // 也必须继续交给 AI 根据任务目标、当前推进过程、历史对话、本轮输入判断是否推进。
  return (null as any);
}

function evalKeyword(intent: IntentType, msg: string, currentPhases: string[]): ProgressResult | null {
  const m = String(msg || "").toLowerCase();

  // 只保留明确“不需要大模型”的非推进类判断。
  // 注意：推进过程是否完成、插入、失败，必须交给 evalAi 根据上下文动态判断。
  if (intent === "query_progress" && QUERY_KW.some(k => m.includes(k))) {
    return {
      level: "maintain", tier: "keyword",
      reason: "查询任务状态，不推进",
      needClarify: false,
      processUpdate: { action: "none", phaseIndex: null, newPhase: null },
    };
  }

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
  npcCards: string,
  originalGlobalBackground: string,
  dynamicGlobalBackground: string,
  worldKnowledge: string = "",
): Promise<ProgressResult> {
  const systemPrompt = await loadTaskPrompt("task-progress-agent", FALLBACK_SYSTEM);

  const userPrompt = `【重要】请根据玩家的实际行动判断是否推进任务！

当前任务目标：${objective}

推进过程阶段（[]=未开始, [i]=进行中, [s]=已完成, [f]=已失败）：
${progress}

玩家本轮输入：${message}
历史对话：${dialogue || "无"}

角色动态参数卡列表：
${npcCards || "（无可用角色参数卡）"}

故事初始全局背景描述：
${originalGlobalBackground || "（无）"}

故事动态全局背景描述：
${dynamicGlobalBackground || "（无）"}
${worldKnowledge ? `\n\n【世界知识】\n${worldKnowledge}` : ""}

【判断规则】
1. 如果玩家正在执行与任务目标相关的动作（探索、移动、询问、打探、寻找、排查、开始行动等），标记当前进行中的阶段为完成
2. 如果玩家描述了新的行动步骤，插入新阶段
3. 如果玩家说"好"、"开始"、"那开始吧"等接受指令，标记当前阶段完成并激活下一阶段
4. 只有当玩家明确在闲聊、问无关问题、放弃时才返回 none

【返回要求】
- 必须返回一个有效的 processUpdate！
- phaseIndex：第一个状态为[i]或[]的阶段下标（从0开始）
- 如果当前没有未完成阶段，action 填 none
- 大部分情况下应该返回 mark_complete 或 insert！

请输出严格JSON：
{"level":"等级","tier":"判定层级","reason":"理由","needClarify":true/false,"clarifyContent":"追问","processUpdate":{"action":"none|mark_complete|mark_failed|insert","phaseIndex":数字|null,"newPhase":"新阶段文本(仅insert时)"},"processItem":"推进过程文字"}`;

  console.log("[story:mini_game:task:progress:runtime] request", JSON.stringify({
    userId,
    intent,
    objective,
    progressPreview: progress.slice(0, 200),
    messagePreview: message.slice(0, 100),
    systemPromptChars: systemPrompt.length,
    userPromptChars: userPrompt.length,
  }));
  // 单独打印完整 user prompt（用 ↩ 替换换行避免日志框架按行截断）
  console.log("[story:mini_game:task:progress:runtime] full_user_prompt:", userPrompt.replace(/\n/g, "↩"));

  try {
    const startedAt = Date.now();
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
    const latencyMs = Date.now() - startedAt;

    console.log("[story:mini_game:task:progress:runtime] response", JSON.stringify({
      rawTextPreview: rawText.slice(0, 200),
      latencyMs,
    }));

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[TaskProgressAgent] AI 未返回 JSON：", rawText.slice(0, 200));
      console.log(`[story:mini_game:task:progress:stats] status=json_not_found latency_ms=${latencyMs} response_chars=${rawText.length} response_preview=${rawText.slice(0, 150)}`);
      console.log(`[story:mini_game:task:progress:stats] | System Prompt | ${systemPrompt.replace(/\n/g, "↩").slice(0, 120)} | ${systemPrompt.length} |`);
      console.log(`[story:mini_game:task:progress:stats] | User Prompt | ${userPrompt.replace(/\n/g, "↩").slice(0, 120)} | ${userPrompt.length} |`);
      return { level: "maintain", tier: "ai", reason: "AI 未返回 JSON", needClarify: false, processUpdate: { action: "none", phaseIndex: null, newPhase: null } };
    }
    let obj: any;
    try {
      obj = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.warn("[TaskProgressAgent] JSON 解析失败：", e);
      console.log(`[story:mini_game:task:progress:stats] status=parse_error latency_ms=${latencyMs} response_chars=${rawText.length} response_preview=${rawText.slice(0, 150)}`);
      console.log(`[story:mini_game:task:progress:stats] | System Prompt | ${systemPrompt.replace(/\n/g, "↩").slice(0, 120)} | ${systemPrompt.length} |`);
      console.log(`[story:mini_game:task:progress:stats] | User Prompt | ${userPrompt.replace(/\n/g, "↩").slice(0, 120)} | ${userPrompt.length} |`);
      return { level: "maintain", tier: "ai", reason: "AI JSON 解析失败", needClarify: false, processUpdate: { action: "none", phaseIndex: null, newPhase: null } };
    }
    const parsed = AI_SCHEMA.safeParse(obj);
    if (!parsed.success) {
      console.warn("[TaskProgressAgent] schema 校验失败：", parsed.error);
      console.log(`[story:mini_game:task:progress:stats] status=schema_error latency_ms=${latencyMs} response_chars=${rawText.length} response_preview=${rawText.slice(0, 150)}`);
      console.log(`[story:mini_game:task:progress:stats] | System Prompt | ${systemPrompt.replace(/\n/g, "↩").slice(0, 120)} | ${systemPrompt.length} |`);
      console.log(`[story:mini_game:task:progress:stats] | User Prompt | ${userPrompt.replace(/\n/g, "↩").slice(0, 120)} | ${userPrompt.length} |`);
      return { level: "maintain", tier: "ai", reason: "AI schema 校验失败", needClarify: false, processUpdate: { action: "none", phaseIndex: null, newPhase: null } };
    }
    const d = parsed.data;
    const update = d.processUpdate;
    const processItem = d.processItem;

    console.log(`[story:mini_game:task:progress:stats] level=${LEVEL_MAP[d.level] || "maintain"} tier=${TIER_MAP[d.tier] || "ai"} action=${update?.action || "none"} phaseIndex=${update?.phaseIndex ?? null} processItem=${processItem ? "有" : "无"} latency_ms=${latencyMs}`);
    if (result?.usage) {
      console.log(`[story:mini_game:task:progress:stats] actual_input_tokens=${result.usage.inputTokens || 0} actual_output_tokens=${result.usage.outputTokens || 0} actual_reasoning_tokens=${result.usage.reasoningTokens || 0} cache_read_tokens=${result.usage.cacheReadTokens || 0}`);
    }
    console.log(`[story:mini_game:task:progress:stats] response_chars=${rawText.length} response_preview=${rawText.slice(0, 150)}`);
    console.log(`[story:mini_game:task:progress:stats] 以下为 prompt 体积估算，不等于模型真实 usage。`);
    console.log(`[story:mini_game:task:progress:stats] | 区块 | 实际内容 | 字符数 |`);
    console.log(`[story:mini_game:task:progress:stats] |---|---|---:|`);
    console.log(`[story:mini_game:task:progress:stats] | System Prompt | ${systemPrompt.replace(/\n/g, "↩")} | ${systemPrompt.length} |`);
    console.log(`[story:mini_game:task:progress:stats] | User Prompt | ${userPrompt.replace(/\n/g, "↩")} | ${userPrompt.length} |`);

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
      processItem: d.processItem,
    };
  } catch (e) {
    console.error("[TaskProgressAgent] AI调用失败", e);
    console.log(`[story:mini_game:task:progress:stats] status=exception error=${(e as Error)?.message}`);
    return { level: "maintain", tier: "ai", reason: "AI异常", needClarify: false, processUpdate: { action: "none", phaseIndex: null, newPhase: null } };
  }
}

export async function evaluateTaskProgress(
  intent: { intent: IntentType; confidence: number; reasoning: string },
  task: { objective?: string; process?: string[] } | null,
  dialogue: Array<{ role: string; content: string }>,
  message: string,
  userId: number,
  npcCards: string,
  originalGlobalBackground: string,
  dynamicGlobalBackground: string,
  worldKnowledge: string = "",
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
    npcCards,
    originalGlobalBackground,
    dynamicGlobalBackground,
    worldKnowledge,
  );
}
