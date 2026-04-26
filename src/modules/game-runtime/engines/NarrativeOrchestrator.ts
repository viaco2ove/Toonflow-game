import u from "@/utils";
import {
  ChapterRuntimePhase,
  isFreeChapterRuntimeMode,
  JsonRecord,
  RuntimeCurrentEventState,
  readDefaultRuntimeEventDigestWindowTextState,
  readRuntimeDynamicEventByIndex,
  readRuntimeEventDigestWindowTextState,
  normalizeChapterRuntimeOutline,
  readRuntimeCurrentEventDigestState,
  readPhaseAwareRuntimeCurrentEventDigestState,
  upsertRuntimeEventDigestState,
  normalizeRolePair,
  nowTs,
  parseJsonSafe,
  readChapterProgressState,
  readRuntimeCurrentEventState,
  setChapterProgressState,
  syncRuntimeCurrentEventFromChapterProgress,
} from "@/lib/gameEngine";
import {
  advanceChapterProgressAfterNarrative,
  applyAiEventProgressResolution,
  recordChapterProgressSignals,
  readNextEventProgressHint,
  syncChapterProgressWithRuntime,
} from "@/modules/game-runtime/engines/ChapterProgressEngine";
import { resolveRuleNarrativePlan } from "@/modules/game-runtime/engines/RuleOrchestrator";
import { evaluateEventProgressByAi } from "@/modules/game-runtime/services/EventProgressRuntimeService";
import {
  resolveSpeakerModeDecision,
} from "@/modules/game-runtime/engines/SpeakerRouteEngine";
import { DebugLogUtil } from "@/utils/debugLogUtil";

export interface RuntimeMessageInput {
  messageId?: number | null;
  role?: string | null;
  roleType?: string | null;
  eventType?: string | null;
  content?: string | null;
  createTime?: number | null;
  memoryDelta?: {
    eventIndex?: number | null;
    eventKind?: string | null;
    eventSummary?: string | null;
    eventFacts?: string[] | null;
    memorySummary?: string | null;
    memoryFacts?: string[] | null;
  } | null;
}

export interface RuntimeStoryRole {
  id: string;
  roleType: string;
  name: string;
  description?: string;
  sample?: string;
  parameterCardJson?: unknown;
}

export interface OrchestratorInput {
  userId: number;
  world: any;
  chapter: any;
  state: JsonRecord;
  recentMessages: RuntimeMessageInput[];
  playerMessage?: string;
  maxRetries?: number;
  allowControlHints?: boolean;
  allowStateDelta?: boolean;
  traceMeta?: JsonRecord;
}

type NarrativePlanSource = "ai" | "fallback" | "rule";

export interface NarrativePlanResult {
  role: string;
  roleType: string;
  motive: string;
  memoryHints: string[];
  triggerMemoryAgent: boolean;
  stateDelta: JsonRecord;
  awaitUser: boolean;
  nextRole: string;
  nextRoleType: string;
  chapterOutcome: "continue" | "success" | "failed";
  nextChapterId: number | null;
  source: NarrativePlanSource;
  eventAdjustMode: "keep" | "update" | "waiting_input" | "completed";
  eventIndex: number;
  eventKind: RuntimeCurrentEventState["kind"];
  eventSummary: string;
  eventFacts: string[];
  eventStatus: RuntimeCurrentEventState["status"];
  speakerMode?: "template" | "fast" | "premium";
  speakerRouteReason?: string;
  orchestratorRuntime?: NarrativeRuntimeMeta;
}

export interface OrchestratorResult extends NarrativePlanResult {
  content: string;
}

export interface NarrativePlanSummary {
  role: string;
  roleType: string;
  motive: string;
  awaitUser: boolean;
  nextRole: string;
  nextRoleType: string;
  memoryHints: string[];
  triggerMemoryAgent: boolean;
  source: "ai" | "fallback" | "rule";
  eventAdjustMode: "keep" | "update" | "waiting_input" | "completed";
  eventIndex: number;
  eventKind: RuntimeCurrentEventState["kind"];
  eventSummary: string;
  eventFacts: string[];
  eventStatus: RuntimeCurrentEventState["status"];
  speakerMode?: "template" | "fast" | "premium";
  speakerRouteReason?: string;
  orchestratorRuntime?: NarrativeRuntimeMeta;
}

export interface NarrativeRuntimeMeta {
  modelKey: string;
  manufacturer: string;
  model: string;
  reasoningEffort: "minimal" | "low" | "medium" | "high" | "";
  payloadMode: "compact" | "advanced";
  payloadModeSource: "explicit" | "inferred";
}

export interface MemoryManagerResult {
  summary: string;
  facts: string[];
  tags: string[];
  playerCardPatch: JsonRecord;
  npcCardPatches: Array<{
    roleId: string;
    roleName: string;
    roleType: string;
    patch: JsonRecord;
  }>;
  source: "ai" | "fallback";
}

type OrchestratorPromptPayload = {
  worldName: string;
  worldIntro: string;
  chapterTitle: string;
  chapterDirective: string;
  chapterUserTurns: string;
  chapterOpening: string;
  roles: RuntimeStoryRole[];
  wildcardRoles: RuntimeStoryRole[];
  narratorActsAsWildcardFallback: boolean;
  storyState: string;
  turnState: RuntimeTurnState;
  currentPhaseLabel: string;
  currentPhaseGoal: string;
  currentEventIndex: number;
  currentEventKind: string;
  currentEventFlowType: string;
  currentEventStatus: string;
  currentEventSummary: string;
  currentEventFacts: string[];
  currentEventMemorySummary: string;
  currentEventMemoryFacts: string[];
  currentEventWindow: string;
  phaseAllowedSpeakers: string[];
  recentDialogue: RecentDialogueTurn[];
  latestPlayerMessage: string;
  traceMeta?: JsonRecord;
};

type SpeakerPromptPayload = {
  worldName: string;
  worldIntro: string;
  chapterTitle: string;
  chapterContentHint?: string;
  chapterEndingConditionHint?: string;
  currentPhaseLabel: string;
  currentEventWindow?: string;
  currentEventIndex: number;
  currentEventKind: string;
  currentEventFlowType?: string;
  currentEventStatus?: string;
  currentEventSummary: string;
  currentEventFacts: string[];
  currentEventMemorySummary: string;
  currentEventMemoryFacts: string[];
  nextEventIndex?: number;
  nextEventKind?: string;
  nextEventFlowType?: string;
  nextEventStatus?: string;
  nextEventSummary?: string;
  nextEventFacts: string[];
  nextEventTransitionHint?: string;
  speakerName: string;
  speakerRoleType: string;
  speakerProfile: string;
  motive: string;
  storyState: string;
  latestPlayerMessage: string;
  recentDialogue: RecentDialogueTurn[];
  otherRoles: string[];
  traceMeta?: JsonRecord;
};

type RecentDialogueTurn = {
  role: string;
  roleType: string;
  eventType: string;
  content: string;
};

type PromptStatRow = {
  block: string;
  content: string;
  chars: number;
  estimatedTokens: number;
};

type MemoryRoleCardSnapshot = {
  roleId: string;
  roleName: string;
  roleType: string;
  card: JsonRecord;
};

