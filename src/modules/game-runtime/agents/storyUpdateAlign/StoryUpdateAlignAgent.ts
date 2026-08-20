/**
 * 故事版本更新--存档智能对齐 Agent（方向2 可选增强）
 *
 * 当确定性对齐报告里出现"phase 改名无法精确匹配"（hasUnmatchedRename）时，
 * 调本 agent 做语义匹配 + 重新生成 eventSummary。
 *
 * 复用 ai_agent_版本更新存档升级助手.md 的 phaseMapping + newEventSummary 子集。
 * 角色迁移 / 背景迁移在方向2 里用确定性保留替代，不调 AI。
 *
 * 模型：复用记忆管理器同款 storyMemoryModel（与角色参数卡/记忆维护一致）。
 * prompt code: story-update-align-agent
 * Token：~3200，成本约 ¥0.0005/session。
 */
import u from "@/utils";
import { z } from "zod";
import { loadTaskPrompt } from "../taskMode/loadTaskPrompt";
import { ProgressAlignReport } from "@/modules/game-runtime/services/progressAlign";
import { buildWorldKnowledgeText, normalizeWorldBookOutput } from "@/lib/gameEngine";

const FALLBACK_SYSTEM = `你是故事存档迁移专家。任务：把用户在旧版故事中的存档进度对齐到新版章节，重点做阶段语义匹配和事件摘要重生成。

# 输入说明

你会收到一段 JSON，包含：
- oldPhases: 旧版阶段列表，每项含 phaseId、phaseIndex、kind、label
- newPhases: 新版阶段列表，结构同上
- currentProgress: 用户当前进度（phaseId、eventIndex、eventSummary、eventKind、eventStatus）

# 迁移规则

## 阶段映射（phaseMapping）
优先级从高到低：
1. 精确匹配：旧版和新版 phaseId 完全相同 -> 直接映射
2. 语义匹配：phaseId 不同但描述同一场景/事件 -> 映射到新版对应阶段
   判断依据：阶段 label 的语义、kind 类型是否一致、在章节中的位置是否相近
3. 无法匹配：旧阶段在新版完全没有对应物 -> 返回 null

## 当前阶段（newPhaseId）
根据 phaseMapping 把 currentProgress.phaseId 映射到新版；无法映射则为 null。

## 事件摘要重生成（newEventSummary）
基于旧版 eventSummary 和 runtimeFacts，生成符合新版阶段语义的摘要：
- 反映用户此前做了什么
- 用新版叙事语境表述
- 若旧阶段在新版不存在，摘要应说明"用户在此前的旧版阶段完成了..."
- 不超过 100 字

## 兜底原则
- 不确定时保守处理：宁可返回 null，也不要错误映射
- 不要编造映射关系

# 输出格式

严格输出以下 JSON，不要 markdown 围栏，不要 JSON 以外文字：
{
  "phaseMapping": { "旧phaseId": "新phaseId 或 null" },
  "newPhaseId": "映射后的当前阶段ID，无法映射则为 null",
  "newEventSummary": "基于新版阶段重新生成的事件摘要",
  "warnings": ["需要用户注意的警告"],
  "summary": "一句话总结"
}`;

