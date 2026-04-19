import u from "@/utils";
import {
  JsonRecord,
  readChapterProgressState,
  readPhaseAwareRuntimeCurrentEventDigestState,
} from "@/lib/gameEngine";
import { applyChapterOutcomeToState, ChapterOutcomeResult, evaluateChapterOutcome } from "@/modules/game-runtime/engines/ChapterOutcomeEngine";
import { activateChapterEndingCheckState } from "@/modules/game-runtime/engines/ChapterProgressEngine";
import { DebugLogUtil } from "@/utils/debugLogUtil";
import { z } from "zod";

export interface EvaluateRuntimeOutcomeInput {
  userId?: number;
  chapter: any;
  state: JsonRecord;
  messageContent?: string;
  eventType?: string;
  meta?: JsonRecord;
  recentMessages?: any[];
  fallbackStatus?: string;
  fallbackChapterId?: number | null;
  fallbackOutcome?: "continue" | "success" | "failed";
  fallbackNextChapterId?: number | null;
  applyToState?: boolean;
  traceMeta?: JsonRecord;
}

export interface RuntimeOutcomeResolution {
  evaluation: ChapterOutcomeResult;
  outcome: "continue" | "success" | "failed";
  sessionStatus: string;
  nextChapterId: number | null;
}

type ChapterJudgeTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
};

const chapterJudgeOutputSchema = {
  result: z.enum(["continue", "success", "failed"]),
  matched_rule: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  next_chapter_id: z.union([z.number().int().positive(), z.null()]).optional(),
  guide_summary: z.string().nullable().optional(),
  guide_facts: z.array(z.string()).optional(),
};

function normalizeScalarText(input: unknown): string {
  const text = String(input ?? "").trim();
  if (!text || text === "null" || text === "undefined") return "";
  return text;
}

function stringifyCondition(input: unknown): string {
  if (input == null) return "null";
  if (typeof input === "string") return input.trim();
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function getPromptValue(row: any): string {
  const customValue = normalizeScalarText(row?.customValue);
  if (customValue) return customValue;
  return normalizeScalarText(row?.defaultValue);
}

function unwrapModelText(input: unknown): string {
  return normalizeScalarText(input).replace(/^```[a-zA-Z]*\s*|\s*```$/g, "").trim();
}

/**
 * 判断当前运行态是否已经进入“结束条件检查”阶段。
 *
 * 用途：
 * - 章节判定返回 continue 时，并不代表一定要立刻把 current_event 切到 ending；
 * - 如果正文事件还没完成，强行切到 ending 再被 sync 重算，会把 current_event 冲回错误的正文 phase；
 * - 这里只允许已经处于 ending，或正文事件确实已经完成时，才激活 ending-check 状态。
 */
function shouldActivateEndingGuideState(input: EvaluateRuntimeOutcomeInput): boolean {
  const currentProgress = readChapterProgressState(input.state);
  const currentDigest = readPhaseAwareRuntimeCurrentEventDigestState(input.chapter, input.state);
  const currentFlowType = normalizeScalarText(currentDigest.eventFlowType || currentProgress.eventKind).toLowerCase();
  const currentKind = normalizeScalarText(currentDigest.eventKind || currentProgress.eventKind).toLowerCase();
  if (currentKind === "ending" || currentFlowType === "chapter_ending_check") {
    return true;
  }
  return currentProgress.eventStatus === "completed";
}

function normalizeResultObject(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object"){
    console.log("input =", input);
    console.log("typeof input =", typeof input);
    console.log("is null =", input === null);
    console.log("is undefined =", input === undefined);
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  } catch {
    return input as Record<string, unknown>;
  }
}

function normalizeTraceMeta(input: unknown): JsonRecord {
  if (!input || typeof input !== "object") return {};
  return input as JsonRecord;
}

// 用统一 tag 串起章节判定与编排请求，方便确认同一个 orchestration 请求里判章跑了几次。
function logChapterEndingKeyNode(node: string, traceMeta: unknown, extra?: Record<string, unknown>) {
  if (!DebugLogUtil.isDebugLogEnabled()) return;
  console.log("[game:orchestrator:key_nodes]", JSON.stringify({
    node,
    ...normalizeTraceMeta(traceMeta),
    ...(extra || {}),
  }));
}

