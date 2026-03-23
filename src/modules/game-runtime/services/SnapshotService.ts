import {
  PersistSnapshotInput,
  PersistSnapshotResult,
  SnapshotDecision,
  SnapshotPolicyInput,
} from "@/modules/game-runtime/types/runtime";

export function decideSnapshotPolicy(input: SnapshotPolicyInput): SnapshotDecision {
  const {
    saveSnapshot,
    nextChapterId,
    prevChapterId,
    sessionStatus,
    prevStatus,
    round,
  } = input;

  if (saveSnapshot) {
    return { shouldSave: true, reason: "manual" };
  }
  if (nextChapterId !== prevChapterId) {
    return { shouldSave: true, reason: "chapter_switched" };
  }
  if (sessionStatus !== prevStatus) {
    return { shouldSave: true, reason: "status_changed" };
  }
  if (Number(round || 0) > 0 && Number(round || 0) % 5 === 0) {
    return { shouldSave: true, reason: "auto_round" };
  }
  return { shouldSave: false, reason: "" };
}

export async function persistSnapshotIfNeeded(input: PersistSnapshotInput): Promise<PersistSnapshotResult> {
  const {
    db,
    sessionId,
    stateJson,
    round,
    now,
    policy,
  } = input;

  const decision = decideSnapshotPolicy(policy);
  if (!decision.shouldSave) {
    return {
      snapshotSaved: false,
      snapshotReason: "",
    };
  }

  await db("t_sessionStateSnapshot").insert({
    sessionId,
    stateJson,
    reason: decision.reason,
    round,
    createTime: now,
  });

  return {
    snapshotSaved: true,
    snapshotReason: decision.reason,
  };
}
