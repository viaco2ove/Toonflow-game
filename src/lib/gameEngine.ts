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

export function normalizeWorldOutput(row: any): JsonRecord | null {
  if (!row) return null;
  const rolePair = normalizeRolePair(row.playerRole, row.narratorRole);
  return {
    ...row,
    settings: parseJsonSafe<JsonRecord>(row.settings, {}),
    playerRole: rolePair.playerRole,
    narratorRole: rolePair.narratorRole,
  };
}

export function normalizeChapterOutput(row: any): JsonRecord | null {
  if (!row) return null;
  return {
    ...row,
    showCompletionCondition: Boolean(Number(row.showCompletionCondition || 0)),
    entryCondition: parseJsonSafe(row.entryCondition, null),
    completionCondition: parseJsonSafe(row.completionCondition, null),
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
