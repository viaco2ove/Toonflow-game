import {
  getGameDb,
  JsonRecord,
  normalizeRolePair,
  normalizeSessionState,
  nowTs,
  parseJsonSafe,
  toJsonText,
} from "@/lib/gameEngine";
import { ensureWorldRolesWithAiParameterCards } from "@/lib/roleParameterCard";
import {
  advanceNarrativeUntilPlayerTurn,
  applyNarrativeMemoryHintsToState,
  resolveOpeningMessage,
  runNarrativeOrchestrator,
  RuntimeMessageInput,
  setRuntimeTurnState,
  summarizeNarrativePlan,
} from "@/modules/game-runtime/engines/NarrativeOrchestrator";

const CHAPTER_INITIAL_SNAPSHOT_KEY = "chapterInitialSnapshots";

export interface ChapterInitialSnapshotCache {
  chapterId: number;
  chapterTitle: string;
  contentVersion: string;
  stateJson: string;
  messages: RuntimeMessageInput[];
  plan: ReturnType<typeof summarizeNarrativePlan> | null;
  createTime: number;
}

function asRecord(input: unknown): JsonRecord {
  return input && typeof input === "object" && !Array.isArray(input) ? input as JsonRecord : {};
}

function buildContentVersion(world: any, chapter: any, now: number): string {
  const worldVersion = Number(world?.updateTime || world?.createTime || now);
  const chapterVersion = Number(chapter?.updateTime || chapter?.createTime || 0);
  const worldId = Number(world?.id || 0);
  const chapterId = Number(chapter?.id || 0);

  if (chapterId > 0 && chapterVersion > 0) {
    return `w:${worldId}@${worldVersion};c:${chapterId}@${chapterVersion}`;
  }
  return `w:${worldId}@${worldVersion}`;
}

function parseWorldSettings(input: unknown): JsonRecord {
  return parseJsonSafe<JsonRecord>(input, {});
}

function getSnapshotMap(settings: JsonRecord): Record<string, ChapterInitialSnapshotCache> {
  const raw = asRecord(settings[CHAPTER_INITIAL_SNAPSHOT_KEY]);
  return raw as Record<string, ChapterInitialSnapshotCache>;
}

export function readChapterInitialSnapshotCache(input: {
  world: unknown;
  chapter: unknown;
}): ChapterInitialSnapshotCache | null {
  const world = asRecord(input.world);
  const chapter = asRecord(input.chapter);
  const chapterId = Number(chapter.id || 0);
  if (!chapterId) return null;
  const settings = parseWorldSettings(world.settings);
  const snapshot = getSnapshotMap(settings)[String(chapterId)];
  if (!snapshot) return null;
  const contentVersion = buildContentVersion(world, chapter, nowTs());
  if (String(snapshot.contentVersion || "") !== contentVersion) return null;
  return snapshot;
}

// 预生成章节第一轮运行时快照，避免首次 startSession 同步等待开场编排。
export async function buildChapterInitialSnapshotCache(input: {
  userId: number;
  world: unknown;
  chapter: unknown;
}): Promise<{
  world: JsonRecord;
  snapshot: ChapterInitialSnapshotCache;
}> {
  const world = await ensureWorldRolesWithAiParameterCards({
    userId: Number(input.userId || 0),
    world: input.world,
    persist: false,
  });
  const chapter = asRecord(input.chapter);
  const rolePair = normalizeRolePair(world.playerRole, world.narratorRole);
  const state = normalizeSessionState(null, Number(world.id || 0), Number(chapter.id || 0), rolePair, world);
  const createTime = nowTs();
  const messages: RuntimeMessageInput[] = [];
  let plan: ReturnType<typeof summarizeNarrativePlan> = null;

  const openingMessage = resolveOpeningMessage(world, chapter);
  if (openingMessage && String(openingMessage.content || "").trim()) {
    messages.push({
      role: String(openingMessage.role || state.narrator?.name || "旁白"),
      roleType: String(openingMessage.roleType || "narrator"),
      eventType: String(openingMessage.eventType || "on_enter_chapter"),
      content: String(openingMessage.content || ""),
      createTime,
    });
  }

  setRuntimeTurnState(state, world, {
    canPlayerSpeak: false,
    expectedRoleType: "narrator",
    expectedRole: String(state.narrator?.name || "旁白"),
    lastSpeakerRoleType: String(messages[messages.length - 1]?.roleType || "narrator"),
    lastSpeaker: String(messages[messages.length - 1]?.role || state.narrator?.name || "旁白"),
  });

  const orchestrator = await runNarrativeOrchestrator({
    userId: Number(input.userId || 0),
    world,
    chapter,
    state,
    recentMessages: messages,
    playerMessage: "",
    maxRetries: 0,
  });
  const orchestrated = await advanceNarrativeUntilPlayerTurn({
    userId: Number(input.userId || 0),
    world,
    chapter,
    state,
    recentMessages: messages,
    playerMessage: "",
    initialResult: orchestrator,
    maxAutoTurns: 1,
  });
  plan = summarizeNarrativePlan(orchestrator);
  messages.push(...orchestrated.messages);
  applyNarrativeMemoryHintsToState(state, orchestrator.memoryHints);

  return {
    world,
    snapshot: {
      chapterId: Number(chapter.id || 0),
      chapterTitle: String(chapter.title || ""),
      contentVersion: buildContentVersion(world, chapter, createTime),
      stateJson: toJsonText(state, {}),
      messages,
      plan,
      createTime,
    },
  };
}

// 保存世界或章节后异步预热首轮快照，让第一次进入故事时直接复用缓存结果。
export async function prewarmChapterInitialSnapshotCache(input: {
  userId: number;
  world: unknown;
  chapter: unknown;
}): Promise<void> {
  const sourceWorld = asRecord(input.world);
  const chapter = asRecord(input.chapter);
  const worldId = Number(sourceWorld.id || 0);
  const chapterId = Number(chapter.id || 0);
  if (!worldId || !chapterId) return;

  const { world, snapshot } = await buildChapterInitialSnapshotCache(input);
  const settings = parseWorldSettings(world.settings);
  const snapshotMap = getSnapshotMap(settings);
  snapshotMap[String(chapterId)] = snapshot;
  const nextSettings = {
    ...settings,
    [CHAPTER_INITIAL_SNAPSHOT_KEY]: snapshotMap,
  };

  await getGameDb()("t_storyWorld")
    .where({ id: worldId })
    .update({
      playerRole: toJsonText(world.playerRole, {}),
      narratorRole: toJsonText(world.narratorRole, {}),
      settings: toJsonText(nextSettings, {}),
      updateTime: nowTs(),
    });
}
