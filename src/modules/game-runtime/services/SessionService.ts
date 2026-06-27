import {
  getGameDb,
  normalizeChapterOutput,
  normalizeMessageOutput,
  normalizeRolePair,
  normalizeSessionState,
  nowTs,
  parseJsonSafe,
  readChapterProgressState,
  readDefaultRuntimeEventViewState,
  readRuntimeCurrentEventDigestState,
  RuntimeEventDigestState,
  RuntimeEventViewState,
  syncRuntimeCurrentEventFromChapterProgress,
  toJsonText,
  upsertRuntimeEventDigestState,
} from "@/lib/gameEngine";
import { ensureWorldRolesWithAiParameterCards } from "@/lib/roleParameterCard";
import { applyExplicitMemoryDirectiveToPlayerCard } from "@/modules/game-runtime/services/PlayerMemoryDirectiveService";
import { getCurrentUserId } from "@/lib/requestContext";
import {
  applyMemoryResultToState,
  applyNarrativeMemoryHintsToState,
  advanceNarrativeUntilPlayerTurn,
  NarrativePlanSummary,
  RuntimeMessageInput,
  allowPlayerTurn,
  applyOrchestratorResultToState,
  applyPlayerProfileFromMessageToState,
  canPlayerSpeakNow,
  resolveOpeningMessage,
  refreshStoryMemoryBestEffort,
  runNarrativePlan,
  runNarrativeOrchestrator,
  setRuntimeTurnState,
  summarizeNarrativePlan,
  triggerStoryMemoryRefreshInBackground,
} from "@/modules/game-runtime/engines/NarrativeOrchestrator";
import {
  applyAiEventProgressResolution,
  recordChapterProgressSignals,
  initializeChapterProgressForState,
  markCurrentUserNodeCompleted,
  readNextEventProgressHint,
  syncChapterProgressWithRuntime,
} from "@/modules/game-runtime/engines/ChapterProgressEngine";
import { handleMiniGameTurn, isMiniGameActiveState, readActiveTaskStateFromState } from "@/modules/game-runtime/engines/MiniGameController";
import { evaluateTaskProgress } from "@/modules/game-runtime/agents/taskMode/TaskProgressAgent";
import { directTaskNarrative } from "@/modules/game-runtime/agents/taskMode/TaskDirectorAgent";
import { evaluateTaskCompletion } from "@/modules/game-runtime/agents/taskMode/TaskCompletionAgent";
import { analyzeIntentWithAi as analyzeTaskIntent } from "@/modules/game-runtime/agents/intentAnalyzer/IntentClassifier";
import { runTaskProgressEngine } from "@/modules/game-runtime/engines/TaskProgressEngine";
import {
  applyAttributeChanges,
  runTriggerEngine,
} from "@/modules/game-runtime/engines/TriggerEngine";
import { evaluateRuntimeOutcome } from "@/modules/game-runtime/services/ChapterRuntimeService";
import { evaluateEventProgressByAi } from "@/modules/game-runtime/services/EventProgressRuntimeService";
import {
  maybeActivateFreeChapterTaskEvent,
} from "@/modules/game-runtime/services/FreeChapterTaskService";
import { persistSnapshotIfNeeded } from "@/modules/game-runtime/services/SnapshotService";
import {
  AppliedDelta,
  AttributeChangeInput,
  TaskProgressChange,
  TriggerHit,
} from "@/modules/game-runtime/types/runtime";
import { DebugLogUtil } from "@/utils/debugLogUtil";
import {miniGameStateManager, MiniGameOrchestrationResult} from "@/modules/game-runtime/engines/MiniGameStateManager";

// ==================== 游玩模式回溯功能内存缓存 ====================
//
// 设计：
//   - 内存层：每个 sessionId 保留最近 SESSION_REVISIT_HOT_SIZE 条，热数据直接命中
//   - 持久化层：t_sessionMessage.revisitData 字段
//   - 读取顺序：优先内存 → 数据库字段 → 提示缺少记忆

const SESSION_REVISIT_HOT_SIZE = 10; // 内存保留最近 N 条

interface SessionRevisitCacheItem {
  sessionId: string;
  messageId: number;
  revisitData: SessionMessageRevisitData;
  capturedAt: number;
}

// 内存层：sessionId -> 最近 N 条（按 messageId 升序）
const SESSION_REVISIT_HOT = new Map<string, SessionRevisitCacheItem[]>();

// ==================== Session 编排锁 ====================
//
// 防止同一 session 的并发编排请求导致重复台词。
// 内存级互斥锁：同一 sessionId 同时只允许一个编排/commit 操作执行。

const SESSION_LOCKS = new Map<string, Promise<any>>();

async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = SESSION_LOCKS.get(sessionId) || Promise.resolve();
  const next = prev.then(() => fn(), (err) => { throw err; });
  SESSION_LOCKS.set(sessionId, next);
  try {
    return await next;
  } finally {
    if (SESSION_LOCKS.get(sessionId) === next) {
      SESSION_LOCKS.delete(sessionId);
    }
  }
}

// 保存回溯点到内存缓存
function saveSessionRevisitToHotCache(
  sessionId: string,
  messageId: number,
  revisitData: SessionMessageRevisitData,
): void {
  const items = SESSION_REVISIT_HOT.get(sessionId) || [];
  // 移除重复的 messageId
  const filtered = items.filter((item) => item.messageId !== messageId);
  // 添加新的
  filtered.push({
    sessionId,
    messageId,
    revisitData,
    capturedAt: revisitData.t,
  });
  // 按 messageId 排序
  filtered.sort((a, b) => a.messageId - b.messageId);
  // 保留最近 N 条
  const trimmed = filtered.slice(-SESSION_REVISIT_HOT_SIZE);
  SESSION_REVISIT_HOT.set(sessionId, trimmed);
}

// 从内存缓存读取回溯点
function readSessionRevisitFromHotCache(
  sessionId: string,
  messageId: number,
): SessionMessageRevisitData | null {
  const items = SESSION_REVISIT_HOT.get(sessionId);
  if (!items) return null;
  const found = items.find((item) => item.messageId === messageId);
  return found?.revisitData || null;
}

// 清空指定 session 的缓存
export function clearSessionRevisitCache(sessionId: string): void {
  SESSION_REVISIT_HOT.delete(sessionId);
}

// 清空所有缓存
export function clearAllSessionRevisitCaches(): void {
  SESSION_REVISIT_HOT.clear();
}

/**
 * 切章时清理上一章残留的运行态事件缓存。
 *
 * 用途：
 * - 正式游玩链切到下一章后，新章节同样会从 eventIndex=1 开始；
 * - 如果保留上一章的 currentEvent/currentEventDigest/dynamicEvents/chapterProgress，
 *   编排师就会把上一章的事件 1 误当成新章节的事件 1 继续使用；
 * - 这里和调试链保持一致，在真正进入新章节前先把旧章事件缓存清空。
 */
function resetSessionChapterRuntimeOnSwitch(
  state: Record<string, any>,
  nextChapterId: number | null,
  previousChapterId?: number | null,
  nextChapterTitle?: string | null,
): void {
  const normalizedNextChapterId = Number(nextChapterId || 0) || 0;
  const normalizedPreviousChapterId = Number(
    previousChapterId ?? state.chapterId ?? 0,
  ) || 0;
  const chapterSwitched = normalizedNextChapterId > 0
    && normalizedPreviousChapterId > 0
    && normalizedNextChapterId !== normalizedPreviousChapterId;
  if (!chapterSwitched) {
    return;
  }
  // 这些字段都和"当前章节的事件推进"强绑定。
  // 一旦切章还继续保留，后续读取 current_event 时就会串到上一章。
  delete state.currentEvent;
  delete state.currentEventDigest;
  delete state.eventDigestWindow;
  delete state.eventDigestWindowText;
  delete state.dynamicEvents;
  delete state.chapterProgress;
  delete state.__pendingEndingGuide;
  state.chapterId = normalizedNextChapterId;
  if (String(nextChapterTitle || "").trim()) {
    state.chapterTitle = String(nextChapterTitle || "").trim();
  }
}

/**
 * 开场白不属于章节事件图，提交或消费开场白后必须回到章节第一个内容事件。
 *
 * 用途：
 * - 防止旧初始快照或开场白裁决把 phase_1 误标为 completed；
 * - 保证 `/initStory -> /introduction -> /orchestration` 后编排师读取的是事件 1，而不是事件 2。
 */
function resetSessionChapterContentProgressForOpening(chapter: any, state: Record<string, any>): void {
  if (!chapter) return;
  delete state.currentEvent;
  delete state.currentEventDigest;
  delete state.eventDigestWindow;
  delete state.eventDigestWindowText;
  delete state.dynamicEvents;
  delete state.chapterProgress;
  delete state.__pendingEndingGuide;
  state.chapterId = Number(chapter.id || 0) || state.chapterId || null;
  state.chapterTitle = String(chapter.title || "").trim() || String(state.chapterTitle || "").trim();
  initializeChapterProgressForState(chapter, state);
  syncChapterProgressWithRuntime(chapter, state);
}

/**
 * 判断消息是否为章节外开场白。
 *
 * 用途：开场白只负责展示入场文案，不能触发章节判定、事件完成或章节切换。
 */
function isOpeningRuntimeEventType(eventType: unknown): boolean {
  return String(eventType || "").trim() === "on_opening";
}

export interface AddSessionMessageInput {
  sessionId: string;
  roleType?: string | null;
  role?: string | null;
  content: string;
  eventType?: string | null;
  meta?: unknown;
  attrChanges?: AttributeChangeInput[] | null;
  saveSnapshot?: boolean | null;
  orchestrate?: boolean | null;
}

export interface AddSessionMessageResult {
  sessionId: string;
  status: string;
  chapterId: number | null;
  chapter: Record<string, any> | null;
  state: Record<string, any>;
  currentEventDigest: RuntimeEventViewState["currentEventDigest"];
  eventDigestWindow: RuntimeEventViewState["eventDigestWindow"];
  eventDigestWindowText: RuntimeEventViewState["eventDigestWindowText"];
  message: Record<string, any> | null;
  chapterSwitchMessage: Record<string, any> | null;
  narrativeMessage: Record<string, any> | null;
  generatedMessages: Record<string, any>[];
  narrativePlan: any | null;
  triggered: TriggerHit[];
  taskProgress: TaskProgressChange[];
  deltas: AppliedDelta[];
  snapshotSaved: boolean;
  snapshotReason: string;
}

export type ContinueSessionNarrativeResult = AddSessionMessageResult;

export interface SessionNarrativePlanResult {
  role: string;
  roleType: string;
  motive: string;
  awaitUser: boolean;
  nextRole: string;
  nextRoleType: string;
  memoryHints: string[];
  source: "ai" | "fallback" | "rule";
  triggerMemoryAgent: boolean;
  eventType: string;
  presetContent: string | null;
  eventAdjustMode?: "keep" | "update" | "waiting_input" | "completed";
  eventIndex?: number;
  eventKind?: "opening" | "scene" | "user" | "fixed" | "ending";
  eventSummary?: string;
  eventFacts?: string[];
  eventStatus?: "idle" | "active" | "waiting_input" | "completed";
  speakerMode?: "template" | "fast" | "premium";
  speakerRouteReason?: string;
  nextNarrativePlan?: SessionNarrativePlanResult | null;
  orchestratorRuntime?: {
    modelKey: string;
    manufacturer: string;
    model: string;
    reasoningEffort: "minimal" | "low" | "medium" | "high" | "";
    payloadMode: "compact" | "advanced";
    payloadModeSource: "explicit" | "inferred";
  };
}

export interface SessionChapterCommand {
  type: "init_chapter";
  chapterId: number;
  chapterTitle: string;
  trigger: "chapter_completed";
}

export interface SessionOrchestrationResult {
  sessionId: string;
  status: string;
  chapterId: number | null;
  expectedRole: string;
  expectedRoleType: string;
  command?: SessionChapterCommand | null;
  currentEventDigest: RuntimeEventViewState["currentEventDigest"];
  eventDigestWindow: RuntimeEventViewState["eventDigestWindow"];
  eventDigestWindowText: RuntimeEventViewState["eventDigestWindowText"];
  plan: SessionNarrativePlanResult | null;
}

export interface InitSessionChapterResult {
  sessionId: string;
  status: string;
  worldId: number;
  chapterId: number | null;
  chapterTitle: string;
  state: Record<string, any>;
  chapter: Record<string, any> | null;
  currentEventDigest: RuntimeEventViewState["currentEventDigest"];
  eventDigestWindow: RuntimeEventViewState["eventDigestWindow"];
  eventDigestWindowText: RuntimeEventViewState["eventDigestWindowText"];
}

type SessionOrchestrationResultSeed = Omit<
  SessionOrchestrationResult,
  "currentEventDigest" | "eventDigestWindow" | "eventDigestWindowText"
>;

export interface SessionMessageRevisitData {
  v: 1;
  c: number | null;
  s: string;
  r: number;
  t: number;
  st: Record<string, any>;
}

export interface CommitSessionNarrativeTurnInput {
  sessionId: string;
  state?: Record<string, any> | null;
  chapterId?: number | null;
  status?: string | null;
  role?: string | null;
  roleType?: string | null;
  eventType?: string | null;
  content: string;
  createTime?: number | null;
  saveSnapshot?: boolean | null;
}

export class SessionServiceError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "SessionServiceError";
  }
}

export function isSessionServiceError(err: unknown): err is SessionServiceError {
  return err instanceof SessionServiceError;
}

function parseJsonMaybe(input: unknown): Record<string, any> {
  return parseJsonSafe<Record<string, any>>(input, {});
}

function pushRecentEvent(state: Record<string, any>, event: Record<string, any>): void {
  const list = Array.isArray(state.recentEvents) ? state.recentEvents : [];
  list.push(event);
  state.recentEvents = list.slice(-20);
}

