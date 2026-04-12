import {
  ChapterRuntimePhase,
  ChapterRuntimeOutline,
  ConditionContext,
  evaluateCondition,
  isFreeChapterRuntimeMode,
  JsonRecord,
  parseJsonSafe,
  normalizeRuntimeDynamicEventState,
  normalizeChapterRuntimeOutline,
  readChapterProgressState,
  readRuntimeCurrentEventState,
  RuntimeDynamicEventState,
  setChapterProgressState,
  setRuntimeDynamicEventList,
  syncRuntimeCurrentEventFromChapterProgress,
  upsertRuntimeDynamicEventState,
  upsertRuntimeEventDigestState,
} from "@/lib/gameEngine";
import {
  AppliedDelta,
  TaskProgressChange,
  TriggerHit,
} from "@/modules/game-runtime/types/runtime";

/**
 * 将未知输入安全转换为普通对象，避免后续读取章节和运行态字段时反复判空。
 */
function asRecord(input: unknown): JsonRecord {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as JsonRecord
    : {};
}

/**
 * 读取章节运行时编排图；老章节没有显式 phases 时，会自动补一个“章节内容”兜底事件。
 */
function readRuntimeOutline(chapter: any): ChapterRuntimeOutline {
  const outline = normalizeChapterRuntimeOutline(asRecord(chapter).runtimeOutline);
  if (Array.isArray(outline.phases) && outline.phases.length) {
    return outline;
  }
  // 未配置 phases 的章节仍然要能跑事件链，这里主动合成一个最小 scene 事件。
  const syntheticPhase = buildSyntheticChapterContentPhase(chapter);
  if (!syntheticPhase) {
    return outline;
  }
  return {
    ...outline,
    phases: [syntheticPhase],
  };
}

/**
 * 从章节正文里提取简短摘要，作为合成章节内容事件的展示文本。
 */
