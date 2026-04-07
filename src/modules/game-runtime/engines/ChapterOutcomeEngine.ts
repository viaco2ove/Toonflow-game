import {
  ChapterRuntimeOutline,
  ConditionContext,
  JsonRecord,
  evaluateCondition,
  nowTs,
  parseJsonSafe,
  readChapterProgressState,
  setChapterProgressState,
  setValueByPath,
  syncRuntimeCurrentEventFromChapterProgress,
  upsertRuntimeDynamicEventState,
} from "@/lib/gameEngine";

export interface ChapterOutcomeResult {
  hasRule: boolean;
  result: "continue" | "success" | "failed";
  nextChapterId: number | null;
  matchedBy: "runtime_outline" | "completion_condition" | "none";
  matchedRule: string | null;
  reason?: string | null;
  guideSummary?: string | null;
  guideFacts?: string[] | null;
}

export interface ChapterOutcomeInput {
  chapter: any;
  state: JsonRecord;
  messageContent?: string;
  eventType?: string;
  meta?: JsonRecord;
}

function isRecord(input: unknown): input is Record<string, any> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function hasEffectiveRule(input: unknown): boolean {
  if (input === null || input === undefined) return false;
  if (typeof input === "string") {
    const text = input.trim();
    if (!text) return false;
    // 空字符串、空格、纯空白字符不算有效规则
    return text.length > 0;
  }
  if (Array.isArray(input)) {
    // 空数组不算有效规则
    if (input.length === 0) return false;
    // 检查数组中是否有有效元素
    return input.some((item) => hasEffectiveRule(item));
  }
  if (typeof input === "object") {
    const keys = Object.keys(input as Record<string, unknown>);
    if (keys.length === 0) return false;
    // 检查对象中是否有有效的规则字段
    const obj = input as Record<string, unknown>;
    // 常见的规则字段：success, failure, pass, fail, type, op
    const ruleKeys = ["success", "failure", "pass", "fail", "type", "op", "field", "value", "conditions"];
    for (const key of ruleKeys) {
      if (key in obj && hasEffectiveRule(obj[key])) {
        return true;
      }
    }
    // 如果没有常见的规则字段，但有其他键，检查它们是否有值
    for (const key of keys) {
      const value = obj[key];
      if (value !== null && value !== undefined && value !== "") {
        return true;
      }
    }
    return false;
  }
  return true;
}

function readCompletionCondition(chapter: any): unknown {
  return parseJsonSafe((chapter as any)?.completionCondition, (chapter as any)?.completionCondition);
}

function readOutcomeContext(input: ChapterOutcomeInput): ConditionContext {
  return {
    state: input.state,
    messageContent: String(input.messageContent || ""),
    eventType: String(input.eventType || "on_message"),
    meta: isRecord(input.meta) ? input.meta : {},
  };
}