function normalizeMessageId(value: unknown): number {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeSessionRound(state: Record<string, any>): number {
  const round = Number(state.round || 0);
  return Number.isFinite(round) && round >= 0 ? round : 0;
}

function normalizeSessionChapterId(chapterId: number | null | undefined, state: Record<string, any>): number | null {
  const explicitChapterId = Number(chapterId || 0);
  if (Number.isFinite(explicitChapterId) && explicitChapterId > 0) {
    return explicitChapterId;
  }
  const stateChapterId = Number(state.chapterId || 0);
  return Number.isFinite(stateChapterId) && stateChapterId > 0 ? stateChapterId : null;
}

export function buildSessionMessageRevisitData(params: {
  state: Record<string, any>;
  chapterId: number | null | undefined;
  status: string;
  capturedAt?: number;
}): SessionMessageRevisitData {
  return {
    v: 1,
    c: normalizeSessionChapterId(params.chapterId, params.state),
    s: String(params.status || "active").trim() || "active",
    r: normalizeSessionRound(params.state),
    t: Number(params.capturedAt || nowTs()) || nowTs(),
    st: parseJsonSafe<Record<string, any>>(toJsonText(params.state, {}), {}),
  };
}

export function readSessionMessageRevisitData(
  input: unknown,
  sessionId?: string,
  messageId?: number,
): SessionMessageRevisitData | null {
  // 1. 优先从内存缓存读取
  if (sessionId && messageId && Number.isFinite(messageId) && messageId > 0) {
    const cached = readSessionRevisitFromHotCache(sessionId, messageId);
    if (cached) {
      return cached;
    }
  }
  
  // 2. 从数据库字段读取
  const parsed = parseJsonMaybe(input);
  if (!Object.keys(parsed).length) return null;
  const state = parseJsonMaybe(parsed.st);
  if (!Object.keys(state).length) return null;
  const round = Number(parsed.r || 0);
  const capturedAt = Number(parsed.t || 0);
  const chapterId = Number(parsed.c || 0);
  
  const result: SessionMessageRevisitData = {
    v: 1,
    c: Number.isFinite(chapterId) && chapterId > 0 ? chapterId : null,
    s: String(parsed.s || "active").trim() || "active",
    r: Number.isFinite(round) && round >= 0 ? round : 0,
    t: Number.isFinite(capturedAt) && capturedAt > 0 ? capturedAt : 0,
    st: state,
  };
  
  // 如果从数据库读取成功，同时缓存到内存
  if (sessionId && messageId && Number.isFinite(messageId) && messageId > 0) {
    saveSessionRevisitToHotCache(sessionId, messageId, result);
  }
  
  return result;
}

export async function persistSessionMessageRevisitData(params: {
  db: any;
  rows: Array<Record<string, any> | null | undefined>;
  state: Record<string, any>;
  chapterId: number | null | undefined;
  status: string;
  capturedAt?: number;
  sessionId?: string | null; // 添加 sessionId 参数
}): Promise<void> {
  const rowIds = params.rows
    .map((row) => Number(row?.id || 0))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (!rowIds.length) return;
  const revisitData = buildSessionMessageRevisitData({
    state: params.state,
    chapterId: params.chapterId,
    status: params.status,
    capturedAt: params.capturedAt,
  });
  
  // 保存到内存缓存
  if (params.sessionId) {
    rowIds.forEach((messageId) => {
      saveSessionRevisitToHotCache(params.sessionId!, messageId, revisitData);
    });
  }
  
  // 持久化到数据库
  const revisitDataText = toJsonText(revisitData, {});
  await params.db("t_sessionMessage").whereIn("id", rowIds).update({
    revisitData: revisitDataText,
  });
  const parsedRevisitData = parseJsonMaybe(revisitDataText);
  params.rows.forEach((row) => {
    if (!row || typeof row !== "object") return;
    row.revisitData = parsedRevisitData;
  });
}

function buildRecentMessages(rows: any[], state?: any): RuntimeMessageInput[] {
  // 获取当前事件/阶段标记，用于补充历史消息
  const chapterProgress = state ? readChapterProgressState(state) : null;
  return rows
    .reverse()
    .map((item: any) => {
      // 解析 meta，提取事件标记
      let metaData: Record<string, any> = {};
      if (item.meta) {
        try {
          metaData = JSON.parse(item.meta) || {};
        } catch { /* ignore */ }
      }
      // 从 meta 中读取标记，如果没有（undefined）则使用当前 chapterProgress 的值
      // 注意：不能简单用 ?? 操作符，因为 null ?? fallback 会返回 null
      const hasEventIndex = metaData.hasOwnProperty("eventIndex");
      const hasStageIndex = metaData.hasOwnProperty("stageIndex");
      const hasPhaseId = metaData.hasOwnProperty("phaseId");

      // 角色发言计数
      const roleData: Record<string, any> = metaData.roleData || {};
      const roleNumSpeechCurrEvent = Number(roleData.numSpeechCurrEvent || 0);
      const roleNumSpeechCurrStage = Number(roleData.numSpeechCurrStage || 0);

      if (DebugLogUtil.isDebugLogEnabled()) {
           console.log("[story:event_progress:runtime][stage][buildRecentMessages]", JSON.stringify({
               role: String(item.role || ""),
              eventIndex: hasEventIndex ? metaData.eventIndex : (chapterProgress?.eventIndex ?? null),
              stageIndex: hasStageIndex ? metaData.stageIndex : (chapterProgress?.stageIndex ?? 0),
            }
        ));
      }

      return {
        messageId: Number(item.id || 0),
        role: String(item.role || ""),
        roleType: String(item.roleType || ""),
        eventType: String(item.eventType || ""),
        content: String(item.content || ""),
        createTime: Number(item.createTime || 0),
        eventIndex: hasEventIndex ? metaData.eventIndex : (chapterProgress?.eventIndex ?? null),
        stageIndex: hasStageIndex ? metaData.stageIndex : (chapterProgress?.stageIndex ?? 0),
        phaseId: hasPhaseId ? metaData.phaseId : (chapterProgress?.phaseId ?? null),
        roleNumSpeechCurrEvent,
        roleNumSpeechCurrStage,
      };
    });
}

/**
 * 将"正式会话里的用户发言"应用到当前事件进度。
 *
 * 用途：
 * - 先把 trigger / task / delta 等规则信号写进运行态
 * - 再让 AI 判断当前事件到底推进到了哪一步、是否已经结束
 * - 只有 AI 不可用时，才回退到旧的用户节点完成逻辑
 */
async function applySessionUserEventProgress(params: {
  userId?: number;
  chapter: any;
  state: Record<string, any>;
  messageId?: number | null;
  messageContent: string;
  eventType?: string;
  triggered?: TriggerHit[];
  taskProgress?: TaskProgressChange[];
  deltas?: AppliedDelta[];
  recentMessages?: RuntimeMessageInput[];
  traceMeta?: Record<string, any>;
}): Promise<void> {
  if (!params.chapter) {
    return;
  }
  initializeChapterProgressForState(params.chapter, params.state);
  syncChapterProgressWithRuntime(params.chapter, params.state);
  recordChapterProgressSignals(params.chapter, params.state, {
    messageContent: params.messageContent,
    messageRole: String(params.state.player?.name || "用户"),
    messageRoleType: "player",
    triggered: params.triggered,
    taskProgress: params.taskProgress,
    deltas: params.deltas,
  });
  syncChapterProgressWithRuntime(params.chapter, params.state);
  const resolution = await evaluateEventProgressByAi({
    userId: params.userId,
    chapter: params.chapter,
    state: params.state,
    messageContent: params.messageContent,
    messageRole: String(params.state.player?.name || "用户"),
    messageRoleType: "player",
    eventType: params.eventType,
    recentMessages: params.recentMessages,
    traceMeta: params.traceMeta,
  });
  console.log("[applySessionUserEventProgress] resolution applied", {
    ended: resolution?.ended,
    eventStatus: resolution?.eventStatus,
    phaseId: params.state.chapterProgress?.phaseId,
    eventIndex: params.state.chapterProgress?.eventIndex,
  });
  if (DebugLogUtil.isDebugLogEnabled()) {
    // [story:event_progress:stats] resolution
    DebugLogUtil.logEventProgressResolution("story:event_progress:stats", {
      chapter: params.chapter,
      currentEventIndex: Number(params.state?.chapterProgress?.eventIndex || params.state?.currentEventDigest?.eventIndex || 0),
      currentPhaseId: params.state?.chapterProgress?.phaseId,
      currentPhaseLabel: params.state?.chapterProgress?.phaseId,
      ended: resolution?.ended,
      eventStatus: resolution?.eventStatus,
      nextEventIndex: Number(readNextEventProgressHint(params.chapter, params.state)?.index || 0),
      nextEventSummary: readNextEventProgressHint(params.chapter, params.state)?.summary,
    });
  }
  if (resolution) {
    const progressApplied = applyAiEventProgressResolution({
      chapter: params.chapter,
      state: params.state,
      resolution,
    });
    console.log("[applySessionUserEventProgress] after applyAiEventProgressResolution", {
      ended: resolution.ended,
      phaseChanged: progressApplied.phaseChanged,
      stageAdvanced: progressApplied.stageAdvanced,
      enteredUserPhase: progressApplied.enteredUserPhase,
      chapterProgressEventIndex: params.state.chapterProgress?.eventIndex,
      chapterProgressPhaseId: params.state.chapterProgress?.phaseId,
      currentEventIndex: params.state.currentEvent?.index,
      currentEventStatus: params.state.currentEvent?.status,
    });
    syncChapterProgressWithRuntime(params.chapter, params.state);
    return;
  }
  markCurrentUserNodeCompleted(params.chapter, params.state, params.messageId ?? null);
  syncChapterProgressWithRuntime(params.chapter, params.state);
}

/**
 * 在正式 `/game/orchestration` 前，对"最近一条已落库消息"补做一次事件进度检测。
 *
 * 用途：
 * - 之前事件进度 AI 只在用户消息提交时运行，旁白/NPC 自动续写不会触发；
 * - 当旁白已经把当前事件推进到"等待用户输入"时，后端若不先检测，就会继续错误编排下一句旁白；
 * - 这里在真正进入编排前补一刀，命中 `waiting_input` 后立即把输入权交还给用户。
 */
async function applySessionPreOrchestrationEventProgress(params: {
  userId: number;
  world: any;
  chapter: any;
  state: Record<string, any>;
  recentMessages: RuntimeMessageInput[];
  traceMeta?: Record<string, any>;
}): Promise<void> {
  const latestRecentMessage = params.recentMessages[params.recentMessages.length - 1];
  const latestMessageId = Number(latestRecentMessage?.messageId || 0);
  const latestRoleType = String(latestRecentMessage?.roleType || "").trim().toLowerCase();
  const latestEventType = String(latestRecentMessage?.eventType || "").trim();
  const latestContent = String(latestRecentMessage?.content || "").trim();
  if (!params.chapter || !latestMessageId || !latestContent) {
    return;
  }
  if (latestEventType === "on_opening") {
    return;
  }
  if (latestRoleType === "player" && latestEventType === "on_message") {
    return;
  }
  const progressCursor = Number(params.state?.orchestrationEventProgressMessageId || 0);
  if (progressCursor === latestMessageId) {
    return;
  }
  // 如果事件已经被标记为完成（phaseId 已清空），跳过预检测避免重复评估覆盖已有结果
  const currentPhaseId = String(params.state?.chapterProgress?.phaseId || "").trim();
  const currentEventStatus = String(params.state?.chapterProgress?.eventStatus || "").trim().toLowerCase();
  if (!currentPhaseId && currentEventStatus === "completed") {
    return;
  }

  const resolution = await evaluateEventProgressByAi({
    userId: params.userId,
    chapter: params.chapter,
    state: params.state,
    messageContent: latestContent,
    messageRole: String(latestRecentMessage?.role || ""),
    messageRoleType: String(latestRecentMessage?.roleType || ""),
    eventType: latestEventType,
    recentMessages: params.recentMessages,
    traceMeta: {
      ...(params.traceMeta || {}),
      stage: "pre_orchestration",
      latestMessageId,
    },
  });
  params.state.orchestrationEventProgressMessageId = latestMessageId;
  if (!resolution) {
    return;
  }

  const progressApplied = applyAiEventProgressResolution({
    chapter: params.chapter,
    state: params.state,
    resolution,
  });
  syncChapterProgressWithRuntime(params.chapter, params.state);
  if (DebugLogUtil.isDebugLogEnabled()) {
    DebugLogUtil.logEventProgressResolution("story:event_progress:stats", {
      chapter: params.chapter,
      currentEventIndex: Number(params.state?.chapterProgress?.eventIndex || params.state?.currentEventDigest?.eventIndex || 0),
      currentPhaseId: params.state?.chapterProgress?.phaseId,
      currentPhaseLabel: params.state?.chapterProgress?.phaseId,
      ended: resolution?.ended,
      eventStatus: resolution?.eventStatus,
      nextEventIndex: Number(readNextEventProgressHint(params.chapter, params.state)?.index || 0),
      nextEventSummary: readNextEventProgressHint(params.chapter, params.state)?.summary,
    });
  }
  if (progressApplied.enteredUserPhase || resolution.eventStatus === "waiting_input") {
    allowPlayerTurn(
      params.state,
      params.world,
      String(latestRecentMessage?.roleType || "narrator"),
      String(latestRecentMessage?.role || params.state.narrator?.name || "旁白"),
    );
  }
}

function readMemoryCursorMessageId(state: Record<string, any>): number {
  const cursor = parseJsonMaybe(state?.memoryCursor);
  const id = Number(cursor.lastMessageId || 0);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function readMemoryCursor(state: Record<string, any>): Record<string, any> {
  return parseJsonMaybe(state?.memoryCursor);
}

function readStableMemoryEventDigest(state: Record<string, any>): RuntimeEventDigestState & {
  stableEventSummary: string;
  stableEventFacts: string[];
  stableMemorySummary: string;
  stableMemoryFacts: string[];
} {
  const digest = readRuntimeCurrentEventDigestState(state);
  return {
    ...digest,
    stableEventSummary: String(digest.eventSummary || "").trim(),
    stableEventFacts: Array.isArray(digest.eventFacts)
      ? digest.eventFacts.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 6)
      : [],
    stableMemorySummary: String(digest.memorySummary || "").trim(),
    stableMemoryFacts: Array.isArray(digest.memoryFacts)
      ? digest.memoryFacts.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 6)
      : [],
  };
}

function hasMemoryEventDelta(state: Record<string, any>): boolean {
  const cursor = readMemoryCursor(state);
  const currentEventDigest = readStableMemoryEventDigest(state);
  const cursorFacts = Array.isArray(cursor.lastEventFacts)
    ? cursor.lastEventFacts.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const currentFacts = currentEventDigest.stableEventFacts;
  return Number(cursor.lastEventIndex || 0) !== Number(currentEventDigest.eventIndex || 0)
    || String(cursor.lastEventKind || "").trim() !== String(currentEventDigest.eventKind || "").trim()
    || String(cursor.lastEventSummary || "").trim() !== currentEventDigest.stableEventSummary
    || cursorFacts.join("｜") !== currentFacts.join("｜");
}

function setMemoryCursor(state: Record<string, any>, lastMessageId: number, updateTime: number): void {
  const cursor = readMemoryCursor(state);
  const stableLastMessageId = Number.isFinite(lastMessageId) && lastMessageId > 0
    ? lastMessageId
    : Number.isFinite(Number(cursor.lastMessageId || 0)) && Number(cursor.lastMessageId || 0) > 0
      ? Number(cursor.lastMessageId || 0)
      : 0;
  const currentEventDigest = readStableMemoryEventDigest(state);
  state.memoryCursor = {
    lastMessageId: stableLastMessageId,
    lastEventIndex: currentEventDigest.eventIndex,
    lastEventKind: currentEventDigest.eventKind,
    lastEventSummary: currentEventDigest.stableEventSummary,
    lastEventFacts: currentEventDigest.stableEventFacts,
    updateTime: Number.isFinite(updateTime) && updateTime > 0 ? updateTime : nowTs(),
  };
}

function buildMemoryEventDeltaInput(state: Record<string, any>): RuntimeMessageInput | null {
  const currentEventDigest = readStableMemoryEventDigest(state);
  const eventFacts = currentEventDigest.stableEventFacts;
  const memoryFacts = currentEventDigest.stableMemoryFacts;
  return {
    messageId: null,
    role: "系统",
    roleType: "system",
    eventType: "on_event_memory_delta",
    content: [
      `事件#${Number(currentEventDigest.eventIndex || 1)} ${String(currentEventDigest.eventKind || "scene")}`,
      currentEventDigest.stableEventSummary,
      eventFacts.length ? `事件事实：${eventFacts.join("；")}` : "",
    ].filter(Boolean).join("\n"),
    createTime: nowTs(),
    memoryDelta: {
      eventIndex: Number(currentEventDigest.eventIndex || 1),
      eventKind: String(currentEventDigest.eventKind || "scene"),
      eventSummary: currentEventDigest.stableEventSummary,
      eventFacts,
      memorySummary: currentEventDigest.stableMemorySummary,
      memoryFacts,
    },
  };
}

async function loadIncrementalMessagesForMemory(db: any, sessionId: string, state: Record<string, any>): Promise<RuntimeMessageInput[]> {
  const lastMessageId = readMemoryCursorMessageId(state);
  const rows = lastMessageId > 0
    ? await db("t_sessionMessage")
      .where({ sessionId })
      .andWhere("id", ">", lastMessageId)
      .orderBy("id", "asc")
      .limit(20)
    : await db("t_sessionMessage")
      .where({ sessionId })
      .orderBy("id", "desc")
      .limit(20);
  const recentMessages = buildRecentMessages(rows, state);
  if (!hasMemoryEventDelta(state)) {
    return recentMessages;
  }
  const eventDeltaInput = buildMemoryEventDeltaInput(state);
  if (!eventDeltaInput) {
    return recentMessages;
  }
  return [
    ...recentMessages,
    eventDeltaInput,
  ];
}

function resolveDefaultRoleName(roleType: string, state: Record<string, any>): string {
  if (roleType === "player") return String(state.player?.name || "用户");
  if (roleType === "narrator") return String(state.narrator?.name || "旁白");
  return "系统";
}

function runtimeTurnStateFromState(state: Record<string, any>): Record<string, any> {
  const turnState = state?.turnState;
  return turnState && typeof turnState === "object" && !Array.isArray(turnState)
    ? turnState
    : {};
}

function buildSessionRuntimeMeta(state: Record<string, any>, lineIndex: number) {
  const turnState = runtimeTurnStateFromState(state);
  const canPlayerSpeakNow = turnState.canPlayerSpeak !== false;
  return {
    kind: "runtime_stream",
    streaming: false,
    lineIndex,
    status: "generated",
    nextRole: String(
      canPlayerSpeakNow
        ? state.player?.name || "用户"
        : turnState.expectedRole || "",
    ).trim(),
    nextRoleType: String(
      canPlayerSpeakNow
        ? "player"
        : turnState.expectedRoleType || "",
    ).trim(),
  };
}

function buildSessionExpectedSpeaker(state: Record<string, any>) {
  const turnState = runtimeTurnStateFromState(state);
  const canPlayerSpeakNow = turnState.canPlayerSpeak !== false;
  return {
    expectedRole: String(
      canPlayerSpeakNow
        ? state.player?.name || "用户"
        : turnState.expectedRole || "",
    ).trim() || "用户",
    expectedRoleType: String(
      canPlayerSpeakNow
        ? "player"
        : turnState.expectedRoleType || "",
    ).trim() || "player",
  };
}

/**
 * 为"当前已轮到用户输入"的正式会话编排结果构造一个最小计划。
 *
 * 用途：
 * - `/game/orchestration` 必须稳定返回 `role/roleType/motive/awaitUser`；
 * - 之前 waiting_input 分支直接回 `plan: null`，前端就会拿到空角色、空类型；
 * - 这里显式返回"用户可输入"的计划，避免把正常等待用户误渲染成空编排结果。
 */
function buildWaitingForUserSessionPlan(state: Record<string, any>): SessionNarrativePlanResult {
  const playerName = String(state.player?.name || "用户").trim() || "用户";
  return buildSessionPlanResult({
    role: "用户",
    roleType: "player",
    motive: `等待${playerName}输入下一步行动`,
    awaitUser: true,
    nextRole: "",
    nextRoleType: "",
    source: "rule",
    triggerMemoryAgent: false,
    eventType: "on_waiting_input",
    presetContent: "",
    eventAdjustMode: "waiting_input",
    eventStatus: "waiting_input",
  })!;
}

function buildSessionPlanResult(plan: ({
  role?: unknown;
  roleType?: unknown;
  motive?: unknown;
  awaitUser?: unknown;
  nextRole?: unknown;
  nextRoleType?: unknown;
  memoryHints?: unknown;
  source?: unknown;
  triggerMemoryAgent?: unknown;
  eventType?: unknown;
  presetContent?: unknown;
  eventAdjustMode?: unknown;
  eventIndex?: unknown;
  eventKind?: unknown;
  eventSummary?: unknown;
  eventFacts?: unknown;
  eventStatus?: unknown;
  speakerMode?: unknown;
  speakerRouteReason?: unknown;
  nextNarrativePlan?: unknown;
  orchestratorRuntime?: unknown;
}) | null | undefined): SessionNarrativePlanResult | null {
  if (!plan) return null;
  return {
    role: String(plan.role || "").trim(),
    roleType: String(plan.roleType || "").trim() || "narrator",
    motive: String(plan.motive || "").trim(),
    awaitUser: Boolean(plan.awaitUser),
    nextRole: String(plan.nextRole || "").trim(),
    nextRoleType: String(plan.nextRoleType || "").trim(),
    source: plan.source === "fallback"
      ? "fallback"
      : plan.source === "rule"
        ? "rule"
        : "ai",
    triggerMemoryAgent: Boolean(plan.triggerMemoryAgent),
    eventType: String(plan.eventType || "on_orchestrated_reply").trim() || "on_orchestrated_reply",
    presetContent: String(plan.presetContent || "").trim() || null,
    eventAdjustMode: plan.eventAdjustMode === "update"
      ? "update"
      : plan.eventAdjustMode === "waiting_input"
        ? "waiting_input"
        : plan.eventAdjustMode === "completed"
          ? "completed"
          : "keep",
    eventIndex: Number.isFinite(Number(plan.eventIndex)) ? Math.max(1, Number(plan.eventIndex)) : undefined,
    eventKind: plan.eventKind === "opening"
      ? "opening"
      : plan.eventKind === "user"
        ? "user"
        : plan.eventKind === "fixed"
          ? "fixed"
          : plan.eventKind === "ending"
            ? "ending"
          : plan.eventKind === "scene"
            ? "scene"
            : undefined,
    eventSummary: String(plan.eventSummary || "").trim(),
    eventFacts: Array.isArray(plan.eventFacts)
      ? plan.eventFacts.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
    eventStatus: plan.eventStatus === "active"
      ? "active"
      : plan.eventStatus === "waiting_input"
        ? "waiting_input"
        : plan.eventStatus === "completed"
          ? "completed"
          : plan.eventStatus === "idle"
            ? "idle"
            : undefined,
    speakerMode: plan.speakerMode === "template"
      ? "template"
      : plan.speakerMode === "fast"
        ? "fast"
        : plan.speakerMode === "premium"
          ? "premium"
          : undefined,
    speakerRouteReason: String(plan.speakerRouteReason || "").trim(),
    memoryHints: Array.isArray(plan.memoryHints)
      ? plan.memoryHints.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
    nextNarrativePlan: plan.nextNarrativePlan
      ? buildSessionPlanResult(plan.nextNarrativePlan as any)
      : null,
    orchestratorRuntime: (() => {
      const raw = parseJsonMaybe(plan.orchestratorRuntime);
      if (!Object.keys(raw).length) return undefined;
      const reasoningEffort = String(raw.reasoningEffort || "").trim().toLowerCase();
      return {
        modelKey: String(raw.modelKey || "").trim(),
        manufacturer: String(raw.manufacturer || "").trim(),
        model: String(raw.model || "").trim(),
        reasoningEffort: reasoningEffort === "minimal" || reasoningEffort === "low" || reasoningEffort === "medium" || reasoningEffort === "high"
          ? reasoningEffort
          : "",
        payloadMode: String(raw.payloadMode || "").trim().toLowerCase() === "advanced" ? "advanced" : "compact",
        payloadModeSource: String(raw.payloadModeSource || "").trim().toLowerCase() === "explicit" ? "explicit" : "inferred",
      };
    })(),
  };
}

/**
 * 对外返回正式会话编排结果时，隐藏"下一个是谁"字段。
 *
 * 用途：
 * - 后端内部仍然需要 nextRole/nextRoleType 来维护 turnState；
 * - 但接口返回给前端时，只允许暴露"当前谁说、为什么说"，禁止前端消费下一位角色。
 */
function buildPublicSessionPlanResult(plan: SessionNarrativePlanResult | null): SessionNarrativePlanResult | null {
  if (!plan) return null;
  return {
    ...plan,
    nextRole: "",
    nextRoleType: "",
  };
}

function buildEventView(state: Record<string, any>) {
  return readDefaultRuntimeEventViewState(state);
}

function getPendingSessionChapterId(state: Record<string, any>): number | null {
  const pendingChapterId = Number(state?.pendingChapterId || 0);
  return Number.isFinite(pendingChapterId) && pendingChapterId > 0 ? pendingChapterId : null;
}

function setPendingSessionChapterId(state: Record<string, any>, chapterId: number | null): void {
  if (chapterId && chapterId > 0) {
    state.pendingChapterId = chapterId;
    return;
  }
  delete state.pendingChapterId;
}

/**
 * 判断当前会话是否已经显式完成下一章初始化，等待新章节首轮编排。
 *
 * 用途：
 * - `/orchestration` 在收到 `init_chapter` 命令前不能偷偷进入下一章；
 * - `/initchapter` 完成后再把这个标记设为 true，让下一次 `/orchestration`
 *   明确走"新章节启动编排"而不是继续沿用旧章节残局。
 */
function getPendingSessionChapterStart(state: Record<string, any>): boolean {
  return state?.pendingChapterStart === true;
}

/**
 * 写入"下一次编排应该从新章节开场开始"的显式标记。
 *
 * 用途：
 * - 只有 `/initchapter` 才允许把 pendingChapterStart 设为 true；
 * - 一旦 `/orchestration` 消费完新章节开场，就立刻清掉，避免重复开场。
 */
function setPendingSessionChapterStart(state: Record<string, any>, enabled: boolean): void {
  if (enabled) {
    state.pendingChapterStart = true;
    return;
  }
  delete state.pendingChapterStart;
}