function readSyntheticChapterContentSummary(chapter: any): string {
  const text = String((chapter as any)?.content || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^@\s*[^:：\n]+[:：]\s*/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

/**
 * 为未配置 runtimeOutline.phases 的章节生成一个兜底 scene 事件。
 */
function buildSyntheticChapterContentPhase(chapter: any): ChapterRuntimePhase | null {
  const summary = readSyntheticChapterContentSummary(chapter);
  if (!summary) return null;
  return {
    id: "phase_synthetic_chapter_content",
    label: "章节内容",
    kind: "scene",
    targetSummary: summary,
    nextPhaseIds: [],
    defaultNextPhaseId: null,
    allowedSpeakers: [],
    userNodeId: "",
    requiredEventIds: [],
    completionEventIds: [],
    advanceSignals: [],
    relatedFixedEventIds: [],
  };
}

/**
 * 读取当前是否轮到用户输入。
 */
function readCanPlayerSpeak(state: JsonRecord): boolean {
  const turnState = asRecord(state.turnState);
  return turnState.canPlayerSpeak !== false;
}

/**
 * 归一化已完成事件列表，去重并清理空白项。
 */
function normalizeCompletedEvents(input: string[]): string[] {
  return Array.from(new Set(input.map((item) => String(item || "").trim()).filter(Boolean)));
}

/**
 * 将输入文本归一化为便于事件匹配的紧凑字符串。
 */
function normalizeSignalText(input: unknown): string {
  return String(input || "")
    .replace(/[\s，。、“”"'‘’：:；;（）()【】\[\]\-—_·•・⋯…,.!?！？]/g, "")
    .trim()
    .toLowerCase();
}

/**
 * 判断当前输入/输出信号是否命中某个 phase 的推进条件。
 */
function phaseSignalMatches(signalTexts: string[], phase: ChapterRuntimePhase | null): boolean {
  if (!phase) return false;
  const phaseSignals = Array.isArray(phase.advanceSignals) ? phase.advanceSignals : [];
  if (!phaseSignals.length) {
    return signalMatches(phase.label, signalTexts) || signalMatches(phase.targetSummary, signalTexts);
  }
  return phaseSignals.some((item) => signalMatches(item, signalTexts));
}

/**
 * 为用户节点生成统一的 completedEvents 标记。
 */
function getUserNodeMarker(userNodeId: string): string {
  return `user_node:${String(userNodeId || "").trim()}`;
}

/**
 * 为 phase 生成统一的 completedEvents 标记。
 */
function getPhaseMarker(phaseId: string): string {
  return `phase:${String(phaseId || "").trim()}`;
}

/**
 * 在章节编排图中找到下一个尚未完成的用户节点。
 */
function findNextPendingUserNode(outline: ChapterRuntimeOutline, completedEvents: string[]) {
  const done = new Set(completedEvents.map((item) => String(item || "").trim()).filter(Boolean));
  return outline.userNodes.find((item) => !done.has(getUserNodeMarker(item.id))) || null;
}

/**
 * 判断某个用户节点是否已经完成。
 */
function isUserNodeCompleted(completedEvents: string[], userNodeId: string | null | undefined): boolean {
  if (!userNodeId) return false;
  return completedEvents.map((item) => String(item || "").trim()).includes(getUserNodeMarker(userNodeId));
}

/**
 * 判断某个 phase 是否已经完成。
 */
function isPhaseCompleted(completedEvents: string[], phaseId: string | null | undefined): boolean {
  if (!phaseId) return false;
  return completedEvents.map((item) => String(item || "").trim()).includes(getPhaseMarker(phaseId));
}

/**
 * 判断 phase 的前置 requiredEventIds 是否已经全部满足。
 */
function arePhaseRequirementsMet(completedEvents: string[], phase: ChapterRuntimePhase | null): boolean {
  if (!phase) return false;
  const requiredEventIds = Array.isArray(phase.requiredEventIds) ? phase.requiredEventIds : [];
  if (!requiredEventIds.length) return true;
  const completed = new Set(completedEvents.map((item) => String(item || "").trim()).filter(Boolean));
  return requiredEventIds.every((item) => completed.has(String(item || "").trim()));
}

/**
 * 判断 phase 的 completionEventIds 是否被已完成事件或本轮 fixed event 命中。
 */
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

/**
 * 根据当前 progress 解析“当前应处于哪个 phase”。
 */
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
  // 从前往后找到第一个“未完成且满足前置条件”的 phase，作为当前事件。
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

/**
 * 根据用户节点反查所属 phase，用于用户输入后回到对应事件。
 */
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

/**
 * 返回章节编排图里的最后一个 phase。
 */
function resolveFinalPhase(outline: ChapterRuntimeOutline): { phase: ChapterRuntimePhase | null; phaseIndex: number } {
  if (!outline.phases.length) {
    return { phase: null, phaseIndex: 0 };
  }
  return {
    phase: outline.phases[outline.phases.length - 1] || null,
    phaseIndex: Math.max(0, outline.phases.length - 1),
  };
}

/**
 * 判断 completionCondition / endingRules 是否包含有效结束规则。
 */
function hasEffectiveEndingRule(input: unknown): boolean {
  if (input == null) return false;
  if (typeof input === "string") return String(input).trim().length > 0;
  if (Array.isArray(input)) return input.length > 0;
  if (typeof input === "object") return Object.keys(input as Record<string, unknown>).length > 0;
  return true;
}

/**
 * 读取章节 completionCondition，并兼容对象与 JSON 字符串两种存储格式。
 */
function readCompletionCondition(chapter: any): unknown {
  return parseJsonSafe((chapter as any)?.completionCondition, (chapter as any)?.completionCondition);
}

/**
 * 判断当前章节是否需要补一个“结束条件检查”事件。
 */
function hasChapterEndingEvent(chapter: any, outline: ChapterRuntimeOutline): boolean {
  return outline.endingRules.success.length > 0
    || outline.endingRules.failure.length > 0
    || hasEffectiveEndingRule(readCompletionCondition(chapter));
}

/**
 * 对结束条件文本做截断，避免事件摘要过长。
 */
function shortEndingText(input: unknown, fallback: string): string {
  const text = String(input || "").replace(/\r\n/g, "\n").trim();
  if (!text) return fallback;
  return text.length > 72 ? `${text.slice(0, 72)}...` : text;
}

/**
 * 构造结束条件检查事件的摘要文案。
 */
function buildEndingEventSummary(chapter: any, outline: ChapterRuntimeOutline): string {
  const condition = readCompletionCondition(chapter);
  if (typeof condition === "string" && condition.trim()) {
    return `结束条件：${shortEndingText(condition, "结束条件判定")}`;
  }
  if (condition && typeof condition === "object" && !Array.isArray(condition)) {
    const record = condition as Record<string, unknown>;
    const hinted = String(
      record.summary
      || record.label
      || record.description
      || record.prompt
      || record.goal
      || "",
    ).trim();
    if (hinted) {
      return `结束条件：${shortEndingText(hinted, "结束条件判定")}`;
    }
  }
  const successLabels = outline.fixedEvents
    .filter((item) => outline.endingRules.success.includes(item.id))
    .map((item) => String(item.label || "").trim())
    .filter(Boolean);
  const failureLabels = outline.fixedEvents
    .filter((item) => outline.endingRules.failure.includes(item.id))
    .map((item) => String(item.label || "").trim())
    .filter(Boolean);
  if (successLabels.length || failureLabels.length) {
    const successText = successLabels.slice(0, 2).join(" / ");
    const failureText = failureLabels.slice(0, 2).join(" / ");
    if (successText && failureText) {
      return `结束条件：成功满足 ${shortEndingText(successText, "成功条件")}；失败命中 ${shortEndingText(failureText, "失败条件")}`;
    }
    if (successText) {
      return `结束条件：${shortEndingText(successText, "成功条件")}`;
    }
    return `结束条件：${shortEndingText(failureText, "失败条件")}`;
  }
  return "结束条件判定";
}

/**
 * 读取 endingRules 对应的 fixed event 标签，供 UI 和日志展示成功/失败条件。
 */
function readEndingRuleLabels(outline: ChapterRuntimeOutline): { success: string[]; failure: string[] } {
  const fixedEventMap = new Map(
    outline.fixedEvents
      .map((item) => [String(item.id || "").trim(), String(item.label || "").trim()] as const)
      .filter(([id, label]) => id && label),
  );
  const success = outline.endingRules.success
    .map((item) => fixedEventMap.get(String(item || "").trim()) || "")
    .filter(Boolean);
  const failure = outline.endingRules.failure
    .map((item) => fixedEventMap.get(String(item || "").trim()) || "")
    .filter(Boolean);
  return { success, failure };
}

/**
 * 构造结束条件检查事件的事实列表，说明已命中与未命中的条件。
 */
function buildEndingEventFacts(input: {
  chapter: any;
  outline: ChapterRuntimeOutline;
  completedEvents: string[];
}): string[] {
  const { chapter, outline, completedEvents } = input;
  const facts: string[] = [];
  const { success, failure } = readEndingRuleLabels(outline);
  const condition = readCompletionCondition(chapter);
  const completed = new Set(completedEvents.map((item) => String(item || "").trim()).filter(Boolean));
  const matchedSuccess = outline.endingRules.success.filter((item) => completed.has(String(item || "").trim()));
  const matchedFailure = outline.endingRules.failure.filter((item) => completed.has(String(item || "").trim()));
  if (typeof condition === "string" && condition.trim()) {
    facts.push(`结束条件原文：${condition.trim()}`);
  }
  if (success.length) {
    facts.push(`成功条件：${success.join("；")}`);
  }
  if (failure.length) {
    facts.push(`失败条件：${failure.join("；")}`);
  }
  if (matchedSuccess.length) {
    const matchedLabels = success.length
      ? outline.fixedEvents
        .filter((item) => matchedSuccess.includes(String(item.id || "").trim()))
        .map((item) => String(item.label || "").trim())
        .filter(Boolean)
      : [];
    facts.push(`已命中成功条件：${(matchedLabels.length ? matchedLabels : matchedSuccess).join("；")}`);
  }
  if (matchedFailure.length) {
    const matchedLabels = failure.length
      ? outline.fixedEvents
        .filter((item) => matchedFailure.includes(String(item.id || "").trim()))
        .map((item) => String(item.label || "").trim())
        .filter(Boolean)
      : [];
    facts.push(`已命中失败条件：${(matchedLabels.length ? matchedLabels : matchedFailure).join("；")}`);
  }
  if (!matchedSuccess.length && !matchedFailure.length) {
    facts.push("当前尚未命中结束条件，需继续推进或补全条件。");
  }
  return facts;
}

/**
 * 将当前运行态切换到“章节结束条件检查事件”。
 */
function updateEndingState(
  chapter: any,
  outline: ChapterRuntimeOutline,
  state: JsonRecord,
  extraPatch: Partial<JsonRecord> = {},
) {
  const current = readChapterProgressState(state);
  const existingDynamicEvents = Array.isArray(state.dynamicEvents) ? state.dynamicEvents as RuntimeDynamicEventState[] : [];
  // ending 事件必须排在最后一个内容事件后面，避免与章节内容共用 eventIndex。
  const highestContentEventIndex = Math.max(
    outline.phases.length,
    ...existingDynamicEvents
      .filter((item) => !isEndingDynamicEvent(item))
      .map((item) => Number(item?.eventIndex || 0))
      .filter((item) => Number.isFinite(item) && item > 0),
  );
  const endingEventIndex = Math.max(1, highestContentEventIndex + 1);
  const endingSummary = buildEndingEventSummary(chapter, outline);
  const completedEvents = normalizeCompletedEvents(Array.isArray(extraPatch.completedEvents)
    ? extraPatch.completedEvents as string[]
    : current.completedEvents);
  const endingFacts = buildEndingEventFacts({
    chapter,
    outline,
    completedEvents,
  });
  const rawStatus = String(extraPatch.eventStatus || current.eventStatus || "active").trim().toLowerCase();
  const endingStatus: "idle" | "active" | "waiting_input" | "completed" = rawStatus === "completed"
    ? "completed"
    : rawStatus === "waiting_input"
      ? "waiting_input"
      : rawStatus === "idle"
        ? "idle"
        : "active";
  setChapterProgressState(state, {
    phaseId: "",
    phaseIndex: outline.phases.length,
    eventIndex: endingEventIndex,
    eventKind: "ending",
    eventSummary: endingSummary,
    eventStatus: endingStatus,
    userNodeId: "",
    userNodeIndex: -1,
    userNodeStatus: "idle",
    pendingGoal: endingSummary,
    ...extraPatch,
  });
  // 运行态里只保留一个 ending 动态事件，避免重复生成多个“结束条件检查”卡片。
  const existingEnding = existingDynamicEvents
    .map((item) => normalizeRuntimeDynamicEventState(item))
    .find((item) => isEndingDynamicEvent(item)) || null;
  const preservedDynamicEvents = existingDynamicEvents
    .map((item) => normalizeRuntimeDynamicEventState(item))
    .filter((item) => !isEndingDynamicEvent(item));
  preservedDynamicEvents.push(normalizeRuntimeDynamicEventState({
    ...existingEnding,
    eventIndex: endingEventIndex,
    phaseId: "",
    kind: "ending",
    flowType: "chapter_ending_check",
    summary: endingSummary,
    runtimeFacts: endingFacts,
    summarySource: "system",
    memorySummary: "",
    memoryFacts: [],
    status: endingStatus,
    allowedRoles: [],
    userNodeId: "",
    updateTime: 0,
  }));
  setRuntimeDynamicEventList(state, preservedDynamicEvents);
  syncRuntimeCurrentEventFromChapterProgress(state);
}

/**
 * 主动把当前事件切到 ending 检查，并补充引导摘要/事实。
 */
export function activateChapterEndingCheckState(input: {
  chapter: any;
  state: JsonRecord;
  reason?: string | null;
  guideSummary?: string | null;
  guideFacts?: string[] | null;
  eventStatus?: "idle" | "active" | "waiting_input" | "completed";
}): void {
  const outline = readRuntimeOutline(input.chapter);
  if (!hasChapterEndingEvent(input.chapter, outline)) return;
  const current = readChapterProgressState(input.state);
  const guideSummary = String(input.guideSummary || "").trim();
  updateEndingState(input.chapter, outline, input.state, {
    completedEvents: normalizeCompletedEvents(Array.isArray(current.completedEvents) ? current.completedEvents : []),
    eventSummary: guideSummary || undefined,
    eventStatus: input.eventStatus || "active",
  });
  const reason = String(input.reason || "").trim();
  if (!reason) return;
  const digest = readChapterProgressState(input.state);
  const currentDigest = readRuntimeCurrentEventState(input.state);
  const facts = Array.isArray(currentDigest.facts)
    ? currentDigest.facts.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const guideFacts = Array.isArray(input.guideFacts)
    ? input.guideFacts.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const reasonFact = `判定说明：${reason}`;
  const nextFacts = [...facts];
  for (const fact of guideFacts) {
    if (fact && !nextFacts.includes(fact)) {
      nextFacts.push(fact);
    }
  }
  if (!nextFacts.includes(reasonFact)) {
    nextFacts.push(reasonFact);
  }
  upsertRuntimeEventDigestState(input.state, {
    eventIndex: digest.eventIndex,
    eventKind: "ending",
    eventFlowType: "chapter_ending_check",
    eventStatus: input.eventStatus || "active",
    eventSummary: guideSummary || undefined,
    eventFacts: nextFacts,
  });
}

/**
 * 为自由模式章节生成/更新动态事件列表，不依赖固定的 runtimeOutline graph。
 */
function ensureFreeChapterDynamicEventState(
  chapter: any,
  state: JsonRecord,
  requestedEventIndex?: number | null,
  extraPatch: Partial<JsonRecord> = {},
) {
  if (!isFreeChapterRuntimeMode(chapter)) return;
  const current = readChapterProgressState(state);
  const runtimeEvent = readRuntimeCurrentEventState(state);
  const outline = readRuntimeOutline(chapter);
  const minimumEventIndex = outline.phases.length > 0 ? outline.phases.length + 1 : 1;
  const normalizedEventIndex = Number.isFinite(Number(requestedEventIndex))
    ? Math.max(minimumEventIndex, Number(requestedEventIndex))
    : Math.max(minimumEventIndex, Number(runtimeEvent.index || current.eventIndex || 1));
  setChapterProgressState(state, {
    phaseId: "",
    phaseIndex: -1,
    eventIndex: normalizedEventIndex,
    eventKind: "scene",
    eventSummary: "",
    eventStatus: "active",
    userNodeId: "",
    userNodeIndex: -1,
    userNodeStatus: "idle",
    pendingGoal: "",
    ...extraPatch,
  });
  upsertRuntimeDynamicEventState(state, {
    eventIndex: normalizedEventIndex,
    phaseId: "",
    kind: "scene",
    summary: "",
    runtimeFacts: [],
    summarySource: "system",
    memorySummary: "",
    memoryFacts: [],
    status: "active",
    allowedRoles: [],
    userNodeId: "",
    updateTime: 0,
  });
  syncRuntimeCurrentEventFromChapterProgress(state);
}

/**
 * 生成当前阶段的 pendingGoal，作为当前要完成事项的简短提示。
 */
function resolvePendingGoal(phase: ChapterRuntimePhase | null, outline: ChapterRuntimeOutline, userNodeId: string | null): string {
  if (phase?.targetSummary) return phase.targetSummary;
  if (!userNodeId) return "";
  const matchedUserNode = outline.userNodes.find((item) => item.id === userNodeId) || null;
  return matchedUserNode
    ? (matchedUserNode.label || matchedUserNode.triggerHint || matchedUserNode.promptText)
    : "";
}

/**
 * 根据 phaseId 在编排图里查 phase，并返回其索引。
 */
function getPhaseById(outline: ChapterRuntimeOutline, phaseId: string | null | undefined): { phase: ChapterRuntimePhase | null; phaseIndex: number } {
  if (!phaseId) return { phase: null, phaseIndex: -1 };
  const phaseIndex = outline.phases.findIndex((item) => item.id === phaseId);
  if (phaseIndex < 0) return { phase: null, phaseIndex: -1 };
  return {
    phase: outline.phases[phaseIndex] || null,
    phaseIndex,
  };
}

/**
 * 解析当前 phase 的候选 nextPhaseIds，同时兜底串联顺序下一个 phase。
 */
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

/**
 * 按图结构解析当前 phase 完成后应进入的下一个 phase。
 */
function resolveNextPhaseFromGraph(
  outline: ChapterRuntimeOutline,
  currentPhaseId: string | null | undefined,
  completedEvents: string[],
  fallbackIndex: number,
): { phase: ChapterRuntimePhase | null; phaseIndex: number } {
  const visited = new Set<string>();
  const queue = getPhaseCandidateNextIds(outline, currentPhaseId, fallbackIndex);
  while (queue.length) {
    // 使用候选队列逐个尝试下一个 phase，优先遵循图关系，再兜底顺序下一个节点。
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

/**
 * 把 chapterProgress/currentEvent/dynamicEvents 同步到指定 phase。
 */
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
  const eventIndex = phaseIndex >= 0 ? phaseIndex + 1 : 1;
  const eventKind = (phase?.kind || "scene") as "opening" | "scene" | "user" | "fixed" | "ending";
  const eventSummary = String(phase?.targetSummary || phase?.label || "").trim();
  const eventStatus: "idle" | "active" | "waiting_input" | "completed" = userNodeStatus === "waiting_input"
    ? "waiting_input"
    : phase
      ? "active"
      : "idle";
  setChapterProgressState(state, {
    phaseId: String(phase?.id || "").trim(),
    phaseIndex,
    eventIndex,
    eventKind,
    eventSummary,
    eventStatus,
    userNodeId: userNodeId || "",
    userNodeIndex,
    userNodeStatus,
    pendingGoal: resolvePendingGoal(phase, outline, userNodeId),
    ...extraPatch,
  });
  // phase 变更后立刻同步 dynamicEvents/currentEvent，避免 UI 和 AI 读取到不同步的事件状态。
  syncRuntimeDynamicEvents(state, outline);
}

/**
 * 把 progress 状态映射成动态事件卡片使用的统一状态值。
 */
function resolveRuntimeDynamicEventStatus(input: {
  phase: ChapterRuntimePhase;
  phaseIndex: number;
  current: ReturnType<typeof readChapterProgressState>;
  completedEvents: string[];
}): RuntimeDynamicEventState["status"] {
  if (isPhaseCompleted(input.completedEvents, input.phase.id)) {
    return "completed";
  }
  if (input.current.phaseId === input.phase.id) {
    if (input.current.eventStatus === "completed") return "completed";
    if (input.current.eventStatus === "waiting_input") return "waiting_input";
    if (input.current.eventStatus === "active") return "active";
  }
  if (input.current.phaseIndex > input.phaseIndex) {
    return "completed";
  }
  return "idle";
}

/**
 * 根据 runtimeOutline 与当前 progress 重建动态事件列表。
 */
function buildRuntimeDynamicEvents(
  outline: ChapterRuntimeOutline,
  current: ReturnType<typeof readChapterProgressState>,
  existingDynamicEvents: RuntimeDynamicEventState[],
): RuntimeDynamicEventState[] {
  const completedEvents = normalizeCompletedEvents(Array.isArray(current.completedEvents) ? current.completedEvents : []);
  const phaseEvents: RuntimeDynamicEventState[] = (Array.isArray(outline.phases) ? outline.phases : []).map((phase, index) => {
    const existing = existingDynamicEvents.find((item) => item.phaseId === String(phase.id || "").trim())
      || existingDynamicEvents.find((item) => item.eventIndex === index + 1)
      || null;
    const summarySource: RuntimeDynamicEventState["summarySource"] = existing?.summarySource === "ai"
      ? "ai"
      : existing?.summarySource === "memory"
        ? "memory"
        : existing?.summarySource === "system"
          ? "system"
          : "phase";
    return {
      eventIndex: index + 1,
      phaseId: String(phase.id || "").trim(),
      kind: phase.kind || "scene",
      flowType: "chapter_content",
      summary: String(existing?.summary || phase.targetSummary || phase.label || "").trim(),
      runtimeFacts: Array.isArray(existing?.runtimeFacts) ? existing.runtimeFacts : [],
      summarySource,
      memorySummary: String(existing?.memorySummary || "").trim(),
      memoryFacts: Array.isArray(existing?.memoryFacts) ? existing.memoryFacts : [],
      updateTime: Number.isFinite(Number(existing?.updateTime)) ? Math.max(0, Number(existing?.updateTime)) : 0,
      status: resolveRuntimeDynamicEventStatus({
        phase,
        phaseIndex: index,
        current,
        completedEvents,
      }),
      allowedRoles: Array.isArray(phase.allowedSpeakers)
        ? phase.allowedSpeakers.map((item) => String(item || "").trim()).filter(Boolean)
        : [],
      userNodeId: String(phase.userNodeId || "").trim(),
    };
  });
  const staticEventLimit = phaseEvents.length;
  const extraEvents: RuntimeDynamicEventState[] = existingDynamicEvents
    .filter((item) => Number(item?.eventIndex || 0) > staticEventLimit)
    .map((item) => normalizeRuntimeDynamicEventState({
      ...item,
      phaseId: "",
      userNodeId: String(item.userNodeId || "").trim(),
    }));
  const contentExtraEvents = extraEvents.filter((item) => !isEndingDynamicEvent(item));
  const endingExtraEvents = extraEvents.filter((item) => isEndingDynamicEvent(item));
  const highestContentEventIndex = Math.max(
    staticEventLimit,
    ...contentExtraEvents
      .map((item) => Number(item.eventIndex || 0))
      .filter((item) => Number.isFinite(item) && item > 0),
  );
  // ending 卡片只保留最新一条，并强制把索引放到最后一个内容事件后面。
  const normalizedEndingEvent = endingExtraEvents.length
    ? normalizeRuntimeDynamicEventState({
      ...endingExtraEvents
        .slice()
        .sort((left, right) => {
          const updateDelta = Number(right.updateTime || 0) - Number(left.updateTime || 0);
          return updateDelta !== 0 ? updateDelta : Number(right.eventIndex || 0) - Number(left.eventIndex || 0);
        })[0],
      eventIndex: Math.max(1, highestContentEventIndex + 1),
      kind: "ending",
      flowType: "chapter_ending_check",
    })
    : null;
  return [
    ...phaseEvents,
    ...contentExtraEvents,
    ...(normalizedEndingEvent ? [normalizedEndingEvent] : []),
  ].sort((a, b) => a.eventIndex - b.eventIndex);
}

/**
 * 判断某个动态事件是否属于章节结束条件检查事件。
 */
function isEndingDynamicEvent(input: RuntimeDynamicEventState | null | undefined): boolean {
  if (!input) return false;
  const kind = String(input.kind || "").trim().toLowerCase();
  const flowType = String(input.flowType || "").trim().toLowerCase();
  return kind === "ending" || flowType === "chapter_ending_check";
}

/**
 * 统一重建运行态里的 dynamicEvents 列表。
 */
function syncRuntimeDynamicEvents(state: JsonRecord, outline: ChapterRuntimeOutline): RuntimeDynamicEventState[] {
  const current = readChapterProgressState(state);
  const existingDynamicEvents = Array.isArray(state.dynamicEvents) ? state.dynamicEvents as RuntimeDynamicEventState[] : [];
  return setRuntimeDynamicEventList(state, buildRuntimeDynamicEvents(outline, current, existingDynamicEvents));
}

/**
 * 将指定 phase 追加到 completedEvents。
 */
function markPhaseCompleted(completedEvents: string[], phaseId: string | null | undefined): string[] {
  if (!phaseId) return normalizeCompletedEvents(completedEvents);
  const next = [...completedEvents];
  const marker = getPhaseMarker(phaseId);
  if (!next.includes(marker)) {
    next.push(marker);
  }
  return normalizeCompletedEvents(next);
}

/**
 * 使用归一化文本做宽松信号匹配。
 */
function signalMatches(label: string, signalTexts: string[]): boolean {
  const normalizedLabel = normalizeSignalText(label);
  if (!normalizedLabel) return false;
  return signalTexts.some((item) => item.includes(normalizedLabel) || normalizedLabel.includes(item));
}

/**
 * 收集宽松信号集，包含内容、角色、触发器、任务进度和 delta 等辅助信号。
 */
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

/**
 * 收集严格信号集，只保留适合直接命中 fixed event 的核心文本。
 */
function collectStrictSignalTexts(input: {
  messageContent?: string;
  triggered?: TriggerHit[];
  taskProgress?: TaskProgressChange[];
  deltas?: AppliedDelta[];
}): string[] {
  const texts = [
    String(input.messageContent || ""),
    ...(Array.isArray(input.triggered) ? input.triggered.flatMap((item) => [item.name, item.eventType]) : []),
    ...(Array.isArray(input.taskProgress) ? input.taskProgress.flatMap((item) => [item.title, item.nextStatus]) : []),
    ...(Array.isArray(input.deltas) ? input.deltas.flatMap((item) => [item.field, item.source, item.entityId]) : []),
  ];
  return Array.from(new Set(texts.map((item) => normalizeSignalText(item)).filter(Boolean)));
}

/**
 * 判断某个 fixed event 是否在本轮输入/输出中被命中。
 */
function fixedEventMatches(input: {
  label: string;
  id: string;
  conditionExpr?: unknown;
  strictSignalTexts: string[];
  ctx: ConditionContext;
}): boolean {
  const normalizedId = normalizeSignalText(input.id);
  // fixed event 只能被明确 signal 或条件表达式命中，避免用户只输入“2”就误命中“输入不符合要求2次”。
  if (normalizedId && input.strictSignalTexts.some((item) => item === normalizedId)) {
    return true;
  }
  if (input.conditionExpr != null && evaluateCondition(input.conditionExpr, input.ctx)) {
    return true;
  }
  if (evaluateCondition(input.label, input.ctx)) {
    return true;
  }
  const normalizedLabel = normalizeSignalText(input.label);
  if (!normalizedLabel) return false;
  return input.strictSignalTexts.some((item) => item === normalizedLabel);
}

/**
 * 初始化章节运行进度；章节切换时会重置完成标记，同章节重复进入时则做幂等同步。
 */
export function initializeChapterProgressForState(chapter: any, state: JsonRecord): void {
  const outline = readRuntimeOutline(chapter);
  const current = readChapterProgressState(state);
  const chapterId = Number(chapter?.id || 0);
  
  // 章节切换和同章节重复初始化不是一回事，这里先拆开，避免把上一章的完成标记带过来。
  const isChapterSwitched = current.chapterId > 0 && current.chapterId !== chapterId;
  
  if (isChapterSwitched) {
    // 章节切换：重置completedEvents和phase相关状态，但保留其他状态
    const freshCompletedEvents: string[] = [];
    if (isFreeChapterRuntimeMode(chapter)) {
      if (!outline.phases.length) {
        ensureFreeChapterDynamicEventState(chapter, state, 1, {
          completedEvents: freshCompletedEvents,
        });
        return;
      }
    }
    // 重新初始化章节进度，从第一个事件开始
    const nextUserNode = findNextPendingUserNode(outline, freshCompletedEvents);
    const activePhaseInfo = resolveCurrentOrInitialPhase(outline, "", freshCompletedEvents);
    if (!activePhaseInfo.phase && !nextUserNode) {
      if (isFreeChapterRuntimeMode(chapter)) {
        ensureFreeChapterDynamicEventState(chapter, state, 1, {
          completedEvents: freshCompletedEvents,
        });
        return;
      }
      // 没有可继续推进的内容事件时，如果章节有结束条件，则直接切到 ending 事件。
      if (hasChapterEndingEvent(chapter, outline)) {
        updateEndingState(chapter, outline, state, {
          completedEvents: freshCompletedEvents,
        });
        return;
      }
      const finalPhase = resolveFinalPhase(outline);
      updatePhaseState(outline, state, finalPhase.phase, finalPhase.phaseIndex, null, -1, "idle", {
        chapterId,
        completedEvents: freshCompletedEvents,
      });
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
      {
        chapterId,
        completedEvents: freshCompletedEvents,
      },
    );
    return;
  }
  
  // 同一章节内的再次初始化，需要尽量复用当前已推进的 phase 和 completedEvents。
  if (isFreeChapterRuntimeMode(chapter)) {
    if (!outline.phases.length) {
      ensureFreeChapterDynamicEventState(chapter, state, current.eventIndex || 1, {
        completedEvents: normalizeCompletedEvents(current.completedEvents),
      });
      return;
    }
    if (current.eventIndex > outline.phases.length) {
      ensureFreeChapterDynamicEventState(chapter, state, current.eventIndex, {
        completedEvents: normalizeCompletedEvents(current.completedEvents),
      });
      return;
    }
  }
  const completedEvents = normalizeCompletedEvents(current.completedEvents);
  const nextUserNode = findNextPendingUserNode(outline, completedEvents);
  const activePhaseInfo = resolveCurrentOrInitialPhase(outline, current.phaseId, completedEvents);
  if (!activePhaseInfo.phase && !nextUserNode) {
    if (isFreeChapterRuntimeMode(chapter)) {
      ensureFreeChapterDynamicEventState(chapter, state, Math.max(outline.phases.length + 1, current.eventIndex || 1), {
        completedEvents,
      });
      return;
    }
    if (hasChapterEndingEvent(chapter, outline)) {
      updateEndingState(chapter, outline, state, {
        completedEvents,
      });
      return;
    }
    const finalPhase = resolveFinalPhase(outline);
    updatePhaseState(outline, state, finalPhase.phase, finalPhase.phaseIndex, null, -1, "idle", {
      chapterId,
    });
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
    {
      chapterId,
    },
  );
}

/**
 * 根据当前运行态重新同步 chapterProgress、dynamicEvents 与 currentEvent。
 */
export function syncChapterProgressWithRuntime(chapter: any, state: JsonRecord): void {
  const outline = readRuntimeOutline(chapter);
  const current = readChapterProgressState(state);
  if (isFreeChapterRuntimeMode(chapter)) {
    if (!outline.phases.length) {
      ensureFreeChapterDynamicEventState(
        chapter,
        state,
        current.eventStatus === "completed" ? current.eventIndex + 1 : current.eventIndex || 1,
        {
          completedEvents: normalizeCompletedEvents(Array.isArray(current.completedEvents) ? current.completedEvents : []),
        },
      );
      return;
    }
    if (current.eventIndex > outline.phases.length) {
      ensureFreeChapterDynamicEventState(
        chapter,
        state,
        current.eventStatus === "completed" ? current.eventIndex + 1 : current.eventIndex,
        {
          completedEvents: normalizeCompletedEvents(Array.isArray(current.completedEvents) ? current.completedEvents : []),
        },
      );
      return;
    }
  }
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
    if (isFreeChapterRuntimeMode(chapter)) {
      ensureFreeChapterDynamicEventState(
        chapter,
        state,
        current.eventStatus === "completed"
          ? Math.max(outline.phases.length + 1, current.eventIndex + 1)
          : Math.max(outline.phases.length + 1, current.eventIndex || 1),
        {
          completedEvents,
        },
      );
      return;
    }
    // 所有内容 phase 都结束后，如果章节存在结束条件，当前事件应切到 ending。
    if (hasChapterEndingEvent(chapter, outline)) {
      updateEndingState(chapter, outline, state, {
        completedEvents,
        eventStatus: current.fixedOutcomeLocked ? "completed" : "active",
      });
      return;
    }
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

/**
 * 用户节点提交输入后，标记当前用户节点和必要的 phase 完成，并推进到下一个事件。
 */
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
  if (!advancedPhase && !nextUserNode && isFreeChapterRuntimeMode(chapter)) {
    ensureFreeChapterDynamicEventState(chapter, state, Math.max(outline.phases.length + 1, current.eventIndex + 1), {
      completedEvents,
      lastEvaluatedMessageId: Number.isFinite(Number(messageId)) ? Number(messageId) : current.lastEvaluatedMessageId,
    });
    return;
  }
  if (!advancedPhase && !nextUserNode && hasChapterEndingEvent(chapter, outline)) {
    updateEndingState(chapter, outline, state, {
      completedEvents,
      lastEvaluatedMessageId: Number.isFinite(Number(messageId)) ? Number(messageId) : current.lastEvaluatedMessageId,
      eventStatus: "active",
    });
    return;
  }
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
      eventStatus: nextUserNode ? "active" : "completed",
      lastEvaluatedMessageId: Number.isFinite(Number(messageId)) ? Number(messageId) : current.lastEvaluatedMessageId,
    },
  );
}

/**
 * 旁白/NPC 发言后尝试推进章节内容事件。
 */
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

  // 先做完整性校验，便于排查“为什么事件没推进”的问题。
  const validation = validateEventCompleteness(chapter, state);
  console.log("[event:completeness:check]", JSON.stringify({
    chapterId: Number(chapter?.id || 0),
    eventIndex: current.eventIndex,
    isComplete: validation.isComplete,
    hasStarted: validation.hasStarted,
    hasProgressed: validation.hasProgressed,
    hasEnded: validation.hasEnded,
    details: validation.details,
  }));

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
  // 旁白/NPC 的文本本身就是推进 scene 事件的主要信号来源。
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
    if (isFreeChapterRuntimeMode(chapter)) {
      ensureFreeChapterDynamicEventState(chapter, state, Math.max(outline.phases.length + 1, current.eventIndex + 1), {
        completedEvents,
      });
      return {
        phaseChanged: true,
        enteredUserPhase: false,
        matchedPhaseSignal,
      };
    }
    // 内容 phase 走到末尾后，不直接判章结束，而是进入 ending 检查事件。
    if (hasChapterEndingEvent(chapter, outline)) {
      updateEndingState(chapter, outline, state, {
        completedEvents,
        eventStatus: "active",
      });
      return {
        phaseChanged: true,
        enteredUserPhase: false,
        matchedPhaseSignal: true,
      };
    }
    setChapterProgressState(state, {
      completedEvents,
      eventStatus: "completed",
    });
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
    {
      completedEvents,
      eventStatus: enteredUserPhase ? "waiting_input" : "active",
    },
  );
  return {
    phaseChanged: true,
    enteredUserPhase,
    matchedPhaseSignal: true,
  };
}

/**
 * 将本轮输入/输出命中的 fixed event 写入 completedEvents。
 */
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
  const strictSignalTexts = collectStrictSignalTexts(input);
  let completedEvents = normalizeCompletedEvents(Array.isArray(current.completedEvents) ? current.completedEvents : []);
  // fixed event 是规则层识别事件的核心入口：内容、任务变化、delta 都会在这里被转成已完成事件。
  const matchedFixedEvents = outline.fixedEvents
    .filter((item) => fixedEventMatches({
      label: String(item.label || "").trim(),
      id: String(item.id || "").trim(),
      conditionExpr: (item as any)?.conditionExpr,
      strictSignalTexts,
      // 条件表达式命中依赖当前 state 与本轮输入，而不是 AI 额外判断。
      ctx: {
        state,
        messageContent: String(input.messageContent || ""),
        eventType: "",
        meta: {},
      },
    }))
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
    setChapterProgressState(state, {
      completedEvents,
      eventStatus: markedPhaseCompleted ? "completed" : current.eventStatus,
    });
  }
  return {
    matchedFixedEvents,
    markedPhaseCompleted,
  };
}