// 截断错误信息，避免日志和报错文本过长。
function truncateErrorMessage(input: unknown, limit = 180): string {
  const text = normalizeScalarText(input);
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function normalizeTraceMeta(input: unknown): JsonRecord {
  if (!input || typeof input !== "object") return {};
  return input as JsonRecord;
}

// 用统一 tag 串起编排请求和模型调用，方便定位同一个请求是否重复触发了 AI。
function logOrchestratorKeyNode(node: string, traceMeta: unknown, extra?: Record<string, unknown>) {
  if (!DebugLogUtil.isDebugLogEnabled()) return;
  console.log("[game:orchestrator:key_nodes]", JSON.stringify({
    node,
    ...normalizeTraceMeta(traceMeta),
    ...(extra || {}),
  }));
}

function estimatePromptTokens(text: string): number {
  const chars = String(text || "").length;
  if (!chars) return 0;
  return Math.max(1, Math.ceil(chars / 4));
}

function normalizePromptStatContent(content: string): string {
  return normalizeScalarText(content).replaceAll("\n", " ↩ ");
}

// 按阶段包装模型异常，统一成前后端可读的错误信息。
function createRuntimeModelError(stage: "orchestrator" | "memory" | "speaker", reason?: unknown): Error {
  const detail = truncateErrorMessage(reason);
  if (/^(编排师|角色发言|记忆管理)对接的模型异常/.test(detail)) {
    return new Error(detail);
  }
  const prefix = stage === "memory"
    ? "记忆管理对接的模型异常"
    : stage === "speaker"
      ? "角色发言对接的模型异常"
      : "编排师对接的模型异常";
  return new Error(detail ? `${prefix}：${detail}` : prefix);
}

// 归一化单值文本，过滤空串和 null/undefined。
export function normalizeScalarText(input: unknown): string {
  const text = String(input ?? "").trim();
  if (!text) return "";
  if (text === "null" || text === "undefined") return "";
  return text;
}

// 对文本列表去重并保留最近的若干项。
function uniqueTextList(input: unknown[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of input) {
    const text = normalizeScalarText(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result.slice(-Math.max(1, limit));
}

// 读取 prompt 配置里的自定义值或默认值。
function getPromptValue(row: any): string {
  const customValue = normalizeScalarText(row?.customValue);
  if (customValue) return customValue;
  return normalizeScalarText(row?.defaultValue);
}

// 将未知输入尽量解析为 JSON 对象记录。
function asRecord(input: unknown): JsonRecord {
  return parseJsonSafe<JsonRecord>(input, {});
}

function hasRecordKeys(input: JsonRecord): boolean {
  return Object.keys(input).length > 0;
}

function formatRuntimeErrorMessage(runtimeError: unknown): string {
  if (runtimeError instanceof Error) {
    return normalizePromptStatContent(runtimeError.message);
  }
  if (typeof runtimeError === "string") {
    return normalizePromptStatContent(runtimeError);
  }
  return normalizePromptStatContent(JSON.stringify(runtimeError ?? ""));
}

// 从世界定义里组装用户、旁白和 NPC 角色列表。
export function worldRoles(world: any): RuntimeStoryRole[] {
  const rolePair = normalizeRolePair(world?.playerRole, world?.narratorRole);
  const settings = asRecord(world?.settings);
  const npcRoles = Array.isArray(settings.roles)
    ? settings.roles.filter((item) => item && item.roleType === "npc")
    : [];
  return [
    {
      id: String(rolePair.playerRole.id || "player"),
      roleType: "player",
      name: String(rolePair.playerRole.name || "用户"),
      description: normalizeScalarText(rolePair.playerRole.description),
      sample: normalizeScalarText(rolePair.playerRole.sample),
      parameterCardJson: rolePair.playerRole.parameterCardJson ?? null,
    },
    {
      id: String(rolePair.narratorRole.id || "narrator"),
      roleType: "narrator",
      name: String(rolePair.narratorRole.name || "旁白"),
      description: normalizeScalarText(rolePair.narratorRole.description),
      sample: normalizeScalarText(rolePair.narratorRole.sample),
      parameterCardJson: rolePair.narratorRole.parameterCardJson ?? null,
    },
    ...npcRoles.map((item: any, index: number) => ({
      id: String(item?.id || `npc_${index + 1}`),
      roleType: "npc",
      name: String(item?.name || `角色${index + 1}`),
      description: normalizeScalarText(item?.description),
      sample: normalizeScalarText(item?.sample),
      parameterCardJson: item?.parameterCardJson ?? null,
    })),
  ];
}

// 用运行时状态覆盖基础角色信息。
function applyRuntimeRoleOverlay(base: RuntimeStoryRole, runtimeRole: unknown): RuntimeStoryRole {
  const raw = asRecord(runtimeRole);
  if (!hasRecordKeys(raw)) return base;
  return {
    ...base,
    id: normalizeScalarText(raw.id) || base.id,
    roleType: sanitizeRoleType(raw.roleType || base.roleType),
    name: normalizeScalarText(raw.name) || base.name,
    description: normalizeScalarText(raw.description) || base.description,
    sample: normalizeScalarText(raw.sample) || base.sample,
    parameterCardJson: raw.parameterCardJson ?? base.parameterCardJson ?? null,
  };
}

// 在运行时状态里查找与当前 NPC 对应的覆盖数据。
function findRuntimeNpcOverlay(runtimeState: JsonRecord, role: RuntimeStoryRole): unknown {
  const npcBag = asRecord(runtimeState.npcs);
  if (!hasRecordKeys(npcBag)) return null;
  const roleId = normalizeScalarText(role.id);
  const roleName = normalizeScalarText(role.name);
  for (const entry of Object.values(npcBag)) {
    const raw = asRecord(entry);
    const entryId = normalizeScalarText(raw.id);
    const entryName = normalizeScalarText(raw.name);
    if ((roleId && entryId && entryId === roleId) || (roleName && entryName && entryName === roleName)) {
      return raw;
    }
  }
  return null;
}

// 合并基础角色与运行时覆盖，得到当前剧情真正可用的角色列表。
export function runtimeStoryRoles(world: any, state?: JsonRecord | null): RuntimeStoryRole[] {
  const roles = worldRoles(world);
  const runtimeState = asRecord(state);
  return roles.map((role) => {
    if (sanitizeRoleType(role.roleType) === "player") {
      return applyRuntimeRoleOverlay(role, runtimeState.player);
    }
    if (sanitizeRoleType(role.roleType) === "narrator") {
      return applyRuntimeRoleOverlay(role, runtimeState.narrator);
    }
    return applyRuntimeRoleOverlay(role, findRuntimeNpcOverlay(runtimeState, role));
  });
}

// 生成章节开场消息，优先使用章节配置的开场白。
export function resolveOpeningMessage(world: any, chapter: any) {
  const roles = worldRoles(world);
  const openingText = normalizeScalarText(chapter?.openingText);
  const openingRoleName = normalizeScalarText(chapter?.openingRole) || String(world?.narratorRole?.name || "旁白");
  const matchedRole = roles.find((item) => item.name === openingRoleName)
    || roles.find((item) => item.roleType === "narrator")
    || roles[0]
    || { name: openingRoleName || "旁白", roleType: "narrator" };

  if (openingText) {
    return {
      role: matchedRole.name,
      roleType: matchedRole.roleType || "narrator",
      eventType: "on_opening",
      content: openingText,
      createTime: nowTs(),
    };
  }

  return {
    role: matchedRole.name || "旁白",
    roleType: matchedRole.roleType || "narrator",
    eventType: "on_enter_chapter",
    content: "",
    createTime: nowTs(),
  };
}

// 提取章节内部提纲文本，供编排器判断剧情走向。
function chapterDirectiveText(chapter: any): string {
  return normalizeScalarText(chapter?.content);
}

// 判断角色是否能临时承担万能角色或路人兜底职责。
function roleActsAsWildcard(role: RuntimeStoryRole | undefined): boolean {
  if (!role) return false;
  const haystack = [
    role.name,
    role.description,
    role.sample,
    typeof role.parameterCardJson === "string" ? role.parameterCardJson : "",
  ]
    .map((item) => normalizeScalarText(item))
    .join("\n");
  return /万能角色|万能/.test(haystack);
}

// 规范化角色类型，防止脏值污染回合状态。
function sanitizeRoleType(input: unknown): string {
  const value = normalizeScalarText(input).toLowerCase();
  if (value === "player") return "player";
  if (value === "npc") return "npc";
  return "narrator";
}

// 将章节提纲按段拆开，方便后续摘要和匹配。
function directiveParagraphs(input: unknown): string[] {
  return normalizeScalarText(input)
    .split(/\r?\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// 截取章节提纲的短摘要，供精简提示词使用。
function directiveExcerpt(input: unknown): string {
  const paragraphs = directiveParagraphs(input);
  if (!paragraphs.length) return "剧情继续推进。";
  return paragraphs.slice(0, 2).join("\n").slice(0, 140);
}

const CHAPTER_USER_INTERACTION_PATTERN = /(用户行动|仅对用户|请发言|请直接输入|你可以[:：]?|唯一行动机会|检测到异常|你是唯一仍可行动的人|⚠️|👉)/;

// 从章节提纲中抽取明确要求用户发言或行动的节点。
function extractChapterUserInteractionText(input: unknown): string {
  const text = normalizeScalarText(input).replace(/\r\n/g, "\n");
  if (!text) return "";
  const lines = text.split("\n");
  const blocks: string[] = [];
  let buffer: string[] = [];
  let active = false;

  const flush = () => {
    const next = buffer.join("\n").trim();
    if (next) {
      blocks.push(next);
    }
    buffer = [];
    active = false;
  };

  const isStartLine = (line: string) => CHAPTER_USER_INTERACTION_PATTERN.test(line);
  const isBoundaryLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/^##+\s+/.test(trimmed) && !isStartLine(trimmed)) return true;
    if (/^@/.test(trimmed) && !/(系统|仅对用户|用户)/.test(trimmed) && !isStartLine(trimmed)) return true;
    return false;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (active && isBoundaryLine(trimmed)) {
      flush();
    }
    if (!active && isStartLine(trimmed)) {
      active = true;
      buffer.push(line.trimEnd());
      continue;
    }
    if (active) {
      buffer.push(line.trimEnd());
    }
  }
  if (active) {
    flush();
  }

  return uniqueTextList(blocks, 3).join("\n\n");
}

// 将任意输入压缩成指定长度内的可读文本。
function shortText(input: unknown, limit = 120): string {
  const text = normalizeScalarText(input);
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

// 将对象或数组压缩成短摘要，便于塞进 prompt。
function summarizeJsonValue(input: unknown, maxPairs = 6): string {
  if (!input || typeof input !== "object") return normalizeScalarText(input);
  if (Array.isArray(input)) {
    return input
      .map((item) => normalizeScalarText(item))
      .filter(Boolean)
      .slice(0, maxPairs)
      .join("；");
  }
  const record = input as Record<string, unknown>;
  return Object.entries(record)
    .map(([key, value]) => {
      const normalized = Array.isArray(value) ? value.join("、") : normalizeScalarText(value);
      if (!normalized) return "";
      return `${key}:${normalized}`;
    })
    .filter(Boolean)
    .slice(0, maxPairs)
    .join("；");
}

// 将参数卡压成适合编排模型读取的短文本，只保留关键人物属性。
function summarizeParameterCardText(input: unknown): string {
  const card = asRecord(input);
  if (!hasRecordKeys(card)) return "";
  const parts = [
    normalizeScalarText(card.name) ? `角色名:${normalizeScalarText(card.name)}` : "",
    normalizeScalarText(card.gender) ? `性别:${normalizeScalarText(card.gender)}` : "",
    card.age != null && normalizeScalarText(card.age) ? `年龄:${normalizeScalarText(card.age)}` : "",
    card.level != null && normalizeScalarText(card.level) ? `等级:${normalizeScalarText(card.level)}` : "",
    normalizeScalarText(card.level_desc || card.levelDesc) ? `等级称号:${normalizeScalarText(card.level_desc || card.levelDesc)}` : "",
    normalizeScalarText(card.raw_setting || card.rawSetting) ? `设定摘要:${shortText(card.raw_setting || card.rawSetting, 28)}` : "",
    normalizeScalarText(card.personality) ? `性格:${shortText(card.personality, 24)}` : "",
    normalizeScalarText(card.appearance) ? `外貌:${shortText(card.appearance, 24)}` : "",
    normalizeScalarText(card.voice) ? `音色:${shortText(card.voice, 24)}` : "",
    Array.isArray(card.skills) && card.skills.length ? `技能:${card.skills.map((item: unknown) => normalizeScalarText(item)).filter(Boolean).slice(0, 3).join("、")}` : "",
    Array.isArray(card.items) && card.items.length ? `物品:${card.items.map((item: unknown) => normalizeScalarText(item)).filter(Boolean).slice(0, 3).join("、")}` : "",
    Array.isArray(card.equipment) && card.equipment.length ? `装备:${card.equipment.map((item: unknown) => normalizeScalarText(item)).filter(Boolean).slice(0, 3).join("、")}` : "",
    Number.isFinite(Number(card.hp)) ? `血量:${Number(card.hp)}` : "",
    Number.isFinite(Number(card.mp)) ? `蓝量:${Number(card.mp)}` : "",
    Number.isFinite(Number(card.money)) ? `金钱:${Number(card.money)}` : "",
    Array.isArray(card.other) && card.other.length ? `其他:${card.other.map((item: unknown) => normalizeScalarText(item)).filter(Boolean).slice(0, 3).join("、")}` : "",
  ].filter(Boolean);
  return parts.join("|");
}

function summarizeParameterCardKeyText(input: unknown): string {
  const card = asRecord(input);
  if (!hasRecordKeys(card)) return "";
  const levelValue = card.level != null && normalizeScalarText(card.level) ? normalizeScalarText(card.level) : "";
  const levelLabel = normalizeScalarText(card.level_desc || card.levelDesc);
  const level = [levelValue, levelLabel].filter(Boolean).join("/");
  const parts = [
    normalizeScalarText(card.name) ? `角色名:${normalizeScalarText(card.name)}` : "",
    normalizeScalarText(card.gender) ? `性别:${normalizeScalarText(card.gender)}` : "",
    card.age != null && normalizeScalarText(card.age) ? `年龄:${normalizeScalarText(card.age)}` : "",
    normalizeScalarText(card.personality) ? `性格:${shortText(card.personality, 20)}` : "",
    level ? `等级:${level}` : "",
  ].filter(Boolean);
  return parts.join("|");
}

function normalizeCardTextList(value: unknown, limit = 8): string[] {
  return Array.isArray(value)
    ? value.map((item: unknown) => normalizeScalarText(item)).filter(Boolean).slice(0, limit)
    : [];
}

function normalizeOptionalCardNumber(value: unknown): number | null {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

// 根据当前调试模式限制记忆事实/标签的体积，避免调用方重复写同一套分支。
function buildLimitedMemoryText(value: unknown, compactLimit: number, fullLimit: number, compactMode: boolean): string {
  const maxItems = compactMode ? compactLimit : fullLimit;
  return uniqueTextList(Array.isArray(value) ? value : [], maxItems).join("；");
}

// 记忆管理器不需要完整参数卡原文，只需要足以推断成长变化的关键信息。
function buildMemoryRoleCardSummary(input: {
  roleId: string;
  roleName: string;
  roleType: string;
  card: JsonRecord;
}, compactMode: boolean): JsonRecord {
  const card = asRecord(input.card);
  const detailedCard = {
    name: normalizeScalarText(card.name),
    raw_setting: normalizeScalarText(card.raw_setting || card.rawSetting),
    gender: normalizeScalarText(card.gender),
    age: normalizeOptionalCardNumber(card.age),
    level: normalizeOptionalCardNumber(card.level),
    level_desc: normalizeScalarText(card.level_desc || card.levelDesc),
    personality: normalizeScalarText(card.personality),
    appearance: normalizeScalarText(card.appearance),
    voice: normalizeScalarText(card.voice),
    skills: normalizeCardTextList(card.skills),
    items: normalizeCardTextList(card.items),
    equipment: normalizeCardTextList(card.equipment),
    hp: normalizeOptionalCardNumber(card.hp),
    mp: normalizeOptionalCardNumber(card.mp),
    money: normalizeOptionalCardNumber(card.money),
    other: normalizeCardTextList(card.other),
  };
  return {
    role_id: input.roleId,
    role_name: input.roleName,
    role_type: sanitizeRoleType(input.roleType),
    card: compactMode ? summarizeParameterCardText(card) : detailedCard,
  };
}

// 为记忆管理器选出本轮最相关的角色参数卡，避免把整个世界的所有角色都塞进 prompt。
function collectMemoryRoleCardSnapshots(input: {
  world: any;
  state: JsonRecord;
  recentMessages: RuntimeMessageInput[];
}): {
  playerCard: MemoryRoleCardSnapshot | null;
  npcCards: MemoryRoleCardSnapshot[];
} {
  const allRoles = runtimeStoryRoles(input.world, input.state);
  const messageRoleNames = new Set<string>();
  const messageRoleIds = new Set<string>();
  (Array.isArray(input.recentMessages) ? input.recentMessages : []).forEach((message) => {
    const roleName = normalizeScalarText(message.role);
    const roleType = sanitizeRoleType(message.roleType);
    if (roleName && roleType !== "narrator") {
      messageRoleNames.add(roleName);
    }
  });
  allRoles.forEach((role) => {
    if (messageRoleNames.has(normalizeScalarText(role.name))) {
      messageRoleIds.add(normalizeScalarText(role.id));
    }
  });

  const playerRole = allRoles.find((role) => sanitizeRoleType(role.roleType) === "player") || null;
  const playerCard = playerRole
    ? {
      roleId: normalizeScalarText(playerRole.id) || "player",
      roleName: normalizeScalarText(playerRole.name) || "用户",
      roleType: sanitizeRoleType(playerRole.roleType),
      card: asRecord(playerRole.parameterCardJson),
    }
    : null;

  const npcCards = allRoles
    .filter((role) => sanitizeRoleType(role.roleType) === "npc")
    .sort((left, right) => {
      const leftMatched = messageRoleIds.has(normalizeScalarText(left.id)) || messageRoleNames.has(normalizeScalarText(left.name));
      const rightMatched = messageRoleIds.has(normalizeScalarText(right.id)) || messageRoleNames.has(normalizeScalarText(right.name));
      if (leftMatched === rightMatched) return 0;
      return leftMatched ? -1 : 1;
    })
    .slice(0, 8)
    .map((role) => ({
      roleId: normalizeScalarText(role.id),
      roleName: normalizeScalarText(role.name),
      roleType: sanitizeRoleType(role.roleType),
      card: asRecord(role.parameterCardJson),
    }));

  return { playerCard, npcCards };
}

// 将角色的基础信息、口吻和参数卡压成编排模型可读的短摘要，避免把整份设定直接塞给模型。
function describeRole(role: RuntimeStoryRole | null | undefined, compactMode = false): string {
  if (!role) return "";
  if (compactMode) {
    return summarizeParameterCardKeyText(role.parameterCardJson) || `角色名:${normalizeScalarText(role.name)}`;
  }
  const parts = [
    `姓名:${normalizeScalarText(role.name)}`,
    `身份:${sanitizeRoleType(role.roleType)}`,
    summarizeParameterCardKeyText(role.parameterCardJson) ? `参数:${summarizeParameterCardKeyText(role.parameterCardJson)}` : "",
    shortText(role.sample, 48) ? `口吻:${shortText(role.sample, 48)}` : "",
    shortText(role.description, 60) ? `设定:${shortText(role.description, 60)}` : "",
  ].filter(Boolean);
  return parts.join("\n");
}

// 给 fast speaker 使用的极简角色资料，只保留这一轮真正需要的口吻和核心设定。
function describeRoleLite(role: RuntimeStoryRole | null | undefined): string {
  if (!role) return "";
  const card = asRecord(role.parameterCardJson);
  const summary = shortText(
    normalizeScalarText(card.raw_setting || card.rawSetting || role.description),
    24,
  );
  const personality = shortText(normalizeScalarText(card.personality), 12);
  const speechStyle = shortText(normalizeScalarText(card.voice || role.sample), 16);
  return [
    summary ? `设定:${summary}` : "",
    personality ? `性格:${personality}` : "",
    speechStyle ? `口吻:${speechStyle}` : "",
  ].filter(Boolean).join("|");
}

function readCurrentChapterPhase(chapter: any, state: JsonRecord): ChapterRuntimePhase | null {
  const outline = normalizeChapterRuntimeOutline(chapter?.runtimeOutline);
  const progress = readChapterProgressState(state);
  const runtimeEvent = readRuntimeCurrentEventState(state);
  if (!outline.phases.length) return null;
  if (progress.phaseId) {
    const matched = outline.phases.find((item) => item.id === progress.phaseId) || null;
    if (matched) return matched;
  }
  if (isFreeChapterRuntimeMode(chapter) && runtimeEvent.index > outline.phases.length) {
    return null;
  }
  return outline.phases[0] || null;
}

function isRoleAllowedInPhase(role: RuntimeStoryRole, phase: ChapterRuntimePhase | null): boolean {
  if (!phase) return true;
  const allowedSpeakers = Array.isArray(phase.allowedSpeakers) ? phase.allowedSpeakers : [];
  if (!allowedSpeakers.length) return true;
  const normalizedName = normalizeScalarText(role.name).toLowerCase();
  const normalizedType = sanitizeRoleType(role.roleType);
  return allowedSpeakers.some((item) => {
    const normalized = normalizeScalarText(item).toLowerCase();
    if (!normalized) return false;
    if (normalized === normalizedName) return true;
    if (normalized === normalizedType) return true;
    if (normalized === "系统" && normalizedType === "narrator") return true;
    return false;
  });
}

function filterRolesForPhase(roles: RuntimeStoryRole[], phase: ChapterRuntimePhase | null): RuntimeStoryRole[] {
  const filtered = roles.filter((item) => isRoleAllowedInPhase(item, phase));
  return filtered.length ? filtered : roles;
}

function resolvePhaseAwareNextRole(input: {
  requestedNextRole: string;
  requestedNextRoleType: string;
  awaitUser: boolean;
  currentRole: RuntimeStoryRole | null;
  roles: RuntimeStoryRole[];
  world: any;
}): { nextRole: string; nextRoleType: string } {
  const rolePair = rolePairForWorld(input.world);
  if (input.awaitUser) {
    return {
      nextRole: normalizeScalarText(rolePair.playerRole.name) || "用户",
      nextRoleType: "player",
    };
  }
  const requestedNextRole = normalizeScalarText(input.requestedNextRole);
  const requestedNextRoleType = sanitizeRoleType(input.requestedNextRoleType);
  const matchedByName = requestedNextRole
    ? input.roles.find((item) => normalizeScalarText(item.name) === requestedNextRole)
    : null;
  const matchedByType = requestedNextRoleType !== "player"
    ? input.roles.find((item) => sanitizeRoleType(item.roleType) === requestedNextRoleType)
    : null;
  const fallbackRole = resolveNextFallbackRole(
    input.roles,
    input.currentRole || input.roles[0] || { id: "fallback_narrator", roleType: "narrator", name: "旁白" },
  );
  const targetRole = matchedByName || matchedByType || fallbackRole || input.currentRole;
  return {
    nextRole: normalizeScalarText(targetRole?.name) || "旁白",
    nextRoleType: sanitizeRoleType(targetRole?.roleType || "narrator"),
  };
}

// 压缩当前故事状态，给编排模型只留关键记忆。
function summarizeStoryState(state: JsonRecord): string {
  const parts = [
    shortText(state.memorySummary, 180) ? `背景摘要:${shortText(state.memorySummary, 180)}` : "",
    Array.isArray(state.memoryFacts) && state.memoryFacts.length
      ? `关键事实:${state.memoryFacts.map((item) => shortText(item, 48)).filter(Boolean).slice(0, 5).join("；")}`
      : "",
  ].filter(Boolean);
  return parts.join("\n");
}

// 根据事件 kind 推导运行流，避免多个上下文分支里重复写同一套嵌套三元。
function resolveEventFlowType(
  eventKind: unknown,
  fallbackFlowType: "free_runtime" | "chapter_content" = "chapter_content",
): "introduction" | "chapter_content" | "chapter_ending_check" | "free_runtime" {
  const normalizedEventKind = String(eventKind || "").trim();
  if (normalizedEventKind === "opening") {
    return "introduction";
  }
  if (normalizedEventKind === "fixed" || normalizedEventKind === "ending") {
    return "chapter_ending_check";
  }
  return fallbackFlowType;
}

// 校验 phase-aware digest 是否仍然指向当前 phase，避免旧事件摘要错误复用到新 phase。
function matchesCurrentPhaseDigest(input: {
  runtimeEventDigest: JsonRecord;
  phaseDerivedEventIndex: number;
  runtimeEvent: RuntimeCurrentEventState;
  progress: JsonRecord;
  currentPhase: ChapterRuntimePhase | null;
  digestDynamicEvent: JsonRecord | null;
}): boolean {
  const expectedEventIndex = Number(
    input.phaseDerivedEventIndex || input.runtimeEvent.index || input.progress.eventIndex || 0,
  );
  const digestEventIndex = Number(input.runtimeEventDigest.eventIndex || 0);
  if (digestEventIndex !== expectedEventIndex) {
    return false;
  }
  if (!input.currentPhase || !input.digestDynamicEvent) {
    return true;
  }
  const digestPhaseId = String(input.digestDynamicEvent.phaseId || "").trim();
  if (!digestPhaseId) {
    return true;
  }
  return digestPhaseId === String(input.currentPhase.id || "").trim();
}

// 读取当前 phase 关联的用户节点和固定事件，减少主流程里的条件查找噪音。
function resolveCurrentPhaseNarrativeContext(input: {
  outline: JsonRecord;
  currentPhase: ChapterRuntimePhase;
}): { userNode: JsonRecord | null; fixedEvent: JsonRecord | null } {
  const userNodes = Array.isArray(input.outline.userNodes) ? input.outline.userNodes as JsonRecord[] : [];
  const fixedEvents = Array.isArray(input.outline.fixedEvents) ? input.outline.fixedEvents as JsonRecord[] : [];
  const userNode = input.currentPhase.userNodeId
    ? userNodes.find((item: JsonRecord) => item.id === input.currentPhase.userNodeId) || null
    : null;
  const fixedEvent = fixedEvents.find((item: JsonRecord) => {
    return input.currentPhase.relatedFixedEventIds.includes(item.id)
      || input.currentPhase.completionEventIds.includes(item.id);
  }) || null;
  return { userNode, fixedEvent };
}

// 给当前 phase 生成事件摘要，优先使用目标摘要，其次回退到用户节点、固定事件和 phase 标题。
function resolveCurrentPhaseEventSummary(input: {
  currentPhase: ChapterRuntimePhase;
  userNode: JsonRecord | null;
  fixedEvent: JsonRecord | null;
}): string {
  const summarySource = (
    input.currentPhase.targetSummary
    || input.userNode?.promptText
    || input.fixedEvent?.label
    || input.currentPhase.label
  );
  return shortText(summarySource, 120) || "当前事件未命名";
}

function readCurrentRuntimeEventContext(chapter: any, state: JsonRecord): {
  eventIndex: number;
  eventKind: RuntimeCurrentEventState["kind"];
  eventFlowType: "introduction" | "chapter_content" | "chapter_ending_check" | "free_runtime";
  eventSummary: string;
  eventFacts: string[];
  eventMemorySummary: string;
  eventMemoryFacts: string[];
  eventStatus: RuntimeCurrentEventState["status"];
} {
  const runtimeEvent = readRuntimeCurrentEventState(state);
  const outline = normalizeChapterRuntimeOutline(chapter?.runtimeOutline);
  const progress = readChapterProgressState(state);
  const phases = Array.isArray(outline.phases) ? outline.phases : [];
  const currentPhase = progress.phaseId
    ? phases.find((item) => item.id === progress.phaseId) || null
    : phases[0] || null;
  const phaseIndex = currentPhase ? phases.findIndex((item) => item.id === currentPhase.id) : -1;
  const phaseDerivedEventIndex = phaseIndex >= 0 ? phaseIndex + 1 : 0;
  const runtimeEventDigest = readPhaseAwareRuntimeCurrentEventDigestState(chapter, state);
  const digestDynamicEvent = readRuntimeDynamicEventByIndex(
    state,
    Number(runtimeEventDigest.eventIndex || 0),
  );
  // 当前章节 phaseId 是真实状态机的锚点。
  // 只要 phaseId 已经推进到新事件，就不能让旧 digest 再把编排上下文拉回旧事件。
  // 这里除了 eventIndex，还要校验 digest 对应的动态事件 phaseId 是否仍属于当前 phase。
  // 否则上一章 eventIndex=1 的摘要，会在下一章同样 eventIndex=1 时被误复用。
  const digestMatchesCurrentEvent = matchesCurrentPhaseDigest({
    runtimeEventDigest,
    phaseDerivedEventIndex,
    runtimeEvent,
    progress,
    currentPhase,
    digestDynamicEvent,
  });
  if (runtimeEventDigest.eventSummary && digestMatchesCurrentEvent) {
    return {
      eventIndex: runtimeEventDigest.eventIndex,
      eventKind: runtimeEventDigest.eventKind,
      eventFlowType: runtimeEventDigest.eventFlowType,
      eventSummary: runtimeEventDigest.eventSummary,
      eventFacts: Array.isArray(runtimeEventDigest.eventFacts) ? runtimeEventDigest.eventFacts : [],
      eventMemorySummary: normalizeScalarText(runtimeEventDigest.memorySummary),
      eventMemoryFacts: Array.isArray(runtimeEventDigest.memoryFacts) ? runtimeEventDigest.memoryFacts : [],
      eventStatus: runtimeEventDigest.eventStatus,
    };
  }
  if (isFreeChapterRuntimeMode(chapter)) {
    const digestSummary = runtimeEventDigest.eventSummary || runtimeEvent.summary;
    const digestEventFacts = Array.isArray(runtimeEventDigest.eventFacts) ? runtimeEventDigest.eventFacts : [];
    const digestMemoryFacts = Array.isArray(runtimeEventDigest.memoryFacts) ? runtimeEventDigest.memoryFacts : [];
    const resolvedEventSummary = digestMatchesCurrentEvent ? digestSummary : runtimeEvent.summary;
    const resolvedEventFacts = digestMatchesCurrentEvent && digestEventFacts.length
      ? digestEventFacts
      : runtimeEvent.facts;
    const resolvedMemorySummary = digestMatchesCurrentEvent ? runtimeEventDigest.memorySummary : "";
    const resolvedMemoryFacts = digestMatchesCurrentEvent ? digestMemoryFacts : [];
    const resolvedEventStatus = digestMatchesCurrentEvent ? runtimeEventDigest.eventStatus : runtimeEvent.status;
    return {
      eventIndex: runtimeEvent.index,
      eventKind: runtimeEvent.kind,
      eventFlowType: resolveEventFlowType(runtimeEvent.kind, "free_runtime"),
      eventSummary: normalizeScalarText(resolvedEventSummary),
      eventFacts: resolvedEventFacts,
      eventMemorySummary: normalizeScalarText(resolvedMemorySummary),
      eventMemoryFacts: resolvedMemoryFacts,
      eventStatus: resolvedEventStatus || runtimeEvent.status || "active",
    };
  }
  if (!currentPhase) {
    const fallbackEventKind = progress.eventKind || runtimeEvent.kind || "scene";
    return {
      eventIndex: Number.isFinite(Number(progress.eventIndex)) ? Math.max(1, Number(progress.eventIndex)) : 1,
      eventKind: fallbackEventKind,
      eventFlowType: resolveEventFlowType(fallbackEventKind),
      eventSummary: normalizeScalarText(progress.eventSummary)
        || shortText(chapterDirectiveText(chapter), 120)
        || "当前事件未命名",
      eventFacts: [],
      eventMemorySummary: "",
      eventMemoryFacts: [],
      eventStatus: progress.eventStatus || runtimeEvent.status || "idle",
    };
  }
  const { userNode, fixedEvent } = resolveCurrentPhaseNarrativeContext({
    outline,
    currentPhase,
  });
  const eventSummary = resolveCurrentPhaseEventSummary({
    currentPhase,
    userNode,
    fixedEvent,
  });
  return {
    eventIndex: phaseDerivedEventIndex || Math.max(1, Number(progress.phaseIndex || 0) + 1),
    eventKind: currentPhase.kind || "scene",
    eventFlowType: resolveEventFlowType(currentPhase.kind, "chapter_content"),
    eventSummary,
    eventFacts: Array.isArray(runtimeEvent.facts) ? runtimeEvent.facts : [],
    eventMemorySummary: "",
    eventMemoryFacts: [],
    eventStatus: progress.eventStatus,
  };
}

function buildPromptEventContextPayload(currentEvent: {
  eventIndex: number;
  eventKind: RuntimeCurrentEventState["kind"];
  eventFlowType: "introduction" | "chapter_content" | "chapter_ending_check" | "free_runtime";
  eventSummary: string;
  eventFacts: string[];
  eventMemorySummary: string;
  eventMemoryFacts: string[];
  eventStatus: RuntimeCurrentEventState["status"];
}) {
  return {
    currentEventIndex: currentEvent.eventIndex,
    currentEventKind: currentEvent.eventKind,
    currentEventFlowType: currentEvent.eventFlowType,
    currentEventStatus: currentEvent.eventStatus,
    currentEventSummary: currentEvent.eventSummary,
    currentEventFacts: currentEvent.eventFacts,
    currentEventMemorySummary: currentEvent.eventMemorySummary,
    currentEventMemoryFacts: currentEvent.eventMemoryFacts,
  };
}

function buildPromptEventContextTextPayload(currentEvent: {
  eventIndex: number;
  eventKind: RuntimeCurrentEventState["kind"];
  eventFlowType: "introduction" | "chapter_content" | "chapter_ending_check" | "free_runtime";
  eventSummary: string;
  eventFacts: string[];
  eventMemorySummary: string;
  eventMemoryFacts: string[];
  eventStatus: RuntimeCurrentEventState["status"];
}, compactMode: boolean) {
  return {
    currentEventIndex: currentEvent.eventIndex,
    currentEventKind: currentEvent.eventKind,
    currentEventFlowType: currentEvent.eventFlowType,
    currentEventStatus: currentEvent.eventStatus,
    currentEventSummary: currentEvent.eventSummary,
    currentEventFacts: uniqueTextList(currentEvent.eventFacts || [], compactMode ? 3 : 5).join("；"),
    currentEventMemorySummary: shortText(currentEvent.eventMemorySummary || "", compactMode ? 100 : 180),
    currentEventMemoryFacts: uniqueTextList(currentEvent.eventMemoryFacts || [], compactMode ? 3 : 5).join("；"),
  };
}

// 判断一段文本是否仍然保留了章节正文的结构化痕迹，避免把提纲原样塞回模型。
function looksLikeDirectiveStructure(input: unknown): boolean {
  const text = normalizeScalarText(input);
  if (!text) return false;
  return /^##+\s+/.test(text)
    || /^@[^：:\n]{1,24}[：:]/.test(text)
    || /（饰演[^）]{0,24}）/.test(text)
    || /请输入.{0,16}(姓名|名称|性别|年龄)/.test(text);
}

// 解析章节正文行里的“谁在说 / 以谁身份说”信息。
// 用途：
// - 章节正文里的 `@旁白：...`、`（饰演日程空间戒指）...` 不能被当成脏结构全部删掉；
// - 编排师需要这些身份线索来判断当前事件到底应该由谁发声。
function extractDirectiveSpeechIdentity(input: string): { speaker: string; actedRole: string; body: string } {
  let text = normalizeScalarText(input).replace(/^##+\s+/, "").trim();
  let speaker = "";
  let actedRole = "";
  const speakerMatched = text.match(/^@([^：:\n]{1,24})\s*[：:]\s*(.+)$/);
  if (speakerMatched) {
    speaker = normalizeScalarText(speakerMatched[1]);
    text = normalizeScalarText(speakerMatched[2]);
  }
  const actedRoleMatched = text.match(/^[（(]\s*饰演([^）)]{1,24})\s*[）)]\s*(.+)$/);
  if (actedRoleMatched) {
    actedRole = normalizeScalarText(actedRoleMatched[1]);
    text = normalizeScalarText(actedRoleMatched[2]);
  }
  return {
    speaker,
    actedRole,
    body: text,
  };
}

// 将章节正文类文本压缩成事件摘要，同时保留“谁在说 / 以谁身份说”的关键约束。
function summarizeDirectiveLikeText(input: unknown, limit = 72): string {
  const paragraphs = directiveParagraphs(input)
    .map((item) => extractDirectiveSpeechIdentity(item))
    .map(({ speaker, actedRole, body }) => {
      const normalizedBody = normalizeScalarText(body)
        .replace(/\s+/g, " ")
        .replace(/[：:]\s*/g, "，")
        .trim();
      const identityParts = [
        speaker ? `@${speaker}` : "",
        actedRole ? `饰演${actedRole}` : "",
      ].filter(Boolean);
      const identityText = identityParts.join("，");
      if (identityText && normalizedBody) return `${identityText}：${normalizedBody}`;
      return identityText || normalizedBody;
    })
    .filter(Boolean);
  if (!paragraphs.length) return "";
  const summary = paragraphs
    .join("；")
    .replace(/；{2,}/g, "；")
    .replace(/\s+/g, " ")
    .trim();
  return shortText(summary, limit);
}

// 生成保留完整细节的结构化正文摘要。
// 用途：
// - 编排师的当前事件/阶段目标不能再被省略号截断，否则会丢掉事件内的关键事实与话术约束；
// - 这里仍然保留“谁在说 / 以谁身份说”，但不再做长度裁剪。
function summarizeDirectiveLikeTextFull(input: unknown): string {
  const paragraphs = directiveParagraphs(input)
    .map((item) => extractDirectiveSpeechIdentity(item))
    .map(({ speaker, actedRole, body }) => {
      const normalizedBody = normalizeScalarText(body)
        .replace(/\s+/g, " ")
        .replace(/[：:]\s*/g, "，")
        .trim();
      const identityParts = [
        speaker ? `@${speaker}` : "",
        actedRole ? `饰演${actedRole}` : "",
      ].filter(Boolean);
      const identityText = identityParts.join("，");
      if (identityText && normalizedBody) return `${identityText}：${normalizedBody}`;
      return identityText || normalizedBody;
    })
    .filter(Boolean);
  return paragraphs
    .join("；")
    .replace(/；{2,}/g, "；")
    .replace(/\s+/g, " ")
    .trim();
}

// 只为 prompt 生成“当前事件摘要”，避免直接把章节正文或动机模板原文交给模型。
function buildPromptSafeEventSummary(input: {
  currentEventSummary: string;
  currentPhaseLabel: string;
  chapterDirective: string;
  limit: number;
}): string {
  const rawSummary = normalizeScalarText(input.currentEventSummary);
  if (!rawSummary) {
    const fallbackSummary = summarizeDirectiveLikeTextFull(input.chapterDirective);
    return fallbackSummary || normalizeScalarText(input.currentPhaseLabel) || "当前事件未命名";
  }
  if (!looksLikeDirectiveStructure(rawSummary) && !looksLikeDirectiveLeak(rawSummary, input.chapterDirective, "")) {
    return rawSummary || normalizeScalarText(input.currentPhaseLabel) || "当前事件未命名";
  }
  const directiveSummary = summarizeDirectiveLikeTextFull(rawSummary)
    || summarizeDirectiveLikeTextFull(input.chapterDirective);
  return directiveSummary || normalizeScalarText(input.currentPhaseLabel) || "当前事件未命名";
}

// 过滤当前事件事实里的正文残留，同时保留必要的“说话者/饰演者”身份线索。
function buildPromptSafeEventFacts(input: {
  currentEventFacts: string[];
  chapterDirective: string;
  limit: number;
}): string[] {
  return uniqueTextList(input.currentEventFacts || [], input.limit)
    .map((item) => normalizeScalarText(item))
    .filter(Boolean)
    .map((item) => {
      if (!looksLikeDirectiveStructure(item) && !looksLikeDirectiveLeak(item, input.chapterDirective, "")) {
        return shortText(item, 48);
      }
      // 结构化正文行不直接丢弃，而是压成摘要后保留给模型，避免“谁在说”被误删。
      return shortText(summarizeDirectiveLikeText(item, 48), 48);
    })
    .filter(Boolean);
}

// 生成 prompt 专用的阶段目标，章节正文阶段只保留一句用途说明，避免整段剧情正文泄漏。
function buildPromptSafePhaseGoal(input: {
  currentPhaseLabel: string;
  currentEventSummary: string;
  chapterDirective: string;
  limit: number;
}): string {
  const summary = buildPromptSafeEventSummary({
    currentEventSummary: input.currentEventSummary,
    currentPhaseLabel: input.currentPhaseLabel,
    chapterDirective: input.chapterDirective,
    limit: input.limit,
  });
  const phaseLabel = normalizeScalarText(input.currentPhaseLabel);
  if (phaseLabel && summary && !summary.includes(phaseLabel)) {
    return `${phaseLabel}：${summary}`;
  }
  return summary || phaseLabel;
}

// 编排 prompt 不再直接带整段章节正文，只保留用户交互节点和开场白等结构化输入。
function buildPromptSafeChapterDirective(_input: {
  chapterDirective: string;
  currentEventFlowType: string;
}): string {
  return "";
}

// 压缩事件窗口，避免历史事件摘要继续把整段章节正文带回编排和角色发言链。
function buildPromptSafeEventWindow(input: {
  currentEventWindow: string;
  chapterDirective: string;
  currentEventFlowType?: string;
  limit: number;
}): string {
  if (input.currentEventFlowType === "chapter_content") return "";
  const rawWindow = normalizeScalarText(input.currentEventWindow);
  if (!rawWindow) return "";
  const lines = rawWindow
    .split(/\r?\n+/)
    .map((item) => normalizeScalarText(item))
    .filter(Boolean)
    .filter((item) => !looksLikeDirectiveStructure(item))
    .filter((item) => !looksLikeDirectiveLeak(item, input.chapterDirective, ""));
  return shortText(lines.join(" | "), input.limit);
}

// 清洗模型返回的普通文本行，去掉多余引号和超长内容。
function normalizeGeneratedLine(input: unknown, limit = 220): string {
  const text = normalizeScalarText(input)
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replaceAll("\r", "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

// 去掉舞台提示尾部多余标点，避免括号内容难读。
function trimStageDirectionTail(input: string): string {
  return normalizeScalarText(input)
    .replace(/[：:，,；;、\s]+$/g, "")
    .trim();
}

// 将动作描写与台词拆开，保证朗读和展示都更自然。
function formatDialogueWithStageDirection(content: string, roleType: string): string {
  const normalized = normalizeGeneratedLine(content, 220);
  if (!normalized) return "";
  if (sanitizeRoleType(roleType) === "narrator") return normalized;
  if (/^\s*\([^)]*\)\s*[\r\n]+/.test(normalized) || /^\s*（[^）]*）\s*[\r\n]+/.test(normalized)) {
    return normalized;
  }

  const lines = normalized
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (lines.length >= 2 && !/^[（(]/.test(lines[0])) {
    const stage = trimStageDirectionTail(lines[0]);
    const speech = lines.slice(1).join("\n").trim();
    if (stage && speech) {
      return `(${stage})\n${speech}`;
    }
  }

  const colonMatch = normalized.match(/^(.{6,160}?)[：:]\s*([\s\S]+)$/);
  if (colonMatch && !/^[（(]/.test(colonMatch[1])) {
    const stage = trimStageDirectionTail(colonMatch[1]);
    const speech = normalizeScalarText(colonMatch[2]);
    if (stage && speech) {
      return `(${stage})\n${speech}`;
    }
  }

  return normalized;
}

// 去掉模型返回里包裹的代码块标记。
function unwrapModelText(input: unknown): string {
  const text = normalizeScalarText(input)
    .replace(/^```(?:json|yaml|txt|text|markdown)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return text;
}

// 从纯文本中解析 key:value 形式的字段。
// 兼容两种常见返回：
// 1. `key: value`
// 2. `key:` 下一行才是真正的 value
// 这样可以容忍模型把字段值拆到下一行，而不会把 role/motive 解析丢掉。
function parseFieldMap(rawText: string): Record<string, string> {
  const lines = unwrapModelText(rawText)
    .split(/\r?\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const result: Record<string, string> = {};
  let pendingKey = "";
  for (const line of lines) {
    const matched = line.match(/^[-*]?\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*[:：=]\s*(.*)$/);
    if (matched) {
      const key = matched[1].toLowerCase();
      const value = matched[2].trim();
      if (value) {
        result[key] = value;
        pendingKey = "";
      } else {
        // 模型有时会输出：
        // motive:
        // 展示空间戒指内的具体存放物品情况
        // 这里先记住 key，下一行再吃 value。
        pendingKey = key;
      }
      continue;
    }
    if (pendingKey) {
      result[pendingKey] = line;
      pendingKey = "";
    }
  }
  return result;
}

// 按候选字段名顺序获取第一个可用值。
function getPlainField(fields: Record<string, string>, ...keys: string[]): string {
  for (const key of keys) {
    const value = normalizeScalarText(fields[key.toLowerCase()]);
    if (value) return value;
  }
  return "";
}

// 解析纯文本布尔值。
function parsePlainBoolean(input: unknown): boolean {
  const value = normalizeScalarText(input).toLowerCase();
  return value === "true" || value === "1" || value === "yes" || value === "是";
}

// 解析纯文本列表字段。
function parsePlainList(input: unknown): string[] {
  return normalizeScalarText(input)
    .split(/\s*[|｜；;]\s*/g)
    .map((item) => normalizeScalarText(item))
    .filter(Boolean);
}

// 解析纯文本里的状态增量，兜底成键值对对象。
function parsePlainStateDelta(input: unknown): JsonRecord {
  const text = normalizeScalarText(input);
  if (!text) return {};
  const objectLike = parseJsonSafe<JsonRecord>(text, {});
  if (hasRecordKeys(objectLike)) {
    return objectLike;
  }
  const result: JsonRecord = {};
  text.split(/\s*[;；]\s*/g).forEach((item) => {
    const matched = item.match(/^([^=:=：]+)\s*[:：=]\s*(.+)$/);
    if (!matched) return;
    const key = normalizeScalarText(matched[1]);
    const rawValue = normalizeScalarText(matched[2]);
    if (!key || !rawValue) return;
    if (/^(true|false)$/i.test(rawValue)) {
      result[key] = /^true$/i.test(rawValue);
      return;
    }
    const num = Number(rawValue);
    result[key] = Number.isFinite(num) ? num : rawValue;
  });
  return result;
}

// 把世界、章节、角色、状态拼成编排师可直接消费的用户提示词。
function buildCompactOrchestratorSections(payload: OrchestratorPromptPayload): Array<{ title: string; content: string }> {
  const rolesText = payload.roles
    .map((role) => `- ${sanitizeRoleType(role.roleType)}|${normalizeScalarText(role.name)}|${describeRole(role, true)}`)
    .join("\n");
  // 事件索引规则：
  // - 开场白 (eventKind: "opening") 不占用事件序号，eventIndex 为 undefined
  // - 章节内容 (eventKind: "scene") 从 index:1 开始
  // - 结局判断 (eventKind: "ending") 紧随章节内容之后
  const currentEventLines = [
    payload.currentEventIndex != null ? `index:${payload.currentEventIndex}` : "",
    `kind:${payload.currentEventKind || "scene"}`,
    `flow:${payload.currentEventFlowType || "chapter_content"}`,
    `status:${payload.currentEventStatus || "active"}`,
    `summary:${payload.currentEventSummary || "当前事件未命名"}`,
    payload.currentEventFacts.length ? `facts:${payload.currentEventFacts.join("｜")}` : "",
    payload.currentEventMemorySummary ? `memory:${payload.currentEventMemorySummary}` : "",
    payload.currentEventMemoryFacts.length ? `memory_facts:${payload.currentEventMemoryFacts.join("｜")}` : "",
  ].filter(Boolean).join("\n");
  const eventSeed = shortText(
    [
      payload.chapterDirective,
      payload.chapterUserTurns,
      payload.chapterOpening,
    ].filter(Boolean).join("\n"),
    160,
  );
  const recentLines = [
    stringifyRecentDialogue(payload.recentDialogue),
    payload.latestPlayerMessage ? `用户待处理:${payload.latestPlayerMessage}` : "",
  ].filter(Boolean).join("\n");
  const shouldShowEventSeed = !payload.currentEventSummary && !payload.currentEventFacts.length && Boolean(eventSeed);
  return [
    { title: "角色", content: rolesText || "无" },
    { title: "当前事件", content: currentEventLines || "kind:scene\nflow:chapter_content\nsummary:当前事件未命名" },
    ...(shouldShowEventSeed ? [{ title: "事件种子", content: eventSeed }] : []),
    { title: "最近对话", content: recentLines || "无" },
  ];
}

function buildOrchestratorPromptStats(payload: OrchestratorPromptPayload, compactMode: boolean): PromptStatRow[] {
  const orchestratorCurrentEventIndexLine = payload.currentEventIndex != null ? `index:${payload.currentEventIndex}` : "";
  const orchestratorWorldContent = [
    payload.worldName ? `名称:${payload.worldName}` : "",
    payload.worldIntro ? `简介:${payload.worldIntro}` : "",
  ].filter(Boolean).join("\n") || "无";
  const orchestratorChapterContent = [
    payload.chapterTitle ? `标题:${payload.chapterTitle}` : "",
    payload.chapterDirective ? `提纲摘录:${payload.chapterDirective}` : "",
    payload.chapterUserTurns ? `用户交互节点:${payload.chapterUserTurns}` : "",
    payload.chapterOpening ? `开场白:${payload.chapterOpening}` : "",
  ].filter(Boolean).join("\n") || "无";
  const orchestratorCurrentPhaseContent = [
    `label:${payload.currentPhaseLabel || "未命名阶段"}`,
    payload.currentPhaseGoal ? `goal:${payload.currentPhaseGoal}` : "",
    `allowed_speakers:${payload.phaseAllowedSpeakers.length ? payload.phaseAllowedSpeakers.join("、") : "全部当前角色"}`,
  ].filter(Boolean).join("\n");
  const orchestratorCurrentEventContent = [
    orchestratorCurrentEventIndexLine,
    `kind:${payload.currentEventKind || "scene"}`,
    `flow:${payload.currentEventFlowType || "chapter_content"}`,
    `status:${payload.currentEventStatus || "active"}`,
    `summary:${payload.currentEventSummary || "当前事件未命名"}`,
    payload.currentEventFacts.length ? `facts:${payload.currentEventFacts.join("；")}` : "",
    payload.currentEventMemorySummary ? `memory_summary:${payload.currentEventMemorySummary}` : "",
    payload.currentEventMemoryFacts.length ? `memory_facts:${payload.currentEventMemoryFacts.join("；")}` : "",
    payload.currentEventWindow ? `事件窗口:${payload.currentEventWindow}` : "",
  ].filter(Boolean).join("\n");
  const orchestratorStorySection = compactMode ? [] : [{ title: "剧情摘要", content: payload.storyState || "无" }];
  let sections: Array<{ title: string; content: string }>;
  if (compactMode) {
    sections = buildCompactOrchestratorSections(payload);
  } else {
    sections = [
      { title: "世界", content: orchestratorWorldContent },
      { title: "章节内部提纲", content: orchestratorChapterContent },
      { title: "角色列表", content: payload.roles.map((role) => `- ${sanitizeRoleType(role.roleType)} | ${normalizeScalarText(role.name)} | ${describeRole(role)}`).join("\n") || "无" },
      ...orchestratorStorySection,
      { title: "当前阶段", content: orchestratorCurrentPhaseContent },
      { title: "当前事件", content: orchestratorCurrentEventContent },
      { title: "回合状态", content: [`can_player_speak:${payload.turnState.canPlayerSpeak ? "true" : "false"}`, `expected_role_type:${sanitizeRoleType(payload.turnState.expectedRoleType)}`, `expected_role:${payload.turnState.expectedRole || "无"}`, `last_speaker_role_type:${sanitizeRoleType(payload.turnState.lastSpeakerRoleType)}`, `last_speaker:${payload.turnState.lastSpeaker || "无"}`].join("\n") },
      { title: "最近对话", content: payload.recentDialogue.length ? stringifyRecentDialogue(payload.recentDialogue) : "[]" },
      { title: "用户本轮输入", content: payload.latestPlayerMessage || "无" },
    ];
  }
  return sections.map((section) => {
    const content = section.content || "无";
    return {
      block: section.title,
      content,
      chars: content.length,
      estimatedTokens: estimatePromptTokens(content),
    };
  });
}

// 把角色发言链路里的上下文拆成可读统计块，方便直接对比快路由和标准路由的 prompt 体积。
function buildSpeakerPromptStats(payload: SpeakerPromptPayload, compactMode: boolean): PromptStatRow[] {
  const speakerCurrentEventIndexLine = payload.currentEventIndex != null ? `index:${payload.currentEventIndex}` : "";
  const nextEventLines = [
    payload.nextEventIndex != null ? `index:${payload.nextEventIndex}` : "",
    payload.nextEventKind ? `kind:${payload.nextEventKind}` : "",
    payload.nextEventFlowType ? `flow:${payload.nextEventFlowType}` : "",
    payload.nextEventStatus ? `status:${payload.nextEventStatus}` : "",
    payload.nextEventSummary ? `summary:${payload.nextEventSummary}` : "",
    payload.nextEventFacts.length ? `facts:${payload.nextEventFacts.join("；")}` : "",
    payload.nextEventTransitionHint ? `transition_hint:${payload.nextEventTransitionHint}` : "",
  ].filter(Boolean).join("\n") || "无";
  const speakerWorldContent = [
    payload.worldName ? `名称:${payload.worldName}` : "",
    payload.worldIntro ? `简介:${payload.worldIntro}` : "",
  ].filter(Boolean).join("\n") || "无";
  const speakerChapterContent = [
    payload.chapterTitle ? `标题:${payload.chapterTitle}` : "",
    payload.chapterContentHint ? `章节内容:${payload.chapterContentHint}` : "",
    payload.chapterEndingConditionHint ? `章节结束条件:${payload.chapterEndingConditionHint}` : "",
    payload.currentPhaseLabel ? `阶段:${payload.currentPhaseLabel}` : "",
  ].filter(Boolean).join("\n") || "无";
  const speakerCurrentEventContent = [
    speakerCurrentEventIndexLine,
    `kind:${payload.currentEventKind || "scene"}`,
    payload.currentEventFlowType ? `flow:${payload.currentEventFlowType}` : "",
    payload.currentEventStatus ? `status:${payload.currentEventStatus}` : "",
    `summary:${payload.currentEventSummary || "当前事件未命名"}`,
    payload.currentEventFacts.length ? `facts:${payload.currentEventFacts.join("；")}` : "",
    payload.currentEventMemorySummary ? `memory_summary:${payload.currentEventMemorySummary}` : "",
    payload.currentEventMemoryFacts.length ? `memory_facts:${payload.currentEventMemoryFacts.join("；")}` : "",
    payload.currentEventWindow ? `window:${payload.currentEventWindow}` : "",
  ].filter(Boolean).join("\n") || "无";
  const speakerStorySections = compactMode ? [] : [{ title: "剧情摘要", content: payload.storyState || "无" }];
  const speakerVisibleRoleSections = compactMode ? [] : [{ title: "其他可见角色", content: payload.otherRoles.length ? payload.otherRoles.join("、") : "无" }];
  const sections = [
    { title: "世界", content: speakerWorldContent },
    { title: "章节", content: speakerChapterContent },
    { title: "当前事件", content: speakerCurrentEventContent },
    { title: "下一事件", content: nextEventLines },
    { title: "当前说话人", content: [`name:${payload.speakerName || "未命名角色"}`, `role_type:${payload.speakerRoleType || "unknown"}`, payload.speakerProfile || ""].filter(Boolean).join("\n") || "无" },
    { title: "本轮动机", content: payload.motive || "无" },
    ...speakerStorySections,
    { title: "最近对话", content: payload.recentDialogue.length ? stringifyRecentDialogue(payload.recentDialogue) : "[]" },
    { title: "用户最近输入", content: payload.latestPlayerMessage || "无" },
    ...speakerVisibleRoleSections,
  ];
  return sections.map((section) => {
    const content = section.content || "无";
    return {
      block: section.title,
      content,
      chars: content.length,
      estimatedTokens: estimatePromptTokens(content),
    };
  });
}

// 把记忆管理链路里的上下文拆成可读统计块，便于直接判断“旧记忆为什么被覆盖了”。
function buildMemoryCurrentEventContent(payload: {
  currentEventIndex: number;
  currentEventKind: string;
  currentEventSummary: string;
  currentEventFacts: string;
  currentEventMemorySummary: string;
  currentEventMemoryFacts: string;
}): string {
  return [
    `index:${payload.currentEventIndex || 1}`,
    `kind:${payload.currentEventKind || "scene"}`,
    `summary:${payload.currentEventSummary || "当前事件未命名"}`,
    payload.currentEventFacts ? `facts:${payload.currentEventFacts}` : "",
    payload.currentEventMemorySummary ? `memory_summary:${payload.currentEventMemorySummary}` : "",
    payload.currentEventMemoryFacts ? `memory_facts:${payload.currentEventMemoryFacts}` : "",
  ].filter(Boolean).join("\n") || "无";
}

// 把紧凑模式的记忆调试块拆开，避免 buildMemoryPromptStats 里堆太多条件拼接。
function buildCompactMemoryPromptSections(payload: {
  currentMemory: string;
  currentFacts: string;
  currentEventContent: string;
  eventDeltaText: string;
  currentTags: string;
  playerCardText: string;
  npcCardsText: string;
  recentDialogueText: string;
}): Array<{ title: string; content: string }> {
  return [
    { title: "当前记忆", content: payload.currentMemory || "无" },
    { title: "当前事实", content: payload.currentFacts || "无" },
    { title: "当前事件", content: payload.currentEventContent },
    { title: "事件增量", content: payload.eventDeltaText || "无" },
    { title: "当前标签", content: payload.currentTags || "无" },
    { title: "用户参数卡", content: payload.playerCardText },
    { title: "相关NPC参数卡", content: payload.npcCardsText },
    { title: "新增对话", content: payload.recentDialogueText },
  ];
}

// 把完整模式的记忆调试块拆开，后面如果继续加统计项，不会把主函数再次堆高。
function buildFullMemoryPromptSections(payload: {
  worldName: string;
  chapterTitle: string;
  currentMemory: string;
  currentFacts: string;
  currentEventContent: string;
  eventDeltaText: string;
  currentTags: string;
  playerCardText: string;
  npcCardsText: string;
  recentDialogueText: string;
}): Array<{ title: string; content: string }> {
  return [
    { title: "世界", content: payload.worldName ? `名称:${payload.worldName}` : "无" },
    { title: "章节", content: payload.chapterTitle ? `标题:${payload.chapterTitle}` : "无" },
    { title: "当前事件", content: payload.currentEventContent },
    { title: "事件增量", content: payload.eventDeltaText || "无" },
    { title: "现有记忆摘要", content: payload.currentMemory || "无" },
    { title: "当前事实", content: payload.currentFacts || "无" },
    { title: "当前标签", content: payload.currentTags || "无" },
    { title: "用户参数卡", content: payload.playerCardText },
    { title: "相关NPC参数卡", content: payload.npcCardsText },
    { title: "新增对话", content: payload.recentDialogueText },
  ];
}

// 把记忆管理链路里的上下文拆成可读统计块，便于直接判断“旧记忆为什么被覆盖了”。
function buildMemoryPromptStats(payload: {
  worldName: string;
  chapterTitle: string;
  currentEventIndex: number;
  currentEventKind: string;
  currentEventSummary: string;
  currentEventFacts: string;
  currentEventMemorySummary: string;
  currentEventMemoryFacts: string;
  eventDeltaText: string;
  currentFacts: string;
  currentTags: string;
  recentDialogue: RecentDialogueTurn[];
  currentMemory: string;
  playerCard: JsonRecord | null;
  npcCards: JsonRecord[];
}, compactMode: boolean): PromptStatRow[] {
  const currentEventContent = buildMemoryCurrentEventContent(payload);
  const playerCardText = payload.playerCard ? JSON.stringify(payload.playerCard, null, 2) : "无";
  const npcCardsText = payload.npcCards.length ? JSON.stringify(payload.npcCards, null, 2) : "[]";
  const recentDialogueText = payload.recentDialogue.length ? stringifyRecentDialogue(payload.recentDialogue) : "[]";
  const sections = compactMode
    ? buildCompactMemoryPromptSections({
      currentMemory: payload.currentMemory,
      currentFacts: payload.currentFacts,
      currentEventContent,
      eventDeltaText: payload.eventDeltaText,
      currentTags: payload.currentTags,
      playerCardText,
      npcCardsText,
      recentDialogueText,
    })
    : buildFullMemoryPromptSections({
      worldName: payload.worldName,
      chapterTitle: payload.chapterTitle,
      currentMemory: payload.currentMemory,
      currentFacts: payload.currentFacts,
      currentEventContent,
      eventDeltaText: payload.eventDeltaText,
      currentTags: payload.currentTags,
      playerCardText,
      npcCardsText,
      recentDialogueText,
    });
  return sections.map((section) => {
    const content = section.content || "无";
    return {
      block: section.title,
      content,
      chars: content.length,
      estimatedTokens: estimatePromptTokens(content),
    };
  });
}

function logOrchestratorPromptStats(
  payload: OrchestratorPromptPayload,
  compactMode: boolean,
  runtime: NarrativeRuntimeMeta,
  systemPrompt: string,
  userPrompt: string,
  runtimeError: unknown,
  tokenUsage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } | null,
  rawResponse?: string | null,
  timing?: { buildMs?: number; invokeMs?: number; totalMs?: number } | null,
) {
  const rows: PromptStatRow[] = [
    {
      block: "系统提示词",
      content: systemPrompt || "无",
      chars: systemPrompt.length,
      estimatedTokens: estimatePromptTokens(systemPrompt),
    },
    ...buildOrchestratorPromptStats(payload, compactMode),
    {
      block: "用户提示词",
      content: userPrompt || "无",
      chars: userPrompt.length,
      estimatedTokens: estimatePromptTokens(userPrompt),
    },
  ];
  const totalPromptChars = systemPrompt.length + userPrompt.length;
  const totalPromptTokens = estimatePromptTokens(`${systemPrompt}\n${userPrompt}`.trim());

  // 单次编排只保留一条 runtime 日志，避免同一轮配置/响应各打一条导致看起来像重复调用。
  const runtimeLog: Record<string, any> = {
    ...runtime,
    traceMeta: normalizeTraceMeta(payload.traceMeta),
    requestChars: totalPromptChars,
    systemChars: systemPrompt.length,
    userChars: userPrompt.length,
    requestStatus: runtimeError ? "fallback" : "success",
    responseTextLength: rawResponse ? rawResponse.length : 0,
    responseText: rawResponse ? rawResponse.slice(0, 500) : "",
    tokenUsage: tokenUsage || null,
    buildMs: Number(timing?.buildMs || 0),
    invokeMs: Number(timing?.invokeMs || 0),
    totalMs: Number(timing?.totalMs || 0),
  };
  if (runtimeError) {
    runtimeLog.error = formatRuntimeErrorMessage(runtimeError);
  }

  if (DebugLogUtil.isDebugLogEnabled()) {
    console.log("[story:orchestrator:runtime]", JSON.stringify(runtimeLog));
    // [story:chapter_ending_check:stats] current_chapter
    DebugLogUtil.logCurrentChapter("story:orchestrator:stats", {
      id: payload.traceMeta?.chapterId,
      title: payload.chapterTitle || payload.traceMeta?.chapterTitle,
      sort: payload.traceMeta?.chapterSort,
    });
    console.log(`[story:orchestrator:stats] request_chars=${totalPromptChars} estimated_tokens=${totalPromptTokens} system_chars=${systemPrompt.length} user_chars=${userPrompt.length} build_ms=${Number(timing?.buildMs || 0)} invoke_ms=${Number(timing?.invokeMs || 0)} total_ms=${Number(timing?.totalMs || 0)}`);

    if (tokenUsage) {
      console.log(`[story:orchestrator:stats] actual_input_tokens=${tokenUsage.inputTokens || 0} actual_output_tokens=${tokenUsage.outputTokens || 0} actual_reasoning_tokens=${tokenUsage.reasoningTokens || 0}`);
    }

    const responseText = String(rawResponse || "").trim();
    if (responseText) {
      console.log(`[story:orchestrator:stats] response_chars=${responseText.length}`);
      console.log(`[story:orchestrator:stats] response_preview=${normalizePromptStatContent(responseText)}`);
    }

    if (runtimeError) {
      console.log(`[story:orchestrator:stats] request_status=fallback reason=${formatRuntimeErrorMessage(runtimeError)}`);
    } else {
      console.log("[story:orchestrator:stats] request_status=success");
    }
    console.log("[story:orchestrator:stats] 以下为 prompt 体积估算，不等于模型真实 usage。");
    console.log("[story:orchestrator:stats] | 区块 | 实际内容 | 字符数 | 估算 Prompt Tokens |");
    console.log("[story:orchestrator:stats] |---|---|---:|---:|");
    rows.forEach((row) => {
      console.log(`[story:orchestrator:stats] | ${row.block} | ${normalizePromptStatContent(row.content)} | ${row.chars} | ${row.estimatedTokens} |`);
    });

    if (responseText) {
      console.log(`[story:orchestrator:stats] | 返回内容 | ${normalizePromptStatContent(responseText)} | ${responseText.length} | - |`);
    }
    if (tokenUsage) {
      console.log(`[story:orchestrator:stats] | 实际推理消耗 | input=${tokenUsage.inputTokens || 0}, output=${tokenUsage.outputTokens || 0}, reasoning=${tokenUsage.reasoningTokens || 0} | - | - |`);
    }
    console.log(`[story:orchestrator:stats] System Prompt`);
    console.log(systemPrompt +"\n \n userPrompt:\n"+userPrompt);

    console.log(`[story:orchestrator:stats] 耗时: ${Number(timing?.totalMs || 0)}ms`);




  }
}

// 统一输出记忆管理器的 runtime/stats 日志，便于核对请求是否正确、返回是否为空、以及是否覆盖了旧记忆。
function logMemoryPromptStats(input: {
  payload: {
    worldName: string;
    chapterTitle: string;
    currentEventIndex: number;
    currentEventKind: string;
    currentEventSummary: string;
    currentEventFacts: string;
    currentEventMemorySummary: string;
    currentEventMemoryFacts: string;
    eventDeltaText: string;
    currentFacts: string;
    currentTags: string;
    recentDialogue: RecentDialogueTurn[];
    currentMemory: string;
    playerCard: JsonRecord | null;
    npcCards: JsonRecord[];
  };
  chapterMeta: { id?: unknown; title?: unknown; sort?: unknown } | null;
  compactMode: boolean;
  runtime: NarrativeRuntimeMeta;
  systemPrompt: string;
  userPrompt: string;
  runtimeError: unknown;
  tokenUsage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } | null;
  rawResponse?: string | null;
  timing?: { buildMs?: number; invokeMs?: number; totalMs?: number } | null;
}) {
  const rows: PromptStatRow[] = [
    {
      block: "系统提示词",
      content: input.systemPrompt || "无",
      chars: input.systemPrompt.length,
      estimatedTokens: estimatePromptTokens(input.systemPrompt),
    },
    ...buildMemoryPromptStats(input.payload, input.compactMode),
    {
      block: "用户提示词",
      content: input.userPrompt || "无",
      chars: input.userPrompt.length,
      estimatedTokens: estimatePromptTokens(input.userPrompt),
    },
  ];
  const totalPromptChars = input.systemPrompt.length + input.userPrompt.length;
  const totalPromptTokens = estimatePromptTokens(`${input.systemPrompt}\n${input.userPrompt}`.trim());
  const responseText = String(input.rawResponse || "").trim();
  const runtimeLog: Record<string, unknown> = {
    ...input.runtime,
    requestChars: totalPromptChars,
    systemChars: input.systemPrompt.length,
    userChars: input.userPrompt.length,
    requestStatus: input.runtimeError ? "fallback" : "success",
    responseTextLength: responseText.length,
    responseText: responseText ? responseText.slice(0, 500) : "",
    tokenUsage: input.tokenUsage || null,
    buildMs: Number(input.timing?.buildMs || 0),
    invokeMs: Number(input.timing?.invokeMs || 0),
    totalMs: Number(input.timing?.totalMs || 0),
    currentEventIndex: input.payload.currentEventIndex,
    recentDialogueCount: input.payload.recentDialogue.length,
  };
  if (input.runtimeError) {
    runtimeLog.error = formatRuntimeErrorMessage(input.runtimeError);
  }
  if (!DebugLogUtil.isDebugLogEnabled()) return;
  console.log("[story:memory:runtime]", JSON.stringify(runtimeLog));
  DebugLogUtil.logCurrentChapter("story:memory:stats", input.chapterMeta);
  console.log(`[story:memory:stats] request_chars=${totalPromptChars} estimated_tokens=${totalPromptTokens} system_chars=${input.systemPrompt.length} user_chars=${input.userPrompt.length} build_ms=${Number(input.timing?.buildMs || 0)} invoke_ms=${Number(input.timing?.invokeMs || 0)} total_ms=${Number(input.timing?.totalMs || 0)}`);
  if (input.tokenUsage) {
    console.log(`[story:memory:stats] actual_input_tokens=${input.tokenUsage.inputTokens || 0} actual_output_tokens=${input.tokenUsage.outputTokens || 0} actual_reasoning_tokens=${input.tokenUsage.reasoningTokens || 0}`);
  }
  if (responseText) {
    console.log(`[story:memory:stats] response_chars=${responseText.length}`);
    console.log(`[story:memory:stats] response_preview=${normalizePromptStatContent(responseText)}`);
  }
  if (input.runtimeError) {
    console.log(`[story:memory:stats] request_status=fallback reason=${formatRuntimeErrorMessage(input.runtimeError)}`);
  } else {
    console.log("[story:memory:stats] request_status=success");
  }
  console.log("[story:memory:stats] 以下为 prompt 体积估算，不等于模型真实 usage。");
  console.log("[story:memory:stats] | 区块 | 实际内容 | 字符数 | 估算 Prompt Tokens |");
  console.log("[story:memory:stats] |---|---|---:|---:|");
  rows.forEach((row) => {
    console.log(`[story:memory:stats] | ${row.block} | ${normalizePromptStatContent(row.content)} | ${row.chars} | ${row.estimatedTokens} |`);
  });
  if (responseText) {
    console.log(`[story:memory:stats] | 返回内容 | ${normalizePromptStatContent(responseText)} | ${responseText.length} | - |`);
  }
  if (input.tokenUsage) {
    console.log(`[story:memory:stats] | 实际推理消耗 | input=${input.tokenUsage.inputTokens || 0}, output=${input.tokenUsage.outputTokens || 0}, reasoning=${input.tokenUsage.reasoningTokens || 0} | - | - |`);
  }
  console.log("[story:memory:stats] System Prompt");
  console.log(`${input.systemPrompt}\n \n userPrompt:\n${input.userPrompt}`);
  console.log(`[story:memory:stats] 耗时: ${Number(input.timing?.totalMs || 0)}ms`);
}

// 统一输出角色发言器的 runtime/stats 日志，避免后续排查时还要反查到底走了哪条 speaker 路由。
function logSpeakerPromptStats(input: {
  payload: SpeakerPromptPayload;
  compactMode: boolean;
  speakerMode: string;
  speakerModelKey: string;
  runtime: NarrativeRuntimeMeta;
  systemPrompt: string;
  userPrompt: string;
  runtimeError: unknown;
  tokenUsage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } | null;
  rawResponse?: string | null;
  timing?: { buildMs?: number; invokeMs?: number; totalMs?: number } | null;
}) {
  const rows: PromptStatRow[] = [
    {
      block: "系统提示词",
      content: input.systemPrompt || "无",
      chars: input.systemPrompt.length,
      estimatedTokens: estimatePromptTokens(input.systemPrompt),
    },
    ...buildSpeakerPromptStats(input.payload, input.compactMode),
    {
      block: "用户提示词",
      content: input.userPrompt || "无",
      chars: input.userPrompt.length,
      estimatedTokens: estimatePromptTokens(input.userPrompt),
    },
  ];
  const totalPromptChars = input.systemPrompt.length + input.userPrompt.length;
  const totalPromptTokens = estimatePromptTokens(`${input.systemPrompt}\n${input.userPrompt}`.trim());
  const runtimeLog: Record<string, any> = {
    ...input.runtime,
    traceMeta: normalizeTraceMeta(input.payload.traceMeta),
    speakerMode: input.speakerMode,
    speakerModelKey: input.speakerModelKey,
    requestChars: totalPromptChars,
    systemChars: input.systemPrompt.length,
    userChars: input.userPrompt.length,
    requestStatus: input.runtimeError ? "fallback" : "success",
    responseTextLength: input.rawResponse ? input.rawResponse.length : 0,
    responseText: input.rawResponse ? input.rawResponse.slice(0, 500) : "",
    tokenUsage: input.tokenUsage || null,
    buildMs: Number(input.timing?.buildMs || 0),
    invokeMs: Number(input.timing?.invokeMs || 0),
    totalMs: Number(input.timing?.totalMs || 0),
  };
  if (input.runtimeError) {
    runtimeLog.error = formatRuntimeErrorMessage(input.runtimeError);
  }
  if (!DebugLogUtil.isDebugLogEnabled()) {
    return;
  }
  console.log("[story:streamlines:runtime]", JSON.stringify(runtimeLog));
  console.log(`[story:streamlines:stats] speaker_mode=${input.speakerMode} speaker_model_key=${input.speakerModelKey} request_chars=${totalPromptChars} estimated_tokens=${totalPromptTokens} system_chars=${input.systemPrompt.length} user_chars=${input.userPrompt.length} build_ms=${Number(input.timing?.buildMs || 0)} invoke_ms=${Number(input.timing?.invokeMs || 0)} total_ms=${Number(input.timing?.totalMs || 0)}`);
  if (input.tokenUsage) {
    console.log(`[story:streamlines:stats] actual_input_tokens=${input.tokenUsage.inputTokens || 0} actual_output_tokens=${input.tokenUsage.outputTokens || 0} actual_reasoning_tokens=${input.tokenUsage.reasoningTokens || 0}`);
  }
  const responseText = String(input.rawResponse || "").trim();
  if (responseText) {
    console.log(`[story:streamlines:stats] response_chars=${responseText.length}`);
    console.log(`[story:streamlines:stats] response_preview=${normalizePromptStatContent(responseText)}`);
  }
  if (input.runtimeError) {
    console.log(`[story:streamlines:stats] request_status=fallback reason=${formatRuntimeErrorMessage(input.runtimeError)}`);
  } else {
    console.log("[story:streamlines:stats] request_status=success");
  }
  console.log("[story:streamlines:stats] 以下为 prompt 体积估算，不等于模型真实 usage。");
  console.log("[story:streamlines:stats] | 区块 | 实际内容 | 字符数 | 估算 Prompt Tokens |");
  console.log("[story:streamlines:stats] |---|---|---:|---:|");
  rows.forEach((row) => {
    console.log(`[story:streamlines:stats] | ${row.block} | ${normalizePromptStatContent(row.content)} | ${row.chars} | ${row.estimatedTokens} |`);
  });
  if (responseText) {
    console.log(`[story:streamlines:stats] | 返回内容 | ${normalizePromptStatContent(responseText)} | ${responseText.length} | - |`);
  }
  if (input.tokenUsage) {
    console.log(`[story:streamlines:stats] | 实际推理消耗 | input=${input.tokenUsage.inputTokens || 0}, output=${input.tokenUsage.outputTokens || 0}, reasoning=${input.tokenUsage.reasoningTokens || 0} | - | - |`);
  }

  console.log(`[story:streamlines:stats] System Prompt`);
  console.log(input.systemPrompt +"\n \n userPrompt:\n"+input.userPrompt);
}

// 统一构造编排器事件种子，避免 compact 模式下重复写章节提纲拼接逻辑。
function buildOrchestratorEventSeed(payload: OrchestratorPromptPayload): string {
  return shortText(
    [
      payload.chapterDirective,
      payload.chapterUserTurns,
      payload.chapterOpening,
    ].filter(Boolean).join("\n"),
    160,
  );
}

// 判断是否需要给编排器补事件种子，只在当前事件还没有摘要和事实时启用。
function shouldAttachOrchestratorEventSeed(payload: OrchestratorPromptPayload): boolean {
  const hasCurrentEventContent = Boolean(payload.currentEventSummary) || payload.currentEventFacts.length > 0;
  return !hasCurrentEventContent;
}

function buildOrchestratorInputSnapshot(payload: OrchestratorPromptPayload, compactMode = false): JsonRecord {
  const roleList = payload.roles.map((role) => ({
    role_type: sanitizeRoleType(role.roleType),
    name: normalizeScalarText(role.name),
    profile: describeRole(role, compactMode),
  }));
  const eventWindow = payload.currentEventWindow || "";
  const snapshot: JsonRecord = {
    world: {
      name: payload.worldName || "未命名世界",
      intro: payload.worldIntro || "",
    },
    chapter: {
      title: payload.chapterTitle || "未命名章节",
      directive: payload.chapterDirective || "",
      user_turns: payload.chapterUserTurns || "",
      opening: payload.chapterOpening || "",
    },
    roles: roleList,
    wildcard_roles: payload.wildcardRoles.map((item) => ({
      name: item.name,
      role_type: sanitizeRoleType(item.roleType),
    })),
    narrator_wildcard_fallback: payload.narratorActsAsWildcardFallback,
    story_state: payload.storyState || "",
    current_phase: {
      label: payload.currentPhaseLabel || "未命名阶段",
      goal: payload.currentPhaseGoal || "",
      allowed_speakers: payload.phaseAllowedSpeakers,
    },
    current_event: {
      index: payload.currentEventIndex ?? 1,
      kind: payload.currentEventKind || "scene",
      flow: payload.currentEventFlowType || "chapter_content",
      status: payload.currentEventStatus || "active",
      summary: payload.currentEventSummary || "当前事件未命名",
      facts: payload.currentEventFacts,
      memory_summary: payload.currentEventMemorySummary || "",
      memory_facts: payload.currentEventMemoryFacts,
      window: eventWindow,
    },
    turn_state: {
      can_player_speak: payload.turnState.canPlayerSpeak,
      expected_role_type: sanitizeRoleType(payload.turnState.expectedRoleType),
      expected_role: payload.turnState.expectedRole || "",
      last_speaker_role_type: sanitizeRoleType(payload.turnState.lastSpeakerRoleType),
      last_speaker: payload.turnState.lastSpeaker || "",
    },
    recent_dialogue: payload.recentDialogue,
    latest_player_message: payload.latestPlayerMessage || "",
  };
  if (compactMode) {
    //如果 compactMode 为真，就把 snapshot.current_event.window 这个字段删掉。
    delete (snapshot.current_event as JsonRecord).window;
    delete (snapshot as JsonRecord).world;
    if (shouldAttachOrchestratorEventSeed(payload)) {
      (snapshot as JsonRecord).event_seed = buildOrchestratorEventSeed(payload);
    }
  }
  return snapshot;
}

function buildOrchestratorUserPrompt(payload: OrchestratorPromptPayload, compactMode = false): string {
  return JSON.stringify(buildOrchestratorInputSnapshot(payload, compactMode), null, 2);
}

// 把角色发言提示词里的当前事件段独立出来，减少主提示词函数里的条件堆叠。
function buildSpeakerCurrentEventLines(payload: {
  currentEventIndex: number;
  currentEventKind: string;
  currentEventFlowType?: string;
  currentEventStatus?: string;
  currentEventSummary: string;
  currentEventFacts: string[];
  currentEventMemorySummary: string;
  currentEventMemoryFacts: string[];
  currentEventWindow?: string;
}): string[] {
  return [
    `index: ${payload.currentEventIndex || 1}`,
    `kind: ${payload.currentEventKind || "scene"}`,
    payload.currentEventFlowType ? `flow: ${payload.currentEventFlowType}` : "",
    payload.currentEventStatus ? `status: ${payload.currentEventStatus}` : "",
    `summary: ${payload.currentEventSummary || "当前事件未命名"}`,
    payload.currentEventFacts.length ? `facts: ${payload.currentEventFacts.join("；")}` : "",
    payload.currentEventMemorySummary ? `memory_summary: ${payload.currentEventMemorySummary}` : "",
    payload.currentEventMemoryFacts.length ? `memory_facts: ${payload.currentEventMemoryFacts.join("；")}` : "",
    payload.currentEventWindow ? `window: ${payload.currentEventWindow}` : "",
  ];
}

// 把角色发言提示词里的下一事件段独立出来，方便继续清理 Sonar 对内联条件的告警。
function buildSpeakerNextEventLines(payload: {
  nextEventIndex?: number;
  nextEventKind?: string;
  nextEventFlowType?: string;
  nextEventStatus?: string;
  nextEventSummary?: string;
  nextEventFacts: string[];
  nextEventTransitionHint?: string;
}): string[] {
  return [
    payload.nextEventIndex != null ? `index: ${payload.nextEventIndex}` : "",
    payload.nextEventKind ? `kind: ${payload.nextEventKind}` : "",
    payload.nextEventFlowType ? `flow: ${payload.nextEventFlowType}` : "",
    payload.nextEventStatus ? `status: ${payload.nextEventStatus}` : "",
    payload.nextEventSummary ? `summary: ${payload.nextEventSummary}` : "",
    payload.nextEventFacts.length ? `facts: ${payload.nextEventFacts.join("；")}` : "",
    payload.nextEventTransitionHint ? `transition_hint: ${payload.nextEventTransitionHint}` : "",
  ];
}

// 构造角色发言提示词里的世界区块，避免主函数里堆叠基础元信息。
function buildSpeakerWorldLines(payload: {
  worldName: string;
  worldIntro: string;
}): string[] {
  return [
    "[世界]",
    `名称: ${payload.worldName || "未命名世界"}`,
    payload.worldIntro ? `简介: ${payload.worldIntro}` : "",
  ];
}

// 构造角色发言提示词里的章节区块，统一章节标题和提示字段输出。
function buildSpeakerChapterLines(payload: {
  chapterTitle: string;
  chapterContentHint?: string;
  chapterEndingConditionHint?: string;
}): string[] {
  return [
    "[章节]",
    `标题: ${payload.chapterTitle || "未命名章节"}`,
    payload.chapterContentHint ? `章节内容: ${payload.chapterContentHint}` : "",
    payload.chapterEndingConditionHint ? `章节结束条件: ${payload.chapterEndingConditionHint}` : "",
  ];
}

// 构造角色发言提示词里的当前阶段区块，减少主函数里对阶段标题的重复处理。
function buildSpeakerPhaseLines(payload: {
  currentPhaseLabel: string;
}): string[] {
  return [
    "[当前阶段]",
    `label: ${payload.currentPhaseLabel || "未命名阶段"}`,
  ];
}

// 构造角色发言提示词里的说话人区块，统一说话人名称、类型和画像描述。
function buildSpeakerIdentityLines(payload: {
  speakerName: string;
  speakerRoleType: string;
  speakerProfile: string;
}): string[] {
  return [
    "[当前说话人]",
    `name: ${payload.speakerName}`,
    `role_type: ${payload.speakerRoleType}`,
    payload.speakerProfile || "",
  ];
}

// 构造记忆管理提示词里的当前事件区块，统一 compact/full 两种模式的事件字段输出。
function buildMemoryCurrentEventLines(payload: {
  currentEventIndex: number;
  currentEventKind: string;
  currentEventSummary: string;
  currentEventFacts: string;
  currentEventMemorySummary: string;
  currentEventMemoryFacts: string;
}, spaced = false): string[] {
  const separator = spaced ? ": " : ":";
  return [
    `[当前事件]`,
    `index${separator}${payload.currentEventIndex || 1}`,
    `kind${separator}${payload.currentEventKind || "scene"}`,
    `summary${separator}${payload.currentEventSummary || "当前事件未命名"}`,
    payload.currentEventFacts ? `facts${separator}${payload.currentEventFacts}` : "",
    payload.currentEventMemorySummary ? `memory_summary${separator}${payload.currentEventMemorySummary}` : "",
    payload.currentEventMemoryFacts ? `memory_facts${separator}${payload.currentEventMemoryFacts}` : "",
  ];
}

// 构造记忆管理提示词里的参数卡区块，避免主函数里重复处理 JSON 序列化和空值回退。
function buildMemoryCardLines(payload: {
  playerCard: JsonRecord | null;
  npcCards: JsonRecord[];
}): string[] {
  return [
    "[用户当前参数卡(JSON)]",
    payload.playerCard ? JSON.stringify(payload.playerCard, null, 2) : "无",
    "",
    "[相关NPC参数卡(JSON数组)]",
    payload.npcCards.length ? JSON.stringify(payload.npcCards, null, 2) : "[]",
  ];
}

// 构造 compact 记忆管理任务说明，单独抽出后更容易调整提示词而不影响主结构。
function buildCompactMemoryTaskLines(): string[] {
  return [
    "[任务]",
    "请对比当前记忆、当前参数卡与新增对话，只保留对后续剧情有用的新事实、修正和标签。",
    "如果对话里出现角色状态变化、获得/失去物品、技能成长、身份变化，请同时输出参数卡 patch。",
    "如果有重复，直接合并；如果有冲突，按最新对话修正。",
  ];
}

// 构造 compact 记忆管理输出样例，避免主函数里直接嵌长 JSON 示例。
function buildCompactMemoryOutputExampleLines(): string[] {
  return [
    "[输出格式(JSON)]",
    JSON.stringify({
      summary: "新的故事摘要",
      facts: ["新事实1"],
      tags: ["标签1"],
      player_card_patch: {
        level: 2,
        items: ["新获得物品"],
        other: ["新的长期状态"],
      },
      npc_card_patches: [
        {
          role_id: "npc_xxx",
          role_name: "某角色",
          patch: {
            items: ["新获得物品"],
            other: ["新的长期状态"],
          },
        },
      ],
    }, null, 2),
    "注意：patch 只允许这些字段：raw_setting, personality, appearance, voice, skills, items, equipment, other, gender, age, level, level_desc, hp, mp, money。",
    "没有变化就返回空对象 {} 或空数组 []。",
  ];
}

// 构造 full 记忆管理提示词的世界与章节区块，减少主函数里的基础上下文拼接。
function buildMemoryWorldChapterLines(payload: {
  worldName: string;
  chapterTitle: string;
}): string[] {
  return [
    "[世界]",
    `名称: ${payload.worldName || "未命名世界"}`,
    "",
    "[章节]",
    `标题: ${payload.chapterTitle || "未命名章节"}`,
  ];
}

// 构造 full 记忆管理任务说明，便于后续单独调 prompt 而不影响主结构。
function buildFullMemoryTaskLines(): string[] {
  return [
    "[任务]",
    "根据现有记忆、当前事件、最近对话和角色参数卡，更新整个故事所需的长期记忆。",
    "如果对话里出现用户或 NPC 的长期状态变化，必须同时输出参数卡 patch。",
    "只保留对后续剧情真的有用的变化，重复项请合并，冲突项按最新剧情修正。",
  ];
}

// 构造 full 记忆管理输出样例，避免主函数里直接内嵌大段 JSON 示例。
function buildFullMemoryOutputExampleLines(): string[] {
  return [
    "[输出格式(JSON)]",
    JSON.stringify({
      summary: "新的故事摘要",
      facts: ["新事实1", "新事实2"],
      tags: ["标签1", "标签2"],
      player_card_patch: {
        level: 2,
        level_desc: "斗之气2星",
        skills: ["新技能"],
        items: ["新物品"],
        other: ["新的长期状态"],
      },
      npc_card_patches: [
        {
          role_id: "npc_xxx",
          role_name: "某角色",
          patch: {
            items: ["新物品"],
            other: ["新状态"],
          },
        },
      ],
    }, null, 2),
    "只允许使用这些 patch 字段：raw_setting, personality, appearance, voice, skills, items, equipment, other, gender, age, level, level_desc, hp, mp, money。",
    "如果没有参数卡变化，player_card_patch 返回 {}，npc_card_patches 返回 []。",
  ];
}

// 把当前说话人和上下文拼成角色发言提示词。
function buildSpeakerUserPrompt(payload: {
  worldName: string;
  worldIntro: string;
  chapterTitle: string;
  chapterContentHint?: string;
  chapterEndingConditionHint?: string;
  currentPhaseLabel: string;
  currentEventWindow?: string;
  currentEventIndex: number;
  currentEventKind: string;
  currentEventFlowType?: string;
  currentEventStatus?: string;
  currentEventSummary: string;
  currentEventFacts: string[];
  currentEventMemorySummary: string;
  currentEventMemoryFacts: string[];
  nextEventIndex?: number;
  nextEventKind?: string;
  nextEventFlowType?: string;
  nextEventStatus?: string;
  nextEventSummary?: string;
  nextEventFacts: string[];
  nextEventTransitionHint?: string;
  speakerName: string;
  speakerRoleType: string;
  speakerProfile: string;
  motive: string;
  storyState: string;
  latestPlayerMessage: string;
  recentDialogue: RecentDialogueTurn[];
  otherRoles: string[];
}): string {
  const worldLines = buildSpeakerWorldLines(payload);
  const chapterLines = buildSpeakerChapterLines(payload);
  const phaseLines = buildSpeakerPhaseLines(payload);
  const currentEventLines = buildSpeakerCurrentEventLines(payload);
  const nextEventLines = buildSpeakerNextEventLines(payload);
  const speakerIdentityLines = buildSpeakerIdentityLines(payload);
  const visibleRolesText = payload.otherRoles.length ? payload.otherRoles.join("、") : "无";
  return [
    ...worldLines,
    "",
    ...chapterLines,
    "",
    ...phaseLines,
    "",
    "[当前事件]",
    ...currentEventLines,
    "",
    "[下一事件]",
    ...nextEventLines,
    "",
    ...speakerIdentityLines,
    "",
    "[本轮动机]",
    payload.motive,
    "",
    "[剧情摘要]",
    payload.storyState || "暂无额外摘要",
    "",
    "[最近对话(JSON数组)]",
    stringifyRecentDialogue(payload.recentDialogue),
    "",
    "[用户最近输入]",
    payload.latestPlayerMessage || "无",
    "",
    "[其他可见角色]",
    visibleRolesText,
    "",
    "[输出要求]",
    "直接输出本轮真正展示给用户的一段正文，不要 JSON，不要字段名，不要代码块。",
  ].filter(Boolean).join("\n");
}

// 把最近对话和现有记忆拼成记忆管理提示词。
function buildMemoryUserPrompt(payload: {
  worldName: string;
  chapterTitle: string;
  currentEventIndex: number;
  currentEventKind: string;
  currentEventSummary: string;
  currentEventFacts: string;
  currentEventMemorySummary: string;
  currentEventMemoryFacts: string;
  eventDeltaText: string;
  currentFacts: string;
  currentTags: string;
  recentDialogue: RecentDialogueTurn[];
  currentMemory: string;
  playerCard: JsonRecord | null;
  npcCards: JsonRecord[];
}, compactMode = false): string {
  if (compactMode) {
    const currentEventLines = buildMemoryCurrentEventLines(payload);
    const cardLines = buildMemoryCardLines(payload);
    const taskLines = buildCompactMemoryTaskLines();
    const outputExampleLines = buildCompactMemoryOutputExampleLines();
    return [
      "[当前记忆]",
      payload.currentMemory || "无",
      "",
      "[当前事实]",
      payload.currentFacts || "无",
      "",
      ...currentEventLines,
      "",
      "[事件增量]",
      payload.eventDeltaText || "无",
      "",
      "[当前标签]",
      payload.currentTags || "无",
      "",
      ...cardLines,
      "",
      "[新增对话(JSON数组)]",
      stringifyRecentDialogue(payload.recentDialogue),
      "",
      ...taskLines,
      "",
      ...outputExampleLines,
    ].filter(Boolean).join("\n");
  }
  const worldChapterLines = buildMemoryWorldChapterLines(payload);
  const currentEventLines = buildMemoryCurrentEventLines(payload, true);
  const cardLines = buildMemoryCardLines(payload);
  const taskLines = buildFullMemoryTaskLines();
  const outputExampleLines = buildFullMemoryOutputExampleLines();
  return [
    ...worldChapterLines,
    "",
    ...currentEventLines,
    "",
    "[事件增量]",
    payload.eventDeltaText || "无",
    "",
    "[最近对话(JSON数组)]",
    stringifyRecentDialogue(payload.recentDialogue),
    "",
    "[现有记忆摘要]",
    payload.currentMemory || "无",
    "",
    "[当前事实]",
    payload.currentFacts || "无",
    "",
    "[当前标签]",
    payload.currentTags || "无",
    "",
    ...cardLines,
    "",
    ...taskLines,
    "",
    ...outputExampleLines,
  ].filter(Boolean).join("\n");
}

// 记忆管理使用更强压缩模式，避免把完整上下文塞爆本地小上下文模型。
function shouldUseCompactMemoryPayload(config: unknown): boolean {
  const manufacturer = normalizeScalarText((config as Record<string, unknown> | null)?.manufacturer).toLowerCase();
  if (manufacturer === "lmstudio") return true;
  return shouldUseCompactOrchestratorPayload(config);
}

// 判断当前模型是否需要走精简版提示词。
function shouldUseCompactOrchestratorPayload(config: unknown): boolean {
  const configuredMode = normalizeScalarText((config as Record<string, unknown> | null)?.payloadMode).toLowerCase();
  if (configuredMode === "advanced") return false;
  if (configuredMode === "compact") return true;
  const manufacturer = normalizeScalarText((config as Record<string, unknown> | null)?.manufacturer).toLowerCase();
  const model = normalizeScalarText((config as Record<string, unknown> | null)?.model).toLowerCase();
  if (!manufacturer || !model) return true;
  if (manufacturer === "lmstudio" || manufacturer === "autodl_chat") return true;
  if (manufacturer === "volcengine" || manufacturer === "doubao") return /(lite|mini|flash)/.test(model);
  return /(lite|mini|flash|r1|minimax|deepseek)/.test(model);
}

// 归一化当前阶段实际生效的模型运行信息，便于回归时直接观察。
function resolveNarrativeRuntimeMeta(
  stageKey: string,
  config: unknown,
  compactMode: boolean,
): NarrativeRuntimeMeta {
  const raw = (config as Record<string, unknown> | null) || null;
  const configuredMode = normalizeScalarText(raw?.payloadMode).toLowerCase();
  const reasoningEffort = normalizeScalarText(raw?.reasoningEffort).toLowerCase();
  return {
    modelKey: stageKey,
    manufacturer: normalizeScalarText(raw?.manufacturer),
    model: normalizeScalarText(raw?.model),
    reasoningEffort: reasoningEffort === "minimal" || reasoningEffort === "low" || reasoningEffort === "medium" || reasoningEffort === "high"
      ? reasoningEffort
      : "",
    payloadMode: compactMode ? "compact" : "advanced",
    payloadModeSource: configuredMode === "compact" || configuredMode === "advanced" ? "explicit" : "inferred",
  };
}

// 生成便于做相似度比较的归一化文本。
function normalizeComparableText(input: unknown): string {
  return normalizeScalarText(input)
    .replace(/\s+/g, "")
    .replace(/[：:]/g, ":")
    .toLowerCase();
}

// 检测模型输出是否泄漏了章节提纲或开场白。
function looksLikeDirectiveLeak(content: unknown, chapterDirective: unknown, openingText: unknown): boolean {
  const text = normalizeScalarText(content);
  if (!text) return false;
  const trimmed = text.trim();
  if (/^(章节内容|开场白|故事背景|系统提示词|内部规则)\s*[:：]/.test(trimmed)) {
    return true;
  }

  const normalizedContent = normalizeComparableText(trimmed);
  const normalizedDirective = normalizeComparableText(chapterDirective);
  const normalizedOpening = normalizeComparableText(openingText);

  if (normalizedDirective) {
    if (normalizedContent === normalizedDirective) return true;
    if (normalizedDirective.length > 24 && normalizedContent.includes(normalizedDirective.slice(0, Math.min(48, normalizedDirective.length)))) {
      return true;
    }
  }
  if (normalizedOpening && normalizedContent.includes(normalizedOpening)) {
    const extraLength = normalizedContent.length - normalizedOpening.length;
    if (extraLength > 8) {
      return true;
    }
  }

  const directiveHits = directiveParagraphs(chapterDirective)
    .slice(0, 4)
    .filter((item) => item.length > 8 && trimmed.includes(item.slice(0, Math.min(28, item.length))));
  return directiveHits.length > 0;
}

type RuntimeTurnState = {
  canPlayerSpeak: boolean;
  expectedRoleType: string;
  expectedRole: string;
  lastSpeakerRoleType: string;
  lastSpeaker: string;
};

// 从世界对象里拿到用户与旁白角色对。
function rolePairForWorld(world: any) {
  return normalizeRolePair(world?.playerRole, world?.narratorRole);
}

// 读取当前回合状态，决定谁该发言。
export function readRuntimeTurnState(state: JsonRecord, world: any): RuntimeTurnState {
  const raw = asRecord(state.turnState);
  const rolePair = rolePairForWorld(world);
  const playerName = normalizeScalarText(rolePair.playerRole.name) || "用户";
  return {
    canPlayerSpeak: raw.canPlayerSpeak !== false,
    expectedRoleType: sanitizeRoleType(raw.expectedRoleType || "player"),
    expectedRole: normalizeScalarText(raw.expectedRole) || playerName,
    lastSpeakerRoleType: sanitizeRoleType(raw.lastSpeakerRoleType || ""),
    lastSpeaker: normalizeScalarText(raw.lastSpeaker),
  };
}

// 写回当前回合状态，并返回规范化后的结果。
export function setRuntimeTurnState(
  state: JsonRecord,
  world: any,
  patch: Partial<RuntimeTurnState>,
): RuntimeTurnState {
  const current = readRuntimeTurnState(state, world);
  const next: RuntimeTurnState = {
    ...current,
    ...patch,
  };
  state.turnState = {
    canPlayerSpeak: next.canPlayerSpeak,
    expectedRoleType: sanitizeRoleType(next.expectedRoleType),
    expectedRole: normalizeScalarText(next.expectedRole),
    lastSpeakerRoleType: sanitizeRoleType(next.lastSpeakerRoleType || ""),
    lastSpeaker: normalizeScalarText(next.lastSpeaker),
  };
  return readRuntimeTurnState(state, world);
}

// 将性别文本统一成男/女。
function normalizeGenderValue(input: unknown): string {
  const text = normalizeScalarText(input);
  if (!text) return "";
  if (/女/.test(text)) return "女";
  if (/男/.test(text)) return "男";
  return "";
}

// 将年龄文本解析成合法数字。
function normalizeAgeValue(input: unknown): number | null {
  const text = normalizeScalarText(input);
  if (!text) return null;
  const matched = text.match(/(\d{1,3})/);
  if (!matched) return null;
  const value = Number(matched[1]);
  if (!Number.isFinite(value) || value <= 0 || value > 150) return null;
  return value;
}

// 从身份绑定输入里解析姓名、性别和年龄。
// 这里只接受“异天,男,36”或“姓名:异天 性别:男 年龄:36”这类显式填写格式，
// 禁止把“我是路过的”这种普通剧情对话误判成姓名。
function parsePlayerProfileFromMessage(message: string): {
  name?: string;
  gender?: string;
  age?: number;
} {
  const text = normalizeScalarText(message)
    .replace(/[。！？!?\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return {};

  const result: { name?: string; gender?: string; age?: number } = {};

  // 紧凑格式：异天,男,36
  const compact = text.match(/^([A-Za-z\u4e00-\u9fa5·•]{1,16})\s*[，,、/|｜]\s*(男|女|男性|女性|男生|女生)\s*[，,、/|｜]\s*(\d{1,3})\s*岁?$/u);
  if (compact) {
    result.name = normalizeScalarText(compact[1]);
    result.gender = normalizeGenderValue(compact[2]);
    result.age = normalizeAgeValue(compact[3]) ?? undefined;
    return result;
  }

  // 显式标签格式：姓名:异天 性别:男 年龄:36
  const explicitName = text.match(/(?:姓名|名称|名字|角色名)\s*[:：]\s*([A-Za-z\u4e00-\u9fa5·•]{1,16})/u);
  const explicitGender = text.match(/性别\s*[:：]\s*(男|女|男性|女性|男生|女生)/u);
  const explicitAge = text.match(/年龄\s*[:：]\s*(\d{1,3})\s*岁?/u);
  if (explicitName) {
    result.name = normalizeScalarText(explicitName[1]);
  }
  if (explicitGender) {
    result.gender = normalizeGenderValue(explicitGender[1]);
  }
  if (explicitAge) {
    result.age = normalizeAgeValue(explicitAge[1]) ?? undefined;
  }
  return result;
}


// 将用户资料写回运行时状态和参数卡。
export function applyPlayerProfileFromMessageToState(state: JsonRecord, world: any, message: unknown): JsonRecord {
  const text = normalizeScalarText(message);
  const rolePair = rolePairForWorld(world);
  const currentPlayer = asRecord(state.player);
  const displayName = normalizeScalarText(rolePair.playerRole.name) || "用户";
  const currentName = normalizeScalarText(currentPlayer.name || displayName) || displayName;
  const parsed = parsePlayerProfileFromMessage(text);
  const identityAlreadyBound = currentPlayer.identity_bound === true;
  const parsedCompleteProfile = Boolean(parsed.name && parsed.gender && parsed.age != null);
  if (!parsed.name && !parsed.gender && parsed.age == null) {
    if (!identityAlreadyBound && text) {
      const previousInvalidAttempts = Number(currentPlayer.identity_invalid_attempts || 0);
      currentPlayer.identity_invalid_attempts = Number.isFinite(previousInvalidAttempts)
        ? previousInvalidAttempts + 1
        : 1;
      state.player = currentPlayer;
    }
    return currentPlayer;
  }

  const nextPlayer = {
    ...rolePair.playerRole,
    ...currentPlayer,
    roleType: "player",
    name: normalizeScalarText(parsed.name || currentPlayer.name || displayName) || displayName,
  } as JsonRecord;
  const nextCard = asRecord(nextPlayer.parameterCardJson);
  nextCard.name = normalizeScalarText(parsed.name || nextCard.name || displayName) || displayName;
  nextCard.raw_setting = normalizeScalarText(nextCard.raw_setting || nextCard.rawSetting || nextPlayer.description);
  nextCard.personality = normalizeScalarText(nextCard.personality);
  nextCard.appearance = normalizeScalarText(nextCard.appearance);
  const levelValue = Number(nextCard.level);
  nextCard.level = Number.isFinite(levelValue) && levelValue > 0 ? Math.floor(levelValue) : 1;
  nextCard.level_desc = normalizeScalarText(nextCard.level_desc || nextCard.levelDesc) || "初入此界";
  const voice = normalizeScalarText(nextCard.voice || nextPlayer.voice);
  if (voice) {
    nextCard.voice = voice;
  }
  if (!Array.isArray(nextCard.skills)) nextCard.skills = [];
  if (!Array.isArray(nextCard.items)) nextCard.items = [];
  if (!Array.isArray(nextCard.equipment)) nextCard.equipment = [];
  if (!Array.isArray(nextCard.other)) nextCard.other = [];
  if (!Number.isFinite(Number(nextCard.hp))) nextCard.hp = 100;
  if (!Number.isFinite(Number(nextCard.mp))) nextCard.mp = 0;
  if (!Number.isFinite(Number(nextCard.money))) nextCard.money = 0;
  if (parsed.gender) {
    nextCard.gender = parsed.gender;
  }
  if (parsed.age != null) {
    nextCard.age = parsed.age;
  }
  if (parsedCompleteProfile) {
    nextPlayer.identity_bound = true;
    nextPlayer.identity_invalid_attempts = 0;
  } else if (!identityAlreadyBound && text) {
    const previousInvalidAttempts = Number(currentPlayer.identity_invalid_attempts || 0);
    nextPlayer.identity_invalid_attempts = Number.isFinite(previousInvalidAttempts)
      ? previousInvalidAttempts + 1
      : 1;
  }
  nextPlayer.parameterCardJson = Object.keys(nextCard).length ? nextCard : null;
  state.player = nextPlayer;

  const turnState = readRuntimeTurnState(state, world);
  if (
    sanitizeRoleType(turnState.expectedRoleType) === "player"
    && (!normalizeScalarText(turnState.expectedRole) || normalizeScalarText(turnState.expectedRole) === currentName || normalizeScalarText(turnState.expectedRole) === normalizeScalarText(parsed.name))
  ) {
    setRuntimeTurnState(state, world, {
      expectedRole: normalizeScalarText(nextPlayer.name || displayName) || displayName,
    });
  }
  return nextPlayer;
}

// 切回用户可发言状态。
export function allowPlayerTurn(state: JsonRecord, world: any, lastSpeakerRoleType = "", lastSpeaker = ""): RuntimeTurnState {
  const rolePair = rolePairForWorld(world);
  return setRuntimeTurnState(state, world, {
    canPlayerSpeak: true,
    expectedRoleType: "player",
    expectedRole: normalizeScalarText(rolePair.playerRole.name) || "用户",
    lastSpeakerRoleType,
    lastSpeaker,
  });
}

// 判断当前是否轮到用户发言。
export function canPlayerSpeakNow(state: JsonRecord, world: any): boolean {
  return readRuntimeTurnState(state, world).canPlayerSpeak;
}

// 在角色列表里找第一个指定类型的角色。
function findFirstRoleByType(roles: RuntimeStoryRole[], roleType: string): RuntimeStoryRole | undefined {
  return roles.find((item) => sanitizeRoleType(item.roleType) === sanitizeRoleType(roleType));
}

// 编排师有时会返回 `speaker: 用户`，但运行时里的真实用户名可能是“异天”。
// 这里统一把“用户/玩家/player”这类占位说法映射到当前用户角色，避免模型明明编排给用户却被当成无效结果。
function resolvePlannerSpeakerRole(
  roles: RuntimeStoryRole[],
  speaker: string,
  roleType: string,
): RuntimeStoryRole | null {
  const normalizedSpeaker = normalizeScalarText(speaker);
  const normalizedRoleType = sanitizeRoleType(roleType);
  if (normalizedRoleType === "player" || /^(用户|玩家|player)$/i.test(normalizedSpeaker)) {
    return findFirstRoleByType(roles, "player") || null;
  }
  if (normalizedSpeaker) {
    const matchedByName = roles.find((item) => normalizeScalarText(item.name) === normalizedSpeaker) || null;
    if (matchedByName) {
      return matchedByName;
    }
  }
  if (normalizedRoleType && normalizedRoleType !== "player") {
    return roles.find((item) => sanitizeRoleType(item.roleType) === normalizedRoleType && sanitizeRoleType(item.roleType) !== "player") || null;
  }
  return null;
}

// 选择当前回合的回退发言角色。
function resolveFallbackRole(roles: RuntimeStoryRole[], turnState: RuntimeTurnState, latestPlayerMessage: string): RuntimeStoryRole {
  const narrator = findFirstRoleByType(roles, "narrator");
  const npcs = roles.filter((item) => sanitizeRoleType(item.roleType) === "npc");
  const expectedRoleName = normalizeScalarText(turnState.expectedRole);
  const expectedRoleType = sanitizeRoleType(turnState.expectedRoleType);
  const matchedExpected = expectedRoleName
    ? roles.find((item) => sanitizeRoleType(item.roleType) !== "player" && normalizeScalarText(item.name) === expectedRoleName)
    : null;
  if (matchedExpected) return matchedExpected;

  if (!latestPlayerMessage) {
    const expectedTypedRole = expectedRoleType !== "player"
      ? roles.find((item) => sanitizeRoleType(item.roleType) === expectedRoleType && normalizeScalarText(item.name) !== normalizeScalarText(turnState.lastSpeaker))
      : null;
    if (expectedTypedRole) return expectedTypedRole;
    return npcs.find((item) => normalizeScalarText(item.name) !== normalizeScalarText(turnState.lastSpeaker))
      || npcs[0]
      || narrator
      || roles[0]
      || { id: "fallback_narrator", roleType: "narrator", name: "旁白" };
  }

  if (expectedRoleType !== "player") {
    const responder = roles.find((item) => sanitizeRoleType(item.roleType) === expectedRoleType);
    if (responder) return responder;
  }
  return npcs.find((item) => normalizeScalarText(item.name) !== normalizeScalarText(turnState.lastSpeaker))
    || npcs[0]
    || narrator
    || roles[0]
    || { id: "fallback_narrator", roleType: "narrator", name: "旁白" };
}

// 选择下一位回退接话的角色。
function resolveNextFallbackRole(roles: RuntimeStoryRole[], currentRole: RuntimeStoryRole): RuntimeStoryRole {
  const narrator = findFirstRoleByType(roles, "narrator");
  const otherNpc = roles.find((item) => sanitizeRoleType(item.roleType) === "npc" && item.name !== currentRole.name);
  if (sanitizeRoleType(currentRole.roleType) === "npc") {
    return narrator || otherNpc || currentRole;
  }
  return otherNpc || narrator || currentRole;
}

// 构造模型不可用时的兜底发言内容。
function buildFallbackContent(role: RuntimeStoryRole, latestPlayerMessage: string, fallbackIsSkip: boolean): string {
  const roleName = normalizeScalarText(role.name) || "旁白";
  const roleType = sanitizeRoleType(role.roleType);
  if (fallbackIsSkip) {
    if (roleType === "npc") {
      return `${roleName}见你暂时沉默，便先一步接过话头，继续推动眼前的局势。`;
    }
    return "你选择暂时沉默，其他角色顺势接过话头，剧情继续推进。";
  }
  if (!latestPlayerMessage) {
    if (roleType === "npc") {
      return `${roleName}率先打破僵持，开始根据眼前的异动继续行动。`;
    }
    return "局势仍在迅速变化，场上的角色开始根据眼前的异动继续行动。";
  }
  if (roleType === "npc") {
    return `${roleName}接住了你的回应，顺着当前局势继续推进。`;
  }
  return "你的回应让场上的气氛发生了变化，剧情继续向前推进。";
}

function normalizeFallbackCueText(input: unknown): string {
  return String(input || "")
    .replace(/[\s，。、“”"'‘’：:；;（）()【】\[\]\-—_·•・⋯…,.!?！？]/g, "")
    .trim()
    .toLowerCase();
}

function textRequestsUserIdentity(input: unknown): boolean {
  const normalized = normalizeFallbackCueText(input);
  if (!normalized) return false;
  const asksIdentityAction = ["输入", "填写", "提供", "告知", "绑定", "创建"].some((item) => normalized.includes(item));
  const mentionsName = normalized.includes("姓名") || normalized.includes("名称") || normalized.includes("名字") || normalized.includes("角色名");
  return asksIdentityAction && mentionsName && normalized.includes("性别") && normalized.includes("年龄");
}

function phaseRequestsUserIdentity(phase: ChapterRuntimePhase | null): boolean {
  if (!phase) return false;
  if (textRequestsUserIdentity(phase.targetSummary)) return true;
  return Array.isArray(phase.advanceSignals) && phase.advanceSignals.some((item) => textRequestsUserIdentity(item));
}

function isProviderBalanceOrQuotaError(input: unknown): boolean {
  const text = String((input as any)?.message || input || "").toLowerCase();
  return text.includes("insufficient account balance")
    || text.includes("insufficient_balance")
    || text.includes("insufficient_user_quota")
    || text.includes("quota")
    || text.includes("quota exceeded")
    || text.includes("余额不足")
    || text.includes("额度不足")
    || text.includes("配额不足")
    || text.includes("剩余额度")
    || text.includes("欠费")
    || text.includes("信用点不足")
    || text.includes("令牌不足");
}

function buildFallbackNarrativePlan(input: {
  roles: RuntimeStoryRole[];
  turnState: RuntimeTurnState;
  latestPlayerMessage: string;
  currentPhase: ChapterRuntimePhase | null;
  currentEvent: {
    eventIndex: number;
    eventKind: RuntimeCurrentEventState["kind"];
    eventSummary: string;
    eventFacts: string[];
    eventStatus: RuntimeCurrentEventState["status"];
  };
  hasPlayerInput: boolean;
  world: any;
  fallbackReason: unknown;
  pendingEndingGuide?: boolean;
  orchestratorRuntime?: NarrativeRuntimeMeta;
}): NarrativePlanResult {
  const currentRole = input.pendingEndingGuide
    ? (findFirstRoleByType(input.roles, "narrator") || resolveFallbackRole(input.roles, input.turnState, input.latestPlayerMessage))
    : resolveFallbackRole(input.roles, input.turnState, input.latestPlayerMessage);
  const shouldYieldToUser = input.currentPhase?.kind === "user"
    || input.currentEvent.eventStatus === "waiting_input"
    || phaseRequestsUserIdentity(input.currentPhase)
    || (isProviderBalanceOrQuotaError(input.fallbackReason) && phaseRequestsUserIdentity(input.currentPhase));
  if (input.pendingEndingGuide) {
    return {
      role: normalizeScalarText(currentRole.name),
      roleType: sanitizeRoleType(currentRole.roleType || "narrator"),
      motive: "结束条件尚未满足，先明确告诉用户还缺哪些关键信息，再把回合交还给用户。",
      memoryHints: [],
      triggerMemoryAgent: false,
      stateDelta: {},
      awaitUser: true,
      nextRole: normalizeScalarText(rolePairForWorld(input.world).playerRole.name) || "用户",
      nextRoleType: "player",
      chapterOutcome: "continue",
      nextChapterId: null,
      source: "fallback",
      eventAdjustMode: "waiting_input",
      eventIndex: input.currentEvent.eventIndex,
      eventKind: input.currentEvent.eventKind,
      eventSummary: input.currentEvent.eventSummary,
      eventFacts: input.currentEvent.eventFacts,
      eventStatus: "waiting_input",
      orchestratorRuntime: input.orchestratorRuntime,
    };
  }
  const nextRole = resolvePhaseAwareNextRole({
    requestedNextRole: "",
    requestedNextRoleType: "",
    awaitUser: shouldYieldToUser,
    currentRole,
    roles: input.roles,
    world: input.world,
  });
  return {
    role: shouldYieldToUser ? "" : normalizeScalarText(currentRole.name),
    roleType: shouldYieldToUser ? "player" : sanitizeRoleType(currentRole.roleType),
    motive: shouldYieldToUser
      ? "按当前章节节点把回合稳定交还给用户。"
      : (input.hasPlayerInput
        ? "顺着当前局势接住用户输入并继续推进剧情。"
        : "按当前阶段约束补一轮非用户推进内容。"),
    memoryHints: [],
    triggerMemoryAgent: false,
    stateDelta: {},
    awaitUser: shouldYieldToUser,
    nextRole: shouldYieldToUser ? normalizeScalarText(rolePairForWorld(input.world).playerRole.name) || "用户" : nextRole.nextRole,
    nextRoleType: shouldYieldToUser ? "player" : nextRole.nextRoleType,
    chapterOutcome: "continue",
    nextChapterId: null,
    source: "fallback",
    eventAdjustMode: shouldYieldToUser ? "waiting_input" : "keep",
    eventIndex: input.currentEvent.eventIndex,
    eventKind: input.currentEvent.eventKind,
    eventSummary: input.currentEvent.eventSummary,
    eventFacts: input.currentEvent.eventFacts,
    eventStatus: shouldYieldToUser ? "waiting_input" : input.currentEvent.eventStatus,
    orchestratorRuntime: input.orchestratorRuntime,
  };
}

function buildOrchestratorOutputFields(options: {
  allowControlHints: boolean;
  allowStateDelta: boolean;
}): string {
  const fields = [
    "role_type",
    "speaker",
    "motive",
    "await_user",
    "next_role_type",
    "next_speaker",
  ];
  if (options.allowControlHints) {
    fields.push("chapter_outcome", "next_chapter_id");
  }
  fields.push("memory_hints", "trigger_memory_agent");
  fields.push("event_adjust_mode", "event_status", "event_summary", "event_facts");
  if (options.allowStateDelta) {
    fields.push("state_delta");
  }
  return fields.join(" / ");
}

// 把最近对话整理成结构化数组，避免模型把多轮台词误当成一整段普通文本。
function recentDialogueItems(messages: RuntimeMessageInput[], maxCount = 12, maxChars = 0): RecentDialogueTurn[] {
  const items = messages
    .slice(-Math.max(1, maxCount))
    .map((item) => {
      const role = normalizeScalarText(item.role) || normalizeScalarText(item.roleType) || "系统";
      const roleType = sanitizeRoleType(item.roleType);
      const eventType = normalizeScalarText(item.eventType);
      const content = normalizeScalarText(item.content);
      if (!content) return null;
      return {
        role,
        roleType,
        eventType,
        content,
      };
    })
    .filter((item): item is RecentDialogueTurn => Boolean(item));
  if (maxChars <= 0) {
    return items;
  }
  let remain = Math.max(0, maxChars);
  const selected: RecentDialogueTurn[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const current = items[index];
    const currentChars = current.content.length;
    if (selected.length > 0 && currentChars > remain) {
      break;
    }
    selected.unshift(current);
    remain -= currentChars;
  }
  return selected;
}

// 把结构化最近对话稳定序列化成 JSON，方便纯文本 prompt 也能保留轮次结构。
function stringifyRecentDialogue(turns: RecentDialogueTurn[]): string {
  if (!Array.isArray(turns) || !turns.length) {
    return "[]";
  }
  return JSON.stringify(turns, null, 2);
}

function readMemoryDeltaInput(message: RuntimeMessageInput): {
  eventIndex: number;
  eventKind: string;
  eventSummary: string;
  eventFacts: string[];
  memorySummary: string;
  memoryFacts: string[];
} | null {
  const raw = asRecord((message as Record<string, unknown>)?.memoryDelta);
  if (!hasRecordKeys(raw)) return null;
  return {
    eventIndex: Number.isFinite(Number(raw.eventIndex)) ? Math.max(1, Number(raw.eventIndex)) : 1,
    eventKind: normalizeScalarText(raw.eventKind) || "scene",
    eventSummary: normalizeScalarText(raw.eventSummary),
    eventFacts: uniqueTextList(Array.isArray(raw.eventFacts) ? raw.eventFacts : [], 6),
    memorySummary: normalizeScalarText(raw.memorySummary),
    memoryFacts: uniqueTextList(Array.isArray(raw.memoryFacts) ? raw.memoryFacts : [], 6),
  };
}

function splitMemoryRefreshInputs(messages: RuntimeMessageInput[]): {
  dialogueMessages: RuntimeMessageInput[];
  eventDeltaMessages: RuntimeMessageInput[];
} {
  const dialogueMessages: RuntimeMessageInput[] = [];
  const eventDeltaMessages: RuntimeMessageInput[] = [];
  for (const item of messages) {
    const isEventDelta = normalizeScalarText(item.eventType) === "on_event_memory_delta" || !!readMemoryDeltaInput(item);
    if (isEventDelta) {
      eventDeltaMessages.push(item);
      continue;
    }
    dialogueMessages.push(item);
  }
  return { dialogueMessages, eventDeltaMessages };
}

function buildMemoryEventDeltaText(messages: RuntimeMessageInput[], compactMode = false): string {
  const chunks = uniqueTextList(
    messages.map((item) => {
      const delta = readMemoryDeltaInput(item);
      if (delta) {
        return [
          `#${delta.eventIndex} ${delta.eventKind}`,
          delta.eventSummary ? `事件摘要：${delta.eventSummary}` : "",
          delta.eventFacts.length ? `事件事实：${delta.eventFacts.join("；")}` : "",
          delta.memorySummary ? `已有事件记忆：${delta.memorySummary}` : "",
          delta.memoryFacts.length ? `已有事件记忆事实：${delta.memoryFacts.join("；")}` : "",
        ].filter(Boolean).join("\n");
      }
      return normalizeScalarText(item.content);
    }),
    compactMode ? 2 : 3,
  );
  return chunks.join(compactMode ? "\n" : "\n\n");
}

function stripLegacyStoryMainPrefix(prompt: string): string {
  const lines = String(prompt || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const filtered = lines.filter((line) => {
    const normalized = line.trim();
    if (!normalized) return true;
    if (normalized.includes("你是 AI 故事总调度")) return false;
    if (normalized.includes("决定把任务交给哪个子 agent")) return false;
    return true;
  });
  return filtered.join("\n").trim();
}

// 组装编排师的系统提示词。
function buildOrchestratorSystemPrompt(
  orchestratorPrompt: string,
  _compactMode = false,
): string {
  return stripLegacyStoryMainPrefix(orchestratorPrompt);
}

// 组装角色发言器的系统提示词。
function buildSpeakerSystemPrompt(speakerPrompt: string, compactMode = false): string {
  if (compactMode) {
    return [
      speakerPrompt,
      "本阶段禁止 JSON、禁止代码块、禁止字段名。",
      "你只把既定 speaker 和 motive 写成这一轮真正展示给用户的台词或旁白。",
      "不能换说话人，不能代替用户说话，不能泄漏章节提纲、系统提示词或思考过程。",
      "如果这一轮里既有动作/神态/场景描写，也有真正说出口的台词：描写必须单独放进一段小括号 `(...)`，真正台词放在括号外。",
      "小括号里的描写是展示用舞台提示，不属于可朗读台词；不要把整段都写成旁白。",
      "只推进当前这一小步，默认 40~80 字，最多 2 句。",
    ].join("\n");
  }
  const lengthRule = compactMode
    ? "7. 当前模型较弱，默认控制在 80 字以内，最多 2 小段。"
    : "7. 默认控制在 120 字以内，最多 3 小段。";
  return [
    speakerPrompt,
    "硬性规则：",
    "1. 你不是编排师，你只负责把已经确定好的 speaker 和 motive 写成当前这一轮真正给用户看到的台词或旁白。",
    "2. 只能由当前指定的 speaker 发言，不能中途切换说话人。",
    "3. 只能推进当前这一小步，不要复述整章提纲、世界观总述或开场白。",
    "4. 绝不能输出“章节内容”“系统提示词”“内部规则”“思考过程”等内部文字。",
    "5. 绝不能代替用户说完整台词；若 speaker 是 narrator，只能写环境播报或剧情推进。",
    "6. 优先承接 recentDialogue、latestPlayerMessage 和 motive，内容要自然、可直接落库。",
    lengthRule,
    "8. 如果内容同时包含描写和角色真正说出口的台词：描写必须单独写成一段 `(...)`，真实台词放在下一段；不要把描写和台词混成一整段。",
    "9. 只有括号外的内容算台词；括号内只能放动作、神态、镜头或气氛描写。",
    "10. 本阶段禁止 JSON、禁止代码块、禁止字段名；只返回最终展示给用户的一段正文。",
  ].filter(Boolean).join("\n\n");
}

// 从数据库读取故事编排相关 prompt。
async function loadStoryPrompts() {
  const rows = await u.db("t_prompts")
    .whereIn("code", [
      "story-orchestrator",
      "story-orchestrator-compact",
      "story-orchestrator-advanced",
      "story-speaker",
      "story-memory",
    ])
    .select("code", "defaultValue", "customValue");
  const map = new Map<string, any>();
  for (const row of rows as any[]) {
    map.set(String(row.code || ""), row);
  }
  const legacyOrchestrator = getPromptValue(map.get("story-orchestrator"));
  const compactOrchestrator = getPromptValue(map.get("story-orchestrator-compact")) || legacyOrchestrator;
  const advancedOrchestrator = getPromptValue(map.get("story-orchestrator-advanced")) || legacyOrchestrator;
  return {
    storyOrchestrator: legacyOrchestrator,
    storyOrchestratorCompact: compactOrchestrator,
    storyOrchestratorAdvanced: advancedOrchestrator,
    storySpeaker: getPromptValue(map.get("story-speaker")),
    storyMemory: getPromptValue(map.get("story-memory")),
  };
}

// 给不同阶段的模型配置生成中文标签。
function stageModelLabel(key: string): string {
  if (key === "storyOrchestratorModel") return "编排师";
  if (key === "storyFastSpeakerModel") return "快速角色发言";
  if (key === "storySpeakerModel") return "角色发言";
  if (key === "storyMemoryModel") return "记忆管理";
  return key;
}

// 判断模型槽位是否已经绑定了厂商，避免每个调用点都去解构 manufacturer。
function hasConfiguredStageModel(input: unknown): boolean {
  return Boolean(normalizeScalarText((input as Record<string, unknown> | null)?.manufacturer));
}

// 根据编排出的下一事件类型推导发言器看到的下一步运行流。
function resolveNextEventFlowType(nextEventKind: string): "chapter_ending_check" | "chapter_content" {
  return nextEventKind === "ending" ? "chapter_ending_check" : "chapter_content";
}

// 解析阶段模型配置，必要时回退到备用槽位。
async function resolveTextStageModel(userId: number, primaryKey: string, fallbackKey?: string) {
  const primary = await u.getPromptAi(primaryKey, userId);
  if (hasConfiguredStageModel(primary)) {
    return primary;
  }
  if (fallbackKey) {
    const fallback = await u.getPromptAi(fallbackKey, userId);
    if (hasConfiguredStageModel(fallback)) {
      return fallback;
    }
  }
  throw new Error(`${stageModelLabel(primaryKey)}对接的模型未配置，请在设置中单独绑定`);
}

// 调用模型生成当前角色的具体台词或旁白正文。
export async function runStorySpeakerContent(input: {
  userId: number;
  world: any;
  chapter: any;
  state: JsonRecord;
  recentMessages: RuntimeMessageInput[];
  playerMessage?: string;
  currentRole: RuntimeStoryRole;
  motive: string;
}): Promise<string> {
  // 角色发言链和编排链一样，保留 build/invoke/total 三段耗时，方便直接对照慢点到底出在哪。
  const totalStartedAt = Date.now();
  const currentPhase = readCurrentChapterPhase(input.chapter, input.state);
  const currentEvent = readCurrentRuntimeEventContext(input.chapter, input.state);
  const roles = filterRolesForPhase(runtimeStoryRoles(input.world, input.state), currentPhase);
  if (!isRoleAllowedInPhase(input.currentRole, currentPhase)) {
    throw createRuntimeModelError("speaker", "当前阶段不允许该角色发言");
  }
  const speakerMode = resolveSpeakerModeDecision({
    role: input.currentRole,
    motive: input.motive,
    latestUserMessage: normalizeScalarText(input.playerMessage),
  });
  console.log("[speaker:route] mode", {
    role: normalizeScalarText(input.currentRole.name),
    roleType: sanitizeRoleType(input.currentRole.roleType),
    mode: speakerMode.mode,
    reason: speakerMode.reason,
  });
  const prompts = await loadStoryPrompts();
  const useFastSpeakerPrompt = speakerMode.mode === "fast";
  const speakerModelKey = useFastSpeakerPrompt ? "storyFastSpeakerModel" : "storySpeakerModel";
  const promptAiConfig = await resolveTextStageModel(input.userId, speakerModelKey, useFastSpeakerPrompt ? "storySpeakerModel" : undefined);
  const compactMode = shouldUseCompactOrchestratorPayload(promptAiConfig);
  const currentChapter = {
    title: normalizeScalarText(input.chapter?.title),
    directive: chapterDirectiveText(input.chapter),
    directiveExcerpt: directiveExcerpt(chapterDirectiveText(input.chapter)),
  };
  const speakerSummaryLimit = useFastSpeakerPrompt ? 56 : (compactMode ? 72 : 96);
  const speakerFactsLimit = useFastSpeakerPrompt ? 2 : (compactMode ? 3 : 4);
  const speakerWorldIntroLimit = compactMode ? 48 : 72;
  const speakerMotiveLimit = useFastSpeakerPrompt ? 64 : (compactMode ? 80 : 120);
  const speakerStoryStateLimit = compactMode ? 160 : 260;
  const speakerNextEventFactsLimit = compactMode ? 2 : 3;
  const promptEventSummary = buildPromptSafeEventSummary({
    currentEventSummary: currentEvent.eventSummary,
    currentPhaseLabel: normalizeScalarText(currentPhase?.label),
    chapterDirective: currentChapter.directive,
    limit: speakerSummaryLimit,
  });
  const promptEventFacts = buildPromptSafeEventFacts({
    currentEventFacts: currentEvent.eventFacts,
    chapterDirective: currentChapter.directive,
    limit: speakerFactsLimit,
  });
  // 当前事件已经完成时，角色发言器应该面向下一事件继续生成，而不是围绕已完成事件原地打转。
  // 这里复用事件进度检测同一份“下一事件提示”，让角色发言器和事件进度检测看到一致的阶段边界。
  const nextEventHint = readNextEventProgressHint(input.chapter, input.state);
  let nextEventFlowType: "chapter_ending_check" | "chapter_content" | undefined;
  if (nextEventHint) {
    nextEventFlowType = resolveNextEventFlowType(nextEventHint.kind);
  }
  // 章节内容和章节结束条件单独显式喂给角色发言器，避免模型只能从事件窗口里间接猜边界。
  const chapterContentHint = shortText(
    currentChapter.directiveExcerpt || currentChapter.directive,
    compactMode ? 120 : 220,
  );
  const chapterEndingConditionHint = shortText(
    nextEventFlowType === "chapter_ending_check"
      ? normalizeScalarText(nextEventHint?.summary || nextEventHint?.transitionHint)
      : extractChapterUserInteractionText(currentChapter.directive),
    compactMode ? 100 : 180,
  );
  const promptCurrentEventIndex = currentEvent.eventStatus === "completed" && nextEventHint
    ? nextEventHint.index
    : currentEvent.eventIndex;
  let nextPromptEventKind: RuntimeCurrentEventState["kind"] = "scene";
  if (nextEventHint && ["opening", "scene", "user", "fixed", "ending"].includes(nextEventHint.kind)) {
    nextPromptEventKind = nextEventHint.kind as RuntimeCurrentEventState["kind"];
  }
  const promptCurrentEventKind: RuntimeCurrentEventState["kind"] = currentEvent.eventStatus === "completed" && nextEventHint
    ? nextPromptEventKind
    : currentEvent.eventKind;
  const promptCurrentEventFlowType = currentEvent.eventStatus === "completed" && nextEventHint
    ? (nextEventFlowType || currentEvent.eventFlowType)
    : currentEvent.eventFlowType;
  const promptCurrentEventStatus = currentEvent.eventStatus === "completed" && nextEventHint
    ? "active"
    : currentEvent.eventStatus;
  const promptCurrentEventSummary = currentEvent.eventStatus === "completed" && nextEventHint
    ? normalizeScalarText(nextEventHint.summary || nextEventHint.label)
    : promptEventSummary;
  const promptCurrentEventFacts = currentEvent.eventStatus === "completed" && nextEventHint
    ? uniqueTextList([
      normalizeScalarText(nextEventHint.summary),
      normalizeScalarText(nextEventHint.transitionHint),
    ], speakerNextEventFactsLimit)
    : promptEventFacts;
  const payload: SpeakerPromptPayload = {
    worldName: normalizeScalarText(input.world?.name),
    worldIntro: useFastSpeakerPrompt ? "" : shortText(input.world?.intro, speakerWorldIntroLimit),
    chapterTitle: currentChapter.title,
    chapterContentHint,
    chapterEndingConditionHint,
    currentPhaseLabel: normalizeScalarText(currentPhase?.label),
    ...buildPromptEventContextPayload({
      ...currentEvent,
      eventIndex: promptCurrentEventIndex,
      eventKind: promptCurrentEventKind,
      eventFlowType: promptCurrentEventFlowType,
      eventStatus: promptCurrentEventStatus,
      eventSummary: promptCurrentEventSummary,
      eventFacts: promptCurrentEventFacts,
    }),
    currentEventWindow: buildPromptSafeEventWindow({
      currentEventWindow: readDefaultRuntimeEventDigestWindowTextState(input.state),
      chapterDirective: currentChapter.directive,
      currentEventFlowType: currentEvent.eventFlowType,
      limit: compactMode ? 80 : 140,
    }),
    nextEventIndex: nextEventHint?.index,
    nextEventKind: nextEventHint?.kind,
    nextEventFlowType,
    nextEventStatus: nextEventHint ? "active" : "",
    nextEventSummary: normalizeScalarText(nextEventHint?.summary || nextEventHint?.label),
    nextEventFacts: uniqueTextList([
      normalizeScalarText(nextEventHint?.summary),
      normalizeScalarText(nextEventHint?.transitionHint),
    ], speakerNextEventFactsLimit),
    nextEventTransitionHint: normalizeScalarText(nextEventHint?.transitionHint),
    speakerName: normalizeScalarText(input.currentRole.name),
    speakerRoleType: sanitizeRoleType(input.currentRole.roleType),
    speakerProfile: useFastSpeakerPrompt ? describeRoleLite(input.currentRole) : describeRole(input.currentRole, true),
    motive: shortText(input.motive, speakerMotiveLimit),
    storyState: useFastSpeakerPrompt ? "" : shortText(summarizeStoryState(input.state), speakerStoryStateLimit),
    latestPlayerMessage: normalizeScalarText(input.playerMessage),
    recentDialogue: useFastSpeakerPrompt
      ? recentDialogueItems(input.recentMessages, 2, 180)
      : compactMode
        ? recentDialogueItems(input.recentMessages, 3, 240)
        : recentDialogueItems(input.recentMessages, 5, 520),
    otherRoles: useFastSpeakerPrompt
      ? []
      : roles
        .filter((item) => item.name !== input.currentRole.name)
        .map((item) => `${item.name}(${sanitizeRoleType(item.roleType)})`)
        .slice(0, compactMode ? 3 : 4),
    traceMeta: {
      worldId: Number(input.world?.id || 0),
      chapterId: Number(input.chapter?.id || 0),
      role: normalizeScalarText(input.currentRole.name),
      speakerMode: speakerMode.mode,
      speakerModelKey,
    },
  };
  // 只在 prompt payload 层切换当前/下一事件上下文，不改运行态原始事件信息，避免 UI 和回溯链失真。
  const systemPrompt = buildSpeakerSystemPrompt(prompts.storySpeaker || prompts.storyOrchestrator, useFastSpeakerPrompt || compactMode);
  // 无论快路由还是标准路由，都统一使用完整版 speaker prompt。
  // 区别只保留在模型槽位和上下文裁剪，不再分裂成另一套缺少章节/事件信息的 prompt 结构。
  const userPrompt = buildSpeakerUserPrompt(payload);
  const buildMs = Date.now() - totalStartedAt;
  let invokeMs = 0;
  let rawResponse = "";
  let runtimeError: unknown = null;
  let tokenUsage: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } | null = null;

  try {
    const invokeStartedAt = Date.now();
    const result = await u.ai.text.invoke(
      {
        plainTextOutput: true,
        usageType: "角色发言",
        usageRemark: `${normalizeScalarText(input.world?.name)} / ${normalizeScalarText(input.chapter?.title)} / ${normalizeScalarText(input.currentRole.name)} / ${speakerMode.mode}`,
        usageMeta: {
          stage: speakerModelKey,
          worldId: Number(input.world?.id || 0),
          chapterId: Number(input.chapter?.id || 0),
          role: normalizeScalarText(input.currentRole.name),
          speakerMode: speakerMode.mode,
          speakerRouteReason: speakerMode.reason,
        },
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: userPrompt,
          },
        ],
        maxRetries: 0,
      },
      promptAiConfig as any,
    );
    invokeMs = Date.now() - invokeStartedAt;
    rawResponse = unwrapModelText((result as any)?.text || "");
    tokenUsage = {
      inputTokens: Number((result as any)?.usage?.inputTokens || 0),
      outputTokens: Number((result as any)?.usage?.outputTokens || 0),
      reasoningTokens: Number((result as any)?.usage?.outputTokenDetails?.reasoningTokens || (result as any)?.usage?.reasoningTokens || 0),
    };
    const rawText = rawResponse;
    const objectLike = parseJsonSafe<Record<string, unknown>>(rawText, {});
    const fieldMap = parseFieldMap(rawText);
    const rawContent = normalizeGeneratedLine(
      (objectLike && Object.keys(objectLike).length ? objectLike.content : undefined)
      || getPlainField(fieldMap, "content")
      || rawText,
      compactMode ? 140 : 220,
    );
    const content = formatDialogueWithStageDirection(rawContent, input.currentRole.roleType);
    if (!content) {
      throw createRuntimeModelError("speaker", "模型返回内容为空");
    }
    if (looksLikeDirectiveLeak(content, currentChapter.directive, input.chapter?.openingText)) {
      throw createRuntimeModelError("speaker", "模型返回了内部编排内容");
    }
    logSpeakerPromptStats({
      payload,
      compactMode: useFastSpeakerPrompt || compactMode,
      speakerMode: speakerMode.mode,
      speakerModelKey,
      runtime: {
        modelKey: speakerModelKey,
        manufacturer: normalizeScalarText((promptAiConfig as any)?.manufacturer),
        model: normalizeScalarText((promptAiConfig as any)?.model),
        reasoningEffort: (() => {
          const value = normalizeScalarText((promptAiConfig as any)?.reasoningEffort).toLowerCase();
          return value === "minimal" || value === "low" || value === "medium" || value === "high" ? value : "";
        })(),
        payloadMode: useFastSpeakerPrompt || compactMode ? "compact" : "advanced",
        payloadModeSource: useFastSpeakerPrompt ? "explicit" : "inferred",
      },
      systemPrompt,
      userPrompt,
      runtimeError: null,
      tokenUsage,
      rawResponse,
      timing: {
        buildMs,
        invokeMs,
        totalMs: Date.now() - totalStartedAt,
      },
    });
    return content;
  } catch (err) {
    runtimeError = err;
    console.warn("[story:speaker] error", {
      manufacturer: (promptAiConfig as any)?.manufacturer || "",
      model: (promptAiConfig as any)?.model || "",
      role: normalizeScalarText(input.currentRole.name),
      message: (err as any)?.message || String(err),
    });
    logSpeakerPromptStats({
      payload,
      compactMode: useFastSpeakerPrompt || compactMode,
      speakerMode: speakerMode.mode,
      speakerModelKey,
      runtime: {
        modelKey: speakerModelKey,
        manufacturer: normalizeScalarText((promptAiConfig as any)?.manufacturer),
        model: normalizeScalarText((promptAiConfig as any)?.model),
        reasoningEffort: (() => {
          const value = normalizeScalarText((promptAiConfig as any)?.reasoningEffort).toLowerCase();
          return value === "minimal" || value === "low" || value === "medium" || value === "high" ? value : "";
        })(),
        payloadMode: useFastSpeakerPrompt || compactMode ? "compact" : "advanced",
        payloadModeSource: useFastSpeakerPrompt ? "explicit" : "inferred",
      },
      systemPrompt,
      userPrompt,
      runtimeError,
      tokenUsage,
      rawResponse,
      timing: {
        buildMs,
        invokeMs,
        totalMs: Date.now() - totalStartedAt,
      },
    });
    if (isProviderBalanceOrQuotaError(err)) {
      throw createRuntimeModelError("speaker", "当前角色发言模型余额不足，请充值或切换模型后重试");
    }
    return buildFallbackContent(
      input.currentRole,
      normalizeScalarText(input.playerMessage),
      normalizeScalarText(input.playerMessage) === ".",
    );
  }
}

// 把模型返回的状态增量应用到运行时状态。
function applyStateDelta(state: JsonRecord, delta: JsonRecord) {
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) return;
  Object.entries(delta).forEach(([key, value]) => {
    state[key] = value;
  });
}

function sanitizeNarrativeStateDelta(
  delta: JsonRecord,
  options?: {
    allowStateDelta?: boolean;
  },
): JsonRecord {
  if (options?.allowStateDelta !== true) {
    return {};
  }
  const forbiddenTopLevelKeys = new Set([
    "chapterId",
    "turnState",
    "chapterProgress",
    "player",
    "narrator",
    "npcs",
    "flags",
  ]);
  const sanitized: JsonRecord = {};
  for (const [key, value] of Object.entries(delta || {})) {
    if (forbiddenTopLevelKeys.has(String(key))) {
      continue;
    }
    sanitized[key] = value as any;
  }
  return sanitized;
}

// 调用编排模型，决定本轮谁说话、为什么说、以及是否轮到用户。
export async function runNarrativePlan(input: OrchestratorInput): Promise<NarrativePlanResult> {
  const start = Date.now();
  logOrchestratorKeyNode("runNarrativePlan:enter", input.traceMeta, {
    playerMessageLength: normalizeScalarText(input.playerMessage).length,
    recentMessageCount: Array.isArray(input.recentMessages) ? input.recentMessages.length : 0,
  });
  try {
    const result = await doRunNarrativePlan(input);
    return result;
  } finally {
    const cost = Date.now() - start;
    logOrchestratorKeyNode("runNarrativePlan:exit", input.traceMeta, { totalMs: cost });
    console.log(`[runNarrativePlan] 耗时: ${cost}ms`);
  }
}

// 调用编排模型，决定本轮谁说话、为什么说、以及是否轮到用户。
async function doRunNarrativePlan(input: OrchestratorInput): Promise<NarrativePlanResult> {
  const prompts = await loadStoryPrompts();
  const allRoles = runtimeStoryRoles(input.world, input.state);
  const promptAiConfig = await resolveTextStageModel(input.userId, "storyOrchestratorModel");
  const compactMode = shouldUseCompactOrchestratorPayload(promptAiConfig);
  const orchestratorRuntime = resolveNarrativeRuntimeMeta("storyOrchestratorModel", promptAiConfig, compactMode);
  const orchestratorPrompt = compactMode
    ? (prompts.storyOrchestratorCompact || prompts.storyOrchestrator || prompts.storyOrchestratorAdvanced)
    : (prompts.storyOrchestratorAdvanced || prompts.storyOrchestrator || prompts.storyOrchestratorCompact);
  const allowControlHints = input.allowControlHints !== false;
  const allowStateDelta = input.allowStateDelta !== false;
  const turnState = readRuntimeTurnState(input.state, input.world);
  const currentPhase = readCurrentChapterPhase(input.chapter, input.state);
  const currentEvent = readCurrentRuntimeEventContext(input.chapter, input.state);
  const roles = filterRolesForPhase(allRoles, currentPhase);
  const currentChapter = {
    id: Number(input.chapter?.id || 0),
    title: normalizeScalarText(input.chapter?.title),
    directive: chapterDirectiveText(input.chapter),
    openingRole: normalizeScalarText(input.chapter?.openingRole),
    openingText: normalizeScalarText(input.chapter?.openingText),
    backgroundPath: normalizeScalarText(input.chapter?.backgroundPath),
    bgmPath: normalizeScalarText(input.chapter?.bgmPath),
  };
  const promptEventSummary = buildPromptSafeEventSummary({
    currentEventSummary: currentEvent.eventSummary,
    currentPhaseLabel: normalizeScalarText(currentPhase?.label),
    chapterDirective: currentChapter.directive,
    limit: compactMode ? 72 : 96,
  });
  const promptEventFacts = buildPromptSafeEventFacts({
    currentEventFacts: currentEvent.eventFacts,
    chapterDirective: currentChapter.directive,
    limit: compactMode ? 3 : 4,
  });
  const payload = {
    worldName: normalizeScalarText(input.world?.name),
    worldIntro: shortText(input.world?.intro, compactMode ? 120 : 240),
    chapterTitle: currentChapter.title,
    chapterDirective: buildPromptSafeChapterDirective({
      chapterDirective: currentChapter.directive,
      currentEventFlowType: currentEvent.eventFlowType,
    }),
    chapterUserTurns: shortText(extractChapterUserInteractionText(currentChapter.directive), compactMode ? 180 : 880),
    chapterOpening: compactMode ? normalizeScalarText(currentChapter.openingText).slice(0, 80) : shortText(currentChapter.openingText, 180),
    roles,
    wildcardRoles: roles
      .filter((item) => roleActsAsWildcard(item))
      .map((item) => item),
    narratorActsAsWildcardFallback: roles.every((item) => !roleActsAsWildcard(item)),
    storyState: compactMode ? shortText(summarizeStoryState(input.state), 180) : summarizeStoryState(input.state),
    turnState,
    currentPhaseLabel: normalizeScalarText(currentPhase?.label),
    currentPhaseGoal: buildPromptSafePhaseGoal({
      currentPhaseLabel: normalizeScalarText(currentPhase?.label),
      currentEventSummary: currentEvent.eventSummary,
      chapterDirective: currentChapter.directive,
      limit: compactMode ? 72 : 96,
    }),
    ...buildPromptEventContextPayload(currentEvent),
    currentEventWindow: buildPromptSafeEventWindow({
      currentEventWindow: compactMode
        ? readRuntimeEventDigestWindowTextState(input.state, { windowSize: 3, includeMemory: false, summaryLimit: 40, factLimit: 1 })
        : readDefaultRuntimeEventDigestWindowTextState(input.state),
      chapterDirective: currentChapter.directive,
      currentEventFlowType: currentEvent.eventFlowType,
      limit: compactMode ? 80 : 140,
    }),
    phaseAllowedSpeakers: Array.isArray(currentPhase?.allowedSpeakers) ? currentPhase.allowedSpeakers : [],
    recentDialogue: compactMode ? recentDialogueItems(input.recentMessages, 10, 900) : recentDialogueItems(input.recentMessages),
    latestPlayerMessage: normalizeScalarText(input.playerMessage),
    traceMeta: normalizeTraceMeta(input.traceMeta),
  };
  // 编排 prompt 只读取精简后的事件摘要与事实，避免把章节正文当成“当前事件”再次送进模型。
  payload.currentEventSummary = promptEventSummary;
  payload.currentEventFacts = promptEventFacts;
  const hasPlayerInput = payload.latestPlayerMessage.length > 0;
  const isSkip = payload.latestPlayerMessage === ".";
  const ruleDecision = resolveRuleNarrativePlan({
    phase: currentPhase,
    state: input.state,
    roles: roles.map((item) => ({
      id: item.id,
      roleType: item.roleType,
      name: item.name,
    })),
    turnState: {
      canPlayerSpeak: turnState.canPlayerSpeak,
    },
    userDisplayName: normalizeScalarText(input.state?.player?.name || input.world?.playerRole?.name || "用户"),
    latestPlayerMessage: payload.latestPlayerMessage,
    currentEventKind: currentEvent.eventKind,
    currentEventFlowType: currentEvent.eventFlowType,
    currentEventStatus: currentEvent.eventStatus,
    pendingEndingGuide: input.state?.__pendingEndingGuide === true,
  });
  if (ruleDecision.resolved && ruleDecision.plan) {
    console.log("[rule:orchestrator] hit", {
      reason: ruleDecision.reason,
      role: ruleDecision.plan.role,
      roleType: ruleDecision.plan.roleType,
      awaitUser: ruleDecision.plan.awaitUser,
      nextRole: ruleDecision.plan.nextRole,
      nextRoleType: ruleDecision.plan.nextRoleType,
    });
    return {
      ...ruleDecision.plan,
      eventAdjustMode: ruleDecision.plan.awaitUser ? "waiting_input" : "keep",
      eventIndex: currentEvent.eventIndex,
      eventKind: currentEvent.eventKind,
      eventSummary: currentEvent.eventSummary,
      eventFacts: currentEvent.eventFacts,
      eventStatus: ruleDecision.plan.awaitUser ? "waiting_input" : currentEvent.eventStatus,
      orchestratorRuntime,
    };
  }

  const totalStartedAt = Date.now();
  const buildStartedAt = Date.now();
  const systemPrompt = buildOrchestratorSystemPrompt(orchestratorPrompt, compactMode);
  const userPrompt = buildOrchestratorUserPrompt(payload, compactMode);
  const promptBuildMs = Date.now() - buildStartedAt;
  let orchestratorRuntimeError: unknown = null;
  let orchestratorRawText = "";
  let orchestratorTokenUsage: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } | null = null;
  let orchestratorInvokeMs = 0;
  const start = Date.now();
  try {

    // 发送请求 进行编排
    const invokeStartedAt = Date.now();
    logOrchestratorKeyNode("storyOrchestratorModel:invoke:start", input.traceMeta, {
      currentEventIndex: currentEvent.eventIndex,
      currentEventKind: currentEvent.eventKind,
      currentEventFlowType: currentEvent.eventFlowType,
      currentEventStatus: currentEvent.eventStatus,
      hasPlayerInput,
    });
    const result = await u.ai.text.invoke(
      {
        plainTextOutput: true,
        usageType: "编排师",
        usageRemark: `${currentChapter.title || "未知章节"} / ${normalizeScalarText(input.world?.name)}`,
        usageMeta: {
          stage: "storyOrchestratorModel",
          worldId: Number(input.world?.id || 0),
          chapterId: currentChapter.id || 0,
          eventIndex: currentEvent.eventIndex,
          eventKind: currentEvent.eventKind,
        },
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: userPrompt,
          },
        ],
        maxRetries: input.maxRetries ?? 0,
      },
      promptAiConfig as any,
    );
    orchestratorInvokeMs = Date.now() - invokeStartedAt;
    logOrchestratorKeyNode("storyOrchestratorModel:invoke:done", input.traceMeta, {
      invokeMs: orchestratorInvokeMs,
    });
    const rawText = unwrapModelText((result as any)?.text || "");
    orchestratorRawText = rawText;
    orchestratorTokenUsage = (result as any)?.usage || null;
    const objectLike = parseJsonSafe<Record<string, unknown>>(rawText, {});
    const hasObjectLike = hasRecordKeys(asRecord(objectLike));
    const fieldMap = parseFieldMap(rawText);
    const speaker = normalizeScalarText(
      (hasObjectLike ? (objectLike.speaker ?? objectLike.role) : undefined)
      || getPlainField(fieldMap, "speaker", "role"),
    );
    const roleType = sanitizeRoleType(
      (hasObjectLike ? objectLike.roleType : undefined)
      || getPlainField(fieldMap, "role_type", "roletype"),
    );
    const matchedRole = resolvePlannerSpeakerRole(roles, speaker, roleType);
    const motive = normalizeGeneratedLine(
      (hasObjectLike ? objectLike.motive : undefined)
      || getPlainField(fieldMap, "motive"),
      compactMode ? 100 : 160,
    );
    const awaitUser = parsePlainBoolean(
      (hasObjectLike ? objectLike.awaitUser : undefined)
      || getPlainField(fieldMap, "await_user", "awaituser"),
    );
    const rawNextRoleType = normalizeScalarText(
      (hasObjectLike ? objectLike.nextRoleType : undefined)
      || getPlainField(fieldMap, "next_role_type", "nextroletype"),
    );
    const rawNextRole = normalizeScalarText(
      (hasObjectLike ? objectLike.nextSpeaker : undefined)
      || getPlainField(fieldMap, "next_speaker", "nextspeaker"),
    );
    const nextRoleState = resolvePhaseAwareNextRole({
      requestedNextRole: rawNextRole,
      requestedNextRoleType: rawNextRoleType || matchedRole?.roleType || turnState.expectedRoleType,
      awaitUser,
      currentRole: matchedRole,
      roles,
      world: input.world,
    });
    const nextRole = nextRoleState.nextRole;
    const nextRoleType = nextRoleState.nextRoleType;
    if (matchedRole && !isRoleAllowedInPhase(matchedRole, currentPhase)) {
      throw createRuntimeModelError("orchestrator", "模型选择了当前阶段不允许发言的角色");
    }
    const chapterOutcome = String(
      (hasObjectLike ? objectLike.chapterOutcome : undefined)
      || getPlainField(fieldMap, "chapter_outcome", "chapteroutcome")
      || "continue",
    ).trim().toLowerCase();
    const nextChapterIdRaw = normalizeScalarText(
      (hasObjectLike ? objectLike.nextChapterId : undefined)
      || getPlainField(fieldMap, "next_chapter_id", "nextchapterid"),
    );
    const nextChapterId = Number(nextChapterIdRaw || 0);
    const memoryHints = Array.isArray(objectLike?.memoryHints)
      ? (objectLike as any).memoryHints.map((item: unknown) => normalizeScalarText(item)).filter(Boolean)
      : parsePlainList(getPlainField(fieldMap, "memory_hints", "memoryhints"));
    const triggerMemoryAgent = parsePlainBoolean(
      (hasObjectLike ? objectLike.triggerMemoryAgent : undefined)
      || getPlainField(fieldMap, "trigger_memory_agent", "triggermemoryagent"),
    ) || memoryHints.length > 0;

    if (DebugLogUtil.isDebugLogEnabled()) {
       console.log(`[story:memory:runtime] triggerMemoryAgent=${triggerMemoryAgent}`);
    }

    const rawEventAdjustMode = normalizeScalarText(
      (hasObjectLike ? objectLike.eventAdjustMode : undefined)
      || getPlainField(fieldMap, "event_adjust_mode", "eventadjustmode"),
    ).toLowerCase();
    const rawEventStatus = normalizeScalarText(
      (hasObjectLike ? objectLike.eventStatus : undefined)
      || getPlainField(fieldMap, "event_status", "eventstatus"),
    );
    const eventStatus: RuntimeCurrentEventState["status"] = rawEventStatus === "completed"
      ? "completed"
      : rawEventStatus === "waiting_input"
        ? "waiting_input"
        : rawEventStatus === "active"
          ? "active"
          : (awaitUser ? "waiting_input" : currentEvent.eventStatus);
    const eventSummary = normalizeGeneratedLine(
      (objectLike && Object.keys(objectLike).length ? objectLike.eventSummary : undefined)
      || getPlainField(fieldMap, "event_summary", "eventsummary")
      || currentEvent.eventSummary,
      compactMode ? 80 : 120,
    ) || currentEvent.eventSummary;
    const eventFacts = uniqueTextList(
      Array.isArray(objectLike?.eventFacts)
        ? (objectLike as any).eventFacts
        : parsePlainList(getPlainField(fieldMap, "event_facts", "eventfacts")),
      4,
    );
    const eventAdjustMode: NarrativePlanResult["eventAdjustMode"] = rawEventAdjustMode === "completed"
      ? "completed"
      : rawEventAdjustMode === "waiting_input"
        ? "waiting_input"
        : rawEventAdjustMode === "update"
          ? "update"
          : rawEventAdjustMode === "keep"
            ? "keep"
            : eventStatus === "completed"
              ? "completed"
              : eventStatus === "waiting_input"
                ? "waiting_input"
                : eventSummary !== currentEvent.eventSummary
                  ? "update"
                  : "keep";
    const rawStateDelta = (objectLike && objectLike.stateDelta && typeof objectLike.stateDelta === "object" && !Array.isArray(objectLike.stateDelta))
      ? asRecord(objectLike.stateDelta)
      : parsePlainStateDelta(getPlainField(fieldMap, "state_delta", "statedelta"));
    const stateDelta = sanitizeNarrativeStateDelta(rawStateDelta, {
      allowStateDelta,
    });

    let normalizedOutcome: "failed" | "success" | "continue" = "continue";
    if (allowControlHints) {
      if (chapterOutcome === "failed") {
        normalizedOutcome = "failed";
      } else if (chapterOutcome === "success") {
        normalizedOutcome = "success";
      }
    }
    const normalizedNextChapterId = allowControlHints && Number.isFinite(nextChapterId) && nextChapterId > 0
      ? nextChapterId
      : null;
    const pendingEndingGuide = input.state?.__pendingEndingGuide === true;
    // “等待用户选择/输入”并不要求当前请求必须带着用户发言。
    // 只要模型明确给出 await_user=true，就应该允许直接把回合交还给用户。
    const canYieldDirectly = awaitUser && !matchedRole && !pendingEndingGuide;
    if (motive && looksLikeDirectiveLeak(motive, currentChapter.directive, currentChapter.openingText)) {
      throw createRuntimeModelError("orchestrator", "模型返回结构无效或泄漏了内部编排内容");
    }

    if (matchedRole) {
      if (pendingEndingGuide) {
        input.state.__pendingEndingGuide = false;
      }
      if (!motive) {
        throw createRuntimeModelError("orchestrator", "模型返回结构无效或缺少发言动机");
      }
      if (isSkip) {
      return {
        role: matchedRole.name,
        roleType: sanitizeRoleType(matchedRole.roleType || "narrator"),
          motive,
          memoryHints,
          triggerMemoryAgent,
          stateDelta,
          awaitUser: false,
          nextRole: normalizeScalarText(nextRole || matchedRole.name),
          nextRoleType: sanitizeRoleType(nextRoleType || matchedRole.roleType || "narrator"),
          chapterOutcome: normalizedOutcome,
          nextChapterId: normalizedNextChapterId,
          source: "ai",
          eventAdjustMode,
          eventIndex: currentEvent.eventIndex,
          eventKind: currentEvent.eventKind,
        eventSummary,
        eventFacts: eventFacts.length ? eventFacts : currentEvent.eventFacts,
        eventStatus,
        orchestratorRuntime,
      };
    }
    return {
        role: matchedRole.name,
        roleType: matchedRole.roleType,
        motive,
        memoryHints,
        triggerMemoryAgent,
        stateDelta,
        awaitUser,
        nextRole,
        nextRoleType,
        chapterOutcome: normalizedOutcome,
        nextChapterId: normalizedNextChapterId,
        source: "ai",
        eventAdjustMode,
        eventIndex: currentEvent.eventIndex,
        eventKind: currentEvent.eventKind,
      eventSummary,
      eventFacts: eventFacts.length ? eventFacts : currentEvent.eventFacts,
      eventStatus,
      orchestratorRuntime,
    };
  }
  if (canYieldDirectly) {
      if (pendingEndingGuide) {
        input.state.__pendingEndingGuide = false;
      }
      return {
        role: "",
        roleType: "player",
        motive: "",
        memoryHints,
        triggerMemoryAgent,
        stateDelta,
        awaitUser: true,
        nextRole,
        nextRoleType,
        chapterOutcome: normalizedOutcome,
        nextChapterId: normalizedNextChapterId,
        source: "ai",
        eventAdjustMode,
        eventIndex: currentEvent.eventIndex,
        eventKind: currentEvent.eventKind,
      eventSummary,
      eventFacts: eventFacts.length ? eventFacts : currentEvent.eventFacts,
      eventStatus,
      orchestratorRuntime,
    };
  }
    throw createRuntimeModelError("orchestrator", "模型返回结构无效或缺少可执行的角色编排");
  } catch (err) {
    orchestratorRuntimeError = err;
    const pendingEndingGuide = input.state?.__pendingEndingGuide === true;
    console.warn("[story:orchestrator] error", {
      manufacturer: (promptAiConfig as any)?.manufacturer || "",
      model: (promptAiConfig as any)?.model || "",
      expectedRoleType: turnState.expectedRoleType,
      expectedRole: turnState.expectedRole,
      message: (err as any)?.message || String(err),
    });
    if (isProviderBalanceOrQuotaError(err)) {
      throw createRuntimeModelError("orchestrator", "当前故事编排模型余额不足，请充值或切换模型后重试");
    }
    if (pendingEndingGuide) {
      input.state.__pendingEndingGuide = false;
    }
    return buildFallbackNarrativePlan({
      roles,
      turnState,
      latestPlayerMessage: payload.latestPlayerMessage,
      currentPhase,
      currentEvent,
      hasPlayerInput,
      world: input.world,
      fallbackReason: err,
      pendingEndingGuide,
      orchestratorRuntime,
    });
  } finally {
    console.log("[orchestrator] request_chars=", systemPrompt.length + userPrompt.length);
    console.log("[orchestrator] systemPrompt.length=", systemPrompt.length);
    console.log("[orchestrator] userPrompt.length=", userPrompt.length);
    console.log("[orchestrator] roles=", payload.roles.length);
    console.log("[orchestrator] payloadMode=", orchestratorRuntime.payloadMode, "reasoningEffort=", orchestratorRuntime.reasoningEffort || "未指定");
    logOrchestratorPromptStats(
      payload,
      compactMode,
      orchestratorRuntime,
      systemPrompt,
      userPrompt,
      orchestratorRuntimeError,
      orchestratorTokenUsage,
      orchestratorRawText,
      {
        buildMs: promptBuildMs,
        invokeMs: orchestratorInvokeMs,
        totalMs: Date.now() - totalStartedAt,
      },
    );
  }
}

