import {
  getGameDb,
  normalizeChapterOutput,
  normalizeMessageOutput,
  normalizeRolePair,
  normalizeSessionState,
  nowTs,
  parseJsonSafe,
  toJsonText,
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
  applyPlayerProfileFromMessageToState,
  canPlayerSpeakNow,
  resolveOpeningMessage,
  runNarrativeOrchestrator,
  setRuntimeTurnState,
  summarizeNarrativePlan,
  triggerStoryMemoryRefreshInBackground,
} from "@/modules/game-runtime/engines/NarrativeOrchestrator";
import { handleMiniGameTurn } from "@/modules/game-runtime/engines/MiniGameController";
import { runTaskProgressEngine } from "@/modules/game-runtime/engines/TaskProgressEngine";
import {
  applyAttributeChanges,
  runTriggerEngine,
} from "@/modules/game-runtime/engines/TriggerEngine";
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
}

export interface AddSessionMessageResult {
  sessionId: string;
  status: string;
  chapterId: number | null;
  chapter: Record<string, any> | null;
  state: Record<string, any>;
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
      role: String(item.role || ""),
      roleType: String(item.roleType || ""),
      eventType: String(item.eventType || ""),
      content: String(item.content || ""),
      createTime: Number(item.createTime || 0),
    }));
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
        ? state.player?.name || "玩家"
        : turnState.expectedRole || "",
    ).trim(),
    nextRoleType: String(
      canPlayerSpeakNow
        ? "player"
        : turnState.expectedRoleType || "",
    ).trim(),
  };
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
      await getGameDb()("t_gameSession").where({ sessionId: params.sessionId }).update({
        stateJson: toJsonText(latestState, {}),
        updateTime: nowTs(),
      });
    },
  });
}

async function loadSessionWorldWithEnsuredRoles(db: any, worldId: number, currentUserId: number) {
  let world = await db("t_storyWorld as w")
    .leftJoin("t_project as p", "w.projectId", "p.id")
    .where("w.id", worldId)
    .select("w.*", "p.userId as ownerUserId")
    .first();
  if (!world) return null;
  const ownerUserId = Number(world.ownerUserId || 0);
  world = await ensureWorldRolesWithAiParameterCards({
    userId: ownerUserId > 0 ? ownerUserId : currentUserId,
    world,
    persist: ownerUserId > 0 && ownerUserId === currentUserId,
  });
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

  const world = await loadSessionWorldWithEnsuredRoles(db, Number(sessionRow.worldId || 0), currentUserId);
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

  if (roleTypeValue === "player" && eventTypeValue === "on_message" && messageContent.trim() && !canPlayerSpeakNow(state, world)) {
    throw new SessionServiceError(409, "当前还没轮到用户发言");
  }

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
      const orchestrator = await runNarrativeOrchestrator({
        userId: currentUserId,
        world,
        chapter: switchedChapter,
        state,
        recentMessages: transitionMessages,
        playerMessage: "",
        maxRetries: 0,
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
    const rawRecentMessagesForMemory = await db("t_sessionMessage").where({ sessionId }).orderBy("id", "desc").limit(20);
    scheduleSessionMemoryRefresh({
      sessionId,
      userId: currentUserId,
      world,
      chapter: asyncMemoryRefreshChapter,
      state,
      recentMessages: buildRecentMessages(rawRecentMessagesForMemory),
    });
  }

  const messageRow = await db("t_sessionMessage").where({ id: messageId }).first();
  const activeChapter = nextChapterId
    ? normalizeChapterOutput(await db("t_storyChapter").where({ id: nextChapterId }).first())
    : null;
  return {
    sessionId,
    status: sessionStatus,
    chapterId: nextChapterId,
    chapter: activeChapter,
    state,
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
  const world = await loadSessionWorldWithEnsuredRoles(db, Number(sessionRow.worldId || 0), currentUserId);
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
  const sessionStatus = orchestrator.chapterOutcome === "failed" ? "failed" : prevStatus;
  const stateJson = toJsonText(state, {});
  await db("t_gameSession").where({ sessionId }).update({
    stateJson,
    chapterId: prevChapterId,
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
      nextChapterId: prevChapterId,
      prevChapterId,
      sessionStatus,
      prevStatus,
      round: Number(state.round || 0),
    },
  });

  if (orchestrator.triggerMemoryAgent) {
    const recentMessagesForMemory = [
      ...recentMessages,
      ...generatedMessages.map((item) => ({
        role: String(item.role || ""),
        roleType: String(item.roleType || ""),
        eventType: String(item.eventType || ""),
        content: String(item.content || ""),
        createTime: Number(item.createTime || now),
      })),
    ];
    scheduleSessionMemoryRefresh({
      sessionId,
      userId: currentUserId,
      world,
      chapter,
      state,
      recentMessages: recentMessagesForMemory.slice(-20),
    });
  }

  return {
    sessionId,
    status: sessionStatus,
    chapterId: prevChapterId,
    chapter,
    state,
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