const AI_SCHEMA = z.object({
  phaseMapping: z.record(z.string(), z.string().nullable()).default({}),
  newPhaseId: z.string().nullable().default(null),
  newEventSummary: z.string().default(""),
  warnings: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

export interface StoryUpdateAlignInput {
  userId: number;
  /** 世界 ID（用于世界书注入，调用方传入） */
  worldId?: number;
  oldPhases: Array<{ phaseId: string; phaseIndex: number; kind: string; label: string }>;
  newPhases: Array<{ phaseId: string; phaseIndex: number; kind: string; label: string }>;
  currentProgress: {
    phaseId: string;
    phaseIndex: number;
    eventIndex: number;
    eventSummary: string;
    eventKind: string;
    eventStatus: string;
  };
}

export interface StoryUpdateAlignResult {
  phaseMapping: Record<string, string | null>;
  newPhaseId: string | null;
  newEventSummary: string;
  warnings: string[];
  summary: string;
  source: "ai" | "fallback";
  latencyMs: number;
}

export async function runStoryUpdateAlignAgent(input: StoryUpdateAlignInput): Promise<StoryUpdateAlignResult> {
  const systemPrompt = await loadTaskPrompt("story-update-align-agent", FALLBACK_SYSTEM);

  // ★ 世界书注入
  let worldKnowledge = "";
  if (input.worldId) {
    try {
      const scanText = [
        input.currentProgress.eventSummary,
        ...input.oldPhases.map((p) => p.label),
      ].join("\n");
      const rows = await u.db("t_worldBook").where({ worldId: input.worldId }).select("*");
      const entries = normalizeWorldBookOutput(rows);
      worldKnowledge = buildWorldKnowledgeText(entries, scanText, 400, "story_update_align");
    } catch (e) {
      console.warn("[story_update_align] 世界书加载失败", e);
    }
  }

  const userPrompt = `${worldKnowledge ? `【世界知识】\n${worldKnowledge}\n\n` : ""}请对齐以下存档进度到新版章节，严格输出 JSON。

旧版阶段：
${JSON.stringify(input.oldPhases, null, 2)}

新版阶段：
${JSON.stringify(input.newPhases, null, 2)}

当前进度：
${JSON.stringify(input.currentProgress, null, 2)}

请输出：
{
  "phaseMapping": { "...": "..." },
  "newPhaseId": "...",
  "newEventSummary": "...",
  "warnings": [],
  "summary": "..."
}`;

  const startedAt = Date.now();
  try {
    const modelConfig = await u.getPromptAi("storyMemoryModel", input.userId);
    const result = await u.ai.text.invoke({
      plainTextOutput: true,
      usageType: "存档智能对齐",
      usageRemark: "StoryUpdateAlignAgent",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }, modelConfig as any) as any;

    const rawText = String(result?.text || "").trim();
    const latencyMs = Date.now() - startedAt;

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[StoryUpdateAlignAgent] AI 未返回 JSON：", rawText.slice(0, 200));
      return fallback(input, latencyMs);
    }
    let obj: any;
    try {
      obj = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.warn("[StoryUpdateAlignAgent] JSON 解析失败：", e);
      return fallback(input, latencyMs);
    }
    const parsed = AI_SCHEMA.safeParse(obj);
    if (!parsed.success) {
      console.warn("[StoryUpdateAlignAgent] schema 校验失败：", parsed.error);
      return fallback(input, latencyMs);
    }

    console.log("[StoryUpdateAlignAgent] ok", JSON.stringify({
      newPhaseId: parsed.data.newPhaseId,
      latencyMs,
      warnings: parsed.data.warnings.length,
    }));
    return { ...parsed.data, source: "ai", latencyMs };
  } catch (e) {
    const latencyMs = Date.now() - startedAt;
    console.error("[StoryUpdateAlignAgent] AI调用失败", e);
    return fallback(input, latencyMs);
  }
}

/** AI 失败时的确定性兜底：精确匹配 + 索引就近（与 progressAlign 一致） */
function fallback(input: StoryUpdateAlignInput, latencyMs: number): StoryUpdateAlignResult {
  const newIds = input.newPhases.map((p) => p.phaseId);
  const mapping: Record<string, string | null> = {};
  for (const old of input.oldPhases) {
    mapping[old.phaseId] = newIds.includes(old.phaseId) ? old.phaseId
      : (newIds[old.phaseIndex] || null);
  }
  const cur = input.currentProgress.phaseId;
  const newPhaseId = mapping[cur] ?? null;
  return {
    phaseMapping: mapping,
    newPhaseId,
    newEventSummary: input.currentProgress.eventSummary || "",
    warnings: ["AI 智能对齐失败，已回退确定性对齐"],
    summary: "确定性兜底",
    source: "fallback",
    latencyMs,
  };
}

/** 把 AI 结果合并进已有的确定性对齐报告（覆盖映射 + 摘要） */
export function mergeAiAlignIntoReport(
  base: ProgressAlignReport,
  ai: StoryUpdateAlignResult,
  oldPhaseIds: string[],
): ProgressAlignReport {
  const mapped = [...base.mapped];
  const fallbackEntries = [...base.fallback];
  // 用 AI 的 phaseMapping 覆盖 base.mapped 里 reason=nearby 的项
  for (const oldId of oldPhaseIds) {
    const aiTarget = ai.phaseMapping[oldId];
    if (aiTarget === undefined) continue;
    const idx = mapped.findIndex((m) => m.from === oldId);
    if (aiTarget === null) {
      if (idx >= 0) mapped.splice(idx, 1);
      if (!fallbackEntries.find((f) => f.from === oldId)) {
        fallbackEntries.push({ from: oldId, to: "(已移除)" });
      }
    } else {
      if (idx >= 0) {
        mapped[idx] = { from: oldId, to: aiTarget, reason: "name" };
      } else {
        mapped.push({ from: oldId, to: aiTarget, reason: "name" });
      }
    }
  }
  return {
    mapped,
    fallback: fallbackEntries,
    dropped: base.dropped,
    // AI 处理过改名匹配后，标记为 false（已尽力语义匹配）
    hasUnmatchedRename: false,
  };
}