// 先编排再补正文，得到完整的一轮剧情结果。
export async function runNarrativeOrchestrator(input: OrchestratorInput): Promise<OrchestratorResult> {
  // 调用编排函数
  const plan = await runNarrativePlan(input);
  if (!plan.role || sanitizeRoleType(plan.roleType) === "player" || !plan.motive) {
    return {
      ...plan,
      content: "",
    };
  }
  const currentPhase = readCurrentChapterPhase(input.chapter, input.state);
  const roles = filterRolesForPhase(runtimeStoryRoles(input.world, input.state), currentPhase);
  const matchedRole = roles.find((item) => normalizeScalarText(item.name) === normalizeScalarText(plan.role))
    || roles.find((item) => sanitizeRoleType(item.roleType) === sanitizeRoleType(plan.roleType) && sanitizeRoleType(item.roleType) !== "player")
    || null;
  if (!matchedRole) {
    throw createRuntimeModelError("speaker", "未找到当前应发言角色");
  }
  const speakerDecision = resolveSpeakerModeDecision({
    role: matchedRole,
    motive: plan.motive,
    latestUserMessage: normalizeScalarText(input.playerMessage),
  });
  const shouldForceMemoryRefresh = Boolean(
    normalizeScalarText(input.playerMessage)
    || speakerDecision.mode === "premium"
    || plan.eventAdjustMode === "update"
    || plan.eventAdjustMode === "completed"
    || (Array.isArray(plan.eventFacts) && plan.eventFacts.length > 0)
    || /关系|立场|表态|选择|冲突|威胁|羞辱|站队|记住|记下来|转折/.test(normalizeScalarText(plan.motive)),
  );
  const content = await runStorySpeakerContent({
    userId: input.userId,
    world: input.world,
    chapter: input.chapter,
    state: input.state,
    recentMessages: input.recentMessages,
    playerMessage: input.playerMessage,
    currentRole: matchedRole,
    motive: plan.motive,
  });
  const result = {
    ...plan,
    triggerMemoryAgent: shouldForceMemoryRefresh
      ? true
      : speakerDecision.memoryMode === "skip" && !(plan.memoryHints || []).length
        ? false
        : plan.triggerMemoryAgent,
    content,
    speakerMode: speakerDecision.mode,
    speakerRouteReason: speakerDecision.reason,
  };

  // DEBUG 日志：记录 orchestrator 返回内容
  if (DebugLogUtil.isDebugLogEnabled()) {
    console.log("[story:orchestrator:result]", JSON.stringify({
      role: result.role,
      roleType: result.roleType,
      motive: result.motive,
      content: result.content?.slice(0, 100) || "",
      contentLength: result.content?.length || 0,
      awaitUser: result.awaitUser,
      eventKind: result.eventKind,
      eventStatus: result.eventStatus,
      chapterOutcome: result.chapterOutcome,
      speakerMode: result.speakerMode,
      orchestratorRuntime: result.orchestratorRuntime,
    }));
  }

  return result;
}

