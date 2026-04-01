import {
  ChapterRuntimePhase,
  ChapterRuntimeOutline,
  JsonRecord,
  normalizeChapterRuntimeOutline,
  readChapterProgressState,
  setChapterProgressState,
} from "@/lib/gameEngine";
import {
  AppliedDelta,
  TaskProgressChange,
  TriggerHit,
} from "@/modules/game-runtime/types/runtime";

function asRecord(input: unknown): JsonRecord {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as JsonRecord
    : {};
}

function readRuntimeOutline(chapter: any): ChapterRuntimeOutline {
  return normalizeChapterRuntimeOutline(asRecord(chapter).runtimeOutline);
}

function readCanPlayerSpeak(state: JsonRecord): boolean {
  const turnState = asRecord(state.turnState);
  return turnState.canPlayerSpeak !== false;
}

function normalizeCompletedEvents(input: string[]): string[] {
  return Array.from(new Set(input.map((item) => String(item || "").trim()).filter(Boolean)));
}

function normalizeSignalText(input: unknown): string {
  return String(input || "")
    .replace(/[\s，。、“”"'‘’：:；;（）()【】\[\]\-—_·•・⋯…,.!?！？]/g, "")
    .trim()
    .toLowerCase();
}

function phaseSignalMatches(signalTexts: string[], phase: ChapterRuntimePhase | null): boolean {
  if (!phase) return false;
  const phaseSignals = Array.isArray(phase.advanceSignals) ? phase.advanceSignals : [];
  if (!phaseSignals.length) {
    return signalMatches(phase.label, signalTexts) || signalMatches(phase.targetSummary, signalTexts);
  }
  return phaseSignals.some((item) => signalMatches(item, signalTexts));
}

function getUserNodeMarker(userNodeId: string): string {
  return `user_node:${String(userNodeId || "").trim()}`;
}

function getPhaseMarker(phaseId: string): string {
  return `phase:${String(phaseId || "").trim()}`;
}

function findNextPendingUserNode(outline: ChapterRuntimeOutline, completedEvents: string[]) {
  const done = new Set(completedEvents.map((item) => String(item || "").trim()).filter(Boolean));
  return outline.userNodes.find((item) => !done.has(getUserNodeMarker(item.id))) || null;
}

function isUserNodeCompleted(completedEvents: string[], userNodeId: string | null | undefined): boolean {
  if (!userNodeId) return false;
  return completedEvents.map((item) => String(item || "").trim()).includes(getUserNodeMarker(userNodeId));
}

function isPhaseCompleted(completedEvents: string[], phaseId: string | null | undefined): boolean {
  if (!phaseId) return false;
  return completedEvents.map((item) => String(item || "").trim()).includes(getPhaseMarker(phaseId));
}

function arePhaseRequirementsMet(completedEvents: string[], phase: ChapterRuntimePhase | null): boolean {
  if (!phase) return false;
  const requiredEventIds = Array.isArray(phase.requiredEventIds) ? phase.requiredEventIds : [];
  if (!requiredEventIds.length) return true;
  const completed = new Set(completedEvents.map((item) => String(item || "").trim()).filter(Boolean));
  return requiredEventIds.every((item) => completed.has(String(item || "").trim()));
}

function arePhaseCompletionEventsMatched(
  completedEvents: string[],
  phase: ChapterRuntimePhase | null,
  matchedFixedEvents: string[] = [],
): boolean {
  if (!phase) return false;
  const completionEventIds = Array.isArray(phase.completionEventIds) ? phase.completionEventIds : [];
  if (!completionEventIds.length) return false;
  const completed = new Set(completedEvents.map((item) => String(item || "").trim()).filter(Boolean));
  for (const item of matchedFixedEvents) {
    completed.add(String(item || "").trim());
  }
  return completionEventIds.some((item) => completed.has(String(item || "").trim()));
}

function resolveCurrentOrInitialPhase(
  outline: ChapterRuntimeOutline,
  currentPhaseId: string,
  completedEvents: string[],
): { phase: ChapterRuntimePhase | null; phaseIndex: number } {
  if (!outline.phases.length) {
    return { phase: null, phaseIndex: 0 };
  }
  if (currentPhaseId) {
    const matchedIndex = outline.phases.findIndex((item) => item.id === currentPhaseId);
    if (matchedIndex >= 0 && !isPhaseCompleted(completedEvents, currentPhaseId)) {
      return {
        phase: outline.phases[matchedIndex],
        phaseIndex: matchedIndex,
      };
    }
  }
  for (let index = 0; index < outline.phases.length; index += 1) {
    const phase = outline.phases[index];
    if (isPhaseCompleted(completedEvents, phase.id)) {
      continue;
    }
    if (!arePhaseRequirementsMet(completedEvents, phase)) {
      continue;
    }
    if (phase.kind !== "user") {
      return { phase, phaseIndex: index };
    }
    if (!isUserNodeCompleted(completedEvents, phase.userNodeId)) {
      return { phase, phaseIndex: index };
    }
  }
  return {
    phase: outline.phases[outline.phases.length - 1] || null,
    phaseIndex: Math.max(0, outline.phases.length - 1),
  };
}

function resolvePhaseForUserNode(
  outline: ChapterRuntimeOutline,
  userNodeId: string | null,
  fallbackIndex: number,
): { phase: ChapterRuntimePhase | null; phaseIndex: number } {
  if (!outline.phases.length) {
    return { phase: null, phaseIndex: fallbackIndex >= 0 ? fallbackIndex : 0 };
  }
  if (userNodeId) {
    const matchedIndex = outline.phases.findIndex((item) => item.userNodeId === userNodeId);
    if (matchedIndex >= 0) {
      return {
        phase: outline.phases[matchedIndex],
        phaseIndex: matchedIndex,
      };
    }
  }
  const safeIndex = Math.max(0, Math.min(fallbackIndex >= 0 ? fallbackIndex : 0, outline.phases.length - 1));
  return {
    phase: outline.phases[safeIndex] || null,
    phaseIndex: safeIndex,
  };
}

function resolveFinalPhase(outline: ChapterRuntimeOutline): { phase: ChapterRuntimePhase | null; phaseIndex: number } {
  if (!outline.phases.length) {
    return { phase: null, phaseIndex: 0 };
  }
  return {
    phase: outline.phases[outline.phases.length - 1] || null,
    phaseIndex: Math.max(0, outline.phases.length - 1),
  };
}

function resolvePendingGoal(phase: ChapterRuntimePhase | null, outline: ChapterRuntimeOutline, userNodeId: string | null): string {
  if (phase?.targetSummary) return phase.targetSummary;
  if (!userNodeId) return "";
  const matchedUserNode = outline.userNodes.find((item) => item.id === userNodeId) || null;
  return matchedUserNode
    ? (matchedUserNode.label || matchedUserNode.triggerHint || matchedUserNode.promptText)
    : "";
}

function getPhaseById(outline: ChapterRuntimeOutline, phaseId: string | null | undefined): { phase: ChapterRuntimePhase | null; phaseIndex: number } {
  if (!phaseId) return { phase: null, phaseIndex: -1 };
  const phaseIndex = outline.phases.findIndex((item) => item.id === phaseId);
  if (phaseIndex < 0) return { phase: null, phaseIndex: -1 };
  return {
    phase: outline.phases[phaseIndex] || null,
    phaseIndex,
  };
}

function getPhaseCandidateNextIds(outline: ChapterRuntimeOutline, phaseId: string | null | undefined, fallbackIndex: number): string[] {
  const { phase } = getPhaseById(outline, phaseId);
  if (!phase) {
    const nextSequentialId = outline.phases[fallbackIndex + 1]?.id || "";
    return nextSequentialId ? [nextSequentialId] : [];
  }
  const explicit = Array.isArray(phase.nextPhaseIds) ? phase.nextPhaseIds.map((item) => String(item || "").trim()).filter(Boolean) : [];
  const defaultNext = String(phase.defaultNextPhaseId || "").trim();
  const nextSequentialId = outline.phases[fallbackIndex + 1]?.id || "";
  return Array.from(new Set([
    ...(defaultNext ? [defaultNext] : []),
    ...explicit,
    ...(nextSequentialId ? [nextSequentialId] : []),
  ]));
}

function resolveNextPhaseFromGraph(
  outline: ChapterRuntimeOutline,
  currentPhaseId: string | null | undefined,
  completedEvents: string[],
  fallbackIndex: number,
): { phase: ChapterRuntimePhase | null; phaseIndex: number } {
  const visited = new Set<string>();
  const queue = getPhaseCandidateNextIds(outline, currentPhaseId, fallbackIndex);
  while (queue.length) {
    const phaseId = String(queue.shift() || "").trim();
    if (!phaseId || visited.has(phaseId)) continue;
    visited.add(phaseId);
    const { phase, phaseIndex } = getPhaseById(outline, phaseId);
    if (!phase || phaseIndex < 0) continue;
    if (isPhaseCompleted(completedEvents, phase.id)) {
      queue.push(...getPhaseCandidateNextIds(outline, phase.id, phaseIndex));
      continue;
    }
    if (!arePhaseRequirementsMet(completedEvents, phase)) {
      continue;
    }
    return { phase, phaseIndex };
  }
  return resolveCurrentOrInitialPhase(outline, "", completedEvents);
}

function updatePhaseState(
  outline: ChapterRuntimeOutline,
  state: JsonRecord,
  phase: ChapterRuntimePhase | null,
  phaseIndex: number,
  userNodeId: string | null,
  userNodeIndex: number,
  userNodeStatus: "idle" | "waiting_input" | "completed" | "skipped",
  extraPatch: Partial<JsonRecord> = {},
) {
  setChapterProgressState(state, {
    phaseId: String(phase?.id || "").trim(),
    phaseIndex,
    userNodeId: userNodeId || "",
    userNodeIndex,
    userNodeStatus,
    pendingGoal: resolvePendingGoal(phase, outline, userNodeId),
    ...extraPatch,
  });
}

function markPhaseCompleted(completedEvents: string[], phaseId: string | null | undefined): string[] {
  if (!phaseId) return normalizeCompletedEvents(completedEvents);
  const next = [...completedEvents];
  const marker = getPhaseMarker(phaseId);
  if (!next.includes(marker)) {
    next.push(marker);
  }
  return normalizeCompletedEvents(next);
}

function signalMatches(label: string, signalTexts: string[]): boolean {
  const normalizedLabel = normalizeSignalText(label);
  if (!normalizedLabel) return false;
  return signalTexts.some((item) => item.includes(normalizedLabel) || normalizedLabel.includes(item));
}

function collectSignalTexts(input: {
  messageContent?: string;
  messageRole?: string;
  messageRoleType?: string;
  triggered?: TriggerHit[];
  taskProgress?: TaskProgressChange[];
  deltas?: AppliedDelta[];
}): string[] {
  const texts = [
    String(input.messageContent || ""),
    String(input.messageRole || ""),
    String(input.messageRoleType || ""),
    ...(Array.isArray(input.triggered) ? input.triggered.flatMap((item) => [item.name, item.eventType]) : []),
    ...(Array.isArray(input.taskProgress) ? input.taskProgress.flatMap((item) => [item.title, item.nextStatus]) : []),
    ...(Array.isArray(input.deltas) ? input.deltas.flatMap((item) => [item.field, item.source, item.entityId]) : []),
  ];
  return Array.from(new Set(texts.map((item) => normalizeSignalText(item)).filter(Boolean)));
}

export function initializeChapterProgressForState(chapter: any, state: JsonRecord): void {
  const outline = readRuntimeOutline(chapter);
  const current = readChapterProgressState(state);
  const completedEvents = normalizeCompletedEvents(current.completedEvents);
  const nextUserNode = findNextPendingUserNode(outline, completedEvents);
  const activePhaseInfo = resolveCurrentOrInitialPhase(outline, current.phaseId, completedEvents);
  if (!activePhaseInfo.phase && !nextUserNode) {
    const finalPhase = resolveFinalPhase(outline);
    updatePhaseState(outline, state, finalPhase.phase, finalPhase.phaseIndex, null, -1, "idle");
    return;
  }
  const activePhase = activePhaseInfo.phase;
  const effectiveUserNodeId = activePhase?.kind === "user"
    ? (activePhase.userNodeId || nextUserNode?.id || null)
    : (nextUserNode?.id || null);
  const effectiveUserNodeIndex = effectiveUserNodeId
    ? outline.userNodes.findIndex((item) => item.id === effectiveUserNodeId)
    : -1;
  const shouldWaitForUser = activePhase?.kind === "user" && readCanPlayerSpeak(state);
  updatePhaseState(
    outline,
    state,
    activePhase,
    activePhaseInfo.phaseIndex,
    effectiveUserNodeId,
    effectiveUserNodeIndex,
    shouldWaitForUser ? "waiting_input" : "idle",
  );
}

export function syncChapterProgressWithRuntime(chapter: any, state: JsonRecord): void {
  const outline = readRuntimeOutline(chapter);
  const current = readChapterProgressState(state);
  const completedEvents = normalizeCompletedEvents(Array.isArray(current.completedEvents) ? current.completedEvents : []);
  const nextUserNode = findNextPendingUserNode(outline, completedEvents);
  let activePhaseInfo = resolveCurrentOrInitialPhase(outline, current.phaseId, completedEvents);
  if (activePhaseInfo.phase?.kind === "user" && isUserNodeCompleted(completedEvents, activePhaseInfo.phase.userNodeId)) {
    const nextPhaseInfo = resolveNextPhaseFromGraph(
      outline,
      activePhaseInfo.phase.id,
      completedEvents,
      activePhaseInfo.phaseIndex,
    );
    if (nextPhaseInfo.phase) {
      activePhaseInfo = nextPhaseInfo;
    }
  }
  if (!activePhaseInfo.phase && !nextUserNode) {
    const finalPhase = resolveFinalPhase(outline);
    updatePhaseState(outline, state, finalPhase.phase, finalPhase.phaseIndex, null, -1, "idle");
    return;
  }
  const activePhase = activePhaseInfo.phase;
  const effectiveUserNodeId = activePhase?.kind === "user"
    ? (activePhase.userNodeId || nextUserNode?.id || null)
    : (nextUserNode?.id || null);
  const effectiveUserNodeIndex = effectiveUserNodeId
    ? outline.userNodes.findIndex((item) => item.id === effectiveUserNodeId)
    : -1;
  const shouldWaitForUser = activePhase?.kind === "user" && readCanPlayerSpeak(state);
  updatePhaseState(
    outline,
    state,
    activePhase,
    activePhaseInfo.phaseIndex,
    effectiveUserNodeId,
    effectiveUserNodeIndex,
    shouldWaitForUser ? "waiting_input" : "idle",
  );
}

export function markCurrentUserNodeCompleted(chapter: any, state: JsonRecord, messageId?: number | null): void {
  const outline = readRuntimeOutline(chapter);
  const current = readChapterProgressState(state);
  const currentNode = current.userNodeId
    ? outline.userNodes.find((item) => item.id === current.userNodeId) || null
    : findNextPendingUserNode(outline, current.completedEvents);
  if (!currentNode) return;
  let completedEvents = normalizeCompletedEvents(Array.isArray(current.completedEvents) ? [...current.completedEvents] : []);
  const marker = getUserNodeMarker(currentNode.id);
  if (!completedEvents.includes(marker)) {
    completedEvents.push(marker);
  }
  completedEvents = markPhaseCompleted(completedEvents, current.phaseId);
  const nextUserNode = findNextPendingUserNode(outline, completedEvents);
  const currentPhaseIndex = outline.phases.findIndex((item) => item.id === current.phaseId);
  const advancedPhase = currentPhaseIndex >= 0
    ? resolveNextPhaseFromGraph(outline, current.phaseId, completedEvents, currentPhaseIndex).phase
    : null;
  const advancedPhaseIndex = advancedPhase
    ? outline.phases.findIndex((item) => item.id === advancedPhase.id)
    : -1;
  const phaseInfo = advancedPhase
    ? {
      phase: advancedPhase,
      phaseIndex: advancedPhaseIndex >= 0 ? advancedPhaseIndex : currentPhaseIndex + 1,
    }
    : nextUserNode
      ? resolvePhaseForUserNode(outline, nextUserNode.id, outline.userNodes.findIndex((item) => item.id === nextUserNode.id))
      : resolveFinalPhase(outline);
  const nextUserNodeId = phaseInfo.phase?.kind === "user"
    ? (phaseInfo.phase.userNodeId || nextUserNode?.id || null)
    : (nextUserNode?.id || null);
  const nextUserNodeIndex = nextUserNodeId
    ? outline.userNodes.findIndex((item) => item.id === nextUserNodeId)
    : -1;
  updatePhaseState(
    outline,
    state,
    phaseInfo.phase,
    phaseInfo.phaseIndex,
    nextUserNodeId,
    nextUserNodeIndex,
    nextUserNode ? "idle" : "completed",
    {
      completedEvents,
      lastEvaluatedMessageId: Number.isFinite(Number(messageId)) ? Number(messageId) : current.lastEvaluatedMessageId,
    },
  );
}

export function advanceChapterProgressAfterNarrative(chapter: any, state: JsonRecord, input?: {
  messageContent?: string;
  messageRole?: string;
  messageRoleType?: string;
}): {
  phaseChanged: boolean;
  enteredUserPhase: boolean;
  matchedPhaseSignal: boolean;
} {
  const outline = readRuntimeOutline(chapter);
  const current = readChapterProgressState(state);
  if (!outline.phases.length) {
    return { phaseChanged: false, enteredUserPhase: false, matchedPhaseSignal: false };
  }
  const currentPhaseIndex = outline.phases.findIndex((item) => item.id === current.phaseId);
  if (currentPhaseIndex < 0) {
    syncChapterProgressWithRuntime(chapter, state);
    const synced = readChapterProgressState(state);
    return {
      phaseChanged: synced.phaseId !== current.phaseId,
      enteredUserPhase: synced.userNodeStatus === "waiting_input",
      matchedPhaseSignal: false,
    };
  }
  const currentPhase = outline.phases[currentPhaseIndex];
  if (currentPhase.kind === "user") {
    syncChapterProgressWithRuntime(chapter, state);
    return {
      phaseChanged: false,
      enteredUserPhase: readChapterProgressState(state).userNodeStatus === "waiting_input",
      matchedPhaseSignal: false,
    };
  }
  const signalTexts = collectSignalTexts({
    messageContent: input?.messageContent,
    messageRole: input?.messageRole,
    messageRoleType: input?.messageRoleType,
  });
  const matchedPhaseSignal = phaseSignalMatches(signalTexts, currentPhase);
  const matchedPhaseCompletion = arePhaseCompletionEventsMatched(current.completedEvents, currentPhase);
  if (signalTexts.length && !matchedPhaseSignal && !matchedPhaseCompletion) {
    return { phaseChanged: false, enteredUserPhase: false, matchedPhaseSignal: false };
  }
  const completedEvents = markPhaseCompleted(
    normalizeCompletedEvents(Array.isArray(current.completedEvents) ? current.completedEvents : []),
    currentPhase.id,
  );
  const nextPhaseInfo = resolveNextPhaseFromGraph(outline, currentPhase.id, completedEvents, currentPhaseIndex);
  const nextPhase = nextPhaseInfo.phase;
  if (!nextPhase) {
    setChapterProgressState(state, { completedEvents });
    return { phaseChanged: false, enteredUserPhase: false, matchedPhaseSignal: true };
  }
  const nextUserNodeId = nextPhase.kind === "user"
    ? (nextPhase.userNodeId || current.userNodeId || null)
    : current.userNodeId || null;
  const nextUserNodeIndex = nextUserNodeId
    ? outline.userNodes.findIndex((item) => item.id === nextUserNodeId)
    : -1;
  const enteredUserPhase = nextPhase.kind === "user";
  updatePhaseState(
    outline,
    state,
    nextPhase,
    nextPhaseInfo.phaseIndex,
    nextUserNodeId,
    nextUserNodeIndex,
    enteredUserPhase ? "waiting_input" : "idle",
    { completedEvents },
  );
  return {
    phaseChanged: true,
    enteredUserPhase,
    matchedPhaseSignal: true,
  };
}

export function recordChapterProgressSignals(chapter: any, state: JsonRecord, input: {
  messageContent?: string;
  messageRole?: string;
  messageRoleType?: string;
  triggered?: TriggerHit[];
  taskProgress?: TaskProgressChange[];
  deltas?: AppliedDelta[];
}): {
  matchedFixedEvents: string[];
  markedPhaseCompleted: boolean;
} {
  const outline = readRuntimeOutline(chapter);
  const current = readChapterProgressState(state);
  const signalTexts = collectSignalTexts(input);
  if (!signalTexts.length) {
    return { matchedFixedEvents: [], markedPhaseCompleted: false };
  }
  let completedEvents = normalizeCompletedEvents(Array.isArray(current.completedEvents) ? current.completedEvents : []);
  const matchedFixedEvents = outline.fixedEvents
    .filter((item) => signalMatches(item.label, signalTexts) || signalMatches(item.id, signalTexts))
    .map((item) => item.id);
  for (const fixedEventId of matchedFixedEvents) {
    if (!completedEvents.includes(fixedEventId)) {
      completedEvents.push(fixedEventId);
    }
  }
  let markedPhaseCompleted = false;
  const currentPhase = outline.phases.find((item) => item.id === current.phaseId) || null;
  if (currentPhase && currentPhase.kind !== "user") {
    const relatedFixedEvents = Array.isArray(currentPhase.relatedFixedEventIds)
      ? currentPhase.relatedFixedEventIds
      : [];
    const phaseMatched = phaseSignalMatches(signalTexts, currentPhase)
      || arePhaseCompletionEventsMatched(completedEvents, currentPhase, matchedFixedEvents)
      || (matchedFixedEvents.length > 0 && (
        !relatedFixedEvents.length || matchedFixedEvents.some((item) => relatedFixedEvents.includes(item))
      ));
    if (phaseMatched) {
      completedEvents = markPhaseCompleted(completedEvents, currentPhase.id);
      markedPhaseCompleted = true;
    }
  }
  completedEvents = normalizeCompletedEvents(completedEvents);
  if (completedEvents.join("|") !== current.completedEvents.join("|")) {
    setChapterProgressState(state, { completedEvents });
  }
  return {
    matchedFixedEvents,
    markedPhaseCompleted,
  };
}
