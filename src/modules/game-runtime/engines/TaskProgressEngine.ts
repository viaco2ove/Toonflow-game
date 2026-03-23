import {
  evaluateCondition,
  getValueByPath,
  normalizeActionList,
  parseJsonSafe,
  setValueByPath,
} from "@/lib/gameEngine";
import { applyRuntimeAction } from "@/modules/game-runtime/engines/TriggerEngine";
import {
  AppliedDelta,
  TaskProgressChange,
  TaskProgressInput,
  TaskProgressResult,
  TriggerHit,
} from "@/modules/game-runtime/types/runtime";

function isRecord(input: unknown): input is Record<string, any> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function normalizeTaskStatus(input: unknown): string {
  const status = String(input || "").trim().toLowerCase();
  if (status === "done" || status === "failed" || status === "doing") return status;
  return "todo";
}

function hasEffectiveCondition(input: unknown): boolean {
  if (input === null || input === undefined) return false;
  if (typeof input === "string") {
    const text = input.trim();
    if (!text) return false;
    const parsed = parseJsonSafe<unknown>(text, text);
    if (parsed === null || parsed === undefined) return false;
    if (typeof parsed === "string") return parsed.trim().length > 0;
    if (Array.isArray(parsed)) return parsed.length > 0;
    if (isRecord(parsed)) return Object.keys(parsed).length > 0;
    return true;
  }
  if (Array.isArray(input)) return input.length > 0;
  if (isRecord(input)) return Object.keys(input).length > 0;
  return true;
}

function ensureTaskProgress(state: Record<string, any>): Record<string, any> {
  const current = state.taskProgress;
  if (isRecord(current)) return current;
  const next: Record<string, any> = {};
  state.taskProgress = next;
  return next;
}

function appendDelta(
  deltas: AppliedDelta[],
  taskId: number,
  oldValue: unknown,
  newValue: unknown,
  source: string,
) {
  deltas.push({
    entityType: "task",
    entityId: String(taskId),
    field: `taskProgress.${taskId}.status`,
    oldValue,
    newValue,
    source,
  });
}

export async function runTaskProgressEngine(input: TaskProgressInput): Promise<TaskProgressResult> {
  const {
    db,
    chapterId,
    state,
    messageContent,
    eventType,
    meta,
    now,
    nextChapterId: rawNextChapterId,
    currentStatus,
  } = input;

  const appliedDeltas: AppliedDelta[] = [];
  const taskProgressChanges: TaskProgressChange[] = [];
  let sessionStatus = currentStatus;
  let nextChapterId = rawNextChapterId;
  let triggerHit: TriggerHit | null = null;

  if (chapterId) {
    const taskRows = await db("t_chapterTask")
      .where({ chapterId: Number(chapterId) })
      .orderBy("sort", "asc")
      .orderBy("id", "asc");

    if (taskRows.length > 0) {
      const taskProgress = ensureTaskProgress(state);
      for (const task of taskRows) {
        const taskId = Number(task.id || 0);
        if (!Number.isFinite(taskId) || taskId <= 0) continue;

        const key = String(taskId);
        const currentTaskState = isRecord(taskProgress[key]) ? taskProgress[key] : {};
        const previousStatus = normalizeTaskStatus(currentTaskState.status || task.status);

        let nextStatus = previousStatus;
        if (previousStatus !== "done" && previousStatus !== "failed") {
          const failEnabled = hasEffectiveCondition(task.failCondition);
          const successEnabled = hasEffectiveCondition(task.successCondition);

          const failMatched = failEnabled
            ? evaluateCondition(task.failCondition, { state, messageContent, eventType, meta })
            : false;
          const successMatched = successEnabled
            ? evaluateCondition(task.successCondition, { state, messageContent, eventType, meta })
            : false;

          if (failMatched) {
            nextStatus = "failed";
          } else if (successMatched) {
            nextStatus = "done";
          }
        }

        if (nextStatus !== previousStatus) {
          const nextTaskState = {
            ...currentTaskState,
            id: taskId,
            title: String(task.title || ""),
            status: nextStatus,
            updateTime: now,
            lastEventType: eventType,
          };
          taskProgress[key] = nextTaskState;
          appendDelta(appliedDeltas, taskId, previousStatus, nextStatus, `task:${taskId}`);
          taskProgressChanges.push({
            taskId,
            title: String(task.title || `任务${taskId}`),
            previousStatus,
            nextStatus,
          });

          if (nextStatus === "done") {
            const rewardActions = normalizeActionList(task.rewardAction);
            for (const action of rewardActions) {
              const actionResult = applyRuntimeAction({
                state,
                action,
                sourceTag: `task:${taskId}`,
                appliedDeltas,
                nextChapterId,
                sessionStatus,
              });
              nextChapterId = actionResult.nextChapterId;
              sessionStatus = actionResult.sessionStatus;
            }
          }
        }
      }
    }
  }

  const chapterToCheck = nextChapterId
    ? await db("t_storyChapter").where({ id: Number(nextChapterId) }).first()
    : null;
  if (chapterToCheck && hasEffectiveCondition(chapterToCheck.completionCondition)) {
    const chapterDone = evaluateCondition(chapterToCheck.completionCondition, {
      state,
      messageContent,
      eventType,
      meta,
    });
    if (chapterDone) {
      const oldValue = getValueByPath(state, "flags.chapterCompleted");
      setValueByPath(state, "flags.chapterCompleted", true);
      sessionStatus = "chapter_completed";
      if (oldValue !== true) {
        appliedDeltas.push({
          entityType: "state",
          entityId: "state",
          field: "flags.chapterCompleted",
          oldValue,
          newValue: true,
          source: "chapter_completion",
        });
      }
      triggerHit = {
        triggerId: 0,
        name: "章节完成检测",
        eventType: "chapter_completion",
        actionCount: 1,
      };
    }
  }

  return {
    appliedDeltas,
    taskProgressChanges,
    sessionStatus,
    nextChapterId,
    triggerHit,
  };
}
