import u from "@/utils";

export interface JsonRecord {
  [key: string]: any;
}

export interface RolePair {
  playerRole: JsonRecord;
  narratorRole: JsonRecord;
}

export interface ConditionContext {
  state: JsonRecord;
  messageContent: string;
  eventType: string;
  meta: JsonRecord;
}

export interface ChapterOpeningParts {
  role: string;
  line: string;
  body: string;
}

const DEFAULT_PLAYER_ROLE: JsonRecord = {
  id: "player",
  name: "玩家",
  roleType: "player",
  description: "用户在故事中的主视角角色",
  attributes: {},
};

const DEFAULT_NARRATOR_ROLE: JsonRecord = {
  id: "narrator",
  name: "旁白",
  roleType: "narrator",
  description: "负责环境推进、规则提示与节奏控制",
  attributes: {},
};

function isRecord(input: unknown): input is JsonRecord {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function normalizeEditorText(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return input.replace(/\r\n/g, "\n").trim();
  if (typeof input === "number" || typeof input === "boolean") return String(input).trim();
  try {
    return JSON.stringify(input).trim();
  } catch {
    return "";
  }
}

function isNullLikeText(input: string): boolean {
  const text = String(input || "").trim().toLowerCase();
  return !text || text === "null" || text === "undefined";
}

export function extractOpeningContentParts(input: unknown): ChapterOpeningParts | null {
  const text = normalizeEditorText(input);
  if (!text) return null;
  const match = text.match(/^开场白(?:\[(.+?)\]|([^\[\]:：\r\n]+))\s*[:：]\s*([^\r\n]*)(?:\r?\n)*/);
  if (!match) return null;
  const role = String(match[1] || match[2] || "").trim();
  const line = String(match[3] || "").trim();
  const body = text.slice(match[0].length).replace(/^\s*[\r\n]+/, "");
  if (!role && !line) return null;
  return { role, line, body };
}

function splitParagraphs(input: string): string[] {
  return String(input || "")
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeChapterTitle(input: unknown, sort: unknown): string {
  const raw = normalizeEditorText(input);
  if (raw && !/^章节\s*\d{10,}$/u.test(raw)) {
    return raw;
  }
  const chapterSort = Number(sort || 0);
  if (Number.isFinite(chapterSort) && chapterSort > 0) {
    return `第 ${chapterSort} 章`;
  }
  return raw;
}

function escapeRegExp(input: string): string {
  return String(input || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripOpeningHeader(input: string, openingRole?: unknown): string {
  const text = String(input || "").trimStart();
  if (!text) return "";
  const role = normalizeEditorText(openingRole);
  const header = role
    ? new RegExp(`^开场白(?:\\[${escapeRegExp(role)}\\]|${escapeRegExp(role)})?\\s*[:：]\\s*`)
    : /^开场白(?:\[(.+?)\]|([^\[\]:：\r\n]+))?\s*[:：]\s*/;
  return text.replace(header, "").replace(/^\s*[\r\n]+/, "");
}

function stripLeadingOpeningParagraphs(input: string, openingText: string): string {
  const openingParagraphs = splitParagraphs(openingText);
  if (!openingParagraphs.length) {
    return input.trim();
  }
  const openingSet = new Set(openingParagraphs);
  const contentParagraphs = splitParagraphs(input);
  while (contentParagraphs.length && openingSet.has(contentParagraphs[0])) {
    contentParagraphs.shift();
  }
  return contentParagraphs.join("\n\n").trim();
}

export function stripLeadingOpeningArtifacts(input: unknown, openingRole?: unknown, openingText?: unknown): string {
  let text = normalizeEditorText(input);
  if (!text) return "";
  const expectedRole = normalizeEditorText(openingRole);
  const expectedText = normalizeEditorText(openingText);
  const expectedParagraphs = splitParagraphs(expectedText).sort((a, b) => b.length - a.length);

  for (let i = 0; i < 64; i += 1) {
    const before = text;
    text = stripOpeningHeader(text, expectedRole);
    const extracted = extractOpeningContentParts(text);
    if (extracted) {
      const roleMatches = !expectedRole || !extracted.role || extracted.role === expectedRole;
      const lineMatches = !expectedText || !extracted.line || expectedText.startsWith(extracted.line) || extracted.line === expectedText;
      if (roleMatches && lineMatches) {
        text = extracted.body.replace(/^\s*[\r\n]+/, "");
      }
    }
    if (expectedText && text.startsWith(expectedText)) {
      text = text.slice(expectedText.length).replace(/^\s*[\r\n]+/, "");
    }
    const paragraphMatch = expectedParagraphs.find((item) => item && text.startsWith(item));
    if (paragraphMatch) {
      text = text.slice(paragraphMatch.length).replace(/^\s*[\r\n]+/, "");
    }
    if (text === before) break;
  }
  if (expectedText) {
    text = stripLeadingOpeningParagraphs(text, expectedText);
  }
  return text.trim();
}

export function normalizeChapterFields(input: {
  content?: unknown;
  openingRole?: unknown;
  openingText?: unknown;
  entryCondition?: unknown;
  completionCondition?: unknown;
}): {
  content: string;
  openingRole: string;
  openingText: string;
  entryCondition: unknown;
  completionCondition: unknown;
} {
  const extracted = extractOpeningContentParts(input.content);
  const openingRole = normalizeEditorText(input.openingRole) || extracted?.role || "";
  let openingText = normalizeEditorText(input.openingText) || extracted?.line || "";
  let content = stripLeadingOpeningArtifacts(input.content, openingRole, openingText);
  const openingParagraphs = splitParagraphs(openingText);
  if (openingParagraphs.length > 1) {
    openingText = openingParagraphs[0];
    const remainder = openingParagraphs.slice(1).join("\n\n").trim();
    if (remainder) {
      const remainderParagraphs = splitParagraphs(remainder);
      const contentParagraphs = splitParagraphs(content);
      const alreadyPrefixed = remainderParagraphs.every((item, index) => contentParagraphs[index] === item);
      if (!alreadyPrefixed) {
        content = [remainder, content].filter(Boolean).join("\n\n").trim();
      }
    }
  }
  const rawEntry = tryParseCondition(input.entryCondition);
  const rawCompletion = tryParseCondition(input.completionCondition);
  const entryCondition = typeof rawEntry === "string" && isNullLikeText(rawEntry) ? null : rawEntry;
  const completionCondition = typeof rawCompletion === "string" && isNullLikeText(rawCompletion) ? null : rawCompletion;
  return {
    content,
    openingRole,
    openingText,
    entryCondition,
    completionCondition,
  };
}

export function getGameDb(): any {
  return u.db as any;
}

export function parseJsonSafe<T>(input: unknown, fallback: T): T {
  if (input === null || input === undefined) return fallback;
  if (typeof input === "string") {
    const text = input.trim();
    if (!text) return fallback;
    try {
      return JSON.parse(text) as T;
    } catch {
      return fallback;
    }
  }
  if (typeof input === "object") {
    return input as T;
  }
  return fallback;
}

export function toJsonText(input: unknown, fallback: unknown = {}): string {
  try {
    return JSON.stringify(input ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

export function normalizeRolePair(playerRoleRaw: unknown, narratorRoleRaw: unknown): RolePair {
  const playerRaw = parseJsonSafe<JsonRecord>(playerRoleRaw, {});
  const narratorRaw = parseJsonSafe<JsonRecord>(narratorRoleRaw, {});

  return {
    playerRole: {
      ...DEFAULT_PLAYER_ROLE,
      ...playerRaw,
      roleType: "player",
      attributes: {
        ...parseJsonSafe<JsonRecord>(DEFAULT_PLAYER_ROLE.attributes, {}),
        ...parseJsonSafe<JsonRecord>(playerRaw.attributes, {}),
      },
    },
    narratorRole: {
      ...DEFAULT_NARRATOR_ROLE,
      ...narratorRaw,
      roleType: "narrator",
      attributes: {
        ...parseJsonSafe<JsonRecord>(DEFAULT_NARRATOR_ROLE.attributes, {}),
        ...parseJsonSafe<JsonRecord>(narratorRaw.attributes, {}),
      },
    },
  };
}

export function createGameSessionId(): string {
  return `gs_${Date.now()}_${u.uuid().replace(/-/g, "").slice(0, 10)}`;
}

export function nowTs(): number {
  return Date.now();
}

export function normalizeSessionState(
  raw: unknown,
  worldId: number,
  chapterId: number | null,
  rolePair: RolePair,
): JsonRecord {
  const base = parseJsonSafe<JsonRecord>(raw, {});
  const player = isRecord(base.player) ? base.player : {};
  const narrator = isRecord(base.narrator) ? base.narrator : {};
  const rawTurnState = isRecord(base.turnState) ? base.turnState : {};
  const normalizedPlayerName = String(rolePair.playerRole.name || "用户").trim() || "用户";

  return {
    version: 1,
    worldId,
    chapterId,
    round: Number.isFinite(Number(base.round)) ? Number(base.round) : 0,
    ...base,
    player: {
      ...rolePair.playerRole,
      ...player,
      roleType: "player",
      attributes: {
        ...parseJsonSafe<JsonRecord>(rolePair.playerRole.attributes, {}),
        ...parseJsonSafe<JsonRecord>(player.attributes, {}),
      },
    },
    narrator: {
      ...rolePair.narratorRole,
      ...narrator,
      roleType: "narrator",
      attributes: {
        ...parseJsonSafe<JsonRecord>(rolePair.narratorRole.attributes, {}),
        ...parseJsonSafe<JsonRecord>(narrator.attributes, {}),
      },
    },
    flags: isRecord(base.flags) ? base.flags : {},
    vars: isRecord(base.vars) ? base.vars : {},
    npcs: isRecord(base.npcs) ? base.npcs : {},
    inventory: Array.isArray(base.inventory) ? base.inventory : [],
    unlockedRoles: Array.isArray(base.unlockedRoles) ? base.unlockedRoles : [],
    recentEvents: Array.isArray(base.recentEvents) ? base.recentEvents : [],
    turnState: {
      canPlayerSpeak: typeof rawTurnState.canPlayerSpeak === "boolean" ? rawTurnState.canPlayerSpeak : true,
      expectedRoleType: String(rawTurnState.expectedRoleType || "player").trim() || "player",
      expectedRole: String(rawTurnState.expectedRole || normalizedPlayerName).trim() || normalizedPlayerName,
      lastSpeakerRoleType: String(rawTurnState.lastSpeakerRoleType || "").trim(),
      lastSpeaker: String(rawTurnState.lastSpeaker || "").trim(),
    },
  };
}

function splitPath(path: string): string[] {
  return String(path || "")
    .trim()
    .split(".")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getValueByPath(source: unknown, path: string): unknown {
  if (!path) return source;
  const keys = splitPath(path);
  let current: unknown = source;
  for (const key of keys) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    current = (current as any)[key];
  }
  return current;
}

export function setValueByPath(target: JsonRecord, path: string, value: unknown): void {
  const keys = splitPath(path);
  if (!keys.length) return;

  let current: JsonRecord = target;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    const next = current[key];
    if (!isRecord(next)) {
      current[key] = {};
    }
    current = current[key] as JsonRecord;
  }
  current[keys[keys.length - 1]] = value;
}

function tryParseCondition(input: unknown): unknown {
  if (typeof input !== "string") return input;
  const text = input.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function compareValue(left: unknown, right: unknown, op: string): boolean {
  if (op === "equals") return left === right;
  if (op === "contains") {
    if (Array.isArray(left)) return left.some((item) => item === right);
    return String(left ?? "").includes(String(right ?? ""));
  }
  if (op === "in") {
    if (!Array.isArray(right)) return false;
    return right.some((item) => item === left);
  }

  const leftNum = Number(left);
  const rightNum = Number(right);
  if (!Number.isFinite(leftNum) || !Number.isFinite(rightNum)) return false;

  if (op === "gt") return leftNum > rightNum;
  if (op === "gte") return leftNum >= rightNum;
  if (op === "lt") return leftNum < rightNum;
  if (op === "lte") return leftNum <= rightNum;
  return false;
}

function readContextValue(ctx: ConditionContext, fieldRaw: unknown): unknown {
  const field = String(fieldRaw || "").trim();
  if (!field) return undefined;

  if (field === "message" || field === "message.content") return ctx.messageContent;
  if (field === "event" || field === "eventType") return ctx.eventType;
  if (field.startsWith("state.")) return getValueByPath(ctx.state, field.replace(/^state\./, ""));
  if (field.startsWith("meta.")) return getValueByPath(ctx.meta, field.replace(/^meta\./, ""));

  return getValueByPath(ctx.state, field);
}

export function evaluateCondition(input: unknown, ctx: ConditionContext): boolean {
  const condition = tryParseCondition(input);

  if (condition === null || condition === undefined) return true;
  if (typeof condition === "boolean") return condition;
  if (typeof condition === "string") {
    const text = condition.trim();
    if (!text) return true;
    return ctx.messageContent.includes(text);
  }

  if (Array.isArray(condition)) {
    return condition.every((item) => evaluateCondition(item, ctx));
  }

  if (!isRecord(condition)) return false;

  const op = String(condition.type || condition.op || "equals").trim().toLowerCase();

  if (op === "always") return true;
  if (op === "and") {
    const list = Array.isArray(condition.conditions) ? condition.conditions : [];
    return list.every((item) => evaluateCondition(item, ctx));
  }
  if (op === "or") {
    const list = Array.isArray(condition.conditions) ? condition.conditions : [];
    return list.some((item) => evaluateCondition(item, ctx));
  }
  if (op === "not") {
    const child = condition.condition ?? (Array.isArray(condition.conditions) ? condition.conditions[0] : null);
    return !evaluateCondition(child, ctx);
  }

  const left = readContextValue(ctx, condition.field ?? condition.left);
  const right = condition.value ?? condition.right;
  if (["equals", "contains", "in", "gt", "gte", "lt", "lte"].includes(op)) {
    return compareValue(left, right, op);
  }

  return false;
}

export function normalizeActionList(input: unknown): JsonRecord[] {
  const raw = tryParseCondition(input);
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.filter((item): item is JsonRecord => isRecord(item));
  }
  if (isRecord(raw) && Array.isArray(raw.actions)) {
    return raw.actions.filter((item): item is JsonRecord => isRecord(item));
  }
  if (isRecord(raw)) return [raw];
  return [];
}

export function normalizeWorldSettings(settingsRaw: unknown, topLevel: { coverPath?: unknown; publishStatus?: unknown }): JsonRecord {
  const settings = parseJsonSafe<JsonRecord>(settingsRaw, {});
  const coverPath = String(topLevel.coverPath || "").trim();
  const publishStatus = String(topLevel.publishStatus || "").trim();
  if (coverPath) {
    settings.coverPath = coverPath;
  }
  if (publishStatus) {
    settings.publishStatus = publishStatus;
  }
  return settings;
}

export function normalizeWorldOutput(row: any): JsonRecord | null {
  if (!row) return null;
  const rolePair = normalizeRolePair(row.playerRole, row.narratorRole);
  const settings = normalizeWorldSettings(row.settings, {
    coverPath: row.coverPath,
    publishStatus: row.publishStatus,
  });
  return {
    ...row,
    name: String(row.name || ""),
    intro: String(row.intro || ""),
    coverPath: String(row.coverPath || ""),
    coverBgPath: String(row.coverBgPath || ""),
    publishStatus: String(row.publishStatus || ""),
    settings,
    playerRole: rolePair.playerRole,
    narratorRole: rolePair.narratorRole,
  };
}

export function normalizeChapterOutput(row: any): JsonRecord | null {
  if (!row) return null;
  const normalized = normalizeChapterFields({
    content: row.content,
    openingRole: row.openingRole,
    openingText: row.openingText,
    entryCondition: row.entryCondition,
    completionCondition: row.completionCondition,
  });
  return {
    ...row,
    title: normalizeChapterTitle(row.title, row.sort),
    content: normalized.content,
    openingRole: normalized.openingRole,
    openingText: normalized.openingText,
    showCompletionCondition: Boolean(Number(row.showCompletionCondition || 0)),
    entryCondition: normalized.entryCondition,
    completionCondition: normalized.completionCondition,
  };
}

export function normalizeTaskOutput(row: any): JsonRecord | null {
  if (!row) return null;
  return {
    ...row,
    successCondition: parseJsonSafe(row.successCondition, null),
    failCondition: parseJsonSafe(row.failCondition, null),
    rewardAction: parseJsonSafe(row.rewardAction, null),
  };
}

export function normalizeTriggerOutput(row: any): JsonRecord | null {
  if (!row) return null;
  return {
    ...row,
    conditionExpr: parseJsonSafe(row.conditionExpr, null),
    actionExpr: parseJsonSafe(row.actionExpr, null),
  };
}

export function normalizeMessageOutput(row: any): JsonRecord | null {
  if (!row) return null;
  return {
    ...row,
    meta: parseJsonSafe(row.meta, {}),
  };
}