/**
 * 事件完整性验证结果
 */
export interface EventCompletenessValidation {
  /** 事件是否完整 */
  isComplete: boolean;
  /** 开始状态 */
  hasStarted: boolean;
  /** 进行中状态 */
  hasProgressed: boolean;
  /** 结束状态 */
  hasEnded: boolean;
  /** 验证详情 */
  details: string[];
  /** 建议的下一个事件索引 */
  suggestedNextEventIndex: number;
}

/**
 * 验证当前事件是否经历了“开始 -> 推进 -> 完成”的完整生命周期。
 */
export function validateEventCompleteness(chapter: any, state: JsonRecord): EventCompletenessValidation {
  const outline = readRuntimeOutline(chapter);
  const current = readChapterProgressState(state);
  const details: string[] = [];

  // 1. 检查事件是否开始
  const hasStarted = current.eventIndex > 0 && current.eventStatus !== "idle";
  if (hasStarted) {
    details.push(`[开始] 事件 ${current.eventIndex} 已启动 (状态: ${current.eventStatus})`);
  } else {
    details.push(`[开始] 事件未启动 (状态: ${current.eventStatus})`);
  }

  // 2. 检查事件是否经过（有内容生成）
  const currentEvent = readRuntimeCurrentEventState(state);
  const hasProgressed = hasStarted && (
    currentEvent.status === "active" ||
    currentEvent.status === "waiting_input" ||
    currentEvent.status === "completed" ||
    (current.eventKind === "user" && current.userNodeStatus === "waiting_input")
  );
  if (hasProgressed) {
    details.push(`[经过] 事件 ${current.eventIndex} 已推进 (类型: ${current.eventKind}, 当前事件状态: ${currentEvent.status})`);
  } else {
    details.push(`[经过] 事件 ${current.eventIndex} 未推进`);
  }

  // 3. 检查事件是否结束
  const isPhaseDone = isPhaseCompleted(current.completedEvents, current.phaseId);
  const hasEnded = isPhaseDone || current.eventStatus === "completed";
  if (hasEnded) {
    details.push(`[结束] 事件 ${current.eventIndex} 已完成 (completedEvents: ${current.completedEvents.length})`);
  } else {
    details.push(`[结束] 事件 ${current.eventIndex} 未完成`);
  }

  // 计算建议的下一个事件索引，供日志和调试工具使用。
  let suggestedNextEventIndex = current.eventIndex;
  if (hasEnded) {
    // 如果当前事件已完成，建议进入下一个事件
    suggestedNextEventIndex = current.eventIndex + 1;
  }

  // 5. 验证事件索引是否与实际phase匹配
  const expectedPhaseIndex = current.eventIndex - 1;
  const currentPhaseIndex = outline.phases.findIndex((p) => p.id === current.phaseId);
  if (currentPhaseIndex >= 0 && currentPhaseIndex !== expectedPhaseIndex) {
    details.push(`[警告] 事件索引不匹配: eventIndex=${current.eventIndex}, 但phaseIndex=${currentPhaseIndex} (期望: ${expectedPhaseIndex})`);
  }

  // 6. 检查章节切换问题
  const chapterId = Number(chapter?.id || 0);
  if (current.chapterId > 0 && current.chapterId !== chapterId) {
    details.push(`[错误] 章节ID不匹配: chapterProgress.chapterId=${current.chapterId}, 当前章节=${chapterId}`);
  }

  const isComplete = hasStarted && hasProgressed && hasEnded;

  return {
    isComplete,
    hasStarted,
    hasProgressed,
    hasEnded,
    details,
    suggestedNextEventIndex,
  };
}