// 调用记忆管理模型，压缩对后续剧情有用的信息。
export async function runStoryMemoryManager(input: {
  userId: number;
  world: any;
  chapter: any;
  state: JsonRecord;
  recentMessages: RuntimeMessageInput[];
}): Promise<MemoryManagerResult> {
  // 记忆管理也需要打印 build/invoke/total 三段耗时，方便直接比对是 prompt 过大还是模型慢。
  const totalStartedAt = Date.now();
  const prompts = await loadStoryPrompts();
  const promptAiConfig = await resolveTextStageModel(input.userId, "storyMemoryModel");
  const compactMode = shouldUseCompactMemoryPayload(promptAiConfig);
  const memoryRuntime = resolveNarrativeRuntimeMeta("storyMemoryModel", promptAiConfig, compactMode);
  const currentEvent = readCurrentRuntimeEventContext(input.chapter, input.state);
  const memoryInputs = splitMemoryRefreshInputs(input.recentMessages);
  const roleCardSnapshots = collectMemoryRoleCardSnapshots({
    world: input.world,
    state: input.state,
    recentMessages: input.recentMessages,
  });
  const payload = {
    worldName: normalizeScalarText(input.world?.name),
    chapterTitle: normalizeScalarText(input.chapter?.title),
    ...buildPromptEventContextTextPayload(currentEvent, compactMode),
    eventDeltaText: buildMemoryEventDeltaText(memoryInputs.eventDeltaMessages, compactMode),
    recentDialogue: compactMode
      ? recentDialogueItems(memoryInputs.dialogueMessages, 4, 420)
      : recentDialogueItems(memoryInputs.dialogueMessages, 10, 1600),
    currentMemory: shortText(input.state.memorySummary ?? "", compactMode ? 160 : 320),
    currentFacts: buildLimitedMemoryText(input.state.memoryFacts, 5, 8, compactMode),
    currentTags: buildLimitedMemoryText(input.state.memoryTags, 6, 12, compactMode),
    playerCard: roleCardSnapshots.playerCard
      ? buildMemoryRoleCardSummary(roleCardSnapshots.playerCard, compactMode)
      : null,
    npcCards: roleCardSnapshots.npcCards.map((item) => buildMemoryRoleCardSummary(item, compactMode)),
  };
  const systemPrompt = compactMode
    ? [
      "你是记忆管理器。",
      "你负责更新整个故事的长期记忆，包括剧情摘要、关键事实、标签，以及角色动态参数卡。",
      "优先保留新变化、修正冲突、合并重复信息。",
      "不要写剧情正文，不要输出代码块。",
      "严格输出一个 JSON 对象。",
      "字段固定为 summary, facts, tags, player_card_patch, npc_card_patches。",
      "player_card_patch 和 npc_card_patches.patch 只允许这些字段：raw_setting, personality, appearance, voice, skills, items, equipment, other, gender, age, level, level_desc, hp, mp, money。",
      "age、level、hp、mp、money 必须输出数字；不要写“已恢复”“充盈”“满了”这类中文状态。",
      "如果只是表达状态变化，如“已恢复”“斗气更凝实”“状态转好”，请写到 other，不要写进 hp/mp。",
    ].join("\n")
    : [
      prompts.storyMemory,
      "输出要求：",
      "1. 你负责管理整个故事记忆，不只更新摘要，还要维护角色动态参数卡。",
      "2. 只提炼对后续剧情有用的事实和长期变化。",
      "3. 不写剧情正文，不要代码块。",
      "4. 严格输出一个 JSON 对象，字段固定为：summary, facts, tags, player_card_patch, npc_card_patches。",
      "5. player_card_patch 和 npc_card_patches.patch 只允许这些字段：raw_setting, personality, appearance, voice, skills, items, equipment, other, gender, age, level, level_desc, hp, mp, money。",
      "6. age、level、hp、mp、money 必须输出数字；不要写“已恢复”“充盈”“满了”这类中文状态。",
      "7. 如果只是表达状态变化，如“已恢复”“斗气更凝实”“状态转好”，请写到 other，不要写进 hp/mp。",
    ].filter(Boolean).join("\n\n");
  const userPrompt = buildMemoryUserPrompt(payload, compactMode);
  const buildFinishedAt = Date.now();
  let tokenUsage: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } | null = null;
  let rawText = "";

  try {
    const invokeStartedAt = Date.now();
    const result = await u.ai.text.invoke(
      {
        plainTextOutput: true,
        usageType: "记忆管理",
        usageRemark: `${normalizeScalarText(input.world?.name)} / ${normalizeScalarText(input.chapter?.title)}`,
        usageMeta: {
          stage: "storyMemoryModel",
          worldId: Number(input.world?.id || 0),
          chapterId: Number(input.chapter?.id || 0),
        },
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: userPrompt,
          },
        ],
        maxRetries: 0,
      },
      promptAiConfig as any,
    );
    const invokeFinishedAt = Date.now();
    tokenUsage = {
      inputTokens: Number((result as any)?.usage?.inputTokens || 0),
      outputTokens: Number((result as any)?.usage?.outputTokens || 0),
      reasoningTokens: Number((result as any)?.usage?.outputTokenDetails?.reasoningTokens || (result as any)?.usage?.reasoningTokens || 0),
    };
    rawText = unwrapModelText((result as any)?.text || "");
    const objectLike = parseJsonSafe<Record<string, unknown>>(rawText, {});
    const hasObjectLike = hasRecordKeys(asRecord(objectLike));
    const fieldMap = parseFieldMap(rawText);
    const playerCardPatch = sanitizeMemoryParameterCardPatch(
      (hasObjectLike ? objectLike.player_card_patch ?? objectLike.playerCardPatch : undefined)
      || parseJsonSafe<JsonRecord>(getPlainField(fieldMap, "player_card_patch", "playercardpatch"), {}),
    );
    const npcCardPatchSource = hasObjectLike ? objectLike.npc_card_patches ?? objectLike.npcCardPatches : undefined;
    const npcCardPatches = Array.isArray(npcCardPatchSource)
      ? npcCardPatchSource.map((item: unknown) => {
        const rawItem = asRecord(item);
        return {
          roleId: normalizeScalarText(rawItem.role_id || rawItem.roleId),
          roleName: normalizeScalarText(rawItem.role_name || rawItem.roleName),
          roleType: sanitizeRoleType(rawItem.role_type || rawItem.roleType || "npc"),
          patch: sanitizeMemoryParameterCardPatch(rawItem.patch),
        };
      }).filter((item) => (item.roleId || item.roleName) && hasRecordKeys(item.patch))
      : [];
    const normalizedMemory: MemoryManagerResult = {
      summary: normalizeScalarText(
        (hasObjectLike ? objectLike.summary : undefined)
        || getPlainField(fieldMap, "summary"),
      ),
      facts: Array.isArray(objectLike?.facts)
        ? (objectLike as any).facts.map((item: unknown) => normalizeScalarText(item)).filter(Boolean)
        : parsePlainList(getPlainField(fieldMap, "facts")),
      tags: Array.isArray(objectLike?.tags)
        ? (objectLike as any).tags.map((item: unknown) => normalizeScalarText(item)).filter(Boolean)
        : parsePlainList(getPlainField(fieldMap, "tags")),
      playerCardPatch,
      npcCardPatches,
      source: "ai",
    };
    logMemoryPromptStats({
      payload,
      chapterMeta: {
        id: input.chapter?.id,
        title: input.chapter?.title,
        sort: (input.chapter as any)?.sort,
      },
      compactMode,
      runtime: memoryRuntime,
      systemPrompt,
      userPrompt,
      runtimeError: null,
      tokenUsage,
      rawResponse: rawText,
      timing: {
        buildMs: buildFinishedAt - totalStartedAt,
        invokeMs: invokeFinishedAt - invokeStartedAt,
        totalMs: invokeFinishedAt - totalStartedAt,
      },
    });
    return normalizedMemory;
  } catch (err) {
    const failedAt = Date.now();
    logMemoryPromptStats({
      payload,
      chapterMeta: {
        id: input.chapter?.id,
        title: input.chapter?.title,
        sort: (input.chapter as any)?.sort,
      },
      compactMode,
      runtime: memoryRuntime,
      systemPrompt,
      userPrompt,
      runtimeError: err,
      tokenUsage,
      rawResponse: rawText,
      timing: {
        buildMs: buildFinishedAt - totalStartedAt,
        invokeMs: Math.max(0, failedAt - buildFinishedAt),
        totalMs: failedAt - totalStartedAt,
      },
    });
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.warn("[story:memory] error", {
      manufacturer: (promptAiConfig as any)?.manufacturer || "",
      model: (promptAiConfig as any)?.model || "",
      message: errorMessage,
    });
    throw createRuntimeModelError("memory", errorMessage);
  }
}

