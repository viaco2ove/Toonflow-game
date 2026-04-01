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