/**
 * 下一事件推进判定结果。
 */
export interface NextEventDecision {
  /** 是否可以进入下一个事件 */
  canAdvance: boolean;
  /** 原因说明 */
  reason: string;
  /** 下一个事件的信息 */
  nextEvent?: {
    eventIndex: number;
    phaseId: string;
    eventKind: string;
    eventSummary: string;
  };
  /** 是否是章节结束 */
  isChapterEnding: boolean;
}

/**
 * AI 事件进度检测结果。
 *
 * 用途：
 * - 让 AI 只回答“当前事件是否结束、当前摘要/事实是什么”
 * - 事件切换仍然复用本文件已有的 phase graph 推进逻辑
 */
export interface AiEventProgressResolution {
  /** 当前事件是否已经结束。 */
  ended: boolean;
  /** 当前事件的新状态。 */
  eventStatus: "active" | "waiting_input" | "completed";
  /** AI 归纳的当前事件摘要。 */
  progressSummary?: string | null;
  /** AI 归纳的当前事件事实。 */
  progressFacts?: string[] | null;
  /** AI 为什么这样判断。 */
  reason?: string | null;
}

/**
 * 合并已有事件事实、AI 归纳事实和 AI 判定说明。
 */
function mergeAiProgressFacts(
  existingFacts: string[],
  progressFacts: string[] | null | undefined,
  reason: string | null | undefined,
): string[] {
  const merged = Array.isArray(existingFacts)
    ? existingFacts.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const normalizedProgressFacts = Array.isArray(progressFacts)
    ? progressFacts.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  for (const fact of normalizedProgressFacts) {
    if (!merged.includes(fact)) {
      merged.push(fact);
    }
  }
  const normalizedReason = String(reason || "").trim();
  if (normalizedReason) {
    const reasonFact = `进度判定：${normalizedReason}`;
    if (!merged.includes(reasonFact)) {
      merged.push(reasonFact);
    }
  }
  return merged;
}

