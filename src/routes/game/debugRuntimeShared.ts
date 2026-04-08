import express from "express";
import { z } from "zod";
import fs from "fs";
import path from "path";
import {
  ChapterRuntimeOutline,
  normalizeChapterOutput,
  normalizeMessageOutput,
  normalizeRolePair,
  normalizeSessionState,
  nowTs,
  readDefaultRuntimeEventViewState,
  readChapterProgressState,
} from "@/lib/gameEngine";
import {
  advanceChapterProgressAfterNarrative,
  initializeChapterProgressForState,
  markCurrentUserNodeCompleted,
  recordChapterProgressSignals,
  syncChapterProgressWithRuntime,
} from "@/modules/game-runtime/engines/ChapterProgressEngine";
import {
  resolveOpeningMessage,
  RuntimeMessageInput,
  setRuntimeTurnState,
} from "@/modules/game-runtime/engines/NarrativeOrchestrator";
import { evaluateRuntimeOutcome } from "@/modules/game-runtime/services/ChapterRuntimeService";
import {
  AppliedDelta,
  TaskProgressChange,
  TriggerHit,
} from "@/modules/game-runtime/types/runtime";
import { getTmpDebugRevisitDir } from "@/lib/runtimePaths";

const router = express.Router();

// ==================== 回溯功能（内存 + 临时文件两级存储）====================
//
// 设计：
//   - 内存层：每个 debugRuntimeKey 保留最近 DEBUG_REVISIT_HOT_SIZE 条，热数据直接命中
//   - 文件层：溢出到 getTmpDebugRevisitDir()/<debugRuntimeKey>.json，无限量，按需加载
//   - 销毁：clearDebugRevisitHistory() 主动销毁 或 进程退出时清空整个 tmp 目录
//

const DEBUG_REVISIT_HOT_SIZE = 5; // 内存保留最近 N 条

interface DebugRevisitPoint {
  debugRuntimeKey: string;
  messageCount: number;
  state: Record<string, any>;
  messages: RuntimeMessageInput[];
  round: number;
  chapterId: number | null;
  createdAt: number;
}

// 内存层：key -> 最近 N 条（按 messageCount 升序）
const DEBUG_REVISIT_HOT = new Map<string, DebugRevisitPoint[]>();

// ---- 临时文件路径 ----

function sanitizeKey(key: string): string {
  // 只允许字母/数字/下划线/连字符，防止路径穿越
  return key.replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 128);
}

function getRevisitFilePath(debugRuntimeKey: string): string {
  const dir = getTmpDebugRevisitDir();
  return path.join(dir, `${sanitizeKey(debugRuntimeKey)}.json`);
}