// 给任意角色生成一张保底参数卡，避免后续 patch 合并时遇到空对象。
function buildDefaultRoleParameterCardForMemory(input: {
  role?: unknown;
  fallbackName?: string;
}): JsonRecord {
  const role = asRecord(input.role);
  const currentCard = asRecord(role.parameterCardJson);
  return {
    name: normalizeScalarText(currentCard.name || role.name || input.fallbackName || "用户") || "用户",
    raw_setting: normalizeScalarText(currentCard.raw_setting || currentCard.rawSetting || role.description),
    gender: normalizeScalarText(currentCard.gender),
    age: Number.isFinite(Number(currentCard.age)) ? Number(currentCard.age) : null,
    level: Number.isFinite(Number(currentCard.level)) ? Number(currentCard.level) : 1,
    level_desc: normalizeScalarText(currentCard.level_desc || currentCard.levelDesc) || "初入此界",
    personality: normalizeScalarText(currentCard.personality),
    appearance: normalizeScalarText(currentCard.appearance),
    voice: normalizeScalarText(currentCard.voice || role.voice),
    skills: Array.isArray(currentCard.skills)
      ? currentCard.skills.map((item: unknown) => normalizeScalarText(item)).filter(Boolean)
      : [],
    items: Array.isArray(currentCard.items)
      ? currentCard.items.map((item: unknown) => normalizeScalarText(item)).filter(Boolean)
      : [],
    equipment: Array.isArray(currentCard.equipment)
      ? currentCard.equipment.map((item: unknown) => normalizeScalarText(item)).filter(Boolean)
      : [],
    hp: Number.isFinite(Number(currentCard.hp)) ? Number(currentCard.hp) : 100,
    mp: Number.isFinite(Number(currentCard.mp)) ? Number(currentCard.mp) : 0,
    money: Number.isFinite(Number(currentCard.money)) ? Number(currentCard.money) : 0,
    other: Array.isArray(currentCard.other)
      ? currentCard.other.map((item: unknown) => normalizeScalarText(item)).filter(Boolean)
      : [],
  };
}

