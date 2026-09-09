import {
  getGameDb,
  normalizeChapterOutput,
  normalizeRolePair,
  normalizeSessionState,
  nowTs,
  parseJsonSafe,
  toJsonText,
} from "@/lib/gameEngine";
import {
  refreshStoryMemoryBestEffort,
  normalizeScalarText,
  runtimeStoryRoles,
} from "@/modules/game-runtime/engines/NarrativeOrchestrator";
import {
  bootstrapRoleMemoriesFromCards,
  persistRoleMemoryFacts,
} from "@/modules/game-runtime/services/RoleMemoryService";
import { loadPublishedChapter, loadPublishedWorld } from "@/modules/game-runtime/services/publishedRuntime";

type JsonRecord = Record<string, any>;

const POLL_INTERVAL_MS = 30_000;
const RETRY_INTERVAL_MS = 60_000;
const ACTIVE_STATUSES = ["active", "chapter_completed"];

let workerTimer: ReturnType<typeof setInterval> | null = null;
let workerRunning = false;
let currentPollInterval = POLL_INTERVAL_MS;
let lastPollSuccess = true;

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

async function loadWorldForSession(db: any, worldId: number, userId: number, worldPublishId?: number) {
  // 方向2：优先读发布表快照（与 runtime 一致）；无 worldPublishId 回退草稿（兼容旧 session）。
  if (Number.isFinite(worldPublishId) && worldPublishId && worldPublishId > 0) {
    const published = await loadPublishedWorld(worldId, db);
    if (published) {
      return { world: published, ownerUserId: 0 };
    }
  }
  let world = await db("t_storyWorld as w")
    .leftJoin("t_project as p", "w.projectId", "p.id")
    .where("w.id", worldId)
    .select("w.*", "p.userId as ownerUserId")
    .first();
  if (!world) return null;
  return {
    world,
    ownerUserId: Number(world.ownerUserId || 0),
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

  const worldResult = await loadWorldForSession(db, worldId, sessionUserId, Number(row?.worldPublishId || 0));
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

  // 方向2：runtime 读发布章节快照；无 worldPublishId 回退草稿（兼容旧 session）。
  const worldPublishId = Number(row?.worldPublishId || 0);
  const chapter = worldPublishId > 0
    ? await loadPublishedChapter(worldPublishId, chapterId, db)
    : normalizeChapterOutput(await db("t_storyChapter").where({ id: chapterId }).first());
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

    // ★ 本 worker 是记忆链路的另一半：编排链路（SessionService）之外，
    //   这里是唯一会主动跑记忆管理器 AI 的后台线程，必须同样落在 t_role_memory 上，
    //   否则走 worker 刷新的会话（用户静默 / 编排没跑）会一直写不进角色记忆表。
    void persistRoleMemoryFacts({
      sessionId,
      storyId: String(worldId),
      chapterId,
      roleNames: runtimeStoryRoles(worldResult.world, state)
        .filter((item) => !["player", "narrator"].includes(item.roleType))
        .map((item) => normalizeScalarText(item.name))
        .filter(Boolean),
      playerRoleName: normalizeScalarText(
        runtimeStoryRoles(worldResult.world, state).find((item) => item.roleType === "player")?.name,
      ),
      memoryFacts: Array.isArray(memory?.facts)
        ? memory.facts.map((item) => String(item || "").trim()).filter(Boolean)
        : [],
      sourceTurn: latestMessageId > 0 ? latestMessageId : null,
    });
    // ★ 冷启动兜底同上：给"零记忆"的在场角色从参数卡补一条
    void bootstrapRoleMemoriesFromCards({
      sessionId,
      storyId: String(worldId),
      chapterId,
      state,
      sourceTurn: latestMessageId > 0 ? latestMessageId : null,
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
    if (!lastPollSuccess) {
      console.log("[session-memory-worker] poll recovered");
    }
    lastPollSuccess = true;
    if (currentPollInterval !== POLL_INTERVAL_MS) {
      currentPollInterval = POLL_INTERVAL_MS;
      restartWorkerTimer();
    }
  } catch (err) {
    if (lastPollSuccess) {
      console.warn("[session-memory-worker] poll failed (will retry slower)", {
        message: (err as any)?.message || String(err),
      });
    }
    lastPollSuccess = false;
    if (currentPollInterval < RETRY_INTERVAL_MS) {
      currentPollInterval = RETRY_INTERVAL_MS;
      restartWorkerTimer();
    }
  } finally {
    workerRunning = false;
  }
}

function restartWorkerTimer() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
  workerTimer = setInterval(() => {
    void pollSessionMemory();
  }, currentPollInterval);
}

export function startSessionMemoryWorker() {
  if (workerTimer) return;
  currentPollInterval = POLL_INTERVAL_MS;
  lastPollSuccess = true;
  restartWorkerTimer();
  void pollSessionMemory();
}

export function stopSessionMemoryWorker() {
  if (!workerTimer) return;
  clearInterval(workerTimer);
  workerTimer = null;
}