function ensureRevisitDir(): void {
  const dir = getTmpDebugRevisitDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---- 文件层读写 ----

function readRevisitFile(debugRuntimeKey: string): DebugRevisitPoint[] {
  try {
    const filePath = getRevisitFilePath(debugRuntimeKey);
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as DebugRevisitPoint[];
  } catch {
    return [];
  }
}

function writeRevisitFile(debugRuntimeKey: string, points: DebugRevisitPoint[]): void {
  try {
    ensureRevisitDir();
    const filePath = getRevisitFilePath(debugRuntimeKey);
    fs.writeFileSync(filePath, JSON.stringify(points), "utf8");
  } catch (e) {
    console.warn("[debug:revisit] failed to write tmp file:", e);
  }
}

function deleteRevisitFile(debugRuntimeKey: string): void {
  try {
    const filePath = getRevisitFilePath(debugRuntimeKey);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

// ---- 公开 API ----

export function saveDebugRevisitPoint(
  debugRuntimeKey: string,
  state: Record<string, any>,
  messages: RuntimeMessageInput[],
  chapterId: number | null,
  messageCountOverride?: number | null,
): void {
  const normalizedMessageCount = Number(messageCountOverride ?? state?.debugMessageCount ?? messages.length);
  const newPoint: DebugRevisitPoint = {
    debugRuntimeKey,
    messageCount: Number.isFinite(normalizedMessageCount) && normalizedMessageCount > 0
      ? normalizedMessageCount
      : messages.length,
    state: cloneDebugRuntimeState(state),
    messages: cloneDebugRuntimeState(messages),
    round: Number(state.round || 0),
    chapterId,
    createdAt: nowTs(),
  };

  // 每次保存都同时更新内存层和文件层。
  // 内存层只保留最近 N 条做热命中，文件层保存完整历史，避免进程重启/热更新后回溯点丢失。
  const hot = DEBUG_REVISIT_HOT.get(debugRuntimeKey) || [];
  const filePoints = readRevisitFile(debugRuntimeKey);
  const merged = [...filePoints, ...hot, newPoint]
    .reduce<DebugRevisitPoint[]>((acc, point) => {
      const existingIndex = acc.findIndex((item) => item.messageCount === point.messageCount);
      if (existingIndex >= 0) {
        acc[existingIndex] = point;
      } else {
        acc.push(point);
      }
      return acc;
    }, [])
    .sort((left, right) => left.messageCount - right.messageCount);

  DEBUG_REVISIT_HOT.set(debugRuntimeKey, merged.slice(-DEBUG_REVISIT_HOT_SIZE));
  writeRevisitFile(debugRuntimeKey, merged);
}

export function getDebugRevisitPoint(
  debugRuntimeKey: string,
  messageCount: number
): DebugRevisitPoint | null {
  const normalizedMessageCount = Number(messageCount || 0);
  // 1. 先查内存
  const hot = DEBUG_REVISIT_HOT.get(debugRuntimeKey) || [];
  const hotHit = hot.find(p => p.messageCount === normalizedMessageCount);
  if (hotHit) return hotHit;

  // 2. 再查文件
  const filePoints = readRevisitFile(debugRuntimeKey);
  const exactFileHit = filePoints.find(p => p.messageCount === normalizedMessageCount);
  if (exactFileHit) return exactFileHit;

  // 3. 精确命中不到时，回退到最近且不超过请求值的回溯点，避免因为计数口径差 1 条而直接失败。
  const merged = [...hot, ...filePoints]
    .reduce<DebugRevisitPoint[]>((acc, point) => {
      const existingIndex = acc.findIndex((item) => item.messageCount === point.messageCount);
      if (existingIndex >= 0) {
        acc[existingIndex] = point;
      } else {
        acc.push(point);
      }
      return acc;
    }, [])
    .sort((left, right) => left.messageCount - right.messageCount);
  const fallback = [...merged].reverse().find((point) => point.messageCount <= normalizedMessageCount);
  return fallback || null;
}

export function readDebugRevisitPoints(debugRuntimeKey: string): DebugRevisitPoint[] {
  const hot = DEBUG_REVISIT_HOT.get(debugRuntimeKey) || [];
  const hotSet = new Set(hot.map(p => p.messageCount));
  const filePoints = readRevisitFile(debugRuntimeKey).filter(p => !hotSet.has(p.messageCount));
  return [...filePoints, ...hot].sort((a, b) => a.messageCount - b.messageCount);
}

export function clearDebugRevisitHistory(debugRuntimeKey: string): void {
  DEBUG_REVISIT_HOT.delete(debugRuntimeKey);
  deleteRevisitFile(debugRuntimeKey);
}

/** 清空所有调试回溯临时文件（进程退出或启动初始化时调用）*/
export function clearAllDebugRevisitTmpFiles(): void {
  try {
    const dir = getTmpDebugRevisitDir();
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (file.endsWith(".json")) {
        try { fs.unlinkSync(path.join(dir, file)); } catch { /* ignore */ }
      }
    }
  } catch {
    // ignore
  }
  DEBUG_REVISIT_HOT.clear();
}

export function buildDebugMessageWithRevisitData(
  message: RuntimeMessageInput,
  debugRuntimeKey: string,
  messageIndex: number,
  canRevisit: boolean
): Record<string, any> {
  return {
    ...normalizeMessageOutput({
      id: messageIndex,
      role: message.role,
      roleType: message.roleType,
      eventType: message.eventType,
      content: message.content,
      createTime: message.createTime,
      meta: {},
    }),
    revisitData: {
      debugRuntimeKey,
      messageCount: messageIndex,
    },
    canRevisit,
  };
}

// ==================== 原有代码 ====================

const DEBUG_RUNTIME_CACHE_TTL_MS = 1000 * 60 * 60;
const DEBUG_RUNTIME_CACHE = new Map<string, {
  userId: number;
  worldId: number;
  state: Record<string, any>;
  updatedAt: number;
}>();

export const debugMessageSchema = z.object({
  role: z.string().optional().nullable(),
  roleType: z.string().optional().nullable(),
  eventType: z.string().optional().nullable(),
  content: z.string().optional().nullable(),
  createTime: z.number().optional().nullable(),
});

export function asDebugMessage(input: any) {
  return normalizeMessageOutput({
    id: 0,
    role: String(input.role || "旁白"),
    roleType: String(input.roleType || "narrator"),
    eventType: String(input.eventType || "on_debug"),
    content: String(input.content || ""),
    createTime: Number(input.createTime || nowTs()),
    meta: {},
  });
}

export function cloneDebugRuntimeState<T>(input: T): T {
  try {
    return JSON.parse(JSON.stringify(input ?? null)) as T;
  } catch {
    return input;
  }
}

function purgeExpiredDebugRuntimeCache() {
  const now = nowTs();
  for (const [key, entry] of DEBUG_RUNTIME_CACHE.entries()) {
    if (now - entry.updatedAt > DEBUG_RUNTIME_CACHE_TTL_MS) {
      DEBUG_RUNTIME_CACHE.delete(key);
    }
  }
}

export function readDebugRuntimeKey(state: unknown): string {
  if (!state || typeof state !== "object" || Array.isArray(state)) return "";
  return String((state as Record<string, unknown>).debugRuntimeKey || "").trim();
}

function createDebugRuntimeKey() {
  return `dbg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function loadCachedDebugRuntimeState(state: unknown, userId: number, worldId: number): Record<string, any> | null {
  const key = readDebugRuntimeKey(state);
  if (!key) return null;
  purgeExpiredDebugRuntimeCache();
  const cached = DEBUG_RUNTIME_CACHE.get(key);
  if (!cached) return null;
  if (cached.userId !== userId || cached.worldId !== worldId) return null;
  cached.updatedAt = nowTs();
  const snapshot = cloneDebugRuntimeState(cached.state);
  snapshot.debugRuntimeKey = key;
  return snapshot;
}

export function cacheDebugRuntimeState(
  state: Record<string, any>,
  userId: number,
  worldId: number,
  existingKey?: string,
): string {
  purgeExpiredDebugRuntimeCache();
  const key = existingKey || readDebugRuntimeKey(state) || createDebugRuntimeKey();
  // 调试会话必须固定复用同一把 debugRuntimeKey；否则回溯文件会被写散到多个文件名里。
  state.debugRuntimeKey = key;
  DEBUG_RUNTIME_CACHE.set(key, {
    userId,
    worldId,
    state: cloneDebugRuntimeState(state),
    updatedAt: nowTs(),
  });
  return key;
}

function compactTextList(input: unknown, limit = 6): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, limit);
}

export function buildDebugStateSnapshot(state: Record<string, any>, debugRuntimeKey: string) {
  const eventView = readDefaultRuntimeEventViewState(state);
  const chapterProgress = readChapterProgressState(state);
  const snapshot: Record<string, any> = {
    debugRuntimeKey: String(debugRuntimeKey || readDebugRuntimeKey(state) || "").trim(),
    version: Number(state.version || 1),
    worldId: Number(state.worldId || 0) || undefined,
    chapterId: Number(state.chapterId || 0) || undefined,
    round: Number(state.round || 0) || 0,
    turnState: cloneDebugRuntimeState(state.turnState || {}),
    currentEventDigest: cloneDebugRuntimeState(eventView.currentEventDigest),
    eventDigestWindow: cloneDebugRuntimeState(eventView.eventDigestWindow),
    eventDigestWindowText: eventView.eventDigestWindowText,
    // 添加章节进度信息，包含 completedEvents 用于正确显示事件索引
    chapterProgress: {
      chapterId: chapterProgress.chapterId,
      phaseId: chapterProgress.phaseId,
      phaseIndex: chapterProgress.phaseIndex,
      eventIndex: chapterProgress.eventIndex,
      eventKind: chapterProgress.eventKind,
      eventSummary: chapterProgress.eventSummary,
      eventStatus: chapterProgress.eventStatus,
      completedEvents: chapterProgress.completedEvents,
      userNodeId: chapterProgress.userNodeId,
      userNodeIndex: chapterProgress.userNodeIndex,
      userNodeStatus: chapterProgress.userNodeStatus,
    },
  };
  if (state.player && typeof state.player === "object") {
    snapshot.player = cloneDebugRuntimeState(state.player);
  }
  if (state.narrator && typeof state.narrator === "object") {
    snapshot.narrator = cloneDebugRuntimeState(state.narrator);
  }
  const memorySummary = String(state.memorySummary || "").trim();
  if (memorySummary) {
    snapshot.memorySummary = memorySummary;
  }
  const memoryFacts = compactTextList(state.memoryFacts, 8);
  if (memoryFacts.length) {
    snapshot.memoryFacts = memoryFacts;
  }
  const memoryTags = compactTextList(state.memoryTags, 12);
  if (memoryTags.length) {
    snapshot.memoryTags = memoryTags;
  }
  if (state.miniGame && typeof state.miniGame === "object") {
    snapshot.miniGame = cloneDebugRuntimeState(state.miniGame);
  }
  if (state.debugFreePlot && typeof state.debugFreePlot === "object") {
    snapshot.debugFreePlot = cloneDebugRuntimeState(state.debugFreePlot);
  }
  const pendingChapterId = Number(state.debugPendingChapterId || 0);
  if (Number.isFinite(pendingChapterId) && pendingChapterId > 0) {
    snapshot.debugPendingChapterId = pendingChapterId;
  }
  return snapshot;
}

export function cacheAndBuildDebugStateSnapshot(params: {
  userId: number;
  worldId: number;
  state: Record<string, any>;
}) {
  const debugRuntimeKey = cacheDebugRuntimeState(
    params.state,
    params.userId,
    params.worldId,
    readDebugRuntimeKey(params.state),
  );
  return buildDebugStateSnapshot(params.state, debugRuntimeKey);
}

export function isDebugFreePlotActive(state: unknown): boolean {
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  const box = (state as Record<string, unknown>).debugFreePlot;
  if (!box || typeof box !== "object" || Array.isArray(box)) return false;
  return (box as Record<string, unknown>).active === true;
}

export function buildDebugFreePlotMessage(roleName: string, chapterTitle: string) {
  return asDebugMessage({
    role: roleName,
    roleType: "narrator",
    eventType: "on_debug_free_plot",
    content: `章节《${chapterTitle || "当前章节"}》已完成，接下来进入自由剧情，编排师将继续根据局势推进故事。`,
  });
}

function buildEmptyDebugRuntimeOutline(): ChapterRuntimeOutline {
  return {
    openingMessages: [],
    phases: [],
    userNodes: [],
    fixedEvents: [],
    endingRules: {
      success: [],
      failure: [],
      nextChapterId: null,
    },
  };
}

export function buildEffectiveDebugChapter(chapter: any, debugFreePlotActive: boolean) {
  if (!debugFreePlotActive) return chapter;
  return {
    ...chapter,
    content: "",
    openingText: "",
    completionCondition: null,
    runtimeOutline: buildEmptyDebugRuntimeOutline(),
  };
}

export function getPendingDebugChapterId(state: unknown): number | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const value = Number((state as Record<string, unknown>).debugPendingChapterId || 0);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function setPendingDebugChapterId(state: unknown, chapterId: number | null) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return;
  if (chapterId && chapterId > 0) {
    (state as Record<string, unknown>).debugPendingChapterId = chapterId;
  } else {
    delete (state as Record<string, unknown>).debugPendingChapterId;
  }
}

export async function resolveNextChapter(db: any, worldId: number, chapter: any, explicitNextChapterId?: number | null) {
  const chapters = (await db("t_storyChapter").where({ worldId }).orderBy("sort", "asc").orderBy("id", "asc"))
    .map((item: any) => normalizeChapterOutput(item));
  const explicitNext = explicitNextChapterId
    ? chapters.find((item: any) => Number(item.id) === Number(explicitNextChapterId))
    : null;
  const currentIndex = chapters.findIndex((item: any) => Number(item.id) === Number(chapter.id));
  return explicitNext || (currentIndex >= 0 ? chapters[currentIndex + 1] : null) || null;
}

export function buildOpeningRuntimeMessage(world: any, chapter: any, narratorName: string): RuntimeMessageInput {
  const opening = resolveOpeningMessage(world, chapter);
  return {
    role: String(opening.role || narratorName || "旁白"),
    roleType: String(opening.roleType || "narrator"),
    eventType: String(opening.eventType || "on_enter_chapter"),
    content: String(opening.content || ""),
    createTime: nowTs(),
  };
}

// 调试态会生成“章节失败/进入自由剧情”之类的系统收口台词，这些不是用户真实对话，
// 不能再喂回章节判定/编排/记忆，否则会污染下一轮判断。
function isSyntheticDebugTerminalEvent(eventType: string): boolean {
  const normalized = String(eventType || "").trim().toLowerCase();
  return normalized === "on_debug_failed"
    || normalized === "on_debug_success"
    || normalized === "on_debug_free_plot";
}

export function buildDebugRecentMessages(
  messages: RuntimeMessageInput[],
  playerRoleName: string,
  playerContent: string,
) {
  const normalizedContent = String(playerContent || "").trim();
  const list = messages
    .filter((item) => !isSyntheticDebugTerminalEvent(String(item?.eventType || "")))
    .map((item) => ({
      role: String(item.role || ""),
      roleType: String(item.roleType || ""),
      eventType: String(item.eventType || ""),
      content: String(item.content || ""),
      createTime: Number(item.createTime || 0),
    }));
  if (!normalizedContent) {
    return list;
  }
  const last = list[list.length - 1];
  const hasTrailingPlayerMessage = Boolean(
    last
      && String(last.roleType || "").trim().toLowerCase() === "player"
      && String(last.content || "").trim() === normalizedContent,
  );
  if (hasTrailingPlayerMessage) {
    return list;
  }
  return [
    ...list,
    {
      role: String(playerRoleName || "用户"),
      roleType: "player",
      eventType: "on_message",
      content: normalizedContent,
      createTime: nowTs(),
    },
  ];
}

export function syncDebugChapterRuntime(chapter: any, state: Record<string, any>) {
  if (!chapter) return;
  initializeChapterProgressForState(chapter, state);
  syncChapterProgressWithRuntime(chapter, state);
}

export function applyDebugUserMessageProgress(params: {
  chapter: any;
  state: Record<string, any>;
  messageContent: string;
  eventType?: string;
  meta?: Record<string, any>;
  messageId?: number | null;
  triggered?: TriggerHit[];
  taskProgress?: TaskProgressChange[];
  deltas?: AppliedDelta[];
}) {
  if (!params.chapter) {
    return;
  }
  syncDebugChapterRuntime(params.chapter, params.state);
  markCurrentUserNodeCompleted(params.chapter, params.state, params.messageId ?? null);
  recordChapterProgressSignals(params.chapter, params.state, {
    messageContent: params.messageContent,
    messageRole: String(params.state.player?.name || "用户"),
    messageRoleType: "player",
    triggered: params.triggered,
    taskProgress: params.taskProgress,
    deltas: params.deltas,
  });
  syncDebugChapterRuntime(params.chapter, params.state);
}

export function applyDebugNarrativeMessageProgress(params: {
  chapter: any;
  state: Record<string, any>;
  role?: string;
  roleType?: string;
  content?: string;
  triggered?: TriggerHit[];
  taskProgress?: TaskProgressChange[];
  deltas?: AppliedDelta[];
}) {
  if (!params.chapter) {
    return { enteredUserPhase: false };
  }
  syncDebugChapterRuntime(params.chapter, params.state);
  const phaseAdvance = advanceChapterProgressAfterNarrative(params.chapter, params.state, {
    messageContent: params.content,
    messageRole: params.role,
    messageRoleType: params.roleType,
  });
  recordChapterProgressSignals(params.chapter, params.state, {
    messageContent: params.content,
    messageRole: params.role,
    messageRoleType: params.roleType,
    triggered: params.triggered,
    taskProgress: params.taskProgress,
    deltas: params.deltas,
  });
  syncDebugChapterRuntime(params.chapter, params.state);
  return {
    enteredUserPhase: phaseAdvance.enteredUserPhase,
  };
}

export async function evaluateDebugRuntimeOutcome(params: {
  userId?: number;
  chapter: any;
  state: Record<string, any>;
  messageContent?: string;
  eventType?: string;
  meta?: Record<string, any>;
  recentMessages?: any[];
  debugFreePlotActive?: boolean;
  traceMeta?: Record<string, any>;
}) {
  if (!params.chapter || params.debugFreePlotActive) {
    return {
      result: "continue" as const,
      nextChapterId: null,
      matchedBy: "none" as const,
      matchedRule: null,
      hasRule: false,
    };
  }
  const resolved = await evaluateRuntimeOutcome({
    userId: params.userId,
    chapter: params.chapter,
    state: params.state,
    messageContent: params.messageContent,
    eventType: params.eventType,
    meta: params.meta,
    recentMessages: params.recentMessages,
    applyToState: true,
    traceMeta: params.traceMeta,
  });
  if (resolved.outcome !== "continue") {
    syncDebugChapterRuntime(params.chapter, params.state);
  }
  return {
    ...resolved.evaluation,
    result: resolved.outcome,
    nextChapterId: resolved.nextChapterId,
  };
}

export function buildDebugEndDialogDetail(params: {
  endDialog?: string | null;
  chapterTitle?: string | null;
  matchedBy?: string | null;
  matchedRule?: string | null;
}) {
  const endDialog = String(params.endDialog || "").trim();
  const chapterTitle = String(params.chapterTitle || "当前章节").trim() || "当前章节";
  const matchedRule = String(params.matchedRule || "").trim();
  if (endDialog === "已失败") {
    const reason = matchedRule ? `命中失败条件：${matchedRule}` : "命中失败条件";
    return `章节《${chapterTitle}》判定失败。${reason}。当前调试已停止，可继续查看当前记录，或返回编辑后重试。`;
  }
  if (endDialog === "已完结") {
    return `章节《${chapterTitle}》已完成，且没有下一章节。可返回编辑继续补章节。`;
  }
  if (endDialog === "进入自由剧情") {
    return `章节《${chapterTitle}》已完成，接下来进入自由剧情，后续将继续按当前局势推进。`;
  }
  return "";
}

export function normalizeDebugRuntimeState(rawState: unknown, worldId: number, chapterId: number, world: any) {
  const rolePair = normalizeRolePair(world.playerRole, world.narratorRole);
  return normalizeSessionState(rawState, worldId, chapterId, rolePair, world);
}

export function setDebugOpeningTurnState(state: Record<string, any>, world: any, roleName: string, roleType = "narrator") {
  setRuntimeTurnState(state, world, {
    canPlayerSpeak: false,
    expectedRoleType: "narrator",
    expectedRole: roleName,
    lastSpeakerRoleType: roleType,
    lastSpeaker: roleName,
  });
}

// ==================== 回溯接口 ====================
const revisitBodySchema = z.object({
  debugRuntimeKey: z.string(),
  messageCount: z.number(),
});
const revisitQuerySchema = z.object({
  debugRuntimeKey: z.string(),
});

router.post("/revisit", async (req, res) => {
  try {
    const parsed = revisitBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "参数错误", detail: parsed.error.message });
    }
    const { debugRuntimeKey, messageCount } = parsed.data;
    const point = getDebugRevisitPoint(debugRuntimeKey, messageCount);
    if (!point) {
      console.warn("[debug:revisit:not_found]", JSON.stringify({
        debugRuntimeKey,
        requestedMessageCount: messageCount,
        availableMessageCounts: readDebugRevisitPoints(debugRuntimeKey).map((item) => item.messageCount),
      }));
      return res.status(404).json({ error: "未找到可回溯点" });
    }
    console.log("[debug:revisit:hit]", JSON.stringify({
      debugRuntimeKey,
      requestedMessageCount: messageCount,
      restoredMessageCount: point.messageCount,
      availableMessageCounts: readDebugRevisitPoints(debugRuntimeKey).map((item) => item.messageCount),
    }));
    // 清理之后的回溯历史（截断未来记录）
    const history = readDebugRevisitPoints(debugRuntimeKey);
    const validHistory = history.filter(p => p.messageCount <= messageCount);
    // 回溯后要截断“未来记录”，内存层保留最近 N 条，文件层保留完整有效历史。
    DEBUG_REVISIT_HOT.set(debugRuntimeKey, validHistory.slice(-DEBUG_REVISIT_HOT_SIZE));
    writeRevisitFile(debugRuntimeKey, validHistory);
    return res.status(200).json({
      state: point.state,
      messages: point.messages,
      round: point.round,
      chapterId: point.chapterId,
      messageCount: point.messageCount,
    });
  } catch (e: any) {
    console.error("[debug:revisit:error]", e);
    return res.status(500).json({ error: e?.message || "回溯失败" });
  }
});

router.get("/revisit/history", async (req, res) => {
  try {
    const parsed = revisitQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "参数错误", detail: parsed.error.message });
    }
    const { debugRuntimeKey } = parsed.data;
    const history = readDebugRevisitPoints(debugRuntimeKey);
    return res.status(200).json(history.map(p => ({
      messageCount: p.messageCount,
      round: p.round,
      chapterId: p.chapterId,
      createdAt: p.createdAt,
    })));
  } catch (e: any) {
    console.error("[debug:revisit:history:error]", e);
    return res.status(500).json({ error: e?.message || "获取回溯历史失败" });
  }
});

export default router;