// 只允许记忆管理器改动一小组安全字段，避免模型胡乱污染整个参数卡。
function sanitizeMemoryParameterCardPatch(input: unknown): JsonRecord {
  const raw = asRecord(input);
  const patch: JsonRecord = {};
  const scalarKeys = ["raw_setting", "personality", "appearance", "voice", "gender", "level_desc"];
  scalarKeys.forEach((key) => {
    const camelKey = key.replaceAll(/_([a-z])/g, (_, char) => char.toUpperCase());
    const value = normalizeScalarText(raw[key] ?? raw[camelKey]);
    if (value) {
      patch[key] = value;
    }
  });
  const numericKeys = ["age", "level", "hp", "mp", "money"];
  numericKeys.forEach((key) => {
    const numericValue = Number(raw[key]);
    if (Number.isFinite(numericValue)) {
      patch[key] = numericValue;
    }
  });
  const listKeys = ["skills", "items", "equipment", "other"];
  listKeys.forEach((key) => {
    const rawValue = raw[key];
    let listValue: string[] = [];
    if (Array.isArray(rawValue)) {
      listValue = rawValue.map((item: unknown) => normalizeScalarText(item)).filter(Boolean);
    } else if (typeof rawValue === "string") {
      listValue = parsePlainList(rawValue);
    }
    if (listValue.length) {
      patch[key] = uniqueTextList(listValue, 20);
    }
  });
  return patch;
}