function getPendingSessionNarrativePlan(state: Record<string, any>): SessionNarrativePlanResult | null {
  return buildSessionPlanResult(state?.pendingNarrativePlan);
}

function setPendingSessionNarrativePlan(state: Record<string, any>, plan: SessionNarrativePlanResult | null): void {
  if (plan) {
    state.pendingNarrativePlan = plan;
    const isMiniGameMode = miniGameStateManager.isMiniGameMode(state || {});
    if (DebugLogUtil.isDebugLogEnabled() && isMiniGameMode) {
     console.log("[story:mini_game:agent] 把小游戏的编排计划存入 state.pendingNarrativePlan ", JSON.stringify(plan));
    }
    return;
  }
  const isMiniGameMode = miniGameStateManager.isMiniGameMode(state || {});
  if (DebugLogUtil.isDebugLogEnabled() && isMiniGameMode) {
     console.log("[story:mini_game:agent] 把小游戏的编排计划移出 state.pendingNarrativePlan ", JSON.stringify(plan));
  }
  delete state.pendingNarrativePlan;
}

function cloneSessionRuntimeValue<T>(input: T): T {
  try {
    return JSON.parse(JSON.stringify(input ?? null)) as T;
  } catch {
    return input;
  }
}

// 正式会话也用统一 tag 串起请求链路，方便和调试态一起比对重复调用。
function logSessionOrchestrationKeyNode(node: string, traceMeta: Record<string, unknown>, extra?: Record<string, unknown>) {
  if (!DebugLogUtil.isDebugLogEnabled()) return;
  console.log("[game:orchestrator:key_nodes]", JSON.stringify({
    node,
    ...traceMeta,
    ...(extra || {}),
  }));
}

function applyPlanTurnStateToSessionState(
  state: Record<string, any>,
  world: any,
  plan: {
    awaitUser?: boolean;
    nextRole?: string;
    nextRoleType?: string;
    role?: string;
    roleType?: string;
  },
) {
  const speakingRoleType = String(plan.roleType || "").trim().toLowerCase();
  const hasNonPlayerLineToGenerate = Boolean(String(plan.role || "").trim()) && speakingRoleType !== "player";
  // 编排结果里的 nextRole/awaitUser 只描述"这句台词之后"的方向。
  // 如果当前还有旁白/NPC 台词要生成，必须等 /streamlines 落库后才能把输入权交还用户。
  const shouldYieldToPlayer = !hasNonPlayerLineToGenerate && Boolean(plan.awaitUser);
  if (shouldYieldToPlayer) {
    allowPlayerTurn(state, world, String(plan.roleType || "narrator"), String(plan.role || state.narrator?.name || "旁白"));
    return;
  }
  setRuntimeTurnState(state, world, {
    canPlayerSpeak: false,
    // 编辑师现在允许不再返回 nextRoleType。
    // 这里优先沿用显式值，缺失时回退到当前发言角色类型，再回退到旁白。
    expectedRoleType: String(plan.nextRoleType || plan.roleType || "narrator"),
    expectedRole: String(plan.nextRole || plan.role || state.narrator?.name || "旁白"),
    lastSpeakerRoleType: String(plan.roleType || "narrator"),
    lastSpeaker: String(plan.role || state.narrator?.name || "旁白"),
  });
}

// 正式会话只在裁决完成后提交一次 plan，避免 candidatePlan 提前污染 session state。
function applySessionNarrativePlanToState(params: {
  userId: number;
  world: any;
  chapter: any;
  state: Record<string, any>;
  recentMessages: RuntimeMessageInput[];
  plan: Awaited<ReturnType<typeof runNarrativePlan>>;
}) {
  applyOrchestratorResultToState(params.state, params.plan);
  applyNarrativeMemoryHintsToState(params.state, params.plan.memoryHints);
  if (params.plan.triggerMemoryAgent) {
    triggerStoryMemoryRefreshInBackground({
      userId: params.userId,
      world: params.world,
      chapter: params.chapter,
      state: params.state,
      recentMessages: params.recentMessages,
    });
  }
  applyPlanTurnStateToSessionState(params.state, params.world, params.plan);
  return buildSessionPlanResult({
    ...params.plan,
    eventType: "on_orchestrated_reply",
  });
}

/**
 * 任务模式下构造 NarrativePlan：
 *  - Intent → Progress → Director 三步走完，得到 speaker / motive / taskType
 *  - 不调用 Speaker（台词由 /game/streamlines 流式生成）
 *  - 任务结束时调用 Completion 生成总结旁白（这种情况 plan.presetContent 直接落库）
 *
 * 返回 null 表示当前不是任务模式，调用方继续走主线编排。
 */
async function tryBuildTaskModePlan(input: {
  state: Record<string, any>;
  sessionId: string;
  userId: number;
  world: any;
  chapter: any;
  recentMessages: RuntimeMessageInput[];
  latestRecentMessage: RuntimeMessageInput | null;
}): Promise<SessionNarrativePlanResult | null> {
  const card = (input.state.player?.parameterCardJson || {}) as Record<string, any>;
  const miniGameSession = (input.state.miniGame as any)?.session || {};
  const vars = (input.state.vars || {}) as Record<string, any>;
  // 主要依据：activeTaskId；其次：miniGame.game_type="task"；最后：vars.activeFreeTask
  const primaryTaskId = String(card.activeTaskId || "").trim();
  const miniGameTaskActive = String(miniGameSession.game_type || "").trim() === "task"
    && String(miniGameSession.status || "").trim() === "active";
  const varsTaskActive = Boolean(vars.activeFreeTask && typeof vars.activeFreeTask === "object");
  const taskModeActive = primaryTaskId || miniGameTaskActive || varsTaskActive;
  console.log("[task-mode-plan] tryBuildTaskModePlan 入口", {
    sessionId: input.sessionId,
    activeTaskId: primaryTaskId || null,
    miniGameTaskActive,
    varsTaskActive,
    taskModeActive,
    hasLatestMessage: !!input.latestRecentMessage,
    latestRoleType: String((input.latestRecentMessage as any)?.roleType || ""),
    recentMessageCount: input.recentMessages.length,
  });
  if (!taskModeActive) {
    console.log("[task-mode-plan] 不是任务模式，返回 null");
    return null;
  }

  const taskState = readActiveTaskStateFromState(input.state);
  if (!taskState) {
    console.log("[task-mode-plan] task 状态缺失，返回 null");
    return null;
  }

  // 取最新的玩家消息（latestRecentMessage 可能是旁白），找到最近的 player 消息
  const latestPlayerMsg = [...input.recentMessages]
    .reverse()
    .find((m) => String((m as any).roleType || "").trim() === "player");
  // 优先用 latestRecentMessage（addMessage 接口最新一条）；其次用最近的 player 消息
  let playerMessage = String((input.latestRecentMessage as any)?.content || "").trim()
    || String((latestPlayerMsg as any)?.content || "").trim();
  if (!playerMessage) {
    // 没有任何用户输入时，task 模式继续主动推进：给 AI 一个占位文本
    playerMessage = "（任务继续推进）";
    console.log("[task-mode-plan] 无明确 player 消息，使用占位文本继续 task 编排", {
      sessionId: input.sessionId,
      lastRole: String(((input.recentMessages.slice(-1)[0]) as any)?.role || ""),
    });
  }

  console.log("[task-mode-plan] 启动 task 编排", {
    sessionId: input.sessionId,
    playerMessage: playerMessage.slice(0, 60),
    taskTitle: taskState.title,
  });

  const dialogue = input.recentMessages.map((m) => ({
    role: String((m as any).role || "?"),
    content: String((m as any).content || ""),
  }));

  // 提前准备 NPC 列表 + 原始/动态全局背景
  // 为什么提前：早期"用户主动放弃"分支也会调 evaluateTaskCompletion，
  // 之前那里只传了 userId 后就没传上下文，AI 缺少世界观和 NPC 提示，输出质量很差。
  const memoryDigest = readStableMemoryEventDigest(input.state);
  const npcList = collectTaskNpcList(input.world, input.state);
  const npcCards = npcList.map(n => `- ${n.name}（${n.roleType || "npc"}）：${n.card || "无描述"}`).join("\n") || "（无可用NPC）";
  // 故事初始全局背景：优先 settings.globalBackground（前端"全局背景"长描述），回退到  background
  // settings 可能是字符串（直接从数据库来的旧数据）或已解析的对象
  const worldRecord = (input.world || {}) as Record<string, any>;
  const settingsObj = typeof worldRecord.settings === "string"
    ? parseJsonSafe(worldRecord.settings, {})
    : (worldRecord.settings || {});
  const worldGlobalBackground = String(
    settingsObj.globalBackground
    || worldRecord.globalBackground
    || worldRecord.background
    || ""
  ).trim();
  const originalGlobalBg = worldGlobalBackground || "（无）";
  // 故事动态全局背景：来自记忆管理器维护的 memorySummary
  const memorySummary = String(memoryDigest.stableMemorySummary || "").trim();
  const dynamicGlobalBg = memorySummary || "（无动态事实）";

  // 1. Intent
  const intentResult = await analyzeTaskIntent({
    userId: input.userId,
    playerMessage,
    activeTaskId: primaryTaskId || null,
    chapterTitle: String(input.chapter?.title || ""),
  });
  console.log("[task-mode-plan] Intent:", intentResult.intent, intentResult.confidence, "| reasoning:", intentResult.reasoning?.slice(0, 50));

  // 退出/放弃 → Completion 评估，写为 narrator preset 落库（不需要 streamlines）
  if (intentResult.intent === "exit_task" && intentResult.confidence >= 0.7) {
    const completion = await evaluateTaskCompletion(
      "abandon",
      taskState,
      dialogue,
      playerMessage,
      // progressLevel：用户主动放弃没有真正的进展等级，传 "abandon" 作为占位标记
      "abandon",
      input.userId,
      npcCards,
      originalGlobalBg,
      dynamicGlobalBg,
    );
    console.log("[task-mode-plan] 任务放弃，生成完成评估");
    return buildTaskNarrativePlan({
      state: input.state,
      role: "旁白",
      roleType: "narrator",
      motive: completion.statement,
      eventType: "on_mini_game_finished",
      presetContent: completion.narration,
      taskMeta: {
        completionLevel: completion.level,
        suggestion: completion.suggestion,
      },
    });
  }

  // ★ 意图 = memory_update：调用记忆管理器更新参数卡，然后继续走任务编排
  if (intentResult.intent === "memory_update" && intentResult.confidence >= 0.7) {
    try {
      const { refreshStoryMemoryBestEffort } = await import("@/modules/game-runtime/engines/NarrativeOrchestrator");
      console.log("[task-mode-plan] 命中 memory_update，调用记忆管理器更新参数卡", {
        sessionId: input.sessionId,
        playerMessage: playerMessage.slice(0, 80),
      });
      await refreshStoryMemoryBestEffort({
        userId: input.userId,
        world: input.world,
        chapter: input.chapter,
        state: input.state,
        recentMessages: input.recentMessages,
      });
      console.log("[task-mode-plan] 记忆管理器已更新参数卡");
    } catch (err) {
      console.error("[task-mode-plan] memory_update 记忆管理器调用失败", err);
    }
  }

  // 2. Progress（全局背景/NPC 上下文在前面已准备）
  console.log("[task-mode-plan] context_summary", JSON.stringify({
    npcCount: npcList.length,
    npcCardsChars: npcCards.length,
    originalGlobalBgChars: originalGlobalBg.length,
    dynamicGlobalBgChars: dynamicGlobalBg.length,
  }));

  const progressResult = await evaluateTaskProgress(
    {
      intent: intentResult.intent,
      confidence: intentResult.confidence,
      reasoning: intentResult.reasoning || "",
    },
    taskState,
    dialogue,
    playerMessage,
    input.userId,
    npcCards,
    originalGlobalBg,
    dynamicGlobalBg,
  );
  console.log("[task-mode-plan] Progress:", progressResult.level, "/", progressResult.tier, "/", JSON.stringify(progressResult.processUpdate), "| process:", taskState.process?.join(" → "));

  // ★★★ 将 processUpdate 写回 state.vars.activeFreeTask.process ★★★
  const miniGame = (input.state.miniGame || {}) as Record<string, any>;

  if (progressResult.processItem) {
    // AI 直接返回了完整推进过程文字，直接用
    const vars = (input.state.vars || {}) as Record<string, any>;
    const activeTask = vars.activeFreeTask as Record<string, any> | null;
    if (activeTask) {
      activeTask.process = progressResult.processItem;
      vars.activeFreeTask = activeTask;
      input.state.vars = vars;
    }
    // 同步到 miniGame.ui.state_items
    const ui = (miniGame.ui || {}) as Record<string, any>;
    const stateItems = Array.isArray(ui.state_items) ? ui.state_items as Record<string, string>[] : [];
    const processItemEntry = stateItems.find(item => item.key === "推进过程");
    if (processItemEntry) {
      processItemEntry.value = progressResult.processItem;
    }
    const session = (miniGame.session || {}) as Record<string, any>;
    const publicState = (session.public_state || {}) as Record<string, any>;
    publicState.process_steps = progressResult.processItem;
    console.log("[task-mode-plan] processItem 直接更新:", progressResult.processItem);
  } else if (progressResult.processUpdate?.action && progressResult.processUpdate.action !== "none") {
    // 旧逻辑：通过 processUpdate 指令更新
    const vars = (input.state.vars || {}) as Record<string, any>;
    const activeTask = vars.activeFreeTask as Record<string, any> | null;
    if (activeTask && Array.isArray(activeTask.process)) {
      const { applyProcessUpdateToPhases } = await import("@/modules/game-runtime/agents/taskMode/TaskProgressAgent");
      const updatedProcess = applyProcessUpdateToPhases(activeTask.process as string[], progressResult.processUpdate);
      activeTask.process = updatedProcess;
      vars.activeFreeTask = activeTask;
      input.state.vars = vars;
      const ui = (miniGame.ui || {}) as Record<string, any>;
      const stateItems = Array.isArray(ui.state_items) ? ui.state_items as Record<string, string>[] : [];
      const processEntry = stateItems.find(item => item.key === "推进过程");
      if (processEntry) {
        processEntry.value = updatedProcess.join("；");
      }
      const session = (miniGame.session || {}) as Record<string, any>;
      const publicState = (session.public_state || {}) as Record<string, any>;
      publicState.process_steps = updatedProcess;
      console.log("[task-mode-plan] processUpdate 更新:", JSON.stringify(updatedProcess));
    }
  }

  if (progressResult.level === "abandon") {
    const completion = await evaluateTaskCompletion(
      "abandon",
      taskState,
      dialogue,
      playerMessage,
      progressResult.reason,
      input.userId,
      npcCards,
      originalGlobalBg,
      dynamicGlobalBg,
    );
    await finalizeTaskMiniGame({
      state: input.state,
      world: input.world,
      chapter: input.chapter,
      sessionId: input.sessionId,
      userId: input.userId,
      recentMessages: input.recentMessages,
      taskState,
      reason: progressResult.reason,
      finalStatus: "abandon",
    });
    return buildTaskNarrativePlan({
      state: input.state,
      role: "旁白",
      roleType: "narrator",
      motive: completion.statement,
      eventType: "on_mini_game_finished",
      presetContent: completion.narration,
      taskMeta: {
        completionLevel: completion.level,
        suggestion: completion.suggestion,
      },
    });
  }

  // ★ 每轮都调用 TaskCompletionAgent 让它自己判断 decision
  // 强信号：用户输入"完成任务""提交任务""结算"等 → 标记 finalStatus=success 提示 AI
  const submitKeywords = /(完成任务|提交任务|结算|任务结束|交差|收工)/;
  const hintFinalStatus: "auto" | "success" = submitKeywords.test(playerMessage) ? "success" : "auto";
  const completionResult = await evaluateTaskCompletion(
    hintFinalStatus,
    {
      title: taskState.title,
      objective: taskState.objective,
      // 优先使用 AI 刚返回的 processItem 文字，否则用原 process 数组
      process: progressResult.processItem || taskState.process,
    },
    dialogue,
    playerMessage,
    progressResult.level || "",
    input.userId,
    npcCards,
    originalGlobalBg,
    dynamicGlobalBg,
  );
  console.log("[task-mode-plan] Completion 评估", {
    decision: completionResult.decision,
    level: completionResult.level,
    hintFinalStatus,
  });

  if (completionResult.decision === "success" || completionResult.decision === "failed") {
    const finalStatus = completionResult.decision === "success" ? "success" : "failed";
    await finalizeTaskMiniGame({
      state: input.state,
      world: input.world,
      chapter: input.chapter,
      sessionId: input.sessionId,
      userId: input.userId,
      recentMessages: input.recentMessages,
      taskState,
      reason: completionResult.statement || `任务${finalStatus === "success" ? "完成" : "失败"}`,
      finalStatus,
    });
    return buildTaskNarrativePlan({
      state: input.state,
      role: "旁白",
      roleType: "narrator",
      motive: completionResult.statement,
      eventType: "on_mini_game_finished",
      presetContent: completionResult.narration,
      taskMeta: {
        completionLevel: completionResult.level,
        suggestion: completionResult.suggestion,
      },
    });
  }
  // decision === "continue" → 任务继续，往下走 Director

  if (progressResult.needClarify && progressResult.clarifyContent) {
    return buildTaskNarrativePlan({
      state: input.state,
      role: "任务系统",
      roleType: "narrator",
      motive: "请求澄清",
      eventType: "on_orchestrated_reply",
      presetContent: progressResult.clarifyContent,
      taskMeta: {
        progressLevel: progressResult.level,
        clarify: true,
      },
    });
  }

  // 3. Director（npcList 已在 Progress 段收集）
  const directorResult = await directTaskNarrative(
    progressResult.level,
    taskState,
    npcList,
    dialogue,
    playerMessage,
    input.userId,
    npcCards,
    originalGlobalBg,
    dynamicGlobalBg,
  );
  console.log("[task-mode-plan] Director:", directorResult.speaker, "/", directorResult.taskType, "| motive:", directorResult.motive, "| direction:", directorResult.direction, "| speakerRole:", directorResult.speakerRole);

  // Director 决定 speaker，但 speaker 实际台词由 /streamlines 调 TaskSpeaker 生成
  return buildTaskNarrativePlan({
    state: input.state,
    role: directorResult.speaker,
    roleType: directorResult.speakerRole === "system"
      ? "narrator"
      : (directorResult.speakerRole as "narrator" | "npc"),
    motive: directorResult.motive,
    eventType: "on_orchestrated_reply",
    presetContent: null,
    taskMeta: {
      progressLevel: progressResult.level,
      taskType: directorResult.taskType,
      direction: directorResult.direction,
      expectedResult: directorResult.expectedResult,
    },
  });
}

/**
 * 任务完成/放弃后的统一收尾：
 * 1. 调用记忆管理器写双方关系到 player/npc 参数卡的 other 字段、写奖励到 player 卡
 * 2. 关闭 miniGame session、清 vars.activeFreeTask、清 player.activeTaskId
 */
async function finalizeTaskMiniGame(params: {
  state: Record<string, any>;
  world: any;
  chapter: any;
  sessionId: string;
  userId: number;
  recentMessages: RuntimeMessageInput[];
  taskState: { title?: string; objective?: string; process?: any };
  reason: string;
  finalStatus: "success" | "abandon" | "failed";
}): Promise<void> {
  const { state, world, chapter, userId, recentMessages, taskState, finalStatus } = params;

  // 1. 触发记忆管理器，把任务结果（包括 NPC 关系、奖励、状态变化）合并进参数卡
  try {
    const { refreshStoryMemoryBestEffort } = await import("@/modules/game-runtime/engines/NarrativeOrchestrator");
    console.log("[task-mode-plan] finalize 触发记忆管理器", {
      sessionId: params.sessionId,
      taskTitle: taskState.title,
      finalStatus,
    });
    await refreshStoryMemoryBestEffort({ userId, world, chapter, state, recentMessages });
  } catch (err) {
    console.error("[task-mode-plan] finalize 记忆管理器失败", err);
  }

  // 2. 清掉 miniGame 会话，让玩家退出小游戏模式
  const miniGame = (state.miniGame || {}) as Record<string, any>;
  const session = (miniGame.session || {}) as Record<string, any>;
  session.status = "finished";
  session.result = finalStatus;
  session.finish_reason = params.reason;
  miniGame.session = session;
  state.miniGame = miniGame;

  // 3. 清 vars.activeFreeTask + player.parameterCardJson.activeTaskId
  const vars = (state.vars || {}) as Record<string, any>;
  delete vars.activeFreeTask;
  state.vars = vars;
  const player = (state.player || {}) as Record<string, any>;
  const card = (player.parameterCardJson || {}) as Record<string, any>;
  delete card.activeTaskId;
  delete card.activeTaskTitle;
  delete card.activeTaskCategory;
  player.parameterCardJson = card;
  state.player = player;

  console.log("[task-mode-plan] finalize 已退出小游戏，已清 activeTaskId/activeFreeTask", {
    sessionId: params.sessionId,
    finalStatus,
  });
}

