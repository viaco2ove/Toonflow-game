import express from "express";
import { z } from "zod";
import {
  normalizeChapterOutput,
  normalizeMessageOutput,
  normalizeRolePair,
  normalizeSessionState,
  nowTs,
} from "@/lib/gameEngine";
import {
  resolveOpeningMessage,
  RuntimeMessageInput,
  setRuntimeTurnState,
} from "@/modules/game-runtime/engines/NarrativeOrchestrator";

const router = express.Router();
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
  return cloneDebugRuntimeState(cached.state);
}

export function cacheDebugRuntimeState(
  state: Record<string, any>,
  userId: number,
  worldId: number,
  existingKey?: string,
): string {
  purgeExpiredDebugRuntimeCache();
  const key = existingKey || createDebugRuntimeKey();
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
  const snapshot: Record<string, any> = {
    debugRuntimeKey,
    version: Number(state.version || 1),
    worldId: Number(state.worldId || 0) || undefined,
    chapterId: Number(state.chapterId || 0) || undefined,
    round: Number(state.round || 0) || 0,
    turnState: cloneDebugRuntimeState(state.turnState || {}),
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

export function buildDebugRecentMessages(
  messages: RuntimeMessageInput[],
  playerRoleName: string,
  playerContent: string,
) {
  const normalizedContent = String(playerContent || "").trim();
  const list = messages.map((item) => ({
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

export default router;
