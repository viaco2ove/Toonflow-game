import {
  getGameDb,
  normalizeChapterOutput,
  normalizeRolePair,
  normalizeSessionState,
  nowTs,
  parseJsonSafe,
  toJsonText,
} from "@/lib/gameEngine";
import { ensureWorldRolesWithAiParameterCards } from "@/lib/roleParameterCard";
import { refreshStoryMemoryBestEffort } from "@/modules/game-runtime/engines/NarrativeOrchestrator";

type JsonRecord = Record<string, any>;

const POLL_INTERVAL_MS = 30_000;
const ACTIVE_STATUSES = ["active", "chapter_completed"];

let workerTimer: ReturnType<typeof setInterval> | null = null;
let workerRunning = false;

function asRecord(input: unknown): JsonRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return { ...(input as JsonRecord) };
}

function buildRecentMessages(rows: any[]) {
  return rows
    .slice()
    .reverse()
    .map((item: any) => ({
      role: String(item.role || ""),
      roleType: String(item.roleType || ""),
      eventType: String(item.eventType || ""),
      content: String(item.content || ""),
      createTime: Number(item.createTime || 0),
    }));
}

async function loadWorldForSession(db: any, worldId: number, userId: number) {
  let world = await db("t_storyWorld as w")
    .leftJoin("t_project as p", "w.projectId", "p.id")
    .where("w.id", worldId)
    .select("w.*", "p.userId as ownerUserId")
    .first();
  if (!world) return null;
  const ownerUserId = Number(world.ownerUserId || 0);
  world = await ensureWorldRolesWithAiParameterCards({
    userId: ownerUserId > 0 ? ownerUserId : userId,
    world,
    persist: ownerUserId > 0 && ownerUserId === userId,
  });
  return {
    world,
    ownerUserId,
  };
}

async function processSessionMemory(row: any) {
  const db = getGameDb();
  const sessionId = String(row?.sessionId || "").trim();
  if (!sessionId) return;

  const sessionUserId = Number(row?.userId || 0);
  const worldId = Number(row?.worldId || 0);
  if (!Number.isFinite(sessionUserId) || sessionUserId <= 0 || !Number.isFinite(worldId) || worldId <= 0) {
    return;
  }

  const worldResult = await loadWorldForSession(db, worldId, sessionUserId);
  if (!worldResult?.world) return;

  const rolePair = normalizeRolePair(worldResult.world.playerRole, worldResult.world.narratorRole);
  const provisionalChapterId = Number(row.chapterId || 0) || null;
  const state = normalizeSessionState(
    row.stateJson,
    worldId,
    provisionalChapterId,
    rolePair,
    worldResult.world,
  );
  const chapterId = Number(state.chapterId || provisionalChapterId || 0) || null;
  if (!chapterId) return;

  const chapter = normalizeChapterOutput(await db("t_storyChapter").where({ id: chapterId }).first());
  if (!chapter) return;

  const rawRecentMessages = await db("t_sessionMessage")
    .where({ sessionId })
    .orderBy("id", "desc")
    .limit(20);
  if (!rawRecentMessages.length) return;

  const latestMessage = rawRecentMessages[0];
  const latestMessageId = Number(latestMessage?.id || 0);
  const latestMessageTime = Number(latestMessage?.createTime || 0);
  const workerState = asRecord(state.memoryWorker);
  const lastProcessedMessageId = Number(workerState.lastProcessedMessageId || 0);
  if (latestMessageId > 0 && latestMessageId <= lastProcessedMessageId) {
    return;
  }

  const recentMessages = buildRecentMessages(rawRecentMessages);
  try {
    const memory = await refreshStoryMemoryBestEffort({
      userId: worldResult.ownerUserId > 0 ? worldResult.ownerUserId : sessionUserId,
      world: worldResult.world,
      chapter,
      state,
      recentMessages,
    });
    state.memoryWorker = {
      ...workerState,
      lastProcessedMessageId: latestMessageId,
      lastProcessedMessageCreateTime: latestMessageTime,
      lastRunTime: nowTs(),
      lastError: "",
      lastResultSummary: String(memory?.summary || "").trim(),
    };
    await db("t_gameSession")
      .where({ sessionId })
      .update({
        stateJson: toJsonText(state, {}),
      });
  } catch (err) {
    state.memoryWorker = {
      ...workerState,
      lastProcessedMessageId,
      lastProcessedMessageCreateTime: Number(workerState.lastProcessedMessageCreateTime || 0),
      lastRunTime: nowTs(),
      lastError: (err as any)?.message || String(err),
    };
    await db("t_gameSession")
      .where({ sessionId })
      .update({
        stateJson: toJsonText(state, {}),
      });
  }
}

async function pollSessionMemory() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    const db = getGameDb();
    const rows = await db("t_gameSession")
      .whereIn("status", ACTIVE_STATUSES)
      .orderBy("updateTime", "desc")
      .limit(48);
    for (const row of rows) {
      await processSessionMemory(row);
    }
  } catch (err) {
    console.warn("[session-memory-worker] poll failed", {
      message: (err as any)?.message || String(err),
    });
  } finally {
    workerRunning = false;
  }
}

export function startSessionMemoryWorker() {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    void pollSessionMemory();
  }, POLL_INTERVAL_MS);
  void pollSessionMemory();
}

export function stopSessionMemoryWorker() {
  if (!workerTimer) return;
  clearInterval(workerTimer);
  workerTimer = null;
}