/**
 * 从 world.settings.roles 收集 NPC 列表（task agents 使用）
 */
function collectTaskNpcList(world: any, state?: Record<string, any>): Array<{ id: string; name: string; roleType?: string; card?: string }> {
  const settings = (world?.settings || {}) as Record<string, any>;
  const roles = Array.isArray(settings.roles) ? settings.roles : [];
  const stateNpcs = (state?.npcs || {}) as Record<string, any>;
  const npcs: Array<{ id: string; name: string; roleType?: string; card?: string }> = [];

  // 1. 先从 world.settings.roles 收集（5种类型全部保留：npc/system/general/narrator/player）
  for (const role of roles) {
    if (!role || typeof role !== "object") continue;
    const r = role as Record<string, any>;
    // player 和 narrator 是前端限定的特殊角色，narrator 跳过，player 跳过（TaskDirector 由玩家扮演）
    const rt = String(r.roleType || "npc").trim().toLowerCase();
    if (rt === "player" || rt === "narrator") continue;
    const name = String(r.name || "").trim();
    if (!name) continue;
    const id = String(r.id || `npc_${name}`).trim();
    // 优先用 state.npcs 里运行时更新过的最新参数卡
    const stateCard = stateNpcs[id]?.parameterCardJson;
    const card = stateCard
      ? JSON.stringify(stateCard).slice(0, 800)
      : String(r.description || JSON.stringify(r.parameterCardJson || {})).slice(0, 800);
    npcs.push({ id, name, roleType: rt, card });
  }

  // 2. 兜底：state.npcs 里有但 world.settings.roles 里没有的（线上历史数据）
  for (const [id, npcVal] of Object.entries(stateNpcs)) {
    if (npcs.find(n => n.id === id)) continue;
    const npc = npcVal as Record<string, any>;
    const name = String(npc?.name || npc?.role_name || "").trim();
    if (!name) continue;
    const card = npc?.parameterCardJson
      ? JSON.stringify(npc.parameterCardJson).slice(0, 800)
      : String(npc?.description || "").slice(0, 800);
    npcs.push({ id, name, roleType: "npc", card });
  }

  console.log("[task-mode-plan] collectTaskNpcList", JSON.stringify({
    fromWorldRoles: roles.length,
    fromStateNpcs: Object.keys(stateNpcs).length,
    finalCount: npcs.length,
    names: npcs.map(n => n.name),
  }));

  return npcs;
}

/**
 * 构造 task 模式专用的 SessionNarrativePlanResult
 */
function buildTaskNarrativePlan(params: {
  state: Record<string, any>;
  role: string;
  roleType: "narrator" | "npc";
  motive: string;
  eventType: "on_orchestrated_reply" | "on_mini_game_finished";
  presetContent: string | null;
  taskMeta?: Record<string, unknown>;
}): SessionNarrativePlanResult {
  const currentEvent = (params.state.currentEvent || {}) as Record<string, any>;
  const eventIndex = Number(currentEvent.index || 0) || 1;
  return {
    role: params.role,
    roleType: params.roleType,
    motive: params.motive,
    awaitUser: false,
    nextRole: "",
    nextRoleType: "",
    memoryHints: [],
    source: "rule",
    triggerMemoryAgent: false,
    eventType: params.eventType,
    presetContent: params.presetContent,
    eventAdjustMode: "keep",
    eventIndex,
    eventKind: (String(currentEvent.kind || "scene") as any) || "scene",
    eventSummary: String(currentEvent.summary || ""),
    eventFacts: Array.isArray(currentEvent.facts) ? currentEvent.facts : [],
    eventStatus: (String(currentEvent.status || "active") as any) || "active",
    speakerMode: "fast",
    speakerRouteReason: "task-mode-plan",
    // taskMeta 不在 SessionNarrativePlanResult 类型上，但前端能从 plan.meta 读取
    ...(params.taskMeta ? { taskMeta: params.taskMeta } : {}),
  } as SessionNarrativePlanResult;
}

async function countSessionMessages(db: any, sessionId: string): Promise<number> {
  const row = await db("t_sessionMessage")
    .where({ sessionId })
    .count({ count: "*" })
    .first();
  const raw = Array.isArray(row) ? row[0]?.count : row?.count;
  const count = Number(raw || 0);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

// 正式会话并发执行"章节判定 + 候选编排"，最后只提交裁决后的 finalPlan。
async function runConcurrentSessionJudgeAndNarrative(params: {
  userId: number;
  world: any;
  chapter: any;
  state: Record<string, any>;
  recentMessages: RuntimeMessageInput[];
  latestRecentMessage: RuntimeMessageInput;
  sessionStatus: string;
  fallbackChapterId: number | null;
  traceMeta: Record<string, unknown>;
}) {
  const candidateState = cloneSessionRuntimeValue(params.state);
  const candidateRecentMessages = cloneSessionRuntimeValue(params.recentMessages);
  logSessionOrchestrationKeyNode("session_concurrent_arbiter:start", params.traceMeta, {
    recentMessageCount: params.recentMessages.length,
  });
  const candidatePlanPromise = runNarrativePlan({
    userId: params.userId,
    world: params.world,
    chapter: params.chapter,
    state: candidateState,
    recentMessages: candidateRecentMessages,
    playerMessage: "",
    maxRetries: 0,
    allowControlHints: false,
    allowStateDelta: false,
    traceMeta: {
      ...params.traceMeta,
      planMode: "candidate",
    },
  });
  const mergedOutcome = await evaluateRuntimeOutcome({
    userId: params.userId,
    chapter: params.chapter,
    state: params.state,
    messageContent: String(params.latestRecentMessage?.content || ""),
    eventType: String(params.latestRecentMessage?.eventType || "on_message"),
    meta: {},
    recentMessages: params.recentMessages,
    fallbackStatus: params.sessionStatus,
    fallbackChapterId: params.fallbackChapterId,
    applyToState: true,
    traceMeta: {
      ...params.traceMeta,
      judgeMode: "primary",
    },
  });
  logSessionOrchestrationKeyNode("session_concurrent_arbiter:judge_done", params.traceMeta, {
    outcome: mergedOutcome.outcome,
    hasPendingEndingGuide: params.state.__pendingEndingGuide === true,
  });
  const discardCandidatePlan = () => {
    void candidatePlanPromise.catch(() => null);
  };
  if (mergedOutcome.outcome !== "continue") {
    logSessionOrchestrationKeyNode("session_concurrent_arbiter:discard_candidate", params.traceMeta, {
      reason: `judge_${mergedOutcome.outcome}`,
    });
    discardCandidatePlan();
    return {
      mergedOutcome,
      plan: null as SessionNarrativePlanResult | null,
    };
  }
  if (params.state.__pendingEndingGuide === true) {
    logSessionOrchestrationKeyNode("session_concurrent_arbiter:rerun_with_guide", params.traceMeta, {
      reason: "judge_continue_requires_guide",
    });
    discardCandidatePlan();
    const finalPlan = await runNarrativePlan({
      userId: params.userId,
      world: params.world,
      chapter: params.chapter,
      state: params.state,
      recentMessages: params.recentMessages,
      playerMessage: "",
      maxRetries: 0,
      allowControlHints: false,
      allowStateDelta: false,
      traceMeta: {
        ...params.traceMeta,
        planMode: "final",
      },
    });
    return {
      mergedOutcome,
      plan: applySessionNarrativePlanToState({
        userId: params.userId,
        world: params.world,
        chapter: params.chapter,
        state: params.state,
        recentMessages: params.recentMessages,
        plan: finalPlan,
      }),
    };
  }
  try {
    const candidatePlan = await candidatePlanPromise;

    // ★ 防"事件鬼打墙"：candidate 是基于旧 state 跑的，如果它的 eventIndex 比当前 state 已推进的事件还旧，
    //   直接丢弃 candidate 重新跑 final，避免把 chapterProgress 倒退到旧事件。
    const currentProgress = readChapterProgressState(params.state);
    const candidateEventIndex = Number.isFinite(Number((candidatePlan as any)?.eventIndex))
      ? Math.max(0, Number((candidatePlan as any).eventIndex))
      : 0;
    if (candidateEventIndex > 0 && candidateEventIndex < currentProgress.eventIndex) {
      logSessionOrchestrationKeyNode("session_concurrent_arbiter:discard_stale_candidate", params.traceMeta, {
        candidateEventIndex,
        currentEventIndex: currentProgress.eventIndex,
        reason: "candidate_event_index_behind_state",
      });
      const finalPlan = await runNarrativePlan({
        userId: params.userId,
        world: params.world,
        chapter: params.chapter,
        state: params.state,
        recentMessages: params.recentMessages,
        playerMessage: "",
        maxRetries: 0,
        allowControlHints: false,
        allowStateDelta: false,
        traceMeta: {
          ...params.traceMeta,
          planMode: "rerun_after_stale_candidate",
        },
      });
      return {
        mergedOutcome,
        plan: applySessionNarrativePlanToState({
          userId: params.userId,
          world: params.world,
          chapter: params.chapter,
          state: params.state,
          recentMessages: params.recentMessages,
          plan: finalPlan,
        }),
      };
    }

    logSessionOrchestrationKeyNode("session_concurrent_arbiter:reuse_candidate", params.traceMeta, {
      role: String(candidatePlan.role || ""),
      awaitUser: Boolean(candidatePlan.awaitUser),
    });
    return {
      mergedOutcome,
      plan: applySessionNarrativePlanToState({
        userId: params.userId,
        world: params.world,
        chapter: params.chapter,
        state: params.state,
        recentMessages: params.recentMessages,
        plan: candidatePlan,
      }),
    };
  } catch (err) {
    logSessionOrchestrationKeyNode("session_concurrent_arbiter:candidate_failed", params.traceMeta, {
      reason: String((err as any)?.message || "candidate_failed"),
    });
    const finalPlan = await runNarrativePlan({
      userId: params.userId,
      world: params.world,
      chapter: params.chapter,
      state: params.state,
      recentMessages: params.recentMessages,
      playerMessage: "",
      maxRetries: 0,
      allowControlHints: false,
      allowStateDelta: false,
      traceMeta: {
        ...params.traceMeta,
        planMode: "fallback_final",
      },
    });
    return {
      mergedOutcome,
      plan: applySessionNarrativePlanToState({
        userId: params.userId,
        world: params.world,
        chapter: params.chapter,
        state: params.state,
        recentMessages: params.recentMessages,
        plan: finalPlan,
      }),
    };
  }
}

async function insertSessionNarrativeMessages(params: {
  db: any;
  sessionId: string;
  state: Record<string, any>;
  messages: RuntimeMessageInput[];
  now: number;
  eventTypeFallback?: string;
}): Promise<Record<string, any>[]> {
  const insertedRows: Record<string, any>[] = [];
  if (!params.messages.length) return insertedRows;
  let lineIndex = await countSessionMessages(params.db, params.sessionId);
  for (const item of params.messages) {
    lineIndex += 1;
    // 构建 meta 数据，包含事件/阶段标记和角色发言计数
    const chapterProgress = readChapterProgressState(params.state);
    const metaBase = buildSessionRuntimeMeta(params.state, lineIndex);
    if (DebugLogUtil.isDebugLogEnabled()) {
       console.log("[story:event_progress:runtime][stage][insertSessionNarrativeMessages]", JSON.stringify({
            role: String(item.role || ""),
            // 事件/阶段标记，帮助AI判断台词归属
            eventIndex: item.eventIndex ?? chapterProgress.eventIndex ?? null,
            stageIndex: item.stageIndex ?? chapterProgress.stageIndex ?? 0,
            // 角色当前事件/阶段的发言计数
            numSpeechCurrEvent: item.roleNumSpeechCurrEvent ?? 0,
            numSpeechCurrStage: item.roleNumSpeechCurrStage ?? 0,
          }
      ));
    }
    const meta = {
      ...metaBase,
      // 事件/阶段标记
      eventIndex: item.eventIndex ?? chapterProgress.eventIndex ?? null,
      stageIndex: item.stageIndex ?? chapterProgress.stageIndex ?? 0,
      phaseId: item.phaseId ?? chapterProgress.phaseId ?? null,
      // 角色发言计数
      roleData: {
        numSpeechCurrEvent: item.roleNumSpeechCurrEvent ?? 0,
        numSpeechCurrStage: item.roleNumSpeechCurrStage ?? 0,
      },
    };
    const inserted = await params.db("t_sessionMessage").insert({
      sessionId: params.sessionId,
      role: String(item.role || params.state.narrator?.name || "旁白"),
      roleType: String(item.roleType || "narrator"),
      content: String(item.content || ""),
      eventType: String(item.eventType || params.eventTypeFallback || "on_orchestrated_reply"),
      meta: toJsonText(meta, {}),
      createTime: Number(item.createTime || params.now),
    });
    const insertedId = normalizeMessageId(inserted);
    const row = await params.db("t_sessionMessage").where({ id: insertedId }).first();
    const normalizedRow = row ? normalizeMessageOutput(row) : null;
    if (normalizedRow) {
      insertedRows.push(normalizedRow);
    }
  }
  return insertedRows;
}

async function resolveNextChapterIdByOrder(db: any, worldId: number, chapterId: number | null): Promise<number | null> {
  const currentChapterId = Number(chapterId || 0);
  if (!Number.isFinite(currentChapterId) || currentChapterId <= 0) return null;
  const chapters = await db("t_storyChapter")
    .where({ worldId })
    .orderBy("sort", "asc")
    .orderBy("id", "asc");
  const currentIndex = chapters.findIndex((item: any) => Number(item.id || 0) === currentChapterId);
  const next = currentIndex >= 0 ? chapters[currentIndex + 1] : null;
  const nextId = Number(next?.id || 0);
  return Number.isFinite(nextId) && nextId > 0 ? nextId : null;
}

function scheduleSessionMemoryRefresh(params: {
  sessionId: string;
  userId: number;
  world: any;
  chapter: any;
  state: Record<string, any>;
  recentMessages: RuntimeMessageInput[];
  lastMessageId: number;
}) {
  triggerStoryMemoryRefreshInBackground({
    userId: params.userId,
    world: params.world,
    chapter: params.chapter,
    state: params.state,
    recentMessages: params.recentMessages,
    onResolved: async (memory) => {
      const row = await getGameDb()("t_gameSession").where({ sessionId: params.sessionId }).first();
      if (!row) return;
      const latestState = parseJsonSafe<Record<string, any>>(row.stateJson, {});
      applyMemoryResultToState(latestState, memory);
      const currentEventDigest = readStableMemoryEventDigest(latestState);
      upsertRuntimeEventDigestState(latestState, {
        eventIndex: currentEventDigest.eventIndex,
        memorySummary: String(memory.summary || "").trim(),
        memoryFacts: Array.isArray(memory.facts)
          ? memory.facts.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8)
          : [],
        updateTime: nowTs(),
        summarySource: currentEventDigest.summarySource === "ai"
          ? "ai"
          : "memory",
      });
      setMemoryCursor(latestState, params.lastMessageId, nowTs());
      await getGameDb()("t_gameSession").where({ sessionId: params.sessionId }).update({
        stateJson: toJsonText(latestState, {}),
        updateTime: nowTs(),
      });
    },
  });
}

// 后台补扫参数卡，只在缺卡时才会真正生成，不阻塞用户发送主流程。
function scheduleSessionRoleParameterCardRefresh(params: {
  userId: number;
  world: any;
}) {
  void (async () => {
    const ownerUserId = Number(params.world?.ownerUserId || 0);
    await ensureWorldRolesWithAiParameterCards({
      userId: ownerUserId > 0 ? ownerUserId : params.userId,
      world: params.world,
      persist: ownerUserId > 0 && ownerUserId === params.userId,
    });
  })().catch((err) => {
    console.warn("[session:role-card] refresh skipped", {
      userId: params.userId,
      worldId: Number(params.world?.id || 0),
      message: (err as any)?.message || String(err),
    });
  });
}

// 用户发言主链路只读取已保存的世界设定，避免每次发言都触发角色补卡模型。
async function loadSessionWorld(db: any, worldId: number) {
  let world = await db("t_storyWorld as w")
    .leftJoin("t_project as p", "w.projectId", "p.id")
    .where("w.id", worldId)
    .select("w.*", "p.userId as ownerUserId")
    .first();
  if (!world) return null;
  return world;
}

