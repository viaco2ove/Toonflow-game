import {
  ChapterRuntimeOutline,
  ConditionContext,
  JsonRecord,
  evaluateCondition,
  parseJsonSafe,
  readChapterProgressState,
  setChapterProgressState,
  setValueByPath,
} from "@/lib/gameEngine";

export interface ChapterOutcomeResult {
  hasRule: boolean;
  result: "continue" | "success" | "failed";
  nextChapterId: number | null;
  matchedBy: "runtime_outline" | "completion_condition" | "none";
  matchedRule: string | null;
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
  if (typeof input === "string") return input.trim().length > 0;
  if (Array.isArray(input)) return input.length > 0;
  if (typeof input === "object") return Object.keys(input as Record<string, unknown>).length > 0;
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
    return { result: "continue", matchedRule: null };
  }
  if (isRecord(condition)) {
    const failureNode = condition.failure ?? condition.failed ?? condition.fail;
    if (failureNode !== undefined && evaluateCondition(failureNode, ctx)) {
      return { result: "failed", matchedRule: "completion.failure" };
    }
    const successNode = condition.success ?? condition.pass;
    if (successNode !== undefined && evaluateCondition(successNode, ctx)) {
      return { result: "success", matchedRule: "completion.success" };
    }
  }
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

  setChapterProgressState(state, {
    completedEvents,
    fixedOutcomeLocked: true,
    pendingGoal: "",
    userNodeStatus: outcome.result === "success" ? "completed" : progress.userNodeStatus,
  });
}
