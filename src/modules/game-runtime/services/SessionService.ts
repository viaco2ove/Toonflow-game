import {
  getGameDb,
  normalizeChapterOutput,
  normalizeMessageOutput,
  normalizeRolePair,
  normalizeSessionState,
  nowTs,
  parseJsonSafe,
  readDefaultRuntimeEventViewState,
  readRuntimeCurrentEventDigestState,
  RuntimeEventViewState,
  toJsonText,
  upsertRuntimeEventDigestState,
} from "@/lib/gameEngine";
import { ensureWorldRolesWithAiParameterCards } from "@/lib/roleParameterCard";
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
  runNarrativePlan,
  runNarrativeOrchestrator,
  setRuntimeTurnState,
  summarizeNarrativePlan,
  triggerStoryMemoryRefreshInBackground,
} from "@/modules/game-runtime/engines/NarrativeOrchestrator";
import {
  recordChapterProgressSignals,
  initializeChapterProgressForState,
  markCurrentUserNodeCompleted,
  syncChapterProgressWithRuntime,
} from "@/modules/game-runtime/engines/ChapterProgressEngine";
import { handleMiniGameTurn } from "@/modules/game-runtime/engines/MiniGameController";
import { runTaskProgressEngine } from "@/modules/game-runtime/engines/TaskProgressEngine";
import {
  applyAttributeChanges,
  runTriggerEngine,
} from "@/modules/game-runtime/engines/TriggerEngine";
import { evaluateRuntimeOutcome } from "@/modules/game-runtime/services/ChapterRuntimeService";
import { persistSnapshotIfNeeded } from "@/modules/game-runtime/services/SnapshotService";
import {
  AppliedDelta,
  AttributeChangeInput,
  TaskProgressChange,
  TriggerHit,
} from "@/modules/game-runtime/types/runtime";

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
  narrativePlan: NarrativePlanSummary | null;
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
  source: "ai" | "fallback" | "rule";
  triggerMemoryAgent: boolean;
  eventType: string;
  presetContent: string | null;
  eventAdjustMode?: "keep" | "update" | "waiting_input" | "completed";
  eventIndex?: number;
  eventKind?: "opening" | "scene" | "user" | "fixed";
  eventSummary?: string;
  eventFacts?: string[];
  eventStatus?: "idle" | "active" | "waiting_input" | "completed";
  speakerMode?: "template" | "fast" | "premium";
  speakerRouteReason?: string;
}