export async function addSessionMessage(input: AddSessionMessageInput): Promise<AddSessionMessageResult> {
  let narrativeMessageRow: any = null;  // 移到函数开头，避免 used before declaration
  const narrativeMessageRows: any[] = [];  // 移到函数开头
  const db = getGameDb();
  const now = nowTs();
  const sessionId = String(input.sessionId || "").trim();
  if (!sessionId) {
    throw new SessionServiceError(400, "sessionId 不能为空");
  }
  if (!DebugLogUtil.isDebugLogEnabled()) {
    console.log(`[story:streamlines:stats] sesionid=${sessionId}`);
  }
  const sessionRow = await db("t_gameSession").where({ sessionId }).first();
  if (!sessionRow) {
    throw new SessionServiceError(404, "会话不存在");
  }
  const currentUserId = getCurrentUserId(0);
  if (currentUserId > 0 && Number(sessionRow.userId || 0) !== currentUserId) {
    throw new SessionServiceError(403, "无权访问该会话");
  }

  const world = await loadSessionWorld(db, Number(sessionRow.worldId || 0));
  const rolePair = normalizeRolePair(world?.playerRole, world?.narratorRole);
  const prevChapterId = Number(sessionRow.chapterId || 0) || null;
  const prevStatus = String(sessionRow.status || "active");

  const state = normalizeSessionState(
    sessionRow.stateJson,
    Number(sessionRow.worldId || 0),
    prevChapterId,
    rolePair,
    world,
  );
  // ★ 回溯支持：在 state 任何修改之前先快照一份 preMessageState
  // 用户消息的 revisitData 用这份"消息发送前"的 state，
  // 这样回溯到用户消息时可以重新走一遍 handleMiniGameTurn / orchestration 流程
  // 而不是停留在已处理完的 state（旁白丢失）。
  const preMessageStateJson = toJsonText(state, {});
  state.round = Number(state.round || 0) + 1;

  // 诊断：addMessage 入口时检查 state 中的任务字段
  {
    const card = (state.player?.parameterCardJson || {}) as Record<string, any>;
    const miniGameSession = (state.miniGame as any)?.session;
    console.log("[story:mini_game:task] addMessage 入口 state", {
      sessionId,
      activeTaskId: card.activeTaskId || null,
      taskListLength: Array.isArray(card.taskList) ? card.taskList.length : 0,
      executingTaskTitle: card.executing_task ? (card.executing_task as any).title : null,
      miniGameSessionStatus: miniGameSession?.status || null,
      miniGameGameType: miniGameSession?.game_type || null,
      stateJsonHasActiveTaskId: typeof sessionRow.stateJson === "string" ? sessionRow.stateJson.includes("\"activeTaskId\"") : null,
    });
  }

  const roleTypeValue = String(input.roleType || "player").trim() || "player";
  const eventTypeValue = String(input.eventType || "on_message").trim() || "on_message";
  const messageContent = String(input.content || "");
  const metaObj = parseJsonMaybe(input.meta);
  if (roleTypeValue === "player" && eventTypeValue === "on_message" && messageContent.trim()) {
    applyPlayerProfileFromMessageToState(state, world, messageContent);
  }
  const roleValue = String(input.role || resolveDefaultRoleName(roleTypeValue, state)).trim() || "系统";

  const insertedMessage = await db("t_sessionMessage").insert({
    sessionId,
    role: roleValue,
    roleType: roleTypeValue,
    content: messageContent,
    eventType: eventTypeValue,
    meta: toJsonText(metaObj, {}),
    createTime: now,
  });
  const messageId = normalizeMessageId(insertedMessage);

  const attrChangeList = Array.isArray(input.attrChanges) ? input.attrChanges : [];
  const attrDeltas = applyAttributeChanges(state, attrChangeList);

  const currentChapter = prevChapterId
    ? normalizeChapterOutput(await db("t_storyChapter").where({ id: prevChapterId }).first())
    : null;
  if (currentChapter) {
    initializeChapterProgressForState(currentChapter, state);
    syncChapterProgressWithRuntime(currentChapter, state);
  }
  let asyncMemoryRefreshRequested = false;
  let asyncMemoryRefreshChapter: any = null;

  pushRecentEvent(state, {
    messageId,
    eventType: eventTypeValue,
    roleType: roleTypeValue,
    contentPreview: messageContent.slice(0, 120),
    time: now,
  });

  // 显式 @记忆管理 指令要在正式会话里同步写回用户参数卡，
  // 不能只停留在记忆摘要层，否则用户详情面板看不到新增物品/装备/技能。
  if (roleTypeValue === "player" && eventTypeValue === "on_message" && messageContent.trim()) {
    applyExplicitMemoryDirectiveToPlayerCard(state, messageContent);
  }

  if (roleTypeValue === "player" && eventTypeValue === "on_message" && messageContent.trim()) {
    const rawRecentMessages = await db("t_sessionMessage").where({ sessionId }).orderBy("id", "desc").limit(20);
    const recentMessages = buildRecentMessages(rawRecentMessages, state);
    const miniGameResult = await handleMiniGameTurn({
      userId: currentUserId,
      world,
      chapter: currentChapter || { id: prevChapterId || state.chapterId || 0, title: "当前章节" },
      state,
      recentMessages,
      playerMessage: messageContent,
      mode: "session",
    });

    if (miniGameResult?.intercepted) {
      const pendingPlan = miniGameResult.pendingNarrativePlan;
      // 小游戏退出/中止时，必须清除可能残留的 pendingNarrativePlan，
      // 否则后续编排会被过期的 plan 挡住，导致"自动推进没有产出新内容"的死循环。
      // 参见 h1.md 分析。
      const miniGameEventType = String(miniGameResult.message?.eventType || "");
      const isMiniGameEnded = miniGameEventType === "on_mini_game_abort"
        || miniGameEventType === "on_mini_game_finish"
        || !isMiniGameActiveState(state);

      // 输出小游戏拦截日志
      if (DebugLogUtil.isDebugLogEnabled()) {
        console.log("[story:mini_game:agent] 小游戏拦截", JSON.stringify({
          sessionId,
          intercepted: true,
          hasPendingPlan: !!pendingPlan,
          eventType: miniGameEventType,
          isMiniGameEnded: Boolean(isMiniGameEnded),
          gameType: pendingPlan?.source === "rule" ? "小游戏编排" : (((state?.miniGame as Record<string, any>)?.rulebook as Record<string, any>)?.gameType || "未知"),
          motive: String(pendingPlan?.motive || miniGameResult.message?.content || "").trim().slice(0, 100),
        }));
      }

      if (isMiniGameEnded) {
          if (DebugLogUtil.isDebugLogEnabled()) {
              console.log("[story:mini_game:agent] 退出状态",isMiniGameEnded);
          }
        // 小游戏已结束，清除残留的 pendingNarrativePlan 和 heldNarrativePlan
        if (getPendingSessionNarrativePlan(state)) {
          setPendingSessionNarrativePlan(state, null);
        }
        if (state.heldNarrativePlan) {
          delete state.heldNarrativePlan;
        }
      }
      if (pendingPlan) {
        // 有编排计划：只写入 session.pendingNarrativePlan，由后续 orchestration/streamlines 消费。
        // 这里不能提前把输入权交还用户，否则前端会误以为小游戏回合已经结束。
        setPendingSessionNarrativePlan(state, pendingPlan as any);
        applyPlanTurnStateToSessionState(state, world, pendingPlan as any);
        // 记录小游戏回合日志
        const orchestration: MiniGameOrchestrationResult = {
          intercepted: true,
          eventType: pendingPlan.eventType || "on_mini_game",
          narration: pendingPlan.presetContent || pendingPlan.motive || "",
          isStart: pendingPlan.eventType === "on_mini_game_start",
          isEnd: pendingPlan.eventType === "on_mini_game_abort" || pendingPlan.eventType === "on_mini_game_finish",
          awaitUser: pendingPlan.awaitUser ?? true,
          nextPhase: null,
        };
        const miniGameStateInfo = miniGameStateManager.getMiniGameStateInfo(state);
        const turnType = miniGameStateManager.detectTurnType(state, messageContent, orchestration);
        miniGameStateManager.logMiniGameTurn(turnType, {
          gameType: miniGameStateInfo.gameType,
          displayName: miniGameStateInfo.displayName,
          phase: miniGameStateInfo.phase,
          userInput: messageContent,
          eventType: orchestration.eventType,
        });
        // 小游戏走编排通道时，也要将 messages（含陪练发言）插入数据库，确保陪练台词落库。
        // 这些 messages 已经在 handleMiniGameTurn 中由 resolveMiniGameStepMessages 生成。
        const miniGameMessages = miniGameResult.messages && miniGameResult.messages.length
          ? miniGameResult.messages
          : miniGameResult.message
            ? [miniGameResult.message]
            : [];
        for (const item of miniGameMessages) {
          const inserted = await db("t_sessionMessage").insert({
            sessionId,
            role: String(item.role || state.narrator?.name || "旁白"),
            roleType: String(item.roleType || "narrator"),
            content: String(item.content || ""),
            eventType: String(item.eventType || "on_mini_game"),
            meta: toJsonText(item.meta || {}, {}),
            createTime: now,
          });
          const narrativeMessageId = normalizeMessageId(inserted);
          const insertedRow = await db("t_sessionMessage").where({ id: narrativeMessageId }).first();
          if (insertedRow) {
            narrativeMessageRows.push(insertedRow);
            narrativeMessageRow = insertedRow;
          }
        }
        // 不再直接插入旁白消息，小游戏旁白由 /game/streamlines 生成
      } else {
        allowPlayerTurn(
          state,
          world,
          String(miniGameResult.message?.roleType || "narrator"),
          String(miniGameResult.message?.role || state.narrator?.name || "旁白"),
        );
        // 插入 miniGame messages
        const miniGameMessages = miniGameResult.messages && miniGameResult.messages.length
          ? miniGameResult.messages
          : miniGameResult.message
            ? [miniGameResult.message]
            : [];
        for (const item of miniGameMessages) {
          const inserted = await db("t_sessionMessage").insert({
            sessionId,
            role: String(item.role || state.narrator?.name || "旁白"),
            roleType: String(item.roleType || "narrator"),
            content: String(item.content || ""),
            eventType: String(item.eventType || "on_mini_game"),
            meta: toJsonText(item.meta || {}, {}),
            createTime: now,
          });
          const narrativeMessageId = normalizeMessageId(inserted);
          const insertedRow = await db("t_sessionMessage").where({ id: narrativeMessageId }).first();
          if (insertedRow) {
            narrativeMessageRows.push(insertedRow);
            narrativeMessageRow = insertedRow;
          }
        }
      }
      if (attrDeltas.length > 0) {
        const deltaRows = attrDeltas.map((delta) => ({
          sessionId,
          eventId: `message:${messageId}`,
          entityType: delta.entityType,
          entityId: delta.entityId,
          field: delta.field,
          oldValue: toJsonText(delta.oldValue, null),
          newValue: toJsonText(delta.newValue, null),
          source: delta.source,
          createTime: now,
        }));
        await db("t_entityStateDelta").insert(deltaRows);
      }

	      if (currentChapter) {
	        syncChapterProgressWithRuntime(currentChapter, state);
	      }
	      const stateJson = toJsonText(state, {});
      if (DebugLogUtil.isDebugLogEnabled()) {
        const inv = (state as any)?.inventory;
        console.log("[SessionService] 保存前 state.inventory:", JSON.stringify(inv));
      }
	      await db("t_gameSession").where({ sessionId }).update({
        stateJson,
        chapterId: prevChapterId,
        status: prevStatus,
        updateTime: now,
      });
      // 任务/小游戏 拦截路径下的状态校验
      const cardAfterSave = (state.player?.parameterCardJson || {}) as Record<string, any>;
      const taskListLen = Array.isArray(cardAfterSave.taskList) ? cardAfterSave.taskList.length : 0;
      console.log("[story:mini_game:task] handleMiniGameTurn 拦截路径 state 已保存", {
        sessionId,
        activeTaskId: cardAfterSave.activeTaskId || null,
        taskListLength: taskListLen,
        executingTaskTitle: cardAfterSave.executing_task ? (cardAfterSave.executing_task as any).title : null,
        miniGameSessionStatus: ((state.miniGame as any)?.session?.status) || null,
        miniGameGameType: ((state.miniGame as any)?.session?.game_type) || null,
      });

      const snapshotResult = await persistSnapshotIfNeeded({
        db,
        sessionId,
        stateJson,
        round: Number(state.round || 0),
        now,
        policy: {
          saveSnapshot: input.saveSnapshot,
          nextChapterId: prevChapterId,
          prevChapterId,
          sessionStatus: prevStatus,
          prevStatus,
          round: Number(state.round || 0),
        },
      });

      const messageRow = await db("t_sessionMessage").where({ id: messageId }).first();
      // ★ 用户消息的 revisitData 存"消息发送前"的 state（preMessageState）
      // 这样回溯后还能重新触发 handleMiniGameTurn（再次创建任务、推进剧情等）
      const preMessageState = parseJsonSafe<Record<string, any>>(preMessageStateJson, {});
      await persistSessionMessageRevisitData({
        db,
        rows: [messageRow],
        state: preMessageState,
        chapterId: prevChapterId,
        status: prevStatus,
        capturedAt: now,
        sessionId,
      });
      // ★ 旁白/小游戏消息的 revisitData 存"消息发送后"的最终 state
      if (narrativeMessageRow) {
        await persistSessionMessageRevisitData({
          db,
          rows: [narrativeMessageRow],
          state,
          chapterId: prevChapterId,
          status: prevStatus,
          capturedAt: now,
          sessionId,
        });
      }
      const eventView = buildEventView(state);
      // 如果有编排计划（小游戏或普通编排），返回它
      const returnedPlan = state.pendingNarrativePlan
        ? buildSessionPlanResult(state.pendingNarrativePlan)
        : miniGameResult?.pendingNarrativePlan
          ? buildSessionPlanResult(miniGameResult.pendingNarrativePlan as any)
          : null;
      return {
        sessionId,
        status: prevStatus,
        chapterId: prevChapterId,
        chapter: currentChapter || null,
        state,
        currentEventDigest: eventView.currentEventDigest,
        eventDigestWindow: eventView.eventDigestWindow,
        eventDigestWindowText: eventView.eventDigestWindowText,
        message: normalizeMessageOutput(messageRow),
        chapterSwitchMessage: null,
        narrativeMessage: narrativeMessageRow ? normalizeMessageOutput(narrativeMessageRow) : null,
        generatedMessages: narrativeMessageRows
          .map((row) => normalizeMessageOutput(row))
          .filter(Boolean) as Record<string, any>[],
        narrativePlan: returnedPlan,
        triggered: [],
        taskProgress: [],
        deltas: attrDeltas,
        snapshotSaved: snapshotResult.snapshotSaved,
        snapshotReason: snapshotResult.snapshotReason,
      };
    }
  }

  const triggerResult = await runTriggerEngine({
    db,
    chapterId: prevChapterId,
    state,
    messageContent,
    eventType: eventTypeValue,
    meta: metaObj,
    initialStatus: prevStatus,
  });

  const taskResult = await runTaskProgressEngine({
    db,
    chapterId: triggerResult.nextChapterId,
    state,
    messageContent,
    eventType: eventTypeValue,
    meta: metaObj,
    now,
    nextChapterId: triggerResult.nextChapterId,
    currentStatus: triggerResult.sessionStatus,
  });

  const appliedDeltas: AppliedDelta[] = [
    ...attrDeltas,
    ...triggerResult.appliedDeltas,
    ...taskResult.appliedDeltas,
  ];
  const triggered: TriggerHit[] = [
    ...triggerResult.triggerHits,
    ...(taskResult.triggerHit ? [taskResult.triggerHit] : []),
  ];
  let nextChapterId = taskResult.nextChapterId;
  let sessionStatus = taskResult.sessionStatus;
  if (currentChapter) {
    if (roleTypeValue === "player" && eventTypeValue === "on_message" && messageContent.trim()) {
      const rawRecentMessagesForProgress = await db("t_sessionMessage").where({ sessionId }).orderBy("id", "desc").limit(20);
      const recentMessagesForProgress = buildRecentMessages(rawRecentMessagesForProgress, state);
      await applySessionUserEventProgress({
        userId: currentUserId,
        chapter: currentChapter,
        state,
        messageId,
        messageContent,
        eventType: eventTypeValue,
        triggered,
        taskProgress: taskResult.taskProgressChanges,
        deltas: appliedDeltas,
        recentMessages: recentMessagesForProgress,
        traceMeta: {
          route: "/game/addMessage",
          sessionId,
          chapterId: Number(currentChapter.id || 0),
          userId: currentUserId,
        },
      });
      /**
       * ★ 旧的"自由章节任务结算"链路（resolveFreeChapterTask）已被禁用。
       *
       * 现在任务的完成/放弃/继续判定全部走新的 task-mode-plan 链路：
       *   addMessage → /orchestration/minigame → tryBuildTaskModePlan
       *     → Intent → Progress → TaskCompletionAgent (decision: success/failed/continue)
       *     → finalizeTaskMiniGame
       *
       * 这样 [story:mini_game:task:completion:runtime/stats] 才会真正出现在日志里。
       * 不再在 addMessage 阶段直接 return on_task_resolution。
       */
      const resolvedFreeChapterTask: { narration: string } | null = null;
      if (resolvedFreeChapterTask) {
        setRuntimeTurnState(state, world, {
          canPlayerSpeak: true,
          expectedRoleType: "player",
          expectedRole: String(state.player?.name || "用户"),
          lastSpeakerRoleType: "narrator",
          lastSpeaker: String(state.narrator?.name || "旁白"),
        });
        syncChapterProgressWithRuntime(currentChapter, state);
        const taskNarrativeRows = await insertSessionNarrativeMessages({
          db,
          sessionId,
          state,
          messages: [{
            role: String(state.narrator?.name || "旁白"),
            roleType: "narrator",
            eventType: "on_task_resolution",
            content: resolvedFreeChapterTask.narration,
            createTime: now,
          }],
          now,
          eventTypeFallback: "on_task_resolution",
        });
        const latestRecentRows = await db("t_sessionMessage").where({ sessionId }).orderBy("id", "desc").limit(20);
        const latestRecentMessages = buildRecentMessages(latestRecentRows, state);
        await refreshStoryMemoryBestEffort({
          userId: currentUserId,
          world,
          chapter: currentChapter,
          state,
          recentMessages: latestRecentMessages,
        });
        const lastNarrativeMessageId = Number(taskNarrativeRows[taskNarrativeRows.length - 1]?.id || messageId || 0);
        setMemoryCursor(state, lastNarrativeMessageId, nowTs());
        const stateJson = toJsonText(state, {});
        await db("t_gameSession").where({ sessionId }).update({
          stateJson,
          chapterId: state.chapterId || prevChapterId,
          status: sessionStatus,
          updateTime: now,
        });
        const snapshotResult = await persistSnapshotIfNeeded({
          db,
          sessionId,
          stateJson,
          round: Number(state.round || 0),
          now,
          policy: {
            saveSnapshot: input.saveSnapshot,
            nextChapterId: state.chapterId || prevChapterId,
            prevChapterId,
            sessionStatus,
            prevStatus,
            round: Number(state.round || 0),
          },
        });
        scheduleSessionRoleParameterCardRefresh({
          userId: currentUserId,
          world,
        });
        const messageRow = await db("t_sessionMessage").where({ id: messageId }).first();
        const narrativeRow = taskNarrativeRows[taskNarrativeRows.length - 1]
          ? await db("t_sessionMessage").where({ id: Number(taskNarrativeRows[taskNarrativeRows.length - 1].id || 0) }).first()
          : null;
        // ★ 用户消息存"发送前" state，旁白消息存"最终" state
        const preMessageState = parseJsonSafe<Record<string, any>>(preMessageStateJson, {});
        await persistSessionMessageRevisitData({
          db,
          rows: [messageRow],
          state: preMessageState,
          chapterId: prevChapterId,
          status: prevStatus,
          capturedAt: now,
          sessionId,
        });
        if (narrativeRow) {
          await persistSessionMessageRevisitData({
            db,
            rows: [narrativeRow],
            state,
            chapterId: state.chapterId || prevChapterId,
            status: sessionStatus,
            capturedAt: now,
            sessionId,
          });
        }
        const activeChapterId = Number(state.chapterId || prevChapterId || 0) || null;
        const activeChapter = activeChapterId
          ? normalizeChapterOutput(await db("t_storyChapter").where({ id: activeChapterId }).first())
          : null;
        const eventView = buildEventView(state);
        return {
          sessionId,
          status: sessionStatus,
          chapterId: activeChapterId,
          chapter: activeChapter,
          state,
          currentEventDigest: eventView.currentEventDigest,
          eventDigestWindow: eventView.eventDigestWindow,
          eventDigestWindowText: eventView.eventDigestWindowText,
          message: normalizeMessageOutput(messageRow),
          chapterSwitchMessage: null,
          narrativeMessage: narrativeRow ? normalizeMessageOutput(narrativeRow) : null,
          generatedMessages: taskNarrativeRows,
          narrativePlan: null,
          triggered,
          taskProgress: taskResult.taskProgressChanges,
          deltas: appliedDeltas,
          snapshotSaved: snapshotResult.snapshotSaved,
          snapshotReason: snapshotResult.snapshotReason,
        };
      }
      /**
       * 自由章节里"领取推荐任务"不是普通的一句用户输入，而是要正式切入一个动态任务事件。
       *
       * 这里放在事件进度检测之后执行，原因是：
       * 1. 先保留静态引导事件的正常完成判定；
       * 2. 再把"用户选中了哪一个任务"升级成新的动态事件；
       * 3. 新事件创建后立刻把回合交给旁白，让旁白继续描述任务开场，而不是继续等待用户输入。
       */
      const activatedFreeChapterTask = await maybeActivateFreeChapterTaskEvent({
        userId: currentUserId,
        world,
        chapter: currentChapter,
        state,
        recentMessages: recentMessagesForProgress,
        playerMessage: messageContent,
      });
      if (activatedFreeChapterTask) {
        // 任务领取成功后，应由旁白先补充任务过程、成功条件与失败条件。
        setRuntimeTurnState(state, world, {
          canPlayerSpeak: false,
          expectedRoleType: "narrator",
          expectedRole: String(state.narrator?.name || "旁白"),
          lastSpeakerRoleType: "player",
          lastSpeaker: roleValue,
        });
        /**
         * 任务接取后立即刷新一次记忆。
         *
         * 用途：
         * - 让"正在执行的任务"立刻写入记忆摘要/事实和用户参数卡相关上下文；
         * - 避免用户刚接任务时，记忆管理还停留在接任务前的状态。
         */
        await refreshStoryMemoryBestEffort({
          userId: currentUserId,
          world,
          chapter: currentChapter,
          state,
          recentMessages: recentMessagesForProgress,
        });
        setMemoryCursor(state, messageId, nowTs());
        syncChapterProgressWithRuntime(currentChapter, state);
      }
    } else {
      recordChapterProgressSignals(currentChapter, state, {
        messageContent,
        triggered,
        taskProgress: taskResult.taskProgressChanges,
        deltas: appliedDeltas,
      });
      syncChapterProgressWithRuntime(currentChapter, state);
    }
  }
  if (currentChapter) {
    const recentMessagesForOutcome = roleTypeValue === "player" && eventTypeValue === "on_message"
      ? buildRecentMessages(await db("t_sessionMessage").where({ sessionId }).orderBy("id", "desc").limit(20), state)
      : [];
    const mergedOutcome = await evaluateRuntimeOutcome({
      chapter: currentChapter,
      state,
      messageContent,
      eventType: eventTypeValue,
      meta: metaObj,
      recentMessages: recentMessagesForOutcome,
      fallbackStatus: sessionStatus,
      fallbackChapterId: nextChapterId || prevChapterId,
      applyToState: true,
    });
    sessionStatus = mergedOutcome.sessionStatus;
    nextChapterId = mergedOutcome.nextChapterId;
  }
  if (sessionStatus === "chapter_completed" && (!nextChapterId || nextChapterId === prevChapterId)) {
    const resolvedNextChapterId = await resolveNextChapterIdByOrder(db, Number(sessionRow.worldId || 0), prevChapterId);
    if (resolvedNextChapterId && resolvedNextChapterId !== prevChapterId) {
      nextChapterId = resolvedNextChapterId;
      sessionStatus = "active";
    }
  }
  const hasPendingNextChapter = Boolean(nextChapterId && nextChapterId !== prevChapterId);
  if (hasPendingNextChapter) {
    setPendingSessionChapterId(state, nextChapterId);
    setPendingSessionChapterStart(state, false);
    state.chapterId = prevChapterId;
  } else {
    setPendingSessionChapterId(state, null);
    setPendingSessionChapterStart(state, false);
    state.chapterId = nextChapterId;
  }

  if (appliedDeltas.length > 0) {
    const deltaRows = appliedDeltas.map((delta) => ({
      sessionId,
      eventId: `message:${messageId}`,
      entityType: delta.entityType,
      entityId: delta.entityId,
      field: delta.field,
      oldValue: toJsonText(delta.oldValue, null),
      newValue: toJsonText(delta.newValue, null),
      source: delta.source,
      createTime: now,
    }));
    await db("t_entityStateDelta").insert(deltaRows);
  }

  if (input.orchestrate === false) {
    if (roleTypeValue === "player" && eventTypeValue === "on_message" && messageContent.trim()) {
      setRuntimeTurnState(state, world, {
        canPlayerSpeak: false,
        expectedRoleType: "narrator",
        expectedRole: String(state.narrator?.name || "旁白"),
        lastSpeakerRoleType: "player",
        lastSpeaker: roleValue,
      });
      if (currentChapter) {
        syncChapterProgressWithRuntime(currentChapter, state);
      }
    }
    const stateJson = toJsonText(state, {});
    await db("t_gameSession").where({ sessionId }).update({
      stateJson,
      chapterId: state.chapterId || prevChapterId,
      status: sessionStatus,
      updateTime: now,
    });
    const snapshotResult = await persistSnapshotIfNeeded({
      db,
      sessionId,
      stateJson,
      round: Number(state.round || 0),
      now,
      policy: {
        saveSnapshot: input.saveSnapshot,
        nextChapterId: state.chapterId || prevChapterId,
        prevChapterId,
        sessionStatus,
        prevStatus,
        round: Number(state.round || 0),
      },
    });
    scheduleSessionRoleParameterCardRefresh({
      userId: currentUserId,
      world,
    });
    const messageRow = await db("t_sessionMessage").where({ id: messageId }).first();
    // ★ 用户消息存"发送前" state，回溯后能重新触发后续编排
    const preMessageState = parseJsonSafe<Record<string, any>>(preMessageStateJson, {});
    await persistSessionMessageRevisitData({
      db,
      rows: [messageRow],
      state: preMessageState,
      chapterId: prevChapterId,
      status: prevStatus,
      capturedAt: now,
      sessionId,
    });
    const activeChapterId = Number(state.chapterId || prevChapterId || 0) || null;
    const activeChapter = activeChapterId
      ? normalizeChapterOutput(await db("t_storyChapter").where({ id: activeChapterId }).first())
      : null;
    const eventView = buildEventView(state);
    return {
      sessionId,
      status: sessionStatus,
      chapterId: activeChapterId,
      chapter: activeChapter,
      state,
      currentEventDigest: eventView.currentEventDigest,
      eventDigestWindow: eventView.eventDigestWindow,
      eventDigestWindowText: eventView.eventDigestWindowText,
      message: normalizeMessageOutput(messageRow),
      chapterSwitchMessage: null,
      narrativeMessage: null,
      generatedMessages: [],
      narrativePlan: null,
      triggered,
      taskProgress: taskResult.taskProgressChanges,
      deltas: appliedDeltas,
      snapshotSaved: snapshotResult.snapshotSaved,
      snapshotReason: snapshotResult.snapshotReason,
    };
  }

  let chapterSwitchMessageRow: any = null;
  let generatedMessages: Record<string, any>[] = [];
  let narrativePlan: any | null = null;
  if (!(nextChapterId && nextChapterId !== prevChapterId) && roleTypeValue === "player" && eventTypeValue === "on_message" && messageContent.trim()) {
    const playChapter = nextChapterId
      ? normalizeChapterOutput(await db("t_storyChapter").where({ id: nextChapterId }).first())
      : null;
    if (playChapter) {
      const rawRecentMessages = await db("t_sessionMessage").where({ sessionId }).orderBy("id", "desc").limit(20);
      const recentMessages = buildRecentMessages(rawRecentMessages, state);
      const orchestrator = await runNarrativeOrchestrator({
        userId: currentUserId,
        world,
        chapter: playChapter,
        state,
        recentMessages,
        playerMessage: messageContent,
        maxRetries: 0,
        allowControlHints: false,
        allowStateDelta: false,
      });
      narrativePlan = summarizeNarrativePlan(orchestrator);
      asyncMemoryRefreshRequested = Boolean(orchestrator.triggerMemoryAgent);
      asyncMemoryRefreshChapter = playChapter;
      const orchestrated = await advanceNarrativeUntilPlayerTurn({
        userId: currentUserId,
        world,
        chapter: playChapter,
        state,
        recentMessages,
        playerMessage: messageContent,
        initialResult: orchestrator,
        maxAutoTurns: 1,
      });
      applyNarrativeMemoryHintsToState(state, orchestrator.memoryHints);
      generatedMessages = await insertSessionNarrativeMessages({
        db,
        sessionId,
        state,
        messages: orchestrated.messages,
        now,
        eventTypeFallback: "on_orchestrated_reply",
      });
      narrativeMessageRow = generatedMessages[generatedMessages.length - 1] || null;
      syncChapterProgressWithRuntime(playChapter, state);

    }
  }

  const stateJson = toJsonText(state, {});
  await db("t_gameSession").where({ sessionId }).update({
    stateJson,
    chapterId: state.chapterId || prevChapterId,
    status: sessionStatus,
    updateTime: now,
  });

  const snapshotResult = await persistSnapshotIfNeeded({
    db,
    sessionId,
    stateJson,
    round: Number(state.round || 0),
    now,
    policy: {
      saveSnapshot: input.saveSnapshot,
      nextChapterId: state.chapterId || prevChapterId,
      prevChapterId,
      sessionStatus,
      prevStatus,
      round: Number(state.round || 0),
    },
  });

  if (asyncMemoryRefreshRequested && asyncMemoryRefreshChapter) {
    const recentMessagesForMemory = await loadIncrementalMessagesForMemory(db, sessionId, state);
    const lastMemoryMessageId = recentMessagesForMemory.reduce((max, item) => {
      const currentId = Number(item?.messageId || 0);
      return Number.isFinite(currentId) && currentId > max ? currentId : max;
    }, 0);
    if (recentMessagesForMemory.length) {
    scheduleSessionMemoryRefresh({
      sessionId,
      userId: currentUserId,
      world,
      chapter: asyncMemoryRefreshChapter,
      state,
      recentMessages: recentMessagesForMemory,
      lastMessageId: lastMemoryMessageId,
    });
    }
  }
  scheduleSessionRoleParameterCardRefresh({
    userId: currentUserId,
    world,
  });

  const messageRow = await db("t_sessionMessage").where({ id: messageId }).first();
  // ★ 用户消息（messageRow）存"发送前" state，回溯能重新触发后续编排
  const preMessageStateForRevisit = parseJsonSafe<Record<string, any>>(preMessageStateJson, {});
  await persistSessionMessageRevisitData({
    db,
    rows: [messageRow],
    state: preMessageStateForRevisit,
    chapterId: prevChapterId,
    status: prevStatus,
    capturedAt: now,
    sessionId,
  });
  // ★ 旁白/章节切换消息存"最终" state
  const otherRows = [chapterSwitchMessageRow, ...generatedMessages].filter(Boolean);
  if (otherRows.length) {
    await persistSessionMessageRevisitData({
      db,
      rows: otherRows,
      state,
      chapterId: state.chapterId || prevChapterId,
      status: sessionStatus,
      capturedAt: now,
      sessionId,
    });
  }
  const activeChapterId = Number(state.chapterId || prevChapterId || 0) || null;
  const activeChapter = activeChapterId
    ? normalizeChapterOutput(await db("t_storyChapter").where({ id: activeChapterId }).first())
    : null;
  const eventView = buildEventView(state);
  return {
    sessionId,
    status: sessionStatus,
    chapterId: activeChapterId,
    chapter: activeChapter,
    state,
    currentEventDigest: eventView.currentEventDigest,
    eventDigestWindow: eventView.eventDigestWindow,
    eventDigestWindowText: eventView.eventDigestWindowText,
    message: normalizeMessageOutput(messageRow),
    chapterSwitchMessage: chapterSwitchMessageRow,
    narrativeMessage: narrativeMessageRow,
    generatedMessages,
    narrativePlan,
    triggered,
    taskProgress: taskResult.taskProgressChanges,
    deltas: appliedDeltas,
    snapshotSaved: snapshotResult.snapshotSaved,
    snapshotReason: snapshotResult.snapshotReason,
  };
}