// 将记忆管理器给出的 patch 合并到参数卡，标量覆盖、数组去重合并。
function mergeMemoryParameterCardPatch(baseCard: JsonRecord, patchInput: unknown): JsonRecord {
  const patch = sanitizeMemoryParameterCardPatch(patchInput);
  if (!hasRecordKeys(patch)) {
    return baseCard;
  }
  const nextCard = buildDefaultRoleParameterCardForMemory({
    role: {
      parameterCardJson: baseCard,
      name: baseCard.name,
      description: baseCard.raw_setting,
      voice: baseCard.voice,
    },
    fallbackName: normalizeScalarText(baseCard.name) || "用户",
  });
  Object.entries(patch).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      const previousList = Array.isArray(nextCard[key]) ? (nextCard[key] as unknown[]) : [];
      nextCard[key] = uniqueTextList([...previousList, ...value], 20);
      return;
    }
    nextCard[key] = value;
  });
  return nextCard;
}

// 把记忆摘要、事实和标签以长期信息形式补进用户 patch，避免模型只更新摘要不更新参数卡。
function buildDerivedPlayerMemoryPatch(memory: MemoryManagerResult): JsonRecord {
  const nextOther = [
    normalizeScalarText(memory.summary) ? `记忆摘要：${shortText(memory.summary, 120)}` : "",
    ...(Array.isArray(memory.facts) ? memory.facts : []).map((item) => `记忆事实：${shortText(item, 80)}`),
    ...(Array.isArray(memory.tags) ? memory.tags : []).map((item) => `记忆标签：${shortText(item, 40)}`),
  ].map((item) => normalizeScalarText(item)).filter(Boolean);
  return nextOther.length ? { other: nextOther } : {};
}

// 将记忆管理器的用户参数卡 patch 写回当前用户。
function applyMemoryPlayerCardPatchToState(state: JsonRecord, memory: MemoryManagerResult): {
  existedBefore: boolean;
  otherCountBefore: number;
  otherCountAfter: number;
  applied: boolean;
} {
  const player = asRecord(state.player);
  const existedBefore = Boolean(player.parameterCardJson && typeof player.parameterCardJson === "object");
  const currentCard = buildDefaultRoleParameterCardForMemory({
    role: player,
    fallbackName: normalizeScalarText(player.name) || "用户",
  });
  const otherCountBefore = Array.isArray(currentCard.other) ? currentCard.other.length : 0;
  const explicitPatch = asRecord(memory.playerCardPatch);
  const derivedPatch = buildDerivedPlayerMemoryPatch(memory);
  const mergedPatch = {
    ...explicitPatch,
    ...derivedPatch,
    other: uniqueTextList([
      ...(Array.isArray(explicitPatch.other) ? explicitPatch.other : []),
      ...(Array.isArray(derivedPatch.other) ? derivedPatch.other : []),
    ], 20),
  };
  const nextCard = mergeMemoryParameterCardPatch(currentCard, mergedPatch);
  player.parameterCardJson = nextCard;
  state.player = player;
  return {
    existedBefore,
    otherCountBefore,
    otherCountAfter: Array.isArray(nextCard.other) ? nextCard.other.length : 0,
    applied: hasRecordKeys(sanitizeMemoryParameterCardPatch(mergedPatch)),
  };
}