/**
 * 将 AI 的事件进度检测结果应用到运行态。
 *
 * 说明：
 * - 未结束：只更新当前事件摘要、事实和状态
 * - 已结束：将当前 phase 标记完成，并按 phase graph 切到下一事件
 */
export function applyAiEventProgressResolution(input: {
  chapter: any;
  state: JsonRecord;
  resolution: AiEventProgressResolution;
}): {
  phaseChanged: boolean;
  enteredUserPhase: boolean;
} {
  const outline = readRuntimeOutline(input.chapter);
  const current = readChapterProgressState(input.state);
  const currentEvent = readRuntimeCurrentEventState(input.state);
  const nextSummary = String(input.resolution.progressSummary || "").trim()
    || current.eventSummary
    || currentEvent.summary;
  const nextFacts = mergeAiProgressFacts(
    Array.isArray(currentEvent.facts) ? currentEvent.facts : [],
    input.resolution.progressFacts,
    input.resolution.reason,
  );

  // 先把 AI 归纳结果回写到当前事件卡片，确保旧事件即使后续推进也保留完整事实。
  upsertRuntimeEventDigestState(input.state, {
    eventIndex: current.eventIndex,
    eventKind: current.eventKind,
    eventSummary: nextSummary,
    eventFacts: nextFacts,
    eventStatus: input.resolution.ended ? "completed" : input.resolution.eventStatus,
    summarySource: "ai",
  });

  if (!input.resolution.ended) {
    setChapterProgressState(input.state, {
      eventSummary: nextSummary,
      eventStatus: input.resolution.eventStatus,
    });
    syncRuntimeCurrentEventFromChapterProgress(input.state);
    return {
      phaseChanged: false,
      enteredUserPhase: input.resolution.eventStatus === "waiting_input",
    };
  }

  if (!outline.phases.length) {
    setChapterProgressState(input.state, {
      eventSummary: nextSummary,
      eventStatus: "completed",
    });
    syncRuntimeCurrentEventFromChapterProgress(input.state);
    return {
      phaseChanged: false,
      enteredUserPhase: false,
    };
  }

  const completedEvents = markPhaseCompleted(
    normalizeCompletedEvents(Array.isArray(current.completedEvents) ? current.completedEvents : []),
    current.phaseId,
  );
  const currentPhaseIndex = outline.phases.findIndex((item) => item.id === current.phaseId);
  const nextPhaseInfo = resolveNextPhaseFromGraph(outline, current.phaseId, completedEvents, currentPhaseIndex);
  const nextPhase = nextPhaseInfo.phase;
  if (!nextPhase) {
    if (isFreeChapterRuntimeMode(input.chapter)) {
      ensureFreeChapterDynamicEventState(
        input.chapter,
        input.state,
        Math.max(outline.phases.length + 1, current.eventIndex + 1),
        { completedEvents },
      );
      return {
        phaseChanged: true,
        enteredUserPhase: false,
      };
    }
    if (hasChapterEndingEvent(input.chapter, outline)) {
      updateEndingState(input.chapter, outline, input.state, {
        completedEvents,
        eventStatus: "active",
      });
      return {
        phaseChanged: true,
        enteredUserPhase: false,
      };
    }
    setChapterProgressState(input.state, {
      completedEvents,
      eventSummary: nextSummary,
      eventStatus: "completed",
    });
    syncRuntimeCurrentEventFromChapterProgress(input.state);
    return {
      phaseChanged: false,
      enteredUserPhase: false,
    };
  }

  const nextUserNodeId = nextPhase.kind === "user"
    ? (nextPhase.userNodeId || current.userNodeId || null)
    : (current.userNodeId || null);
  const nextUserNodeIndex = nextUserNodeId
    ? outline.userNodes.findIndex((item) => item.id === nextUserNodeId)
    : -1;
  const enteredUserPhase = nextPhase.kind === "user";
  updatePhaseState(
    outline,
    input.state,
    nextPhase,
    nextPhaseInfo.phaseIndex,
    nextUserNodeId,
    nextUserNodeIndex,
    enteredUserPhase ? "waiting_input" : "idle",
    {
      completedEvents,
      eventStatus: enteredUserPhase ? "waiting_input" : "active",
    },
  );
  return {
    phaseChanged: true,
    enteredUserPhase,
  };
}