// =============================================================================
// 玩家行动提示器 (PlayTipAgent)
// =============================================================================

/**
 * 给玩家生成 3 条第一人称行动提示，每次点击 play-tip-fab 都会调一次。
 *
 * - 模型：storyOrchestratorModel（与 task speaker / director 一致）
 * - 失败兜底：返回 3 条与角色/章节相关的中性提示，永不抛错
 */
export async function generatePlayTips(sessionIdInput: string): Promise<{ tips: string[]; source: "ai" | "fallback"; latencyMs: number }> {
  const sessionId = String(sessionIdInput || "").trim();
  if (!sessionId) {
    throw new SessionServiceError(400, "sessionId 不能为空");
  }

  const db = getGameDb();
  const sessionRow = await db("t_gameSession").where({ sessionId }).first();
  if (!sessionRow) {
    throw new SessionServiceError(404, "会话不存在");
  }
  const currentUserId = getCurrentUserId(0);
  if (currentUserId > 0 && Number(sessionRow.userId || 0) !== currentUserId) {
    throw new SessionServiceError(403, "无权访问该会话");
  }

  const currentChapterId = Number(sessionRow.chapterId || 0) || null;
  const world = await loadSessionWorld(db, Number(sessionRow.worldId || 0));
  const rolePair = normalizeRolePair(world?.playerRole, world?.narratorRole);
  const state = normalizeSessionState(
    sessionRow.stateJson,
    Number(sessionRow.worldId || 0),
    currentChapterId,
    rolePair,
    world,
  );
  const chapter = currentChapterId
    ? normalizeChapterOutput(await db("t_storyChapter").where({ id: currentChapterId }).first())
    : null;

  const rawRecentMessages = await db("t_sessionMessage").where({ sessionId }).orderBy("id", "desc").limit(10);
  const recentMessages = buildRecentMessages(rawRecentMessages, state);
  const dialogueText = recentMessages
    .map(m => `${m.role || "?"}：${String((m as any).content || "").slice(0, 80)}`)
    .join("\n");

  // 当前任务（如有）
  const vars = (state.vars || {}) as Record<string, any>;
  const activeTask = vars.activeFreeTask as Record<string, any> | null;
  const taskTitle = String(activeTask?.title || "").trim();
  const taskObjective = String(activeTask?.objective || "").trim();
  const taskProcess = Array.isArray(activeTask?.process)
    ? (activeTask?.process as string[]).join("；")
    : String(activeTask?.process || "").trim();

  // NPC 卡 / 全局背景
  const npcList = collectTaskNpcList(world, state);
  const npcCards = npcList.length
    ? npcList.map(n => `- ${n.name}（${n.roleType || "npc"}）：${n.card || ""}`).join("\n")
    : "（无可用 NPC）";

  // 全局背景：优先 globalBackground，回退 intro / background
  // world 直接从数据库加载（loadSessionWorld），settings 可能是字符串或对象
  const w = (world || {}) as Record<string, any>;
  const wSettings = typeof w.settings === "string" ? parseJsonSafe(w.settings, {}) : (w.settings || {});
  const globalBackground = String(
    wSettings.globalBackground || w.globalBackground || w.intro || w.background || ""
  ).trim();

  // 玩家身份卡
  const player = (state.player || {}) as Record<string, any>;
  const playerCard = player.parameterCardJson
    ? JSON.stringify(player.parameterCardJson).slice(0, 800)
    : `${String(player.name || "用户")}（${String(player.description || "").slice(0, 200)}）`;
  const playerHandle = `@${String(player.name || "故事角色")}`;

  const { generatePlayerTips } = await import("@/modules/game-runtime/agents/playTip/PlayTipAgent");
  // 动态背景：直接从 state.memorySummary 读取（与 buildDynamicWorldBackground 同源）
  const dynamicGlobalBackground = String(state.memorySummary || "").trim() || undefined;
  const result = await generatePlayerTips({
    userId: currentUserId,
    worldName: String(w.name || "未命名世界"),
    chapterTitle: String(chapter?.title || state.chapterTitle || "未命名章节"),
    globalBackground,
    dynamicGlobalBackground,
    taskTitle: taskTitle || undefined,
    taskObjective: taskObjective || undefined,
    taskProcess: taskProcess || undefined,
    npcCards,
    recentDialogue: dialogueText,
    playerCard,
    playerHandle,
  });

  return result;
}

export async function continueSessionNarrative(sessionIdInput: string): Promise<ContinueSessionNarrativeResult> {
  const db = getGameDb();
  const now = nowTs();
  const sessionId = String(sessionIdInput || "").trim();
  if (!sessionId) {
    throw new SessionServiceError(400, "sessionId 不能为空");
  }

  const sessionRow = await db("t_gameSession").where({ sessionId }).first();
  if (!sessionRow) {
    throw new SessionServiceError(404, "会话不存在");
  }
  const currentUserId = getCurrentUserId(0);
  if (currentUserId > 0 && Number(sessionRow.userId || 0) !== currentUserId) {
    throw new SessionServiceError(403, "无权访问该会话");
  }

  const prevChapterId = Number(sessionRow.chapterId || 0) || null;
  const prevStatus = String(sessionRow.status || "active");
  const world = await loadSessionWorld(db, Number(sessionRow.worldId || 0));
  const rolePair = normalizeRolePair(world?.playerRole, world?.narratorRole);
  const state = normalizeSessionState(
    sessionRow.stateJson,
    Number(sessionRow.worldId || 0),
    prevChapterId,
    rolePair,
    world,
  );
  if (canPlayerSpeakNow(state, world)) {
    throw new SessionServiceError(409, "当前已轮到用户发言");
  }

  const chapter = prevChapterId
    ? normalizeChapterOutput(await db("t_storyChapter").where({ id: prevChapterId }).first())
    : null;
  if (!chapter) {
    throw new SessionServiceError(400, "当前章节不存在");
  }

  const rawRecentMessages = await db("t_sessionMessage").where({ sessionId }).orderBy("id", "desc").limit(20);
  const recentMessages = buildRecentMessages(rawRecentMessages, state);
  const requestTrace = {
    requestId: `continue_session_${sessionId}_${nowTs()}_${Math.random().toString(36).slice(2, 8)}`,
    route: "/game/continueSessionNarrative",
    branch: "session_continue",
    sessionId,
    worldId: Number(sessionRow.worldId || 0),
    chapterId: prevChapterId || 0,
    userId: currentUserId,
  };
  logSessionOrchestrationKeyNode("session_continue:accepted", requestTrace, {
    recentMessageCount: recentMessages.length,
  });

  // 续写链没有新的用户输入，章节判定必须等待新台词生成后再执行，因此保留串行流程。
  logSessionOrchestrationKeyNode("session_continue:runNarrativeOrchestrator:start", requestTrace);
  const orchestrator = await runNarrativeOrchestrator({
    userId: currentUserId,
    world,
    chapter,
    state,
    recentMessages,
    playerMessage: "",
    maxRetries: 0,
    allowControlHints: false,
    allowStateDelta: false,
    traceMeta: {
      ...requestTrace,
      planMode: "session_continue",
    },
  });
  logSessionOrchestrationKeyNode("session_continue:runNarrativeOrchestrator:done", requestTrace, {
    role: String(orchestrator.role || ""),
    awaitUser: Boolean(orchestrator.awaitUser),
  });
  const narrativePlan = summarizeNarrativePlan(orchestrator);
  applyNarrativeMemoryHintsToState(state, orchestrator.memoryHints);
  const orchestrated = await advanceNarrativeUntilPlayerTurn({
    userId: currentUserId,
    world,
    chapter,
    state,
    recentMessages,
    playerMessage: "",
    initialResult: orchestrator,
    maxAutoTurns: 1,
  });

  const generatedMessages = await insertSessionNarrativeMessages({
    db,
    sessionId,
    state,
    messages: orchestrated.messages,
    now,
    eventTypeFallback: "on_orchestrated_reply",
  });
  const latestGeneratedMessage = generatedMessages[generatedMessages.length - 1];
  logSessionOrchestrationKeyNode("session_continue:chapter_outcome:start", requestTrace, {
    latestEventType: String(latestGeneratedMessage?.eventType || "on_orchestrated_reply"),
  });
  const mergedOutcome = await evaluateRuntimeOutcome({
    chapter,
    state,
    messageContent: String(latestGeneratedMessage?.content || ""),
    eventType: String(latestGeneratedMessage?.eventType || "on_orchestrated_reply"),
    meta: {},
    recentMessages,
    fallbackStatus: prevStatus,
    fallbackChapterId: prevChapterId,
    applyToState: true,
    traceMeta: {
      ...requestTrace,
      judgeMode: "session_continue",
    },
  });
  logSessionOrchestrationKeyNode("session_continue:chapter_outcome:done", requestTrace, {
    outcome: mergedOutcome.outcome,
    nextChapterId: mergedOutcome.nextChapterId,
  });
  let sessionStatus = mergedOutcome.sessionStatus;
  let nextChapterId = mergedOutcome.nextChapterId;
  if (sessionStatus === "chapter_completed" && (!nextChapterId || nextChapterId === prevChapterId)) {
    const resolvedNextChapterId = await resolveNextChapterIdByOrder(db, Number(sessionRow.worldId || 0), prevChapterId);
    if (resolvedNextChapterId && resolvedNextChapterId !== prevChapterId) {
      nextChapterId = resolvedNextChapterId;
      sessionStatus = "active";
    }
  }
  if (nextChapterId && nextChapterId !== prevChapterId) {
    setPendingSessionChapterId(state, nextChapterId);
    setPendingSessionChapterStart(state, false);
    state.chapterId = prevChapterId;
  } else {
    setPendingSessionChapterId(state, null);
    setPendingSessionChapterStart(state, false);
    state.chapterId = nextChapterId;
  }
  initializeChapterProgressForState(chapter, state);
  syncChapterProgressWithRuntime(chapter, state);
  const stateJson = toJsonText(state, {});
  await db("t_gameSession").where({ sessionId }).update({
    stateJson,
    chapterId: state.chapterId || prevChapterId,
    status: sessionStatus,
    updateTime: now,
  });

  const snapshotResult = await persistSnapshotIfNeeded({
    db,
    sessionId,
    stateJson,
    round: Number(state.round || 0),
    now,
    policy: {
      saveSnapshot: true,
      nextChapterId: state.chapterId || prevChapterId,
      prevChapterId,
      sessionStatus,
      prevStatus,
      round: Number(state.round || 0),
    },
  });

  if (orchestrator.triggerMemoryAgent) {
    const recentMessagesForMemory = await loadIncrementalMessagesForMemory(db, sessionId, state);
    const lastMemoryMessageId = recentMessagesForMemory.reduce((max, item) => {
      const currentId = Number(item?.messageId || 0);
      return Number.isFinite(currentId) && currentId > max ? currentId : max;
    }, 0);
    if (recentMessagesForMemory.length) {
      scheduleSessionMemoryRefresh({
        sessionId,
        userId: currentUserId,
        world,
        chapter,
        state,
        recentMessages: recentMessagesForMemory,
        lastMessageId: lastMemoryMessageId,
      });
    }
  }
  scheduleSessionRoleParameterCardRefresh({
    userId: currentUserId,
    world,
  });
  await persistSessionMessageRevisitData({
    db,
    rows: generatedMessages,
    state,
    chapterId: state.chapterId || prevChapterId,
    status: sessionStatus,
    capturedAt: now,
  });

  const eventView = buildEventView(state);
  return {
    sessionId,
    status: sessionStatus,
    chapterId: Number(state.chapterId || prevChapterId || 0) || null,
    chapter: state.chapterId ? normalizeChapterOutput(await db("t_storyChapter").where({ id: state.chapterId }).first()) : null,
    state,
    currentEventDigest: eventView.currentEventDigest,
    eventDigestWindow: eventView.eventDigestWindow,
    eventDigestWindowText: eventView.eventDigestWindowText,
    message: null,
    chapterSwitchMessage: null,
    narrativeMessage: generatedMessages[generatedMessages.length - 1] || null,
    generatedMessages,
    narrativePlan,
    triggered: [],
    taskProgress: [],
    deltas: [],
    snapshotSaved: snapshotResult.snapshotSaved,
    snapshotReason: snapshotResult.snapshotReason,
  };
}

