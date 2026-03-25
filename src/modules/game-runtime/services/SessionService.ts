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
  applyMemoryResultToState,
  applyOrchestratorResultToState,
  resolveOpeningMessage,
  runNarrativeOrchestrator,
  runStoryMemoryManager,
} from "@/modules/game-runtime/engines/NarrativeOrchestrator";
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

  pushRecentEvent(state, {
    messageId,
    eventType: eventTypeValue,
    roleType: roleTypeValue,
    contentPreview: messageContent.slice(0, 120),
    time: now,
  });

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
      const inserted = await db("t_sessionMessage").insert({
        sessionId,
        role: String(openingMessage.role || state.narrator?.name || "旁白"),
        roleType: String(openingMessage.roleType || "narrator"),
        content: String(openingMessage.content || `进入章节《${String(switchedChapter.title || "未命名章节")}》`),
        eventType: String(openingMessage.eventType || "on_enter_chapter"),
        meta: toJsonText({ chapterId: Number(switchedChapter.id) }, {}),
        createTime: now,
      });
      const switchMessageId = normalizeMessageId(inserted);
      chapterSwitchMessageRow = await db("t_sessionMessage").where({ id: switchMessageId }).first();
    }
  } else if (roleTypeValue === "player" && eventTypeValue === "on_message" && messageContent.trim()) {
    const currentChapter = nextChapterId
      ? normalizeChapterOutput(await db("t_storyChapter").where({ id: nextChapterId }).first())
      : null;
    if (currentChapter) {
      const rawRecentMessages = await db("t_sessionMessage").where({ sessionId }).orderBy("id", "desc").limit(20);
      const recentMessages = rawRecentMessages
        .reverse()
        .map((item: any) => ({
          role: String(item.role || ""),
          roleType: String(item.roleType || ""),
          eventType: String(item.eventType || ""),
          content: String(item.content || ""),
          createTime: Number(item.createTime || 0),
        }));
      const orchestrator = await runNarrativeOrchestrator({
        userId: currentUserId,
        world,
        chapter: currentChapter,
        state,
        recentMessages,
        playerMessage: messageContent,
      });
      applyOrchestratorResultToState(state, orchestrator);
      const inserted = await db("t_sessionMessage").insert({
        sessionId,
        role: orchestrator.role,
        roleType: orchestrator.roleType,
        content: orchestrator.content,
        eventType: "on_orchestrated_reply",
        meta: toJsonText({
          source: orchestrator.source,
          memoryHints: orchestrator.memoryHints,
        }, {}),
        createTime: now,
      });
      const narrativeMessageId = normalizeMessageId(inserted);
      narrativeMessageRow = await db("t_sessionMessage").where({ id: narrativeMessageId }).first();

      const memory = await runStoryMemoryManager({
        userId: currentUserId,
        world,
        chapter: currentChapter,
        state,
        recentMessages: [
          ...recentMessages,
          {
            role: orchestrator.role,
            roleType: orchestrator.roleType,
            eventType: "on_orchestrated_reply",
            content: orchestrator.content,
            createTime: now,
          },
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