function extractConfiguredNextChapterId(condition: unknown, outline: ChapterRuntimeOutline): number | null {
  if (Number.isFinite(Number(outline.endingRules.nextChapterId)) && Number(outline.endingRules.nextChapterId) > 0) {
    return Number(outline.endingRules.nextChapterId);
  }
  if (!isRecord(condition)) return null;
  const raw = condition.nextChapterId ?? condition.nextChapter;
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function evaluateStructuredCondition(
  condition: unknown,
  ctx: ConditionContext,
): { result: "continue" | "success" | "failed"; matchedRule: string | null } {
  if (!hasEffectiveRule(condition)) {
    // 没有有效规则，继续章节
    return { result: "continue", matchedRule: null };
  }
  if (isRecord(condition)) {
    const failureNode = condition.failure ?? condition.failed ?? condition.fail;
    // null 代表"未配置该分支"，不能继续送进条件引擎，否则会误判为命中。
    if (failureNode != null && hasEffectiveRule(failureNode)) {
      // 只有当failure节点有有效规则时才评估
      const failureMatched = evaluateCondition(failureNode, ctx);
      if (failureMatched) {
        return { result: "failed", matchedRule: "completion.failure" };
      }
    }
    const successNode = condition.success ?? condition.pass;
    if (successNode != null && hasEffectiveRule(successNode)) {
      // 只有当success节点有有效规则时才评估
      const successMatched = evaluateCondition(successNode, ctx);
      if (successMatched) {
        return { result: "success", matchedRule: "completion.success" };
      }
    }
    // 如果success和failure都没有，检查condition本身是否是规则
    const hasRuleFields = ["type", "op", "field", "conditions", "value"].some((k) => k in condition);
    if (!hasRuleFields) {
      // 不是规则结构，继续章节
      return { result: "continue", matchedRule: null };
    }
  }
  // 普通条件评估
  return evaluateCondition(condition, ctx)
    ? { result: "success", matchedRule: "completion" }
    : { result: "continue", matchedRule: null };
}

export function evaluateChapterOutcome(input: ChapterOutcomeInput): ChapterOutcomeResult {
  const chapter = input.chapter;
  const outline = isRecord(chapter?.runtimeOutline)
    ? chapter.runtimeOutline as ChapterRuntimeOutline
    : {
      openingMessages: [],
      phases: [],
      userNodes: [],
      fixedEvents: [],
      endingRules: { success: [], failure: [], nextChapterId: null },
    };
  const progress = readChapterProgressState(input.state);
  const completed = new Set(
    Array.isArray(progress.completedEvents)
      ? progress.completedEvents.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
  );
  const hasOutlineRule = outline.endingRules.success.length > 0 || outline.endingRules.failure.length > 0;
  const condition = readCompletionCondition(chapter);
  const hasConditionRule = hasEffectiveRule(condition);
  const hasRule = hasOutlineRule || hasConditionRule;
  const nextChapterId = extractConfiguredNextChapterId(condition, outline);

  if (outline.endingRules.failure.some((id) => completed.has(id))) {
    return {
      hasRule,
      result: "failed",
      nextChapterId,
      matchedBy: "runtime_outline",
      matchedRule: outline.endingRules.failure.find((id) => completed.has(id)) || null,
    };
  }

  if (outline.endingRules.success.length > 0 && outline.endingRules.success.every((id) => completed.has(id))) {
    return {
      hasRule,
      result: "success",
      nextChapterId,
      matchedBy: "runtime_outline",
      matchedRule: outline.endingRules.success.join(","),
    };
  }

  if (!hasConditionRule) {
    return {
      hasRule,
      result: "continue",
      nextChapterId,
      matchedBy: "none",
      matchedRule: null,
    };
  }

  const evaluated = evaluateStructuredCondition(condition, readOutcomeContext(input));
  return {
    hasRule,
    result: evaluated.result,
    nextChapterId,
    matchedBy: evaluated.result === "continue" ? "none" : "completion_condition",
    matchedRule: evaluated.matchedRule,
  };
}

export function applyChapterOutcomeToState(
  chapter: any,
  state: JsonRecord,
  outcome: ChapterOutcomeResult,
): void {
  if (outcome.result === "continue") return;
  const outline = isRecord(chapter?.runtimeOutline)
    ? chapter.runtimeOutline as ChapterRuntimeOutline
    : {
      openingMessages: [],
      phases: [],
      userNodes: [],
      fixedEvents: [],
      endingRules: { success: [], failure: [], nextChapterId: null },
    };
  const progress = readChapterProgressState(state);
  const completedEvents = Array.isArray(progress.completedEvents) ? [...progress.completedEvents] : [];

  if (outcome.result === "success") {
    for (const item of outline.fixedEvents) {
      if (!item.requiredBeforeFinish) continue;
      if (!completedEvents.includes(item.id)) {
        completedEvents.push(item.id);
      }
    }
    setValueByPath(state, "flags.chapterCompleted", true);
    setValueByPath(state, "flags.chapterFailed", false);
  } else if (outcome.result === "failed") {
    setValueByPath(state, "flags.chapterFailed", true);
  }

  const endingEventIndex = Math.max(1, outline.phases.length + 1);
  const endingSummary = outcome.result === "success"
    ? "结束条件已达成"
    : "结束条件失败";
  upsertRuntimeDynamicEventState(state, {
    eventIndex: endingEventIndex,
    phaseId: "",
    kind: "ending",
    summary: endingSummary,
    summarySource: "system",
    status: "completed",
    allowedRoles: [],
    userNodeId: "",
    updateTime: nowTs(),
  });

  setChapterProgressState(state, {
    phaseId: "",
    phaseIndex: outline.phases.length,
    eventIndex: endingEventIndex,
    eventKind: "ending",
    eventSummary: endingSummary,
    eventStatus: "completed",
    completedEvents,
    fixedOutcomeLocked: true,
    pendingGoal: "",
    userNodeStatus: outcome.result === "success" ? "completed" : progress.userNodeStatus,
  });
  syncRuntimeCurrentEventFromChapterProgress(state);
}