export interface SessionOrchestrationResult {
  sessionId: string;
  status: string;
  chapterId: number | null;
  expectedRole: string;
  expectedRoleType: string;
  currentEventDigest: RuntimeEventViewState["currentEventDigest"];
  eventDigestWindow: RuntimeEventViewState["eventDigestWindow"];
  eventDigestWindowText: RuntimeEventViewState["eventDigestWindowText"];
  plan: SessionNarrativePlanResult | null;
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

function buildRecentMessages(rows: any[]): RuntimeMessageInput[] {
  return rows
    .reverse()
    .map((item: any) => ({
      messageId: Number(item.id || 0),
      role: String(item.role || ""),
      roleType: String(item.roleType || ""),
      eventType: String(item.eventType || ""),
      content: String(item.content || ""),
      createTime: Number(item.createTime || 0),
    }));
}

function readMemoryCursorMessageId(state: Record<string, any>): number {
  const cursor = parseJsonMaybe(state?.memoryCursor);
  const id = Number(cursor.lastMessageId || 0);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function readMemoryCursor(state: Record<string, any>): Record<string, any> {
  return parseJsonMaybe(state?.memoryCursor);
}

function hasMemoryEventDelta(state: Record<string, any>): boolean {
  const cursor = readMemoryCursor(state);
  const currentEventDigest = readRuntimeCurrentEventDigestState(state);
  const cursorFacts = Array.isArray(cursor.lastEventFacts)
    ? cursor.lastEventFacts.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const currentFacts = Array.isArray(currentEventDigest.eventFacts)
    ? currentEventDigest.eventFacts.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  return Number(cursor.lastEventIndex || 0) !== Number(currentEventDigest.eventIndex || 0)
    || String(cursor.lastEventKind || "").trim() !== String(currentEventDigest.eventKind || "").trim()
    || String(cursor.lastEventSummary || "").trim() !== String(currentEventDigest.eventSummary || "").trim()
    || cursorFacts.join("｜") !== currentFacts.join("｜");
}

function setMemoryCursor(state: Record<string, any>, lastMessageId: number, updateTime: number): void {
  const cursor = readMemoryCursor(state);
  const stableLastMessageId = Number.isFinite(lastMessageId) && lastMessageId > 0
    ? lastMessageId
    : Number.isFinite(Number(cursor.lastMessageId || 0)) && Number(cursor.lastMessageId || 0) > 0
      ? Number(cursor.lastMessageId || 0)
      : 0;
  const currentEventDigest = readRuntimeCurrentEventDigestState(state);
  state.memoryCursor = {
    lastMessageId: stableLastMessageId,
    lastEventIndex: currentEventDigest.eventIndex,
    lastEventKind: currentEventDigest.eventKind,
    lastEventSummary: String(currentEventDigest.eventSummary || "").trim(),
    lastEventFacts: Array.isArray(currentEventDigest.eventFacts)
      ? currentEventDigest.eventFacts.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 6)
      : [],
    updateTime: Number.isFinite(updateTime) && updateTime > 0 ? updateTime : nowTs(),
  };
}

function buildMemoryEventDeltaInput(state: Record<string, any>): RuntimeMessageInput | null {
  const currentEventDigest = readRuntimeCurrentEventDigestState(state);
  const eventFacts = Array.isArray(currentEventDigest.eventFacts)
    ? currentEventDigest.eventFacts.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 6)
    : [];
  const memoryFacts = Array.isArray(currentEventDigest.memoryFacts)
    ? currentEventDigest.memoryFacts.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 6)
    : [];
  return {
    messageId: null,
    role: "系统",
    roleType: "system",
    eventType: "on_event_memory_delta",
    content: [
      `事件#${Number(currentEventDigest.eventIndex || 1)} ${String(currentEventDigest.eventKind || "scene")}`,
      String(currentEventDigest.eventSummary || "").trim(),
      eventFacts.length ? `事件事实：${eventFacts.join("；")}` : "",
    ].filter(Boolean).join("\n"),
    createTime: nowTs(),
    memoryDelta: {
      eventIndex: Number(currentEventDigest.eventIndex || 1),
      eventKind: String(currentEventDigest.eventKind || "scene"),
      eventSummary: String(currentEventDigest.eventSummary || "").trim(),
      eventFacts,
      memorySummary: String(currentEventDigest.memorySummary || "").trim(),
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
  const recentMessages = buildRecentMessages(rows);
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

function buildSessionPlanResult(plan: ({
  role?: unknown;
  roleType?: unknown;
  motive?: unknown;
  awaitUser?: unknown;
  nextRole?: unknown;
  nextRoleType?: unknown;
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
          : plan.eventAdjustMode === "keep"
            ? "keep"
            : undefined,
    eventIndex: Number.isFinite(Number(plan.eventIndex)) ? Math.max(1, Number(plan.eventIndex)) : undefined,
    eventKind: plan.eventKind === "opening"
      ? "opening"
      : plan.eventKind === "user"
        ? "user"
        : plan.eventKind === "fixed"
          ? "fixed"
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
  };
}

function buildCurrentEventDigest(state: Record<string, any>): Record<string, any> {
  return buildEventView(state).currentEventDigest;
}

function buildEventView(state: Record<string, any>) {
  return readDefaultRuntimeEventViewState(state);
}

function buildEventDigestWindow(state: Record<string, any>): Record<string, any>[] {
  return buildEventView(state).eventDigestWindow;
}

function buildEventDigestWindowText(state: Record<string, any>): string {
  return buildEventView(state).eventDigestWindowText;
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

function getPendingSessionNarrativePlan(state: Record<string, any>): SessionNarrativePlanResult | null {
  return buildSessionPlanResult(state?.pendingNarrativePlan);
}

function setPendingSessionNarrativePlan(state: Record<string, any>, plan: SessionNarrativePlanResult | null): void {
  if (plan) {
    state.pendingNarrativePlan = plan;
    return;
  }
  delete state.pendingNarrativePlan;
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
  const shouldYieldToPlayer = Boolean(plan.awaitUser) || String(plan.nextRoleType || "").trim().toLowerCase() === "player";
  if (shouldYieldToPlayer) {
    allowPlayerTurn(state, world, String(plan.roleType || "narrator"), String(plan.role || state.narrator?.name || "旁白"));
    return;
  }
  setRuntimeTurnState(state, world, {
    canPlayerSpeak: false,
    expectedRoleType: String(plan.nextRoleType || "narrator"),
    expectedRole: String(plan.nextRole || plan.role || state.narrator?.name || "旁白"),
    lastSpeakerRoleType: String(plan.roleType || "narrator"),
    lastSpeaker: String(plan.role || state.narrator?.name || "旁白"),
  });
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
    const inserted = await params.db("t_sessionMessage").insert({
      sessionId: params.sessionId,
      role: String(item.role || params.state.narrator?.name || "旁白"),
      roleType: String(item.roleType || "narrator"),
      content: String(item.content || ""),
      eventType: String(item.eventType || params.eventTypeFallback || "on_orchestrated_reply"),
      meta: toJsonText(buildSessionRuntimeMeta(params.state, lineIndex), {}),
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
      const currentEventDigest = readRuntimeCurrentEventDigestState(latestState);
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
  const db = getGameDb();
  const now = nowTs();
  const sessionId = String(input.sessionId || "").trim();
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
  state.round = Number(state.round || 0) + 1;

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

  if (roleTypeValue === "player" && eventTypeValue === "on_message" && messageContent.trim()) {
    if (currentChapter) {
      markCurrentUserNodeCompleted(currentChapter, state, messageId);
    }
    const rawRecentMessages = await db("t_sessionMessage").where({ sessionId }).orderBy("id", "desc").limit(20);
    const recentMessages = buildRecentMessages(rawRecentMessages);
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

	      let narrativeMessageRow: any = null;
	      if (miniGameResult.message) {
        const inserted = await db("t_sessionMessage").insert({
          sessionId,
          role: String(miniGameResult.message.role || state.narrator?.name || "旁白"),
          roleType: String(miniGameResult.message.roleType || "narrator"),
          content: String(miniGameResult.message.content || ""),
          eventType: String(miniGameResult.message.eventType || "on_mini_game"),
          meta: toJsonText(miniGameResult.message.meta || {}, {}),
          createTime: now,
        });
	        const narrativeMessageId = normalizeMessageId(inserted);
	        narrativeMessageRow = await db("t_sessionMessage").where({ id: narrativeMessageId }).first();
	      }

	      if (currentChapter) {
	        syncChapterProgressWithRuntime(currentChapter, state);
	      }
	      const stateJson = toJsonText(state, {});
	      await db("t_gameSession").where({ sessionId }).update({
        stateJson,
        chapterId: prevChapterId,
        status: prevStatus,
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
          nextChapterId: prevChapterId,
          prevChapterId,
          sessionStatus: prevStatus,
          prevStatus,
          round: Number(state.round || 0),
        },
      });

      const messageRow = await db("t_sessionMessage").where({ id: messageId }).first();
      return {
        sessionId,
        status: prevStatus,
        chapterId: prevChapterId,
        chapter: currentChapter || null,
        state,
        message: normalizeMessageOutput(messageRow),
        chapterSwitchMessage: null,
        narrativeMessage: narrativeMessageRow ? normalizeMessageOutput(narrativeMessageRow) : null,
        generatedMessages: narrativeMessageRow ? [normalizeMessageOutput(narrativeMessageRow)].filter(Boolean) as Record<string, any>[] : [],
        narrativePlan: null,
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
    recordChapterProgressSignals(currentChapter, state, {
      messageContent,
      triggered,
      taskProgress: taskResult.taskProgressChanges,
      deltas: appliedDeltas,
    });
    syncChapterProgressWithRuntime(currentChapter, state);
  }
  if (currentChapter) {
    const mergedOutcome = evaluateRuntimeOutcome({
      chapter: currentChapter,
      state,
      messageContent,
      eventType: eventTypeValue,
      meta: metaObj,
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
  state.chapterId = nextChapterId;

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
      if (nextChapterId && nextChapterId !== prevChapterId) {
        setPendingSessionChapterId(state, nextChapterId);
      }
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
      chapterId: nextChapterId,
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
        nextChapterId,
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
    const activeChapter = nextChapterId
      ? normalizeChapterOutput(await db("t_storyChapter").where({ id: nextChapterId }).first())
      : null;
    const eventView = buildEventView(state);
    return {
      sessionId,
      status: sessionStatus,
      chapterId: nextChapterId,
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
  let narrativeMessageRow: any = null;
  let generatedMessages: Record<string, any>[] = [];
  let narrativePlan: NarrativePlanSummary | null = null;
  if (nextChapterId && nextChapterId !== prevChapterId) {
    const switchedChapter = normalizeChapterOutput(await db("t_storyChapter").where({ id: nextChapterId }).first());
    if (switchedChapter) {
      const openingMessage = resolveOpeningMessage(world, switchedChapter);
      const transitionMessages: RuntimeMessageInput[] = [];
      if (openingMessage && String(openingMessage.content || "").trim()) {
        transitionMessages.push({
          role: String(openingMessage.role || state.narrator?.name || "旁白"),
          roleType: String(openingMessage.roleType || "narrator"),
          eventType: String(openingMessage.eventType || "on_enter_chapter"),
          content: String(openingMessage.content || ""),
          createTime: now,
        });
      }
      setRuntimeTurnState(state, world, {
        canPlayerSpeak: false,
        expectedRoleType: "narrator",
        expectedRole: String(state.narrator?.name || "旁白"),
        lastSpeakerRoleType: String(transitionMessages[transitionMessages.length - 1]?.roleType || "narrator"),
        lastSpeaker: String(transitionMessages[transitionMessages.length - 1]?.role || state.narrator?.name || "旁白"),
      });
      initializeChapterProgressForState(switchedChapter, state);
      syncChapterProgressWithRuntime(switchedChapter, state);
      const orchestrator = await runNarrativeOrchestrator({
        userId: currentUserId,
        world,
        chapter: switchedChapter,
        state,
        recentMessages: transitionMessages,
        playerMessage: "",
        maxRetries: 0,
        allowControlHints: false,
        allowStateDelta: false,
      });
      narrativePlan = summarizeNarrativePlan(orchestrator);
      asyncMemoryRefreshRequested = Boolean(orchestrator.triggerMemoryAgent);
      asyncMemoryRefreshChapter = switchedChapter;
      const orchestrated = await advanceNarrativeUntilPlayerTurn({
        userId: currentUserId,
        world,
        chapter: switchedChapter,
        state,
        recentMessages: transitionMessages,
        playerMessage: "",
        initialResult: orchestrator,
        maxAutoTurns: 1,
      });
      transitionMessages.push(...orchestrated.messages);
      applyNarrativeMemoryHintsToState(state, orchestrator.memoryHints);
      generatedMessages = await insertSessionNarrativeMessages({
        db,
        sessionId,
        state,
        messages: transitionMessages,
        now,
        eventTypeFallback: "on_orchestrated_reply",
      });
      chapterSwitchMessageRow = generatedMessages[0] || null;
      narrativeMessageRow = generatedMessages[generatedMessages.length - 1] || null;
    }
  } else if (roleTypeValue === "player" && eventTypeValue === "on_message" && messageContent.trim()) {
    const playChapter = nextChapterId
      ? normalizeChapterOutput(await db("t_storyChapter").where({ id: nextChapterId }).first())
      : null;
    if (playChapter) {
      const rawRecentMessages = await db("t_sessionMessage").where({ sessionId }).orderBy("id", "desc").limit(20);
      const recentMessages = buildRecentMessages(rawRecentMessages);
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
    chapterId: nextChapterId,
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
      nextChapterId,
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
  const activeChapter = nextChapterId
    ? normalizeChapterOutput(await db("t_storyChapter").where({ id: nextChapterId }).first())
    : null;
  const eventView = buildEventView(state);
  return {
    sessionId,
    status: sessionStatus,
    chapterId: nextChapterId,
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
  const recentMessages = buildRecentMessages(rawRecentMessages);
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
  const mergedOutcome = evaluateRuntimeOutcome({
    chapter,
    state,
    messageContent: String(latestGeneratedMessage?.content || ""),
    eventType: String(latestGeneratedMessage?.eventType || "on_orchestrated_reply"),
    meta: {},
    fallbackStatus: prevStatus,
    fallbackChapterId: prevChapterId,
    applyToState: true,
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
  initializeChapterProgressForState(chapter, state);
  syncChapterProgressWithRuntime(chapter, state);
  const stateJson = toJsonText(state, {});
  await db("t_gameSession").where({ sessionId }).update({
    stateJson,
    chapterId: nextChapterId,
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
      nextChapterId,
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

  const eventView = buildEventView(state);
  return {
    sessionId,
    status: sessionStatus,
    chapterId: nextChapterId,
    chapter: nextChapterId ? normalizeChapterOutput(await db("t_storyChapter").where({ id: nextChapterId }).first()) : null,
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
  const rawRecentMessages = await db("t_sessionMessage").where({ sessionId }).orderBy("id", "desc").limit(20);
  const recentMessages = buildRecentMessages(rawRecentMessages);
  const finalizeOrchestrationResult = async (result: SessionOrchestrationResult): Promise<SessionOrchestrationResult> => {
    const activeChapter = result.chapterId
      ? normalizeChapterOutput(await db("t_storyChapter").where({ id: result.chapterId }).first())
      : null;
    if (activeChapter) {
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
    };
  };

  const buildChapterStartPlan = async (chapter: any): Promise<SessionOrchestrationResult> => {
    state.chapterId = Number(chapter.id || 0) || null;
    const openingMessage = resolveOpeningMessage(world, chapter);
    setPendingSessionChapterId(state, null);
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
      recentMessages: [],
      playerMessage: "",
      maxRetries: 0,
      allowControlHints: false,
      allowStateDelta: false,
    });
    applyOrchestratorResultToState(state, plan);
    applyNarrativeMemoryHintsToState(state, plan.memoryHints);
    applyPlanTurnStateToSessionState(state, world, plan);
    return finalizeOrchestrationResult({
      sessionId,
      status: sessionStatus,
      chapterId: Number(chapter.id || 0) || null,
      expectedRole: "",
      expectedRoleType: "",
      plan: buildSessionPlanResult({
        ...plan,
        eventType: "on_orchestrated_reply",
      }),
    });
  };

  const pendingChapterId = getPendingSessionChapterId(state);
  if (pendingChapterId) {
    const nextChapter = normalizeChapterOutput(await db("t_storyChapter").where({ id: pendingChapterId }).first());
    if (!nextChapter) {
      setPendingSessionChapterId(state, null);
      const eventView = buildEventView(state);
      return finalizeOrchestrationResult({
        sessionId,
        status: sessionStatus,
        chapterId: currentChapterId,
        expectedRole: "",
        expectedRoleType: "",
        currentEventDigest: eventView.currentEventDigest,
        eventDigestWindow: eventView.eventDigestWindow,
        eventDigestWindowText: eventView.eventDigestWindowText,
        plan: null,
      });
    }
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

  if (!recentMessages.length) {
    return buildChapterStartPlan(chapter);
  }
  if (canPlayerSpeakNow(state, world)) {
    const eventView = buildEventView(state);
    return finalizeOrchestrationResult({
      sessionId,
      status: sessionStatus,
      chapterId: Number(chapter.id || 0) || null,
      expectedRole: "",
      expectedRoleType: "",
      currentEventDigest: eventView.currentEventDigest,
      eventDigestWindow: eventView.eventDigestWindow,
      eventDigestWindowText: eventView.eventDigestWindowText,
      plan: null,
    });
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
  });
  applyOrchestratorResultToState(state, plan);
  applyNarrativeMemoryHintsToState(state, plan.memoryHints);
  const latestRecentMessage = recentMessages[recentMessages.length - 1];
  const mergedOutcome = evaluateRuntimeOutcome({
    chapter,
    state,
    messageContent: String(latestRecentMessage?.content || ""),
    eventType: String(latestRecentMessage?.eventType || "on_message"),
    meta: {},
    fallbackStatus: sessionStatus,
    fallbackChapterId: Number(chapter.id || 0) || null,
    applyToState: true,
  });

  let nextStatus = mergedOutcome.sessionStatus;
  let nextChapterId = mergedOutcome.nextChapterId;
  let nextChapter = chapter;
  if (mergedOutcome.outcome === "success") {
    const resolvedNextChapterId = Number(mergedOutcome.nextChapterId || 0)
      || await resolveNextChapterIdByOrder(db, Number(sessionRow.worldId || 0), Number(chapter.id || 0));
    if (resolvedNextChapterId && resolvedNextChapterId !== Number(chapter.id || 0)) {
      const resolvedNextChapter = normalizeChapterOutput(await db("t_storyChapter").where({ id: resolvedNextChapterId }).first());
      if (resolvedNextChapter) {
        if (String(plan.role || "").trim()) {
          setPendingSessionChapterId(state, resolvedNextChapterId);
        } else {
          nextChapter = resolvedNextChapter;
          nextChapterId = resolvedNextChapterId;
          return buildChapterStartPlan(resolvedNextChapter);
        }
      }
    }
  }
  applyPlanTurnStateToSessionState(state, world, plan);
  const eventView = buildEventView(state);
  const result: SessionOrchestrationResult = {
    sessionId,
    status: nextStatus,
    chapterId: nextChapterId,
    expectedRole: "",
    expectedRoleType: "",
    currentEventDigest: eventView.currentEventDigest,
    eventDigestWindow: eventView.eventDigestWindow,
    eventDigestWindowText: eventView.eventDigestWindowText,
    plan: buildSessionPlanResult({
      ...plan,
      eventType: "on_orchestrated_reply",
    }),
  };
  return finalizeOrchestrationResult(result);
}

export async function commitSessionNarrativeTurn(input: CommitSessionNarrativeTurnInput): Promise<AddSessionMessageResult> {
  const db = getGameDb();
  const now = nowTs();
  const sessionId = String(input.sessionId || "").trim();
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
  const world = await loadSessionWorld(db, Number(sessionRow.worldId || 0));
  const rolePair = normalizeRolePair(world?.playerRole, world?.narratorRole);
  const prevChapterId = Number(sessionRow.chapterId || 0) || null;
  const prevStatus = String(sessionRow.status || "active");
  const state = normalizeSessionState(
    input.state ?? sessionRow.stateJson,
    Number(sessionRow.worldId || 0),
    prevChapterId,
    rolePair,
    world,
  );
  const pendingPlan = getPendingSessionNarrativePlan(state);
  let nextChapterId = Number(input.chapterId || prevChapterId || 0) || null;
  let sessionStatus = String(input.status || prevStatus || "active").trim() || "active";
  const createTime = Number(input.createTime || now) || now;
  const insertedRows = await insertSessionNarrativeMessages({
    db,
    sessionId,
    state,
    messages: [{
      role: String(input.role || pendingPlan?.role || state.narrator?.name || "旁白"),
      roleType: String(input.roleType || pendingPlan?.roleType || "narrator"),
      eventType: String(input.eventType || pendingPlan?.eventType || "on_orchestrated_reply"),
      content: String(input.content || ""),
      createTime,
    }],
    now: createTime,
    eventTypeFallback: String(input.eventType || pendingPlan?.eventType || "on_orchestrated_reply"),
  });
  setPendingSessionNarrativePlan(state, null);
  const chapter = nextChapterId
    ? normalizeChapterOutput(await db("t_storyChapter").where({ id: nextChapterId }).first())
    : null;
  if (chapter) {
    const latestGeneratedMessage = insertedRows[insertedRows.length - 1];
    const mergedOutcome = evaluateRuntimeOutcome({
      chapter,
      state,
      messageContent: String(latestGeneratedMessage?.content || input.content || ""),
      eventType: String(latestGeneratedMessage?.eventType || input.eventType || pendingPlan?.eventType || "on_orchestrated_reply"),
      meta: {},
      fallbackStatus: sessionStatus,
      fallbackChapterId: nextChapterId,
      applyToState: true,
    });
    sessionStatus = mergedOutcome.sessionStatus;
    nextChapterId = mergedOutcome.nextChapterId;
    if (sessionStatus === "chapter_completed" && (!nextChapterId || nextChapterId === prevChapterId)) {
      const resolvedNextChapterId = await resolveNextChapterIdByOrder(db, Number(sessionRow.worldId || 0), prevChapterId);
      if (resolvedNextChapterId && resolvedNextChapterId !== prevChapterId) {
        nextChapterId = resolvedNextChapterId;
        sessionStatus = "active";
      }
    }
    initializeChapterProgressForState(chapter, state);
    syncChapterProgressWithRuntime(chapter, state);
  }
  const stateJson = toJsonText(state, {});
  await db("t_gameSession").where({ sessionId }).update({
    stateJson,
    chapterId: nextChapterId,
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
      nextChapterId,
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
  const activeChapter = nextChapterId
    ? normalizeChapterOutput(await db("t_storyChapter").where({ id: nextChapterId }).first())
    : null;
  const eventView = buildEventView(state);
  return {
    sessionId,
    status: sessionStatus,
    chapterId: nextChapterId,
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
