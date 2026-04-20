import {
  extractFirstChapterDialogueLine,
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
  resolveOpeningMessage,
  RuntimeMessageInput,
  setRuntimeTurnState,
  summarizeNarrativePlan,
} from "@/modules/game-runtime/engines/NarrativeOrchestrator";
import { syncChapterProgressWithRuntime } from "@/modules/game-runtime/engines/ChapterProgressEngine";

const CHAPTER_INITIAL_SNAPSHOT_KEY = "chapterInitialSnapshots";
const PUBLISH_FAILURE_REASON_KEY = "publishFailureReason";
// 初始快照不仅依赖章节文本，也依赖“开局运行态如何生成”的算法。
// 旧版本曾把首个章节事件提前标记完成；提升版本可让旧坏缓存自动失效。
const CHAPTER_INITIAL_SNAPSHOT_VERSION = "snapshot_v3";

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

function hashVersionText(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function snapshotRelevantWorldSettings(input: unknown): JsonRecord {
  const settings = parseJsonSafe<JsonRecord>(input, {});
  const next = { ...settings };
  delete next[CHAPTER_INITIAL_SNAPSHOT_KEY];
  delete next.publishStatus;
  delete next[PUBLISH_FAILURE_REASON_KEY];
  return next;
}

export function buildChapterInitialSnapshotVersion(world: unknown, chapter: unknown): string {
  const worldRecord = asRecord(world);
  const chapterRecord = asRecord(chapter);
  const payload = {
    worldId: Number(worldRecord.id || 0),
    playerRole: parseJsonSafe(worldRecord.playerRole, worldRecord.playerRole || {}),
    narratorRole: parseJsonSafe(worldRecord.narratorRole, worldRecord.narratorRole || {}),
    worldSettings: snapshotRelevantWorldSettings(worldRecord.settings),
    chapterId: Number(chapterRecord.id || 0),
    title: String(chapterRecord.title || ""),
    content: String(chapterRecord.content || ""),
    openingRole: String(chapterRecord.openingRole || ""),
    openingText: String(chapterRecord.openingText || ""),
    backgroundPath: String(chapterRecord.backgroundPath || ""),
    bgmPath: String(chapterRecord.bgmPath || ""),
    // 老章节没有显式字段时默认播放，避免历史数据升级后全部静音。
    bgmAutoPlay: chapterRecord.bgmAutoPlay === undefined || chapterRecord.bgmAutoPlay === null
      ? true
      : Number(chapterRecord.bgmAutoPlay) !== 0,
    showCompletionCondition: Boolean(chapterRecord.showCompletionCondition),
    completionCondition: chapterRecord.completionCondition || null,
    entryCondition: chapterRecord.entryCondition || null,
  };
  return `${CHAPTER_INITIAL_SNAPSHOT_VERSION}_${hashVersionText(toJsonText(payload, {}))}`;
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
  const contentVersion = buildChapterInitialSnapshotVersion(world, chapter);
  if (String(snapshot.contentVersion || "") !== contentVersion) return null;
  return snapshot;
}

/**
 * 生成章节开局应直接落库的初始消息列表。
 *
 * 用途：
 * - 章节初始快照必须和 `startSession` 首次未命中缓存时的行为保持一致；
 * - 这里只构造“开场白 + 正文第一条显式台词”，不执行任何自动编排；
 * - 这样正式会话始终从当前章节的第一事件起步，而不是提前推进到下一事件。
 */
function buildChapterInitialMessages(input: {
  world: JsonRecord;
  chapter: JsonRecord;
  state: JsonRecord;
  createTime: number;
}): RuntimeMessageInput[] {
  const messages: RuntimeMessageInput[] = [];
  const openingMessage = resolveOpeningMessage(input.world, input.chapter);
  if (openingMessage && String(openingMessage.content || "").trim()) {
    messages.push({
      role: String(openingMessage.role || input.state.narrator?.name || "旁白"),
      roleType: String(openingMessage.roleType || "narrator"),
      eventType: String(openingMessage.eventType || "on_enter_chapter"),
      content: String(openingMessage.content || ""),
      createTime: input.createTime,
    });
  }

  const firstDialogue = extractFirstChapterDialogueLine(input.chapter.content);
  const firstDialogueContent = String(firstDialogue?.line || "").trim();
  const openingContent = String(openingMessage?.content || "").trim();
  if (!firstDialogue || !firstDialogueContent || firstDialogueContent === openingContent) {
    return messages;
  }

  const firstDialogueRole = String(firstDialogue.role || "").trim();
  const narratorName = String(input.state.narrator?.name || "旁白").trim();
  const userName = String(input.state.player?.name || "用户").trim();
  let roleType = "npc";
  if (!firstDialogueRole || firstDialogueRole === narratorName || firstDialogueRole === "旁白") {
    roleType = "narrator";
  } else if (firstDialogueRole === userName || firstDialogueRole === "用户") {
    roleType = "player";
  }
  messages.push({
    role: firstDialogueRole || narratorName,
    roleType,
    eventType: "on_enter_chapter",
    content: firstDialogueContent,
    createTime: input.createTime + 1,
  });
  return messages;
}

// 预生成章节开局运行时快照，避免首次 startSession 同步等待初始化。
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
  const messages = buildChapterInitialMessages({
    world,
    chapter,
    state,
    createTime,
  });
  const plan: ReturnType<typeof summarizeNarrativePlan> = null;
  const normalizedContent = String(chapter.content || "").replace(/\r\n/g, "\n");
  const explicitDialogueCount = (normalizedContent.match(/^@[^:\n：]+\s*[:：]/gm) || []).length;
  const shouldWaitUserInput = explicitDialogueCount <= 1 && messages.length > 1;

  setRuntimeTurnState(state, world, {
    canPlayerSpeak: shouldWaitUserInput,
    expectedRoleType: shouldWaitUserInput ? "player" : "narrator",
    expectedRole: shouldWaitUserInput
      ? String(state.player?.name || "用户")
      : String(state.narrator?.name || "旁白"),
    lastSpeakerRoleType: String(messages[messages.length - 1]?.roleType || "narrator"),
    lastSpeaker: String(messages[messages.length - 1]?.role || state.narrator?.name || "旁白"),
  });
  // 初始快照只保留章节开局态，不允许在预热阶段自动推进章节事件。
  syncChapterProgressWithRuntime(chapter, state);

  return {
    world,
    snapshot: {
      chapterId: Number(chapter.id || 0),
      chapterTitle: String(chapter.title || ""),
      contentVersion: buildChapterInitialSnapshotVersion(world, chapter),
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