function parseFieldMap(rawText: string): Record<string, string> {
  const lines = unwrapModelText(rawText)
    .split(/\r?\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const result: Record<string, string> = {};

  // 首先尝试解析 key: value 格式
  for (const line of lines) {
    const matched = line.match(/^[-*]?\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*[:：=]\s*(.*)$/);
    if (!matched) continue;
    result[matched[1].toLowerCase()] = matched[2].trim();
  }

  // 如果没有解析到任何字段，尝试逐行 key-value 格式（key 一行，value 一行）
  if (Object.keys(result).length === 0 && lines.length >= 2) {
    const validKeys = new Set([
      "result", "matched_rule", "matchedrule", "reason",
      "next_chapter_id", "nextchapterid", "guide_summary", "guidesummary", "guide_facts", "guidefacts"
    ]);
    for (let i = 0; i < lines.length - 1; i++) {
      const key = lines[i].toLowerCase().replace(/^[-*]?\s*/, "").trim();
      if (validKeys.has(key)) {
        // 下一行是 value
        let value = lines[i + 1].trim();
        // 处理可能的 JSON 数组格式
        if (value.startsWith("[") && value.endsWith("]")) {
          // 保持数组格式
        } else if (value.startsWith("[") && !value.endsWith("]")) {
          // 数组跨多行，收集完整数组
          const arrayLines = [value];
          let j = i + 2;
          while (j < lines.length && !lines[j].trim().endsWith("]")) {
            arrayLines.push(lines[j].trim());
            j++;
          }
          if (j < lines.length) {
            arrayLines.push(lines[j].trim());
          }
          value = arrayLines.join(" ");
          i = j - 1; // 跳过已处理的行
        }
        result[key] = value;
        i++; // 跳过 value 行
      }
    }
  }

  return result;
}

function getPlainField(fields: Record<string, string>, ...keys: string[]): string {
  for (const key of keys) {
    const value = normalizeScalarText(fields[key.toLowerCase()]);
    if (value) return value;
  }
  return "";
}

function normalizeOutcome(value: unknown): "continue" | "success" | "failed" {
  const text = normalizeScalarText(value).toLowerCase();
  if (text === "success" || text === "completed" || text === "pass") return "success";
  if (text === "failed" || text === "fail" || text === "failure" || text === "lose") return "failed";
  return "continue";
}

function shortText(input: unknown, limit = 160): string {
  const text = normalizeScalarText(input);
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

type BuildChapterJudgeInput = {
  chapter: any;
  state: JsonRecord;
  messageContent?: string;
  eventType?: string;
  recentMessages?: any[];
  runtimeStateSend?: boolean;
};

function buildChapterJudgeInputSnapshot({
  chapter,
  state,
  messageContent,
  eventType,
  recentMessages,
  runtimeStateSend = false,
}: BuildChapterJudgeInput): JsonRecord {
  const chapterProgress =
    typeof state.chapterProgress === "object" && state.chapterProgress !== null
      ? (state.chapterProgress as Record<string, unknown>)
      : {};

  const completedEvents = Array.isArray(chapterProgress.completedEvents)
    ? chapterProgress.completedEvents
        .map((item) => normalizeScalarText(item))
        .filter(Boolean)
    : [];

  const runtimeOutline = (chapter as any)?.runtimeOutline;
  const endingRules =
    runtimeOutline && typeof runtimeOutline === "object"
      ? (runtimeOutline as any).endingRules ?? null
      : null;

  // 判章时必须读取“按 phaseId 校正后的当前事件”。
  // 否则 chapterProgress 已经切到事件2，但旧 digest 还停在事件1时，
  // 判章 prompt 会错误读到 eventIndex=0/1，和真实运行态脱节。
  const currentEvent = readPhaseAwareRuntimeCurrentEventDigestState(chapter, state);

  const recentDialogue = Array.isArray(recentMessages)
    ? recentMessages
        .slice(-10)
        .map((item) => ({
          role: normalizeScalarText(item?.role) || "未知角色",
          role_type: normalizeScalarText(item?.roleType) || "",
          event_type: normalizeScalarText(item?.eventType) || "",
          content: shortText(item?.content, 160) || "",
        }))
        .filter((item) => item.content)
    : [];

  return {
    chapter: {
      title: normalizeScalarText(chapter?.title) || "未命名章节",
      completion_condition: (chapter as any)?.completionCondition ?? null,
      ending_rules: endingRules,
    },
    current_event: {
      index: Number(normalizeScalarText(currentEvent.eventIndex) || "0"),
      kind: normalizeScalarText(currentEvent.eventKind) || "scene",
      flow: normalizeScalarText(currentEvent.eventFlowType) || "chapter_content",
      status: normalizeScalarText(currentEvent.eventStatus) || "idle",
      summary: shortText(currentEvent.eventSummary, 120) || "",
      facts: Array.isArray(currentEvent.eventFacts)
        ? currentEvent.eventFacts
            .map((item: unknown) => normalizeScalarText(item))
            .filter(Boolean)
        : [],
    },
    ...(runtimeStateSend
      ? {
          runtime_state: {
            completed_events: completedEvents,
            message_content: normalizeScalarText(messageContent) || "",
            event_type: normalizeScalarText(eventType) || "on_message",
          },
        }
      : {}),
    recent_dialogue: recentDialogue,
  };
}

function buildChapterJudgePrompt(input: {
  chapter: any;
  state: JsonRecord;
  messageContent?: string;
  eventType?: string;
  recentMessages?: any[];
}): string {
  return JSON.stringify(buildChapterJudgeInputSnapshot(input), null, 2);
}

async function loadChapterJudgePrompt(): Promise<string> {
  const row = await u.db("t_prompts")
    .where("code", "story-chapter")
    .first("defaultValue", "customValue");
  return getPromptValue(row);
}

async function resolveChapterJudgeModel(userId?: number) {
  const primary = await u.getPromptAi("storyChapterJudgeModel", userId);
  if (normalizeScalarText((primary as Record<string, unknown> | null)?.manufacturer)) {
    return primary;
  }
  const fallback = await u.getPromptAi("storyOrchestratorModel", userId);
  if (normalizeScalarText((fallback as Record<string, unknown> | null)?.manufacturer)) {
    return fallback;
  }
  throw new Error("章节判定对接的模型未配置");
}

function buildChapterJudgeStats(input: {
  systemPrompt: string;
  prompt: string;
  responseText: string;
  tokenUsage?: ChapterJudgeTokenUsage | null;
  requestStatus: "success" | "fallback" | "skip_no_prompt";
  manufacturer: string;
  model: string;
  reasoningEffort: string;
  buildMs?: number;
  invokeMs?: number;
  totalMs?: number;
  traceMeta?: JsonRecord;
  start: number;
}) {
  const cost = Date.now() - input.start;
  const totalRequestChars = input.systemPrompt.length + input.prompt.length;
  const runtimeLog = {
    manufacturer: input.manufacturer,
    model: input.model,
    reasoningEffort: input.reasoningEffort || "",
    traceMeta: normalizeTraceMeta(input.traceMeta),
    requestChars: totalRequestChars,
    systemChars: input.systemPrompt.length,
    userChars: input.prompt.length,
    requestStatus: input.requestStatus,
    responseText: input.responseText,
    responseTextLength: input.responseText.length,
    tokenUsage: input.tokenUsage || null,
    buildMs: Number(input.buildMs || 0),
    invokeMs: Number(input.invokeMs || 0),
    totalMs: Number(input.totalMs || 0),
  };
  console.log("[story:chapter_ending_check:runtime]", JSON.stringify(runtimeLog));
  if (!DebugLogUtil.isDebugLogEnabled()) return;
  console.log(`[story:chapter_ending_check:stats] request_chars=${totalRequestChars} system_chars=${input.systemPrompt.length} user_chars=${input.prompt.length} request_status=${input.requestStatus} build_ms=${Number(input.buildMs || 0)} invoke_ms=${Number(input.invokeMs || 0)} total_ms=${Number(input.totalMs || 0)}`);
  console.log(`[story:chapter_ending_check:stats] | 区块 | 实际内容 | 字符数 | 估算 Tokens |`);
  console.log(`[story:chapter_ending_check:stats] | System Prompt | ${shortText(input.systemPrompt, 240000) || "无"} | ${input.systemPrompt.length} | ${Math.max(input.systemPrompt ? 1 : 0, Math.ceil(input.systemPrompt.length / 4))} |`);
  console.log(`[story:chapter_ending_check:stats] | 用户提示词 | ${shortText(input.prompt, 240000)} | ${input.prompt.length} | ${Math.max(1, Math.ceil(input.prompt.length / 4))} |`);
  console.log(`[story:chapter_ending_check:stats] | 返回内容 | ${shortText(input.responseText, 240000) || "无"} | ${input.responseText.length} | ${Math.max(input.responseText ? 1 : 0, Math.ceil(input.responseText.length / 4))} |`);
  if (input.tokenUsage) {
    console.log(`[story:chapter_ending_check:stats] | 实际推理消耗 | input=${input.tokenUsage.inputTokens || 0}, output=${input.tokenUsage.outputTokens || 0}, reasoning=${input.tokenUsage.reasoningTokens || 0} | - | - |`);
  }
  console.log(`[story:chapter_ending_check:stats] 耗时: ${cost}ms`);
}

function normalizeGuideSummary(reason: string, rawGuideSummary: unknown): string {
  const guideSummary = normalizeScalarText(rawGuideSummary);
  if (guideSummary) return guideSummary;
  if (!reason) {
    return "继续检查章节结束条件并引导用户补全缺失信息";
  }
  return `结束条件未满足，需引导用户继续补全信息`;
}

function normalizeGuideFacts(reason: string, rawGuideFacts: unknown): string[] {
  const guideFacts = Array.isArray(rawGuideFacts)
    ? rawGuideFacts.map((item) => normalizeScalarText(item)).filter(Boolean)
    : [];
  if (guideFacts.length) {
    return guideFacts.slice(0, 3);
  }
  return [
    "当前章节结束条件尚未命中，需要继续当前章节。",
    reason || "当前用户输入还不足以满足成功或失败条件。",
    "需要通过角色引导用户明确补充完成结束条件所需的信息。",
  ].filter(Boolean);
}

async function evaluateChapterOutcomeByAi(input: EvaluateRuntimeOutcomeInput): Promise<ChapterOutcomeResult | null> {
  const totalStartedAt = Date.now();
  const fallback = evaluateChapterOutcome({
    chapter: input.chapter,
    state: input.state,
    messageContent: input.messageContent,
    eventType: input.eventType,
    meta: input.meta,
  });
  if (!fallback.hasRule) {
    return fallback;
  }
 const start = Date.now();
  const prompt = await loadChapterJudgePrompt();
  if (!prompt) {
    buildChapterJudgeStats({
      systemPrompt: "",
      prompt: buildChapterJudgePrompt(input),
      responseText: "未加载到 AI故事-章节判定 Prompt，已回退到规则判定。",
      tokenUsage: null,
      requestStatus: "skip_no_prompt",
      manufacturer: "",
      model: "",
      reasoningEffort: "",
      buildMs: 0,
      invokeMs: 0,
      totalMs: Date.now() - totalStartedAt,
      traceMeta: input.traceMeta,
      start:start,
    });
    return fallback;
  }
  const buildStartedAt = Date.now();
  const userPrompt = buildChapterJudgePrompt(input);
  const buildMs = Date.now() - buildStartedAt;
  let rawText = "";
  let tokenUsage: ChapterJudgeTokenUsage | null = null;
  let requestStage = "resolve_model";
  let invokeMs = 0;
  try {
    const modelConfig = await resolveChapterJudgeModel(input.userId);
    requestStage = "invoke_model";
    const invokeStartedAt = Date.now();
    logChapterEndingKeyNode("storyChapterJudgeModel:invoke:start", input.traceMeta, {
      chapterId: Number(input.chapter?.id || 0),
      eventType: normalizeScalarText(input.eventType),
      messageLength: normalizeScalarText(input.messageContent).length,
    });
    const result = await u.ai.text.invoke(
      {
        usageType: "章节判定",
        usageRemark: normalizeScalarText(input.chapter?.title) || "未知章节",
        usageMeta: {
          stage: "storyChapterJudgeModel",
          chapterId: Number(input.chapter?.id || 0),
          chapterTitle: normalizeScalarText(input.chapter?.title),
        },
        output: chapterJudgeOutputSchema,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: userPrompt },
        ],
        maxRetries: 0,
      },
      modelConfig as any,
    );
    invokeMs = Date.now() - invokeStartedAt;
    logChapterEndingKeyNode("storyChapterJudgeModel:invoke:done", input.traceMeta, {
      invokeMs,
    });
    // normalizeResultObject = 把“看起来像 object 的脏数据”修正成真正的 object
    const rawObject = (result as any)?.object ?? (typeof result === "object" ? result : null);

    const responseObject = normalizeResultObject(rawObject);
    const responseObjectText = responseObject
      ? JSON.stringify(responseObject, null, 2)
      : "";
    const fallbackText = unwrapModelText((result as any)?.text || "");
    const responseText = responseObjectText || fallbackText;
    rawText = responseText;
    tokenUsage = {
      inputTokens: Number((result as any)?.usage?.inputTokens || 0),
      outputTokens: Number((result as any)?.usage?.outputTokens || 0),
      reasoningTokens: Number((result as any)?.usage?.outputTokenDetails?.reasoningTokens || (result as any)?.usage?.reasoningTokens || 0),
    };
    const fieldMap = parseFieldMap(rawText);
    const resultValue = normalizeOutcome(
      responseObject?.result
      || responseObject?.outcome
      || getPlainField(fieldMap, "result", "outcome"),
    );
    const matchedRule = normalizeScalarText(
      responseObject?.matched_rule
      || responseObject?.matchedRule
      || getPlainField(fieldMap, "matched_rule", "matchedrule"),
    ) || null;
    const reason = normalizeScalarText(
      responseObject?.reason
      || getPlainField(fieldMap, "reason"),
    ) || null;
    const guideSummary = normalizeGuideSummary(
      reason || "",
      responseObject?.guide_summary
      || responseObject?.guideSummary
      || getPlainField(fieldMap, "guide_summary", "guidesummary"),
    );
    const guideFacts = normalizeGuideFacts(
      reason || "",
      responseObject?.guide_facts
      || responseObject?.guideFacts
      || [],
    );
    const nextChapterIdText = normalizeScalarText(
      responseObject?.next_chapter_id
      || responseObject?.nextChapterId
      || getPlainField(fieldMap, "next_chapter_id", "nextchapterid"),
    );
    const nextChapterId = Number.isFinite(Number(nextChapterIdText)) && Number(nextChapterIdText) > 0
      ? Number(nextChapterIdText)
      : fallback.nextChapterId;
    buildChapterJudgeStats({
      systemPrompt: prompt,
      prompt: userPrompt,
      responseText: rawText,
      tokenUsage,
      requestStatus: "success",
      manufacturer: normalizeScalarText((modelConfig as any)?.manufacturer),
      model: normalizeScalarText((modelConfig as any)?.model),
      reasoningEffort: normalizeScalarText((modelConfig as any)?.reasoningEffort),
      buildMs,
      invokeMs,
      totalMs: Date.now() - totalStartedAt,
      traceMeta: input.traceMeta,
      start:start,
    });
    return {
      hasRule: true,
      result: resultValue,
      nextChapterId,
      matchedBy: resultValue === "continue" ? "none" : "completion_condition",
      matchedRule,
      reason,
      guideSummary: resultValue === "continue" ? guideSummary : null,
      guideFacts: resultValue === "continue" ? guideFacts : [],
    };
  } catch (err) {
    buildChapterJudgeStats({
      systemPrompt: prompt,
      prompt: userPrompt,
      responseText: rawText || `章节判定未拿到模型返回内容（阶段: ${requestStage}）`,
      tokenUsage,
      requestStatus: "fallback",
      manufacturer: "",
      model: "",
      reasoningEffort: "",
      buildMs,
      invokeMs,
      totalMs: Date.now() - totalStartedAt,
      traceMeta: input.traceMeta,
      start:start,
    });
    console.warn("[story:chapter_ending_check:runtime]error", {
      chapterId: Number(input.chapter?.id || 0),
      chapterTitle: normalizeScalarText(input.chapter?.title),
      traceMeta: normalizeTraceMeta(input.traceMeta),
      stage: requestStage,
      message: (err as any)?.message || String(err),
    });
    return fallback;
  }
}

