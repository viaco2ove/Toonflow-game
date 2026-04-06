import { JsonRecord } from "@/lib/gameEngine";
import { applyChapterOutcomeToState, ChapterOutcomeResult, evaluateChapterOutcome } from "@/modules/game-runtime/engines/ChapterOutcomeEngine";

export interface EvaluateRuntimeOutcomeInput {
  chapter: any;
  state: JsonRecord;
  messageContent?: string;
  eventType?: string;
  meta?: JsonRecord;
  fallbackStatus?: string;
  fallbackChapterId?: number | null;
  fallbackOutcome?: "continue" | "success" | "failed";
  fallbackNextChapterId?: number | null;
  applyToState?: boolean;
}

export interface RuntimeOutcomeResolution {
  evaluation: ChapterOutcomeResult;
  outcome: "continue" | "success" | "failed";
  sessionStatus: string;
  nextChapterId: number | null;
}

function isDebugLogEnabled(): boolean {
  return String(process.env.LOG_LEVEL || "").trim().toUpperCase() === "DEBUG";
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

export function resolveSessionStatusByOutcome(
  currentStatus: string,
  outcome: "continue" | "success" | "failed",
): string {
  if (outcome === "failed") return "failed";
  if (outcome === "success") return "chapter_completed";
  return currentStatus;
}

// 正式链和调试链统一使用这一层做章节结果收口，
// 避免一边走硬规则、一边自己拼 fallback。
export function evaluateRuntimeOutcome(input: EvaluateRuntimeOutcomeInput): RuntimeOutcomeResolution {
  const evaluation = evaluateChapterOutcome({
    chapter: input.chapter,
    state: input.state,
    messageContent: input.messageContent,
    eventType: input.eventType,
    meta: input.meta,
  });

  const outcome = evaluation.hasRule
    ? evaluation.result
    : (input.fallbackOutcome || "continue");
  const nextChapterId = evaluation.hasRule
    ? (evaluation.nextChapterId || input.fallbackChapterId || null)
    : (input.fallbackNextChapterId || input.fallbackChapterId || null);
  const sessionStatus = resolveSessionStatusByOutcome(String(input.fallbackStatus || "active"), outcome);

  // 总是输出 [tag_end_chapter] 日志，便于调试和追踪
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
        : `命中${evaluation.matchedBy === "runtime_outline" ? "运行时事件规则" : "完成条件"}:${evaluation.matchedRule || "未命名规则"}`)
      : "当前章节没有有效结束条件，沿用fallbackOutcome",
  }));

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