export async function orchestrateSessionTurn(sessionIdInput: string): Promise<SessionOrchestrationResult> {
  const sessionId = String(sessionIdInput || "").trim();
  if (!sessionId) {
    throw new SessionServiceError(400, "sessionId 不能为空");
  }

  return withSessionLock(sessionId, async () => orchestrateSessionTurnInner(sessionId));
}

/**
 * 读取 state.player.parameterCardJson.activeTaskId（orchestration 内联用）
 * MiniGameController 中的同名函数未导出，这里复刻一份以避免循环依赖。
 */
function readActiveTaskIdFromStateOrch(state: any): string | null {
  const card = (state?.player?.parameterCardJson as Record<string, unknown>) || {};
  const id = card?.activeTaskId;
  if (id == null) return null;
  const s = String(id).trim();
  return s ? s : null;
}

async function orchestrateSessionTurnInner(sessionId: string): Promise<SessionOrchestrationResult> {
  const db = getGameDb();

  const sessionRow = await db("t_gameSession").where({ sessionId }).first();
  if (!sessionRow) {
    throw new SessionServiceError(404, "会话不存在");
  }
  const currentUserId = getCurrentUserId(0);
  if (currentUserId > 0 && Number(sessionRow.userId || 0) !== currentUserId) {
    throw new SessionServiceError(403, "无权访问该会话");
  }

  const currentChapterId = Number(sessionRow.chapterId || 0) || null;
  const sessionStatus = String(sessionRow.status || "active");
  const world = await loadSessionWorld(db, Number(sessionRow.worldId || 0));
  const rolePair = normalizeRolePair(world?.playerRole, world?.narratorRole);
  const state = normalizeSessionState(
    sessionRow.stateJson,
    Number(sessionRow.worldId || 0),
    currentChapterId,
    rolePair,
    world,
  );
  // ★ 编排入口：先同步 currentEvent，让所有 agent / 提示词 / 候选 plan 都看到"未完成的当前事件"
  syncRuntimeCurrentEventFromChapterProgress(state);
  const rawRecentMessages = await db("t_sessionMessage").where({ sessionId }).orderBy("id", "desc").limit(20);
  const recentMessages = buildRecentMessages(rawRecentMessages, state);
  const requestTrace = {
    requestId: `orch_session_${sessionId}_${nowTs()}_${Math.random().toString(36).slice(2, 8)}`,
    route: "/game/orchestration",
    branch: "session",
    sessionId,
    worldId: Number(sessionRow.worldId || 0),
    chapterId: currentChapterId || 0,
    userId: currentUserId,
  };
  logSessionOrchestrationKeyNode("session_request:accepted", requestTrace, {
    recentMessageCount: recentMessages.length,
  });
  const finalizeOrchestrationResult = async (result: SessionOrchestrationResultSeed): Promise<SessionOrchestrationResult> => {
    const activeChapter = result.chapterId
      ? normalizeChapterOutput(await db("t_storyChapter").where({ id: result.chapterId }).first())
      : null;
    if (activeChapter) {
      resetSessionChapterRuntimeOnSwitch(
        state,
        Number(activeChapter.id || 0) || null,
        currentChapterId,
        String(activeChapter.title || "").trim(),
      );
      initializeChapterProgressForState(activeChapter, state);
      syncChapterProgressWithRuntime(activeChapter, state);
    }
    const expectedSpeaker = buildSessionExpectedSpeaker(state);
    setPendingSessionNarrativePlan(state, result.plan);
    await db("t_gameSession").where({ sessionId }).update({
      stateJson: toJsonText(state, {}),
      chapterId: result.chapterId,
      status: result.status,
      updateTime: nowTs(),
    });
    const eventView = buildEventView(state);
    return {
      ...result,
      expectedRole: expectedSpeaker.expectedRole,
      expectedRoleType: expectedSpeaker.expectedRoleType,
      currentEventDigest: eventView.currentEventDigest,
      eventDigestWindow: eventView.eventDigestWindow,
      eventDigestWindowText: eventView.eventDigestWindowText,
      command: result.command || null,
      plan: buildPublicSessionPlanResult(result.plan),
    };
  };

  const buildChapterStartPlan = async (chapter: any): Promise<SessionOrchestrationResult> => {
    resetSessionChapterRuntimeOnSwitch(
      state,
      Number(chapter.id || 0) || null,
      currentChapterId,
      String(chapter.title || "").trim(),
    );
    state.chapterId = Number(chapter.id || 0) || null;
    state.chapterTitle = String(chapter.title || "").trim() || String(state.chapterTitle || "").trim();
    const openingMessage = resolveOpeningMessage(world, chapter);
    setPendingSessionChapterId(state, null);
    setPendingSessionChapterStart(state, false);
    setRuntimeTurnState(state, world, {
      canPlayerSpeak: false,
      expectedRoleType: "narrator",
      expectedRole: String(state.narrator?.name || "旁白"),
      lastSpeakerRoleType: String(openingMessage?.roleType || "narrator"),
      lastSpeaker: String(openingMessage?.role || state.narrator?.name || "旁白"),
    });
    if (openingMessage && String(openingMessage.content || "").trim()) {
      return finalizeOrchestrationResult({
        sessionId,
        status: sessionStatus,
        chapterId: Number(chapter.id || 0) || null,
        expectedRole: "",
        expectedRoleType: "",
        plan: buildSessionPlanResult({
          role: String(openingMessage.role || state.narrator?.name || "旁白"),
          roleType: String(openingMessage.roleType || "narrator"),
          motive: "",
          awaitUser: false,
          nextRole: String(state.narrator?.name || "旁白"),
          nextRoleType: "narrator",
          source: "fallback",
          triggerMemoryAgent: false,
          eventType: String(openingMessage.eventType || "on_enter_chapter"),
          presetContent: String(openingMessage.content || ""),
        }),
      });
    }
    const plan = await runNarrativePlan({
      userId: currentUserId,
      world,
      chapter,
      state,
      // 切章启动同样需要保留最近对话窗口，避免编排师完全丢失上一轮真实上下文。
      recentMessages,
      playerMessage: "",
      maxRetries: 0,
      allowControlHints: false,
      allowStateDelta: false,
      traceMeta: {
        ...requestTrace,
        planMode: "chapter_start",
        chapterId: Number(chapter.id || 0),
      },
    });
    const builtPlan = applySessionNarrativePlanToState({
      userId: currentUserId,
      world,
      chapter,
      state,
      // 角色发言器也要看到相同的最近对话，否则会出现编排师与落地台词上下文不一致。
      recentMessages,
      plan,
    });
    return finalizeOrchestrationResult({
      sessionId,
      status: sessionStatus,
      chapterId: Number(chapter.id || 0) || null,
      expectedRole: "",
      expectedRoleType: "",
      plan: builtPlan,
    });
  };

  const pendingChapterId = getPendingSessionChapterId(state);
  const pendingChapterStart = getPendingSessionChapterStart(state);
  if (pendingChapterId && pendingChapterStart) {
    if (DebugLogUtil.isDebugLogEnabled()) {
      console.log("[story:orchestrator:runtime] 判断为不走到模型。原因：pendingChapterId_with_pendingChapterStart", JSON.stringify({
        sessionId,
        chapterId: currentChapterId,
        pendingChapterId,
        pendingChapterStart,
      }));
    }
    const nextChapter = normalizeChapterOutput(await db("t_storyChapter").where({ id: pendingChapterId }).first());
    if (!nextChapter) {
      setPendingSessionChapterId(state, null);
      setPendingSessionChapterStart(state, false);
      return finalizeOrchestrationResult({
        sessionId,
        status: sessionStatus,
        chapterId: currentChapterId,
        expectedRole: "",
        expectedRoleType: "",
        command: null,
        plan: null,
      });
    }
    return buildChapterStartPlan(nextChapter);
  }
  if (pendingChapterId && !pendingChapterStart) {
    if (DebugLogUtil.isDebugLogEnabled()) {
      console.log("[story:orchestrator:runtime] 判断为不走到模型。原因：pendingChapterId_without_pendingChapterStart", JSON.stringify({
        sessionId,
        chapterId: currentChapterId,
        pendingChapterId,
        pendingChapterStart,
      }));
    }
    const nextChapter = normalizeChapterOutput(await db("t_storyChapter").where({ id: pendingChapterId }).first());
    if (!nextChapter) {
      setPendingSessionChapterId(state, null);
      return finalizeOrchestrationResult({
        sessionId,
        status: sessionStatus,
        chapterId: currentChapterId,
        expectedRole: "",
        expectedRoleType: "",
        command: null,
        plan: null,
      });
    }
    // 对外不再暴露 init_chapter 命令，正式切章改由服务端在下一轮编排时自行消化。
    // 这里把 pendingChapterStart 直接切成 true，随后继续走统一的新章节开场编排。
    setPendingSessionChapterStart(state, true);
    return buildChapterStartPlan(nextChapter);
  }

  let chapter = currentChapterId
    ? normalizeChapterOutput(await db("t_storyChapter").where({ id: currentChapterId }).first())
    : null;
  if (!chapter) {
    chapter = await db("t_storyChapter")
      .where({ worldId: Number(sessionRow.worldId || 0) })
      .orderBy("sort", "asc")
      .orderBy("id", "asc")
      .first();
    chapter = normalizeChapterOutput(chapter);
  }
  if (!chapter) {
    throw new SessionServiceError(400, "当前章节不存在");
  }

  // 延迟提升：如果存在 heldNarrativePlan（如陪练回合），在前端主动请求编排时提升为 pendingNarrativePlan。
  // 这确保旁白语音有充足时间播完，陪练回合不会和旁白回合打架。
  if (state.heldNarrativePlan && !state.pendingNarrativePlan) {
    if (DebugLogUtil.isDebugLogEnabled()) {
      console.log("[story:orchestrator:runtime] heldNarrativePlan promoted to pendingNarrativePlan", JSON.stringify({
        sessionId,
        role: String(state.heldNarrativePlan.role || ""),
        roleType: String(state.heldNarrativePlan.roleType || ""),
      }));
    }
    setPendingSessionNarrativePlan(state, state.heldNarrativePlan as any);
    delete state.heldNarrativePlan;
  }

  const pendingNarrativePlan = getPendingSessionNarrativePlan(state);
  if (pendingNarrativePlan) {
    // 小游戏已退出但 pendingNarrativePlan 残留时，说明是小游戏退出不干净，
    // 需要清除过期的 plan，否则编排会一直被它挡住不走大模型。
    if (!isMiniGameActiveState(state)) {
      if (DebugLogUtil.isDebugLogEnabled()) {
        console.log("[story:orchestrator:runtime] 清除过期 pendingNarrativePlan，小游戏已不在 active 状态", JSON.stringify({
          sessionId,
          chapterId: Number(chapter?.id || 0),
          planRole: String(pendingNarrativePlan.role || ""),
          planRoleType: String(pendingNarrativePlan.roleType || ""),
          planAwaitUser: Boolean(pendingNarrativePlan.awaitUser),
          planEventType: String(pendingNarrativePlan.eventType || ""),
        }));
      }
      setPendingSessionNarrativePlan(state, null);
      if (state.heldNarrativePlan) {
        delete state.heldNarrativePlan;
      }
    } else {
      // 任务/小游戏 active 中：检查 plan 是否已过期（用户已发新消息）
      const planEventType = String(pendingNarrativePlan.eventType || "");
      const planRoleType = String(pendingNarrativePlan.roleType || "").toLowerCase();
      const isWaitingInputPlan =
        planEventType === "on_waiting_input"
        || (planRoleType === "player" && Boolean(pendingNarrativePlan.awaitUser));
      const latestMsg = recentMessages[recentMessages.length - 1];
      const latestMsgRoleType = String(latestMsg?.roleType || "").toLowerCase();
      const latestMsgEventType = String(latestMsg?.eventType || "");
      const userJustSpoke = latestMsgRoleType === "player" && latestMsgEventType === "on_message";

      if (isWaitingInputPlan && userJustSpoke) {
        // 用户已发新消息 + plan 是"等待输入"
        // → 清除旧 plan，让编排正常走，让旁白回应用户的任务内行动
        console.log("[story:orchestrator:runtime] 清除过期 waiting_input plan（用户已发新消息）", {
          sessionId,
          planEventType,
          planRoleType,
          latestMsgRoleType,
        });
        setPendingSessionNarrativePlan(state, null);
        if (state.heldNarrativePlan) {
          delete state.heldNarrativePlan;
        }
        // 不 return，继续往下走编排
      } else {
        // 小游戏的旁白播报 / 敌人回合都通过 pendingNarrativePlan 进入正式编排链。
        // 这里必须优先返回，避免再跑普通剧情编排把小游戏回合冲掉。
        if (DebugLogUtil.isDebugLogEnabled()) {
          console.log("[story:orchestrator:runtime] 判断为不走到模型。原因：pendingNarrativePlan_exists", JSON.stringify({
            sessionId,
            chapterId: Number(chapter?.id || 0),
            planRole: String(pendingNarrativePlan.role || ""),
            planRoleType: String(pendingNarrativePlan.roleType || ""),
            planAwaitUser: Boolean(pendingNarrativePlan.awaitUser),
            planEventType: String(pendingNarrativePlan.eventType || ""),
          }));
        }
        return finalizeOrchestrationResult({
          sessionId,
          status: sessionStatus,
          chapterId: Number(chapter.id || 0) || null,
          expectedRole: "",
          expectedRoleType: "",
          command: null,
          plan: pendingNarrativePlan,
        });
      }
    }
  }

  if (!recentMessages.length) {
    if (DebugLogUtil.isDebugLogEnabled()) {
      console.log("[story:orchestrator:runtime] 判断为不走到模型。原因：no_recentMessages", JSON.stringify({
        sessionId,
        chapterId: Number(chapter?.id || 0),
      }));
    }
    return buildChapterStartPlan(chapter);
  }
  await applySessionPreOrchestrationEventProgress({
    userId: currentUserId,
    world,
    chapter,
    state,
    recentMessages,
    traceMeta: {
      ...requestTrace,
      route: "/game/orchestration",
    },
  });
  if (canPlayerSpeakNow(state, world)) {
    if (DebugLogUtil.isDebugLogEnabled()) {
      console.log("[story:orchestrator:runtime] 判断为不走到模型。原因：canPlayerSpeakNow", JSON.stringify({
        sessionId,
        chapterId: Number(chapter?.id || 0),
      }));
    }
    return finalizeOrchestrationResult({
      sessionId,
      status: sessionStatus,
      chapterId: Number(chapter.id || 0) || null,
      expectedRole: "",
      expectedRoleType: "",
      command: null,
      // 命中 waiting_input 时，要明确告诉前端"现在轮到用户"，不能再回空 plan。
      plan: buildWaitingForUserSessionPlan(state),
    });
  }

  const latestRecentMessage = recentMessages[recentMessages.length - 1];

  // ★ B: orchestration 阶段意图分析
  // 用户最新发言若被分类为 create_task，直接调用 createTaskFromUserRequest，
  // 跳过编排，把任务接取消息作为本轮 plan 返回。
  if (latestRecentMessage
      && String(latestRecentMessage.roleType || "").toLowerCase() === "player"
      && String(latestRecentMessage.eventType || "") === "on_message"
      && !isMiniGameActiveState(state)
      && readActiveTaskIdFromStateOrch(state) === null) {
    const playerMsg = String(latestRecentMessage.content || "").trim();
    if (playerMsg) {
      const { analyzeIntent, analyzeIntentWithAiFallback } = await import("@/modules/game-runtime/agents/intentAnalyzer");
      // Fast path: 命令命中
      let intentDescription: string | null = null;
      let intentSource: "command" | "ai" = "command";
      let intentConfidence = 1.0;
      const fastIntent = analyzeIntent({
        userId: currentUserId,
        playerMessage: playerMsg,
        chapterTitle: String(chapter?.title || "") || null,
      });
      if (fastIntent && fastIntent.intent === "create_task") {
        intentDescription = String(fastIntent.params?.task_description || "").trim() || null;
      } else if (!fastIntent) {
        // Slow path: AI 分类
        console.log("[story:intent:analysis] orchestration 阶段进入 AI 分类", {
          messagePreview: playerMsg.slice(0, 60),
        });
        const aiResult = await analyzeIntentWithAiFallback({
          userId: currentUserId,
          playerMessage: playerMsg,
          recentMessages,
          chapterTitle: String(chapter?.title || "") || null,
        });
        console.log("[story:intent:analysis] orchestration AI 分类结果", {
          intent: aiResult.intent,
          confidence: aiResult.confidence,
          path: aiResult.path,
          reasoning: String(aiResult.reasoning || "").slice(0, 80),
        });
        if (aiResult.intent === "create_task" && aiResult.confidence >= 0.7) {
          const td = (aiResult.params as any)?.task_description;
          intentDescription = td && String(td).trim() ? String(td).trim() : playerMsg;
          intentSource = "ai";
          intentConfidence = aiResult.confidence;
        }
      }

      if (intentDescription) {
        console.log("[story:mini_game:task] orchestration 触发任务创建", {
          source: intentSource,
          confidence: intentConfidence,
          taskDescription: intentDescription.slice(0, 80),
        });
        const { createTaskFromUserRequest } = await import("@/modules/game-runtime/services/FreeChapterTaskService");
        const created = await createTaskFromUserRequest({
          userId: currentUserId,
          world,
          chapter,
          state,
          userRequest: intentDescription,
          recentMessages,
        });
        if (created) {
          console.log("[story:mini_game:task] orchestration 任务创建成功", {
            taskId: created.task_id,
            title: created.title,
            objective: String(created.objective || "").slice(0, 80),
          });
          // 设置 turn 状态：旁白接管，发开场介绍
          setRuntimeTurnState(state, world, {
            canPlayerSpeak: false,
            expectedRoleType: "narrator",
            expectedRole: String(state.narrator?.name || "旁白"),
            lastSpeakerRoleType: "player",
            lastSpeaker: String(latestRecentMessage.role || state.player?.name || "用户"),
          });
          // 持久化 state
          await db("t_gameSession").where({ sessionId }).update({
            stateJson: toJsonText(state, {}),
            chapterId: Number(chapter.id || 0) || currentChapterId,
            status: sessionStatus,
            updateTime: nowTs(),
          });
          // 返回一个开场 plan，让 streamlines 生成旁白介绍任务
          const openingMotive = `任务【${created.title}】已开启。请简要介绍任务目标：${created.objective}。`;
          return finalizeOrchestrationResult({
            sessionId,
            status: sessionStatus,
            chapterId: Number(chapter.id || 0) || null,
            expectedRole: "",
            expectedRoleType: "",
            command: null,
            plan: buildSessionPlanResult({
              role: String(state.narrator?.name || "旁白"),
              roleType: "narrator",
              motive: openingMotive,
              awaitUser: true,
              nextRole: String(state.player?.name || "用户"),
              nextRoleType: "player",
              source: "task_created",
              triggerMemoryAgent: true,
              eventType: "on_mini_game_start",
              presetContent: "",
            }),
          });
        }
      }
    }
  }

  if (isOpeningRuntimeEventType(latestRecentMessage?.eventType)) {
    resetSessionChapterContentProgressForOpening(chapter, state);
    logSessionOrchestrationKeyNode("session_opening:skip_judge", requestTrace, {
      reason: "opening_is_outside_chapter_event_graph",
      resetEventIndex: Number(state.chapterProgress?.eventIndex || state.currentEvent?.index || 0),
    });
    if (DebugLogUtil.isDebugLogEnabled()) {
      console.log("[story:orchestrator:runtime] 判断为不走到模型。原因：opening_is_outside_chapter_event_graph", JSON.stringify({
        sessionId,
        chapterId: Number(chapter?.id || 0),
      }));
    }
    const plan = await runNarrativePlan({
      userId: currentUserId,
      world,
      chapter,
      state,
      recentMessages,
      playerMessage: "",
      maxRetries: 0,
      allowControlHints: false,
      allowStateDelta: false,
      traceMeta: {
        ...requestTrace,
        chapterId: Number(chapter.id || 0),
        planMode: "after_opening",
      },
    });
    const builtPlan = applySessionNarrativePlanToState({
      userId: currentUserId,
      world,
      chapter,
      state,
      recentMessages,
      plan,
    });
    return finalizeOrchestrationResult({
      sessionId,
      status: sessionStatus,
      chapterId: Number(chapter.id || 0) || null,
      expectedRole: "",
      expectedRoleType: "",
      command: null,
      plan: builtPlan,
    });
  }
  if (DebugLogUtil.isDebugLogEnabled()) {
    console.log("[story:orchestrator:runtime] 走大模型编排", JSON.stringify({
      sessionId,
      chapterId: Number(chapter?.id || 0),
      recentMessageCount: recentMessages.length,
      latestEventType: String(latestRecentMessage?.eventType || ""),
    }));
  }

  // ★ 任务模式：直接走 4-Agent 编排（Intent → Progress → Director），跳过主线编排
  // Speaker 由 /game/streamlines 调用（任务模式判断在 streamlines 里）
  const taskPlan = await tryBuildTaskModePlan({
    state,
    sessionId,
    userId: currentUserId,
    world,
    chapter,
    recentMessages,
    latestRecentMessage,
  });
  console.log("[story:orchestrator:runtime] tryBuildTaskModePlan 返回", {
    sessionId,
    hasTaskPlan: !!taskPlan,
    taskPlanRole: taskPlan?.role,
    taskPlanRoleType: taskPlan?.roleType,
    taskPlanEventType: taskPlan?.eventType,
    taskPlanSpeakerReason: taskPlan?.speakerRouteReason,
  });
  if (taskPlan) {
    return finalizeOrchestrationResult({
      sessionId,
      status: sessionStatus,
      chapterId: Number(chapter?.id || 0) || null,
      expectedRole: "",
      expectedRoleType: "",
      command: null,
      plan: taskPlan,
    });
  }

  const arbitration = await runConcurrentSessionJudgeAndNarrative({
    userId: currentUserId,
    world,
    chapter,
    state,
    recentMessages,
    latestRecentMessage,
    sessionStatus,
    fallbackChapterId: Number(chapter.id || 0) || null,
    traceMeta: {
      ...requestTrace,
      chapterId: Number(chapter.id || 0),
    },
  });
  const mergedOutcome = arbitration.mergedOutcome;
  const plan = arbitration.plan;

  let nextStatus = mergedOutcome.sessionStatus;
  let nextChapterId = mergedOutcome.nextChapterId;
  let nextChapter = chapter;
  if (mergedOutcome.outcome === "success") {
    const resolvedNextChapterId = Number(mergedOutcome.nextChapterId || 0)
      || await resolveNextChapterIdByOrder(db, Number(sessionRow.worldId || 0), Number(chapter.id || 0));
    if (resolvedNextChapterId && resolvedNextChapterId !== Number(chapter.id || 0)) {
      const resolvedNextChapter = normalizeChapterOutput(await db("t_storyChapter").where({ id: resolvedNextChapterId }).first());
        if (resolvedNextChapter) {
          if (String(plan?.role || "").trim()) {
            setPendingSessionChapterId(state, resolvedNextChapterId);
            // 当前章的收尾台词还要先落库展示，下一章启动标记延后到下一轮 orchestration 自动消费。
            setPendingSessionChapterStart(state, false);
          }
          nextChapter = chapter;
          nextChapterId = Number(chapter.id || 0) || currentChapterId;
          return finalizeOrchestrationResult({
            sessionId,
            status: nextStatus,
            chapterId: nextChapterId,
            expectedRole: "",
            expectedRoleType: "",
            plan,
          });
        }
      }
  }
  const eventView = buildEventView(state);
  const result: SessionOrchestrationResult = {
    sessionId,
    status: nextStatus,
    chapterId: nextChapterId,
    expectedRole: "",
    expectedRoleType: "",
    command: null,
    currentEventDigest: eventView.currentEventDigest,
    eventDigestWindow: eventView.eventDigestWindow,
    eventDigestWindowText: eventView.eventDigestWindowText,
    plan,
  };
  return finalizeOrchestrationResult(result);
}

