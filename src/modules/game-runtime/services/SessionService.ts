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
import { getCurrentUserId } from "@/lib/requestContext";
import {
  advanceNarrativeUntilPlayerTurn,
  applyMemoryResultToState,
  RuntimeMessageInput,
  allowPlayerTurn,
  canPlayerSpeakNow,
  resolveOpeningMessage,
  runNarrativeOrchestrator,
  runStoryMemoryManager,
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
  state: Record<string, any>;
  message: Record<string, any> | null;
  chapterSwitchMessage: Record<string, any> | null;
  narrativeMessage: Record<string, any> | null;
  triggered: TriggerHit[];
  taskProgress: TaskProgressChange[];
  deltas: AppliedDelta[];
  snapshotSaved: boolean;
  snapshotReason: string;
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
      role: String(item.role || ""),
      roleType: String(item.roleType || ""),
      eventType: String(item.eventType || ""),
      content: String(item.content || ""),
      createTime: Number(item.createTime || 0),
    }));
}

function resolveDefaultRoleName(roleType: string, state: Record<string, any>): string {
  if (roleType === "player") return String(state.player?.name || "玩家");
  if (roleType === "narrator") return String(state.narrator?.name || "旁白");
  return "系统";
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

  const world = await db("t_storyWorld").where({ id: Number(sessionRow.worldId || 0) }).first();
  const rolePair = normalizeRolePair(world?.playerRole, world?.narratorRole);
  const prevChapterId = Number(sessionRow.chapterId || 0) || null;
  const prevStatus = String(sessionRow.status || "active");

  const state = normalizeSessionState(
    sessionRow.stateJson,
    Number(sessionRow.worldId || 0),
    prevChapterId,
    rolePair,
  );
  state.round = Number(state.round || 0) + 1;

  const roleTypeValue = String(input.roleType || "player").trim() || "player";
  const roleValue = String(input.role || resolveDefaultRoleName(roleTypeValue, state)).trim() || "系统";
  const eventTypeValue = String(input.eventType || "on_message").trim() || "on_message";
  const messageContent = String(input.content || "");
  const metaObj = parseJsonMaybe(input.meta);

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
        state,
        message: normalizeMessageOutput(messageRow),
        chapterSwitchMessage: null,
        narrativeMessage: normalizeMessageOutput(narrativeMessageRow),
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
  const nextChapterId = taskResult.nextChapterId;
  const sessionStatus = taskResult.sessionStatus;
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
  if (nextChapterId && nextChapterId !== prevChapterId) {
    const switchedChapter = normalizeChapterOutput(await db("t_storyChapter").where({ id: nextChapterId }).first());
    if (switchedChapter) {
      const openingMessage = resolveOpeningMessage(world, switchedChapter);
      const openingRuntimeMessage: RuntimeMessageInput = {
        role: String(openingMessage.role || state.narrator?.name || "旁白"),
        roleType: String(openingMessage.roleType || "narrator"),
        eventType: String(openingMessage.eventType || "on_enter_chapter"),
        content: String(openingMessage.content || `进入章节《${String(switchedChapter.title || "未命名章节")}》`),
        createTime: now,
      };
      const inserted = await db("t_sessionMessage").insert({
        sessionId,
        role: String(openingRuntimeMessage.role || state.narrator?.name || "旁白"),
        roleType: String(openingRuntimeMessage.roleType || "narrator"),
        content: String(openingRuntimeMessage.content || ""),
        eventType: String(openingRuntimeMessage.eventType || "on_enter_chapter"),
        meta: toJsonText({ chapterId: Number(switchedChapter.id) }, {}),
        createTime: Number(openingRuntimeMessage.createTime || now),
      });
      const switchMessageId = normalizeMessageId(inserted);
      chapterSwitchMessageRow = await db("t_sessionMessage").where({ id: switchMessageId }).first();
      allowPlayerTurn(
        state,
        world,
        String(openingRuntimeMessage.roleType || "narrator"),
        String(openingRuntimeMessage.role || state.narrator?.name || "旁白"),
      );

      const memory = await runStoryMemoryManager({
        userId: currentUserId,
        world,
        chapter: switchedChapter,
        state,
        recentMessages: [openingRuntimeMessage],
      });
      applyMemoryResultToState(state, memory);
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
      });
      const orchestrated = await advanceNarrativeUntilPlayerTurn({
        userId: currentUserId,
        world,
        chapter: playChapter,
        state,
        recentMessages,
        playerMessage: messageContent,
        initialResult: orchestrator,
      });

      for (const item of orchestrated.messages) {
        const inserted = await db("t_sessionMessage").insert({
          sessionId,
          role: String(item.role || state.narrator?.name || "旁白"),
          roleType: String(item.roleType || "narrator"),
          content: String(item.content || ""),
          eventType: String(item.eventType || "on_orchestrated_reply"),
          meta: toJsonText({
            source: orchestrator.source,
            memoryHints: orchestrator.memoryHints,
          }, {}),
          createTime: Number(item.createTime || now),
        });
        const narrativeMessageId = normalizeMessageId(inserted);
        narrativeMessageRow = await db("t_sessionMessage").where({ id: narrativeMessageId }).first();
      }

      const memory = await runStoryMemoryManager({
        userId: currentUserId,
        world,
        chapter: playChapter,
        state,
        recentMessages: [
          ...recentMessages,
          ...orchestrated.messages,
        ],
      });
      applyMemoryResultToState(state, memory);
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

  const messageRow = await db("t_sessionMessage").where({ id: messageId }).first();
  return {
    sessionId,
    status: sessionStatus,
    chapterId: nextChapterId,
    state,
    message: normalizeMessageOutput(messageRow),
    chapterSwitchMessage: normalizeMessageOutput(chapterSwitchMessageRow),
    narrativeMessage: normalizeMessageOutput(narrativeMessageRow),
    triggered,
    taskProgress: taskResult.taskProgressChanges,
    deltas: appliedDeltas,
    snapshotSaved: snapshotResult.snapshotSaved,
    snapshotReason: snapshotResult.snapshotReason,
  };
}