// 在运行时 NPC 包里按 id/name 匹配并写回参数卡 patch。
function applyMemoryNpcCardPatchesToState(state: JsonRecord, memory: MemoryManagerResult): Array<{
  roleId: string;
  roleName: string;
  applied: boolean;
}> {
  const npcBag = asRecord(state.npcs);
  const patchList = Array.isArray(memory.npcCardPatches) ? memory.npcCardPatches : [];
  if (!hasRecordKeys(npcBag) || !patchList.length) {
    return [];
  }
  const appliedResults: Array<{ roleId: string; roleName: string; applied: boolean }> = [];
  patchList.forEach((patchEntry) => {
    const roleId = normalizeScalarText(patchEntry.roleId);
    const roleName = normalizeScalarText(patchEntry.roleName);
    const patch = sanitizeMemoryParameterCardPatch(patchEntry.patch);
    if (!hasRecordKeys(patch)) {
      appliedResults.push({ roleId, roleName, applied: false });
      return;
    }
    let matchedKey = "";
    Object.entries(npcBag).some(([key, value]) => {
      const npc = asRecord(value);
      const npcId = normalizeScalarText(npc.id);
      const npcName = normalizeScalarText(npc.name);
      if ((roleId && npcId === roleId) || (roleName && npcName === roleName)) {
        matchedKey = key;
        return true;
      }
      return false;
    });
    if (!matchedKey) {
      appliedResults.push({ roleId, roleName, applied: false });
      return;
    }
    const npc = asRecord(npcBag[matchedKey]);
    const currentCard = buildDefaultRoleParameterCardForMemory({
      role: npc,
      fallbackName: roleName || normalizeScalarText(npc.name) || matchedKey,
    });
    npc.parameterCardJson = mergeMemoryParameterCardPatch(currentCard, patch);
    npcBag[matchedKey] = npc;
    appliedResults.push({ roleId, roleName, applied: true });
  });
  state.npcs = npcBag;
  return appliedResults;
}

export function applyMemoryResultToState(state: JsonRecord, memory: MemoryManagerResult) {
  const previousSummary = normalizeScalarText(state.memorySummary);
  const previousFacts = Array.isArray(state.memoryFacts)
    ? state.memoryFacts.map((item) => normalizeScalarText(item)).filter(Boolean)
    : [];
  const previousTags = Array.isArray(state.memoryTags)
    ? state.memoryTags.map((item) => normalizeScalarText(item)).filter(Boolean)
    : [];
  const mergedFacts = uniqueTextList([...(Array.isArray(memory.facts) ? memory.facts : []), ...previousFacts], 12);
  const mergedTags = uniqueTextList([...(Array.isArray(memory.tags) ? memory.tags : []), ...previousTags], 12);
  const nextSummary = normalizeScalarText(memory.summary)
    || previousSummary
    || shortText(mergedFacts.join("；"), 180);
  state.memorySummary = nextSummary;
  state.memoryFacts = mergedFacts;
  state.memoryTags = mergedTags;
  applyMemoryPlayerCardPatchToState(state, {
    ...memory,
    summary: nextSummary,
    facts: mergedFacts,
    tags: mergedTags,
  });
  applyMemoryNpcCardPatchesToState(state, memory);
}

// 将完整编排结果压缩成前端和日志都好读的摘要。
export function summarizeNarrativePlan(result: OrchestratorResult | null | undefined): NarrativePlanSummary | null {
  if (!result) return null;
  let normalizedSource: "fallback" | "rule" | "ai" = "ai";
  if (result.source === "fallback") {
    normalizedSource = "fallback";
  } else if (result.source === "rule") {
    normalizedSource = "rule";
  }
  return {
    role: normalizeScalarText(result.role),
    roleType: sanitizeRoleType(result.roleType),
    motive: normalizeScalarText(result.motive),
    awaitUser: Boolean(result.awaitUser),
    nextRole: normalizeScalarText(result.nextRole),
    nextRoleType: sanitizeRoleType(result.nextRoleType),
    memoryHints: Array.isArray(result.memoryHints)
      ? result.memoryHints.map((item) => normalizeScalarText(item)).filter(Boolean)
      : [],
    triggerMemoryAgent: Boolean(result.triggerMemoryAgent),
    source: normalizedSource,
    eventAdjustMode: result.eventAdjustMode || "keep",
    eventIndex: Number.isFinite(Number(result.eventIndex)) ? Math.max(1, Number(result.eventIndex)) : 1,
    eventKind: result.eventKind || "scene",
    eventSummary: normalizeScalarText(result.eventSummary),
    eventFacts: Array.isArray(result.eventFacts)
      ? result.eventFacts.map((item) => normalizeScalarText(item)).filter(Boolean)
      : [],
    eventStatus: result.eventStatus || "idle",
    speakerMode: result.speakerMode,
    speakerRouteReason: normalizeScalarText(result.speakerRouteReason),
    orchestratorRuntime: result.orchestratorRuntime
      ? {
        modelKey: normalizeScalarText(result.orchestratorRuntime.modelKey),
        manufacturer: normalizeScalarText(result.orchestratorRuntime.manufacturer),
        model: normalizeScalarText(result.orchestratorRuntime.model),
        reasoningEffort: (() => {
          const value = normalizeScalarText(result.orchestratorRuntime.reasoningEffort).toLowerCase();
          return value === "minimal" || value === "low" || value === "medium" || value === "high" ? value : "";
        })(),
        payloadMode: result.orchestratorRuntime.payloadMode === "advanced" ? "advanced" : "compact",
        payloadModeSource: result.orchestratorRuntime.payloadModeSource === "explicit" ? "explicit" : "inferred",
      }
      : undefined,
  };
}

// 合并编排师返回的记忆提示词到当前 state。
export function applyNarrativeMemoryHintsToState(state: JsonRecord, hints: unknown[]): string[] {
  const nextHints = uniqueTextList(Array.isArray(hints) ? hints : [], 8);
  if (!nextHints.length) return [];

  const currentFacts = Array.isArray(state.memoryFacts)
    ? state.memoryFacts.map((item) => normalizeScalarText(item)).filter(Boolean)
    : [];
  const mergedFacts = uniqueTextList([...currentFacts, ...nextHints], 8);
  state.memoryFacts = mergedFacts;

  const currentSummary = normalizeScalarText(state.memorySummary);
  if (!currentSummary) {
    state.memorySummary = shortText(mergedFacts.join("；"), 180);
  }
  return mergedFacts;
}

// 尝试刷新记忆，失败则静默降级，不影响主剧情。
export async function refreshStoryMemoryBestEffort(input: {
  userId: number;
  world: any;
  chapter: any;
  state: JsonRecord;
  recentMessages: RuntimeMessageInput[];
}): Promise<MemoryManagerResult | null> {
  const recentMessages = Array.isArray(input.recentMessages) ? input.recentMessages.filter(Boolean) : [];
  if (!recentMessages.length) return null;
  try {
    const previousSummary = normalizeScalarText(input.state.memorySummary);
    const previousFacts = Array.isArray(input.state.memoryFacts)
      ? input.state.memoryFacts.map((item) => normalizeScalarText(item)).filter(Boolean)
      : [];
    const previousTags = Array.isArray(input.state.memoryTags)
      ? input.state.memoryTags.map((item) => normalizeScalarText(item)).filter(Boolean)
      : [];
    const previousPlayerCard = asRecord(asRecord(input.state.player).parameterCardJson);
    const memory = await runStoryMemoryManager({
      ...input,
      recentMessages,
    });
    if (
      !memory.summary
      && !memory.facts.length
      && !memory.tags.length
      && !hasRecordKeys(asRecord(memory.playerCardPatch))
      && !memory.npcCardPatches.length
    ) {
      if (DebugLogUtil.isDebugLogEnabled()) {
        console.log("[story:memory:runtime]", JSON.stringify({
          action: "skip_apply",
          reason: "empty_result",
          chapterId: Number(input.chapter?.id || 0),
          recentMessageCount: recentMessages.length,
        }));
      }
      return null;
    }
    applyMemoryResultToState(input.state, memory);
    const nextPlayerCard = asRecord(asRecord(input.state.player).parameterCardJson);
    const nextNpcBag = asRecord(input.state.npcs);
    const npcCardAppliedTargets = (Array.isArray(memory.npcCardPatches) ? memory.npcCardPatches : [])
      .map((item) => {
        const roleId = normalizeScalarText(item.roleId);
        const roleName = normalizeScalarText(item.roleName);
        const matched = Object.values(nextNpcBag).find((npc) => {
          const raw = asRecord(npc);
          return (roleId && normalizeScalarText(raw.id) === roleId)
            || (roleName && normalizeScalarText(raw.name) === roleName);
        });
        return matched ? roleId || roleName : "";
      })
      .filter(Boolean);
    if (DebugLogUtil.isDebugLogEnabled()) {
      console.log("[story:memory:runtime]", JSON.stringify({
        action: "apply_result",
        chapterId: Number(input.chapter?.id || 0),
        source: memory.source,
        previousSummaryLength: previousSummary.length,
        nextSummaryLength: normalizeScalarText(input.state.memorySummary).length,
        previousFactsCount: previousFacts.length,
        nextFactsCount: Array.isArray(input.state.memoryFacts) ? input.state.memoryFacts.length : 0,
        previousTagsCount: previousTags.length,
        nextTagsCount: Array.isArray(input.state.memoryTags) ? input.state.memoryTags.length : 0,
        playerCardExistedBefore: hasRecordKeys(previousPlayerCard),
        playerCardExistsAfter: hasRecordKeys(nextPlayerCard),
        playerCardOtherCountBefore: Array.isArray(previousPlayerCard.other) ? previousPlayerCard.other.length : 0,
        playerCardOtherCountAfter: Array.isArray(nextPlayerCard.other) ? nextPlayerCard.other.length : 0,
        playerCardPatchApplied: hasRecordKeys(asRecord(memory.playerCardPatch)),
        playerCardPatchKeys: Object.keys(asRecord(memory.playerCardPatch)),
        npcCardPatchCount: memory.npcCardPatches.length,
        npcCardAppliedCount: npcCardAppliedTargets.length,
        npcCardAppliedTargets,
      }));
    }
    return memory;
  } catch (err) {
    const message = normalizeScalarText((err as any)?.message || String(err));
    if (/未配置/.test(message)) {
      return null;
    }
    console.warn("[story:memory] refresh skipped", {
      message,
      chapterId: Number(input.chapter?.id || 0),
      recentMessageCount: recentMessages.length,
    });
    return null;
  }
}

// 后台触发记忆刷新，不阻塞当前回合返回。
export function triggerStoryMemoryRefreshInBackground(input: {
  userId: number;
  world: any;
  chapter: any;
  state: JsonRecord;
  recentMessages: RuntimeMessageInput[];
  onResolved?: ((memory: MemoryManagerResult, stateSnapshot: JsonRecord) => Promise<void> | void) | null;
}) {
  const recentMessages = (Array.isArray(input.recentMessages) ? input.recentMessages : []).map((item) => ({
    role: normalizeScalarText(item.role),
    roleType: sanitizeRoleType(item.roleType),
    eventType: normalizeScalarText(item.eventType),
    content: normalizeScalarText(item.content),
    createTime: Number(item.createTime || 0),
    memoryDelta: readMemoryDeltaInput(item),
  }));
  const stateSnapshot = parseJsonSafe<JsonRecord>(JSON.stringify(input.state || {}), {});
  void (async () => {
    const memory = await refreshStoryMemoryBestEffort({
      userId: input.userId,
      world: input.world,
      chapter: input.chapter,
      state: stateSnapshot,
      recentMessages,
    });
    if (!memory) return;
    await input.onResolved?.(memory, stateSnapshot);
  })();
}

// 把编排结果里的状态增量应用到运行时 state。
export function applyOrchestratorResultToState(state: JsonRecord, result: NarrativePlanResult | OrchestratorResult) {
  applyStateDelta(state, sanitizeNarrativeStateDelta(result.stateDelta || {}, {
    allowStateDelta: true,
  }));
  const eventFacts = Array.isArray(result.eventFacts)
    ? result.eventFacts.map((item) => normalizeScalarText(item)).filter(Boolean)
    : [];
  const targetEventIndex = Number.isFinite(Number(result.eventIndex))
    ? Math.max(1, Number(result.eventIndex))
    : null;
  if (targetEventIndex != null) {
    const currentDigest = upsertRuntimeEventDigestState(state, { eventIndex: targetEventIndex });
    upsertRuntimeEventDigestState(state, {
      eventIndex: targetEventIndex,
      eventSummary: result.eventAdjustMode === "keep"
        ? currentDigest.eventSummary
        : normalizeScalarText(result.eventSummary) || currentDigest.eventSummary,
      eventFacts: eventFacts.length ? eventFacts : currentDigest.eventFacts,
      summarySource: result.eventAdjustMode === "keep"
        ? currentDigest.summarySource
        : "ai",
      updateTime: nowTs(),
      eventStatus: result.eventAdjustMode === "completed"
        ? "completed"
        : result.eventAdjustMode === "waiting_input"
          ? "waiting_input"
          : result.eventStatus || currentDigest.eventStatus,
    });
  }
  const currentProgress = readChapterProgressState(state);
  const nextEventStatus = result.eventAdjustMode === "completed"
    ? "completed"
    : result.eventAdjustMode === "waiting_input"
      ? "waiting_input"
      : result.eventStatus || currentProgress.eventStatus;
  const nextEventSummary = result.eventAdjustMode === "keep"
    ? currentProgress.eventSummary
    : normalizeScalarText(result.eventSummary) || currentProgress.eventSummary;
  setChapterProgressState(state, {
    eventIndex: Number.isFinite(Number(result.eventIndex)) ? Math.max(1, Number(result.eventIndex)) : currentProgress.eventIndex,
    eventKind: result.eventKind || currentProgress.eventKind,
    eventSummary: nextEventSummary,
    eventStatus: nextEventStatus,
  });
  syncRuntimeCurrentEventFromChapterProgress(state);
}

/**
 * 将“自动编排产出的旁白/NPC 台词”应用到当前事件进度。
 *
 * 用途：
 * - 先把这句台词携带的规则信号写进当前章节运行态
 * - 再让 AI 判断当前事件是否已经完成，以及摘要/事实需要如何更新
 * - AI 不可用时，再回退到旧的 `advanceChapterProgressAfterNarrative` 规则推进
 */
async function applyNarrativeEventProgress(params: {
  userId?: number;
  chapter: any;
  state: JsonRecord;
  role?: string;
  roleType?: string;
  eventType?: string;
  content?: string;
  recentMessages?: RuntimeMessageInput[];
  traceMeta?: JsonRecord;
}): Promise<{ enteredUserPhase: boolean }> {
  if (!params.chapter) {
    return { enteredUserPhase: false };
  }
  syncChapterProgressWithRuntime(params.chapter, params.state);
  // 先把“当前事件”交给 AI 判断，避免规则信号先把 phase 错切到下一事件。
  const resolution = await evaluateEventProgressByAi({
    userId: params.userId,
    chapter: params.chapter,
    state: params.state,
    messageContent: params.content,
    messageRole: params.role,
    messageRoleType: params.roleType,
    eventType: params.eventType,
    recentMessages: params.recentMessages,
    traceMeta: params.traceMeta,
  });
  if (DebugLogUtil.isDebugLogEnabled()) {
    const nextEvent = readNextEventProgressHint(params.chapter, params.state);
    // [story:event_progress:stats] resolution
    DebugLogUtil.logEventProgressResolution("story:event_progress:stats", {
      chapter: params.chapter,
      currentEventIndex: Number(params.state?.chapterProgress?.eventIndex || params.state?.currentEventDigest?.eventIndex || 0),
      currentPhaseId: params.state?.chapterProgress?.phaseId,
      currentPhaseLabel: params.state?.chapterProgress?.phaseId,
      ended: resolution?.ended,
      eventStatus: resolution?.eventStatus,
      nextEventIndex: Number(nextEvent?.index || 0),
      nextEventSummary: nextEvent?.summary,
    });
  }
  if (resolution) {
    const applied = applyAiEventProgressResolution({
      chapter: params.chapter,
      state: params.state,
      resolution,
    });
    syncChapterProgressWithRuntime(params.chapter, params.state);
    return {
      enteredUserPhase: applied.enteredUserPhase,
    };
  }
  // 只有 AI 无法提供事件进度结果时，才回退到旧的规则推进链。
  recordChapterProgressSignals(params.chapter, params.state, {
    messageContent: params.content,
    messageRole: params.role,
    messageRoleType: params.roleType,
  });
  syncChapterProgressWithRuntime(params.chapter, params.state);
  const phaseAdvance = advanceChapterProgressAfterNarrative(params.chapter, params.state, {
    messageContent: params.content,
    messageRole: params.role,
    messageRoleType: params.roleType,
  });
  syncChapterProgressWithRuntime(params.chapter, params.state);
  return {
    enteredUserPhase: phaseAdvance.enteredUserPhase,
  };
}

// 自动连续推进剧情，直到轮到用户发言或章节结束。
export async function advanceNarrativeUntilPlayerTurn(input: OrchestratorInput & {
  initialResult: OrchestratorResult;
  maxAutoTurns?: number;
}): Promise<{
  messages: RuntimeMessageInput[];
  chapterOutcome: "continue" | "success" | "failed";
  nextChapterId: number | null;
}> {
  const emitted: RuntimeMessageInput[] = [];
  const recentMessages = [...input.recentMessages];
  const maxAutoTurns = Math.max(1, Math.min(Number(input.maxAutoTurns || 3), 5));
  if (DebugLogUtil.isDebugLogEnabled()) {
    console.log(`[orchestration] maxAutoTurns:`,maxAutoTurns);
  }
  let current = input.initialResult;

  for (let step = 0; step < maxAutoTurns; step += 1) {
    applyOrchestratorResultToState(input.state, current);
    syncChapterProgressWithRuntime(input.chapter, input.state);

    if (current.role && current.content) {
      const message: RuntimeMessageInput = {
        role: current.role,
        roleType: current.roleType,
        eventType: "on_orchestrated_reply",
        content: current.content,
        createTime: nowTs(),
      };
      emitted.push(message);
      recentMessages.push(message);
    }

    if (current.role && current.content) {
      const phaseAdvance = await applyNarrativeEventProgress({
        userId: input.userId,
        chapter: input.chapter,
        state: input.state,
        role: current.role,
        roleType: current.roleType,
        eventType: "on_orchestrated_reply",
        content: current.content,
        recentMessages,
        traceMeta: input.traceMeta,
      });
      if (phaseAdvance.enteredUserPhase) {
        allowPlayerTurn(input.state, input.world, sanitizeRoleType(current.roleType), normalizeScalarText(current.role));
        return {
          messages: emitted,
          chapterOutcome: "continue",
          nextChapterId: current.nextChapterId,
        };
      }
    }

    if (current.chapterOutcome !== "continue") {
      setRuntimeTurnState(input.state, input.world, {
        canPlayerSpeak: false,
        expectedRoleType: sanitizeRoleType(current.nextRoleType || "narrator"),
        expectedRole: normalizeScalarText(current.nextRole || current.role),
        lastSpeakerRoleType: sanitizeRoleType(current.roleType),
        lastSpeaker: normalizeScalarText(current.role),
      });
      return {
        messages: emitted,
        chapterOutcome: current.chapterOutcome,
        nextChapterId: current.nextChapterId,
      };
    }

    // 是否交回用户输入只认 awaitUser，避免继续依赖编辑师返回 nextRoleType。
    const shouldYieldToPlayer = current.awaitUser;
    if (shouldYieldToPlayer) {
      allowPlayerTurn(input.state, input.world, sanitizeRoleType(current.roleType), normalizeScalarText(current.role));
      return {
        messages: emitted,
        chapterOutcome: "continue",
        nextChapterId: current.nextChapterId,
      };
    }

    setRuntimeTurnState(input.state, input.world, {
      canPlayerSpeak: false,
      expectedRoleType: sanitizeRoleType(current.nextRoleType || current.roleType || "narrator"),
      expectedRole: normalizeScalarText(current.nextRole || current.role),
      lastSpeakerRoleType: sanitizeRoleType(current.roleType),
      lastSpeaker: normalizeScalarText(current.role),
    });

    if (step >= maxAutoTurns - 1) {
      break;
    }

    current = await runNarrativeOrchestrator({
      ...input,
      recentMessages,
      playerMessage: "",
    });
  }

  const last = emitted[emitted.length - 1];
  allowPlayerTurn(
    input.state,
    input.world,
    sanitizeRoleType(last?.roleType || input.initialResult.roleType),
    normalizeScalarText(last?.role || input.initialResult.role),
  );
  return {
    messages: emitted,
    chapterOutcome: "continue",
    nextChapterId: current.nextChapterId,
  };
}

// 比较调试章节条件里的左右值。
function compareDebugValue(left: unknown, right: unknown, op: string): boolean {
  if (op === "equals" || op === "eq") return String(left ?? "").trim().toLowerCase() === String(right ?? "").trim().toLowerCase();
  if (op === "contains") return String(left ?? "").toLowerCase().includes(String(right ?? "").toLowerCase());
  if (op === "not_contains" || op === "notcontains") return !String(left ?? "").toLowerCase().includes(String(right ?? "").toLowerCase());
  if (op === "regex") {
    try {
      return new RegExp(String(right ?? ""), "i").test(String(left ?? ""));
    } catch {
      return false;
    }
  }
  const leftNum = Number(left);
  const rightNum = Number(right);
  if (!Number.isFinite(leftNum) || !Number.isFinite(rightNum)) return false;
  if (op === "gt") return leftNum > rightNum;
  if (op === "gte") return leftNum >= rightNum;
  if (op === "lt") return leftNum < rightNum;
  if (op === "lte") return leftNum <= rightNum;
  if (op === "length_gte" || op === "lengthgte") return String(left ?? "").length >= rightNum;
  if (op === "length_lte" || op === "lengthlte") return String(left ?? "").length <= rightNum;
  return false;
}

// 递归求值调试章节里的条件树。
function evaluateDebugConditionNode(
  input: unknown,
  ctx: {
    latestMessage: string;
    fullText: string;
    chapterTitle: string;
    chapterContent: string;
  },
): boolean {
  if (input === null || input === undefined) return false;
  if (Array.isArray(input)) {
    if (!input.length) return false;
    return input.some((item) => evaluateDebugConditionNode(item, ctx));
  }
  if (typeof input === "string") {
    const token = input.trim();
    if (!token) return false;
    return ctx.latestMessage.toLowerCase().includes(token.toLowerCase());
  }
  if (typeof input !== "object") return false;
  const node = input as Record<string, any>;
  if (Array.isArray(node.all)) {
    return node.all.length > 0 && node.all.every((item: unknown) => evaluateDebugConditionNode(item, ctx));
  }
  if (Array.isArray(node.any)) {
    return node.any.length > 0 && node.any.some((item: unknown) => evaluateDebugConditionNode(item, ctx));
  }
  if (node.not !== undefined) {
    return !evaluateDebugConditionNode(node.not, ctx);
  }
  const field = String(node.field ?? "message").trim().toLowerCase();
  const target = (() => {
    if (["message", "latest", "latest_message"].includes(field)) return ctx.latestMessage;
    if (["messages", "history", "full", "all"].includes(field)) return ctx.fullText;
    if (["chapter", "chapter_title"].includes(field)) return ctx.chapterTitle;
    if (field === "chapter_content") return ctx.chapterContent;
    return ctx.latestMessage;
  })();
  const op = String(node.type ?? node.op ?? "contains").trim().toLowerCase();
  const value = node.value ?? node.right ?? "";
  return compareDebugValue(target, value, op);
}

// 判断章节是否配置了有效的完成条件。
function hasEffectiveCondition(input: unknown): boolean {
  if (input === null || input === undefined) return false;
  if (typeof input === "string") return input.trim().length > 0;
  if (Array.isArray(input)) return input.length > 0;
  if (typeof input === "object") return Object.keys(input as Record<string, unknown>).length > 0;
  return true;
}

// 从调试条件中提取成功或失败结果。
function extractDebugOutcome(input: unknown): "success" | "failed" {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "success";
  const raw = String(
    (input as Record<string, unknown>).result
    ?? (input as Record<string, unknown>).status
    ?? (input as Record<string, unknown>).outcome
    ?? (input as Record<string, unknown>).onMatched
    ?? "success",
  ).trim().toLowerCase();
  return ["failed", "fail", "failure", "lose", "dead"].includes(raw) ? "failed" : "success";
}

// 从调试条件中提取下一章节 ID。
function extractDebugNextChapterId(input: unknown): number | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = (input as Record<string, unknown>).nextChapterId ?? (input as Record<string, unknown>).nextChapter;
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

// 判断调试章节当前是否满足成功/失败条件。
export function evaluateDebugChapterOutcome(
  chapter: any,
  latestMessage: string,
  historyMessages: RuntimeMessageInput[],
): { result: "continue" | "success" | "failed"; nextChapterId: number | null } {
  const condition = parseJsonSafe((chapter as any)?.completionCondition, (chapter as any)?.completionCondition);
  if (!hasEffectiveCondition(condition)) {
    return { result: "continue", nextChapterId: null };
  }
  const ctx = {
    latestMessage: normalizeScalarText(latestMessage),
    fullText: historyMessages.map((item) => normalizeScalarText(item.content)).filter(Boolean).join("\n"),
    chapterTitle: normalizeScalarText(chapter?.title),
    chapterContent: normalizeScalarText(chapter?.content),
  };
  if (condition && typeof condition === "object" && !Array.isArray(condition)) {
    const node = condition as Record<string, unknown>;
    const failureNode = node.failure ?? node.failed ?? node.fail;
    if (failureNode != null && evaluateDebugConditionNode(failureNode, ctx)) {
      return { result: "failed", nextChapterId: extractDebugNextChapterId(node) };
    }
    const successNode = node.success ?? node.pass;
    if (successNode != null && evaluateDebugConditionNode(successNode, ctx)) {
      return { result: "success", nextChapterId: extractDebugNextChapterId(node) };
    }
  }
  const matched = evaluateDebugConditionNode(condition, ctx);
  if (!matched) {
    return { result: "continue", nextChapterId: null };
  }
  return {
    result: extractDebugOutcome(condition),
    nextChapterId: extractDebugNextChapterId(condition),
  };
}