/**
 * 显式初始化正式会话的下一章节运行态。
 *
 * 用途：
 * - 章节结束后不再在 `/orchestration` 里偷偷切章；
 * - 前端必须先调用 `/initchapter`，把下一章事件图、turnState、pending 标记都准备好；
 * - 随后再次调用 `/orchestration`，才会真正生成下一章的开场编排。
 */
export async function initSessionChapter(sessionIdInput: string, chapterIdInput?: number | null): Promise<InitSessionChapterResult> {
  const db = getGameDb();
  const sessionId = String(sessionIdInput || "").trim();
  if (!sessionId) {
    throw new SessionServiceError(400, "sessionId 不能为空");
  }

  const sessionRow = await db("t_gameSession").where({ sessionId }).first();
  if (!sessionRow) {
    throw new SessionServiceError(404, "会话不存在");
  }
  const currentUserId = getCurrentUserId(0);
  if (currentUserId > 0 && Number(sessionRow.userId || 0) !== currentUserId) {
    throw new SessionServiceError(403, "无权访问该会话");
  }

  const prevChapterId = Number(sessionRow.chapterId || 0) || null;
  const world = await loadSessionWorld(db, Number(sessionRow.worldId || 0));
  const rolePair = normalizeRolePair(world?.playerRole, world?.narratorRole);
  const state = normalizeSessionState(
    sessionRow.stateJson,
    Number(sessionRow.worldId || 0),
    prevChapterId,
    rolePair,
    world,
  );

  const explicitChapterId = Number(chapterIdInput || 0) || null;
  const pendingChapterId = getPendingSessionChapterId(state);
  const targetChapterId = explicitChapterId || pendingChapterId;
  if (!targetChapterId) {
    throw new SessionServiceError(409, "当前没有待初始化的下一章节");
  }

  const chapter = normalizeChapterOutput(
    await db("t_storyChapter").where({ id: targetChapterId, worldId: Number(sessionRow.worldId || 0) }).first(),
  );
  if (!chapter) {
    throw new SessionServiceError(404, "目标章节不存在");
  }

  resetSessionChapterRuntimeOnSwitch(
    state,
    Number(chapter.id || 0) || null,
    prevChapterId,
    String(chapter.title || "").trim(),
  );
  state.chapterId = Number(chapter.id || 0) || null;
  state.chapterTitle = String(chapter.title || "").trim() || String(state.chapterTitle || "").trim();
  setPendingSessionChapterId(state, Number(chapter.id || 0) || null);
  setPendingSessionChapterStart(state, true);
  setPendingSessionNarrativePlan(state, null);
  initializeChapterProgressForState(chapter, state);
  syncChapterProgressWithRuntime(chapter, state);
  setRuntimeTurnState(state, world, {
    canPlayerSpeak: false,
    expectedRoleType: "narrator",
    expectedRole: String(state.narrator?.name || "旁白"),
    lastSpeakerRoleType: String(state.turnState?.lastSpeakerRoleType || "narrator"),
    lastSpeaker: String(state.turnState?.lastSpeaker || state.narrator?.name || "旁白"),
  });

  const stateJson = toJsonText(state, {});
  await db("t_gameSession").where({ sessionId }).update({
    stateJson,
    chapterId: Number(chapter.id || 0) || null,
    status: String(sessionRow.status || "active").trim() || "active",
    updateTime: nowTs(),
  });

  const eventView = buildEventView(state);
  return {
    sessionId,
    status: String(sessionRow.status || "active").trim() || "active",
    worldId: Number(sessionRow.worldId || 0),
    chapterId: Number(chapter.id || 0) || null,
    chapterTitle: String(chapter.title || ""),
    state,
    chapter,
    currentEventDigest: eventView.currentEventDigest,
    eventDigestWindow: eventView.eventDigestWindow,
    eventDigestWindowText: eventView.eventDigestWindowText,
  };
}

export async function commitSessionNarrativeTurn(input: CommitSessionNarrativeTurnInput): Promise<AddSessionMessageResult> {
  const sessionId = String(input.sessionId || "").trim();
  if (!sessionId) {
    throw new SessionServiceError(400, "sessionId 不能为空");
  }
  return withSessionLock(sessionId, async () => commitSessionNarrativeTurnInner(input));
}

async function commitSessionNarrativeTurnInner(input: CommitSessionNarrativeTurnInput): Promise<AddSessionMessageResult> {
  const db = getGameDb();
  const now = nowTs();
  const sessionId = String(input.sessionId || "").trim();
  const sessionRow = await db("t_gameSession").where({ sessionId }).first();
  if (!sessionRow) {
    throw new SessionServiceError(404, "会话不存在");
  }
  const currentUserId = getCurrentUserId(0);
  if (currentUserId > 0 && Number(sessionRow.userId || 0) !== currentUserId) {
    throw new SessionServiceError(403, "无权访问该会话");
  }
  const world = await loadSessionWorld(db, Number(sessionRow.worldId || 0));
  const rolePair = normalizeRolePair(world?.playerRole, world?.narratorRole);
  const prevChapterId = Number(sessionRow.chapterId || 0) || null;
  const prevStatus = String(sessionRow.status || "active");
  // 正式会话的运行态必须以服务端已落库 stateJson 为准。
  //
  // 用途：
  // - `/orchestration` 已经先把 pendingNarrativePlan / turnState 写回数据库；
  // - 前端在流式台词结束后再调用 `/commitNarrativeTurn` 时，手里的本地 state 可能还是旧快照；
  // - 如果这里继续优先信 input.state，会把刚写好的服务端 turnState 覆盖回旧值，出现
  //   "画面已经显示旁白，但输入框仍提示等待上一位角色继续发言"的卡死现象。
  const state = normalizeSessionState(
    sessionRow.stateJson,
    Number(sessionRow.worldId || 0),
    prevChapterId,
    rolePair,
    world,
  );
  const pendingPlan = getPendingSessionNarrativePlan(state);
  let nextChapterId = Number(input.chapterId || prevChapterId || 0) || null;
  let sessionStatus = String(input.status || prevStatus || "active").trim() || "active";
  const createTime = Number(input.createTime || now) || now;
  const committedEventType = String(input.eventType || pendingPlan?.eventType || "on_orchestrated_reply").trim() || "on_orchestrated_reply";
  const insertedRows = await insertSessionNarrativeMessages({
    db,
    sessionId,
    state,
    messages: [{
      role: String(input.role || pendingPlan?.role || state.narrator?.name || "旁白"),
      roleType: String(input.roleType || pendingPlan?.roleType || "narrator"),
      eventType: committedEventType,
      content: String(input.content || ""),
      createTime,
    }],
    now: createTime,
    eventTypeFallback: committedEventType,
  });
  setPendingSessionNarrativePlan(state, null);
  // 延迟提升：如果 pendingPlan 有 nextNarrativePlan（如陪练回合），
  // 不立即提升为 pendingNarrativePlan，而是存入 heldNarrativePlan。
  // 这样旁白语音有充足时间播完，等前端下次请求编排时再提升。
  if (pendingPlan?.nextNarrativePlan) {
    state.heldNarrativePlan = pendingPlan.nextNarrativePlan;
    if (DebugLogUtil.isDebugLogEnabled()) {
      console.log("[story:next_plan:stats] nextNarrativePlan held (delayed promotion)", {
        role: (pendingPlan.nextNarrativePlan as any)?.role,
        roleType: (pendingPlan.nextNarrativePlan as any)?.roleType,
      });
    }
    // 打上陪练回合的 log tag
    const heldRoleType = String((pendingPlan.nextNarrativePlan as any)?.roleType || "");
    if (heldRoleType && !["narrator", "player", "narrator_person"].includes(heldRoleType)) {
      miniGameStateManager.logMiniGameTurn("mentor_turn", {
        gameType: miniGameStateManager.getMiniGameStateInfo(state).gameType,
        displayName: miniGameStateManager.getMiniGameStateInfo(state).displayName,
        phase: miniGameStateManager.getMiniGameStateInfo(state).phase,
        eventType: String((pendingPlan.nextNarrativePlan as any)?.eventType || ""),
      });
    }
  }
  const chapter = nextChapterId
    ? normalizeChapterOutput(await db("t_storyChapter").where({ id: nextChapterId }).first())
    : null;
  if (chapter) {
    const latestGeneratedMessage = insertedRows[insertedRows.length - 1];
    const latestEventType = String(latestGeneratedMessage?.eventType || committedEventType).trim();
    const isOpeningCommit = isOpeningRuntimeEventType(latestEventType);
    // 开场白属于章节外的入场台词，只能落库展示，不能触发章节事件完成、切换或同步推进。
    if (isOpeningCommit) {
      resetSessionChapterContentProgressForOpening(chapter, state);
    } else {
      const mergedOutcome = await evaluateRuntimeOutcome({
        chapter,
        state,
        messageContent: String(latestGeneratedMessage?.content || input.content || ""),
        eventType: latestEventType || committedEventType,
        meta: {},
        recentMessages: insertedRows.map((item) => ({
          role: String(item.role || ""),
          roleType: String(item.roleType || ""),
          eventType: String(item.eventType || ""),
          content: String(item.content || ""),
          createTime: Number(item.createTime || 0),
        })),
        fallbackStatus: sessionStatus,
        fallbackChapterId: nextChapterId,
        applyToState: true,
      });
      sessionStatus = mergedOutcome.sessionStatus;
      nextChapterId = mergedOutcome.nextChapterId;
      const outcome = mergedOutcome.outcome;
      if (DebugLogUtil.isDebugLogEnabled()) {
        // [story:chapter_ending_check:stats] current_chapter
        DebugLogUtil.logCurrentChapter("story:chapter_ending_check:stats", chapter);
        console.log(`[story:chapter_ending_check:stats] sessionStatus: ${sessionStatus}`);
        console.log(`[story:chapter_ending_check:stats] outcome: ${outcome}`);
        console.log(`[story:chapter_ending_check:stats] nextChapterId: ${nextChapterId}`);
      }
      if (sessionStatus === "chapter_completed" && (!nextChapterId || nextChapterId === prevChapterId)) {
        const resolvedNextChapterId = await resolveNextChapterIdByOrder(db, Number(sessionRow.worldId || 0), prevChapterId);
        if (resolvedNextChapterId && resolvedNextChapterId !== prevChapterId) {
          nextChapterId = resolvedNextChapterId;
          sessionStatus = "active";
        }
      }
      if (nextChapterId && nextChapterId !== prevChapterId) {
        setPendingSessionChapterId(state, nextChapterId);
        setPendingSessionChapterStart(state, false);
        state.chapterId = prevChapterId;
      } else {
        setPendingSessionChapterId(state, null);
        setPendingSessionChapterStart(state, false);
        state.chapterId = nextChapterId;
      }
      initializeChapterProgressForState(chapter, state);
      syncChapterProgressWithRuntime(chapter, state);
    }
  }

  const committedRole = String(input.role || pendingPlan?.role || state.narrator?.name || "旁白");
  const committedRoleType = String(input.roleType || pendingPlan?.roleType || "narrator");
  const hasPendingChapterSwitch = Boolean(
    Number((state as any)?.pendingChapterId || 0) > 0
    && Number((state as any)?.pendingChapterId || 0) !== Number(prevChapterId || 0),
  );
  const isOpeningCommit = isOpeningRuntimeEventType(committedEventType);

  // 台词真正落库后，要立刻把 session turnState 推进到"这句之后"的状态。
  //
  // 用途：
  // - orchestration 只负责预编排，不代表这一句已经真正提交；
  // - 如果 commit 后不显式推进 turnState，storyInfo / listSession 仍可能读到旧 expectedRole；
  // - 前端就会继续显示"等待上一位角色发言"，直到回溯或刷新才恢复。
  const heldPlan = state.heldNarrativePlan
    ? buildSessionPlanResult(state.heldNarrativePlan as any)
    : null;
  if (hasPendingChapterSwitch || isOpeningCommit) {
    setRuntimeTurnState(state, world, {
      canPlayerSpeak: false,
      expectedRoleType: "narrator",
      expectedRole: String(state.narrator?.name || "旁白"),
      lastSpeakerRoleType: committedRoleType,
      lastSpeaker: committedRole,
    });
  } else if (heldPlan) {
    // 有 heldNarrativePlan（如陪练回合），turnState 指向下一轮编排，
    // 但不立即暴露 pendingNarrativePlan，等前端下次请求编排时提升。
    applyPlanTurnStateToSessionState(state, world, heldPlan);
  } else if (pendingPlan?.awaitUser) {
    allowPlayerTurn(state, world, committedRoleType, committedRole);
  } else {
    setRuntimeTurnState(state, world, {
      canPlayerSpeak: false,
      expectedRoleType: String(pendingPlan?.nextRoleType || pendingPlan?.roleType || "narrator"),
      expectedRole: String(pendingPlan?.nextRole || pendingPlan?.role || state.narrator?.name || "旁白"),
      lastSpeakerRoleType: committedRoleType,
      lastSpeaker: committedRole,
    });
  }

  const stateJson = toJsonText(state, {});
  await db("t_gameSession").where({ sessionId }).update({
    stateJson,
    chapterId: state.chapterId || prevChapterId,
    status: sessionStatus,
    updateTime: now,
  });
  const snapshotResult = await persistSnapshotIfNeeded({
    db,
    sessionId,
    stateJson,
    round: Number(state.round || 0),
    now,
    policy: {
      saveSnapshot: input.saveSnapshot,
      nextChapterId: state.chapterId || prevChapterId,
      prevChapterId,
      sessionStatus,
      prevStatus,
      round: Number(state.round || 0),
    },
  });
  await persistSessionMessageRevisitData({
    db,
    rows: insertedRows,
    state,
    chapterId: state.chapterId || prevChapterId,
    status: sessionStatus,
    capturedAt: now,
  });
  scheduleSessionRoleParameterCardRefresh({
    userId: currentUserId,
    world,
  });
  const activeChapterId = Number(state.chapterId || prevChapterId || 0) || null;
  const activeChapter = activeChapterId
    ? normalizeChapterOutput(await db("t_storyChapter").where({ id: activeChapterId }).first())
    : null;
  const eventView = buildEventView(state);
  return {
    sessionId,
    status: sessionStatus,
    chapterId: activeChapterId,
    chapter: activeChapter,
    state,
    currentEventDigest: eventView.currentEventDigest,
    eventDigestWindow: eventView.eventDigestWindow,
    eventDigestWindowText: eventView.eventDigestWindowText,
    message: null,
    chapterSwitchMessage: null,
    narrativeMessage: insertedRows[insertedRows.length - 1] || null,
    generatedMessages: insertedRows,
    narrativePlan: null,
    triggered: [],
    taskProgress: [],
    deltas: [],
    snapshotSaved: snapshotResult.snapshotSaved,
    snapshotReason: snapshotResult.snapshotReason,
  };
}