/**
 * 基于当前事件状态和章节编排图，判定是否可以进入下一个事件。
 */
export function canAdvanceToNextEvent(chapter: any, state: JsonRecord): NextEventDecision {
  const outline = readRuntimeOutline(chapter);
  const current = readChapterProgressState(state);

  // 1. 验证当前事件完整性
  const validation = validateEventCompleteness(chapter, state);

  // 2. 如果当前事件未完成，不能进入下一个事件
  if (!validation.hasEnded) {
    return {
      canAdvance: false,
      reason: `当前事件 ${current.eventIndex} 未完成: ${validation.details.join("; ")}`,
      isChapterEnding: false,
    };
  }

  // 3. 查找下一个phase
  const currentPhaseIndex = outline.phases.findIndex((p) => p.id === current.phaseId);
  const nextPhaseIndex = currentPhaseIndex + 1;

  // 4. 检查是否到达章节末尾
  if (nextPhaseIndex >= outline.phases.length) {
    // 检查是否有章节结束事件
    if (hasChapterEndingEvent(chapter, outline)) {
      return {
        canAdvance: true,
        reason: `当前事件 ${current.eventIndex} 已完成，进入章节结束事件`,
        nextEvent: {
          eventIndex: outline.phases.length + 1,
          phaseId: "",
          eventKind: "ending",
          eventSummary: buildEndingEventSummary(chapter, outline),
        },
        isChapterEnding: true,
      };
    }
    return {
      canAdvance: false,
      reason: `已到达章节末尾，没有更多事件 (当前: ${current.eventIndex}/${outline.phases.length})`,
      isChapterEnding: true,
    };
  }

  // 5. 获取下一个phase的信息
  const nextPhase = outline.phases[nextPhaseIndex];
  const nextEventIndex = nextPhaseIndex + 1;

  return {
    canAdvance: true,
    reason: `当前事件 ${current.eventIndex} 已完成，可以进入事件 ${nextEventIndex}`,
    nextEvent: {
      eventIndex: nextEventIndex,
      phaseId: nextPhase.id,
      eventKind: nextPhase.kind || "scene",
      eventSummary: String(nextPhase.targetSummary || nextPhase.label || "").trim(),
    },
    isChapterEnding: false,
  };
}

/**
 * 输出事件推进决策日志，便于排查为什么没有进入下一个事件。
 */
export function logEventAdvanceDecision(chapter: any, state: JsonRecord, decision: NextEventDecision): void {
  const current = readChapterProgressState(state);
  const chapterId = Number(chapter?.id || 0);

  console.log("[event:advance:decision]", JSON.stringify({
    chapterId,
    currentEventIndex: current.eventIndex,
    currentPhaseId: current.phaseId,
    currentEventKind: current.eventKind,
    currentEventStatus: current.eventStatus,
    canAdvance: decision.canAdvance,
    reason: decision.reason,
    nextEvent: decision.nextEvent,
    isChapterEnding: decision.isChapterEnding,
    completedEvents: current.completedEvents,
  }));
}