export function resolveSessionStatusByOutcome(
  currentStatus: string,
  outcome: "continue" | "success" | "failed",
): string {
  if (outcome === "failed") return "failed";
  if (outcome === "success") return "chapter_completed";
  return currentStatus;
}

/**
 * 先用规则引擎做一次轻量判定。
 * 这里只关心“当前章节是否存在有效结束条件”，避免没有结束条件时仍然触发 AI 章节判定。
 */
function buildRuleBasedChapterOutcome(input: EvaluateRuntimeOutcomeInput): ChapterOutcomeResult {
  return evaluateChapterOutcome({
    chapter: input.chapter,
    state: input.state,
    messageContent: input.messageContent,
    eventType: input.eventType,
    meta: input.meta,
  });
}

// 正式链和调试链统一使用这一层做章节结果收口。
export async function evaluateRuntimeOutcome(input: EvaluateRuntimeOutcomeInput): Promise<RuntimeOutcomeResolution> {
  const fallbackEvaluation = buildRuleBasedChapterOutcome(input);
  // 没有任何结束条件时，不应该触发 AI 章节判定器；否则会产生无意义的模型调用和误导日志。
  const evaluation = fallbackEvaluation.hasRule
    ? (await evaluateChapterOutcomeByAi(input) || fallbackEvaluation)
    : fallbackEvaluation;

  const outcome = evaluation.hasRule
    ? evaluation.result
    : (input.fallbackOutcome || "continue");
  const nextChapterId = evaluation.hasRule
    ? (evaluation.nextChapterId || input.fallbackChapterId || null)
    : (input.fallbackNextChapterId || input.fallbackChapterId || null);
  const sessionStatus = resolveSessionStatusByOutcome(String(input.fallbackStatus || "active"), outcome);
  if (DebugLogUtil.isDebugLogEnabled()) {
    DebugLogUtil.logCurrentChapter("story:chapter_ending_check:stats", input.chapter);
    console.log(`[story:chapter_ending_check:stats] sessionStatus: ${sessionStatus}`);
    console.log(`[story:chapter_ending_check:stats] outcome: ${outcome}`);
    console.log(`[story:chapter_ending_check:stats] nextChapterId: ${nextChapterId == null ? "" : String(nextChapterId)}`);
  }
  if (DebugLogUtil.isDebugLogEnabled()) {
    console.log("[tag_end_chapter]", JSON.stringify({
    chapterId: Number(input.chapter?.id || 0),
    chapterTitle: String(input.chapter?.title || "").trim(),
    outcome,
    hasRule: evaluation.hasRule,
    matchedBy: evaluation.matchedBy,
    matchedRule: evaluation.matchedRule,
    nextChapterId,
    completionCondition: stringifyCondition((input.chapter as any)?.completionCondition),
    endingRules: (() => {
      try {
        return JSON.stringify((input.chapter as any)?.runtimeOutline?.endingRules || null);
      } catch {
        return String((input.chapter as any)?.runtimeOutline?.endingRules || "");
      }
    })(),
    eventType: String(input.eventType || "on_message"),
    messageContent: String(input.messageContent || "").trim(),
    why: evaluation.hasRule
      ? (evaluation.result === "continue"
        ? "章节结束条件未命中"
        : `命中${evaluation.matchedBy === "runtime_outline" ? "运行时事件规则" : "章节判定"}:${evaluation.matchedRule || "未命名规则"}`)
      : "当前章节没有有效结束条件，跳过AI章节判定并沿用fallbackOutcome",
    }));
    if (!evaluation.hasRule && DebugLogUtil.isDebugLogEnabled()) {
      console.log("[story:chapter_ending_check:skip]", JSON.stringify({
        chapterId: Number(input.chapter?.id || 0),
        chapterTitle: String(input.chapter?.title || "").trim(),
        reason: "skip_no_rule",
        traceMeta: normalizeTraceMeta(input.traceMeta),
      }));
    }
  }




  if (evaluation.hasRule && outcome === "continue") {
    input.state.__pendingEndingGuide = true;
    // 只有真正进入章节结束检查阶段时，才允许把 current_event 切到 ending。
    // 正文事件尚未完成时仅挂起 guide 标记，避免后续编排读取到被提前改写的事件索引。
    if (shouldActivateEndingGuideState(input)) {
      activateChapterEndingCheckState({
        chapter: input.chapter,
        state: input.state,
        reason: evaluation.reason || null,
        guideSummary: evaluation.guideSummary || null,
        guideFacts: Array.isArray(evaluation.guideFacts) ? evaluation.guideFacts : [],
        eventStatus: "active",
      });
    }
  } else {
    input.state.__pendingEndingGuide = false;
  }

  if (Boolean(input.applyToState) && outcome !== "continue") {
    applyChapterOutcomeToState(input.chapter, input.state, {
      ...evaluation,
      result: outcome,
      nextChapterId,
    });
  }

  return {
    evaluation,
    outcome,
    sessionStatus,
    nextChapterId,
  };
}
