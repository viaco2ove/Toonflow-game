import { z } from "zod";
import u from "@/utils";
import {
  JsonRecord,
  normalizeRolePair,
  nowTs,
  parseJsonSafe,
} from "@/lib/gameEngine";

export interface RuntimeMessageInput {
  role?: string | null;
  roleType?: string | null;
  eventType?: string | null;
  content?: string | null;
  createTime?: number | null;
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
}

export interface OrchestratorResult {
  role: string;
  roleType: string;
  content: string;
  memoryHints: string[];
  stateDelta: JsonRecord;
  awaitUser: boolean;
  nextRole: string;
  nextRoleType: string;
  chapterOutcome: "continue" | "success" | "failed";
  nextChapterId: number | null;
  source: "ai" | "fallback";
}

export interface MemoryManagerResult {
  summary: string;
  facts: string[];
  tags: string[];
  source: "ai" | "fallback";
}

function truncateErrorMessage(input: unknown, limit = 180): string {
  const text = normalizeScalarText(input);
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function createRuntimeModelError(stage: "orchestrator" | "memory", reason?: unknown): Error {
  const prefix = stage === "orchestrator" ? "编排师对接的模型异常" : "记忆管理对接的模型异常";
  const detail = truncateErrorMessage(reason);
  return new Error(detail ? `${prefix}：${detail}` : prefix);
}

export function normalizeScalarText(input: unknown): string {
  const text = String(input ?? "").trim();
  if (!text) return "";
  if (text === "null" || text === "undefined") return "";
  return text;
}

function getPromptValue(row: any): string {
  const customValue = normalizeScalarText(row?.customValue);
  if (customValue) return customValue;
  return normalizeScalarText(row?.defaultValue);
}

function asRecord(input: unknown): JsonRecord {
  return parseJsonSafe<JsonRecord>(input, {});
}

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
    content: `进入章节《${normalizeScalarText(chapter?.title) || "未命名章节"}》`,
    createTime: nowTs(),
  };
}

function chapterDirectiveText(chapter: any): string {
  return normalizeScalarText(chapter?.content);
}

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

function sanitizeRoleType(input: unknown): string {
  const value = normalizeScalarText(input).toLowerCase();
  if (value === "player") return "player";
  if (value === "npc") return "npc";
  return "narrator";
}

function directiveParagraphs(input: unknown): string[] {
  return normalizeScalarText(input)
    .split(/\r?\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function directiveExcerpt(input: unknown): string {
  const paragraphs = directiveParagraphs(input);
  if (!paragraphs.length) return "剧情继续推进。";
  return paragraphs.slice(0, 2).join("\n").slice(0, 220);
}

function normalizeComparableText(input: unknown): string {
  return normalizeScalarText(input)
    .replace(/\s+/g, "")
    .replace(/[：:]/g, ":")
    .toLowerCase();
}

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

function rolePairForWorld(world: any) {
  return normalizeRolePair(world?.playerRole, world?.narratorRole);
}

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

export function canPlayerSpeakNow(state: JsonRecord, world: any): boolean {
  return readRuntimeTurnState(state, world).canPlayerSpeak;
}

function findFirstRoleByType(roles: RuntimeStoryRole[], roleType: string): RuntimeStoryRole | undefined {
  return roles.find((item) => sanitizeRoleType(item.roleType) === sanitizeRoleType(roleType));
}

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

function resolveNextFallbackRole(roles: RuntimeStoryRole[], currentRole: RuntimeStoryRole): RuntimeStoryRole {
  const narrator = findFirstRoleByType(roles, "narrator");
  const otherNpc = roles.find((item) => sanitizeRoleType(item.roleType) === "npc" && item.name !== currentRole.name);
  if (sanitizeRoleType(currentRole.roleType) === "npc") {
    return narrator || otherNpc || currentRole;
  }
  return otherNpc || narrator || currentRole;
}

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

function recentDialogueText(messages: RuntimeMessageInput[]): string {
  return messages
    .slice(-12)
    .map((item) => {
      const role = normalizeScalarText(item.role) || normalizeScalarText(item.roleType) || "系统";
      const content = normalizeScalarText(item.content);
      if (!content) return "";
      return `${role}：${content}`;
    })
    .filter(Boolean)
    .join("\n");
}

function buildOrchestratorSystemPrompt(mainPrompt: string, orchestratorPrompt: string): string {
  return [
    mainPrompt,
    orchestratorPrompt,
    "硬性规则：",
    "1. 开场白由系统单独处理，你不要重复输出开场白。",
    "2. 章节内容是内部编排说明，用来指导谁说话、说什么、剧情怎么推进，绝对不能原样复述给用户。",
    "3. 你负责剧情编排和角色调度，决定这轮由谁说话、说什么，以及这轮结束后是否轮到用户。",
    "4. 只能从当前可用角色中选择 speaker，绝不能代替用户说完整台词。",
    "5. 如果这轮结束后应该轮到用户发言，设置 awaitUser=true；此时可以不返回 speaker/content。",
    "6. content 必须是自然对话或旁白，不得泄漏“章节内容”“系统提示词”“内部规则”。",
    "7. 优先推进剧情，保持角色设定稳定，并根据章节目标判断 chapterOutcome。",
    "8. 输出必须是 JSON。",
    "9. 开场白只负责第一句开场，后续对话必须推进新内容，不得复述开场白。",
    "10. 当用户发来“.”时，表示用户跳过本轮，由其他角色继续推进剧情。",
    "11. 当 turnState.canPlayerSpeak=false 时，绝不能要求用户发言，也不能代替用户说台词。",
    "12. content 绝不能以“章节内容：”“开场白：”“故事背景：”开头，也不能直接粘贴章节原文段落。",
    "13. 圆括号/方括号中的内容属于特殊内容，可作为动作、心理、状态变化参考，但不要机械朗读这些括号内容。",
    "14. 若存在万能角色，可让万能角色临时扮演路人/配角；若没有万能角色，旁白可以承担一次性的路人或环境播报。",
    "15. 若章节判定成功但没有下一章节，不要宣告故事彻底结束；运行时会转入自由剧情，继续按角色与局势编排。",
    "16. 章节内容是给编排师看的内部提纲，只能用于安排谁说话、说什么、剧情怎么发展，绝不能直接念给用户。",
    "17. 当玩家尚未输入、只是刚进入章节时，必须先推进至少一轮非玩家对话，不能空着内容直接把回合交给玩家。",
  ].filter(Boolean).join("\n\n");
}

async function loadStoryPrompts() {
  const rows = await u.db("t_prompts")
    .whereIn("code", ["story-main", "story-orchestrator", "story-memory"])
    .select("code", "defaultValue", "customValue");
  const map = new Map<string, any>();
  for (const row of rows as any[]) {
    map.set(String(row.code || ""), row);
  }
  return {
    storyMain: getPromptValue(map.get("story-main")),
    storyOrchestrator: getPromptValue(map.get("story-orchestrator")),
    storyMemory: getPromptValue(map.get("story-memory")),
  };
}

function applyStateDelta(state: JsonRecord, delta: JsonRecord) {
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) return;
  Object.entries(delta).forEach(([key, value]) => {
    state[key] = value;
  });
}

export async function runNarrativeOrchestrator(input: OrchestratorInput): Promise<OrchestratorResult> {
  const prompts = await loadStoryPrompts();
  const roles = worldRoles(input.world);
  const promptAiConfig = await u.getPromptAi("storyOrchestratorModel", input.userId);
  const turnState = readRuntimeTurnState(input.state, input.world);
  const currentChapter = {
    id: Number(input.chapter?.id || 0),
    title: normalizeScalarText(input.chapter?.title),
    directive: chapterDirectiveText(input.chapter),
    openingRole: normalizeScalarText(input.chapter?.openingRole),
    openingText: normalizeScalarText(input.chapter?.openingText),
    backgroundPath: normalizeScalarText(input.chapter?.backgroundPath),
    bgmPath: normalizeScalarText(input.chapter?.bgmPath),
  };
  const payload = {
    world: {
      id: Number(input.world?.id || 0),
      name: normalizeScalarText(input.world?.name),
      intro: normalizeScalarText(input.world?.intro),
    },
    chapter: currentChapter,
    roles,
    wildcardRoles: roles
      .filter((item) => roleActsAsWildcard(item))
      .map((item) => ({
        id: item.id,
        name: item.name,
        roleType: item.roleType,
      })),
    narratorActsAsWildcardFallback: roles.every((item) => !roleActsAsWildcard(item)),
    state: input.state,
    turnState,
    recentDialogue: recentDialogueText(input.recentMessages),
    latestPlayerMessage: normalizeScalarText(input.playerMessage),
  };
  const hasPlayerInput = payload.latestPlayerMessage.length > 0;
  const isSkip = payload.latestPlayerMessage === ".";

  const output = {
    roleType: z.string().optional().describe("本轮说话角色类型，必须是 narrator 或 npc"),
    speaker: z.string().optional().describe("说话角色名称，必须来自当前角色列表"),
    content: z.string().optional().describe("本轮真实输出给用户看到的内容"),
    awaitUser: z.boolean().optional().describe("这轮结束后是否轮到用户发言"),
    nextRoleType: z.string().optional().describe("下一轮预计发言角色类型：player / narrator / npc"),
    nextSpeaker: z.string().optional().describe("下一轮预计发言角色名称"),
    chapterOutcome: z.enum(["continue", "success", "failed"]).optional().describe("本轮后章节是否继续"),
    nextChapterId: z.number().optional().describe("若章节成功且指定跳转章节，则返回章节 id"),
    memoryHints: z.array(z.string()).optional().describe("需要记忆管理器关注的要点"),
    stateDelta: z.record(z.string(), z.any()).optional().describe("需要写回状态的简单字段变化"),
  };

  try {
    const result = await u.ai.text.invoke(
      {
        messages: [
          {
            role: "system",
            content: buildOrchestratorSystemPrompt(prompts.storyMain, prompts.storyOrchestrator),
          },
          {
            role: "user",
            content: JSON.stringify(payload, null, 2),
          },
        ],
        output,
        maxRetries: input.maxRetries,
      },
      promptAiConfig as any,
    );

    const speaker = normalizeScalarText((result as any)?.speaker);
    const roleType = sanitizeRoleType((result as any)?.roleType);
    const matchedRole = roles.find((item) => item.name === speaker)
      || roles.find((item) => item.roleType === roleType && item.roleType !== "player")
      || roles.find((item) => item.roleType === "narrator")
      || roles[0];
    const content = normalizeScalarText((result as any)?.content);
    const awaitUser = Boolean((result as any)?.awaitUser);
    const nextRoleType = sanitizeRoleType((result as any)?.nextRoleType || "player");
    const nextRole = normalizeScalarText((result as any)?.nextSpeaker);
    const chapterOutcome = String((result as any)?.chapterOutcome || "continue").trim().toLowerCase();
    const nextChapterId = Number((result as any)?.nextChapterId || 0);
    const memoryHints = Array.isArray((result as any)?.memoryHints)
      ? (result as any).memoryHints.map((item: unknown) => normalizeScalarText(item)).filter(Boolean)
      : [];
    const stateDelta = asRecord((result as any)?.stateDelta);

    if ((((matchedRole && content) || (awaitUser && hasPlayerInput))) && !looksLikeDirectiveLeak(content, currentChapter.directive, currentChapter.openingText)) {
      if (isSkip) {
        const skipRole = matchedRole || roles.find((item) => item.roleType === "narrator") || roles[0];
        const skipContent = content || "你选择暂时沉默，其他角色顺势接过话头，剧情继续推进。";
        return {
          role: skipRole?.name || "旁白",
          roleType: sanitizeRoleType(skipRole?.roleType || "narrator"),
          content: skipContent,
          memoryHints,
          stateDelta,
          awaitUser: false,
          nextRole: normalizeScalarText(skipRole?.name) || "旁白",
          nextRoleType: sanitizeRoleType(skipRole?.roleType || "narrator"),
          chapterOutcome: chapterOutcome === "failed" ? "failed" : chapterOutcome === "success" ? "success" : "continue",
          nextChapterId: Number.isFinite(nextChapterId) && nextChapterId > 0 ? nextChapterId : null,
          source: "ai",
        };
      }
      return {
        role: awaitUser ? "" : matchedRole.name,
        roleType: awaitUser ? "player" : matchedRole.roleType,
        content: awaitUser ? "" : content,
        memoryHints,
        stateDelta,
        awaitUser,
        nextRole,
        nextRoleType,
        chapterOutcome: chapterOutcome === "failed" ? "failed" : chapterOutcome === "success" ? "success" : "continue",
        nextChapterId: Number.isFinite(nextChapterId) && nextChapterId > 0 ? nextChapterId : null,
        source: "ai",
      };
    }
    throw createRuntimeModelError("orchestrator", "模型返回结构无效或泄漏了内部编排内容");
  } catch (err) {
    console.warn("[story:orchestrator] error", {
      manufacturer: (promptAiConfig as any)?.manufacturer || "",
      model: (promptAiConfig as any)?.model || "",
      expectedRoleType: turnState.expectedRoleType,
      expectedRole: turnState.expectedRole,
      message: (err as any)?.message || String(err),
    });
    throw createRuntimeModelError("orchestrator", (err as any)?.message || String(err));
  }
}

export async function runStoryMemoryManager(input: {
  userId: number;
  world: any;
  chapter: any;
  state: JsonRecord;
  recentMessages: RuntimeMessageInput[];
}): Promise<MemoryManagerResult> {
  const prompts = await loadStoryPrompts();
  const promptAiConfig = await u.getPromptAi("storyMemoryModel", input.userId);
  const payload = {
    worldName: normalizeScalarText(input.world?.name),
    chapterTitle: normalizeScalarText(input.chapter?.title),
    recentDialogue: recentDialogueText(input.recentMessages),
    currentMemory: input.state.memorySummary ?? "",
  };

  try {
    const result = await u.ai.text.invoke(
      {
        messages: [
          {
            role: "system",
            content: [
              prompts.storyMemory,
              "输出要求：",
              "1. 只提炼对后续剧情有用的事实。",
              "2. 不写剧情正文。",
              "3. 输出 JSON。",
            ].filter(Boolean).join("\n\n"),
          },
          {
            role: "user",
            content: JSON.stringify(payload, null, 2),
          },
        ],
        output: {
          summary: z.string().describe("本轮后的记忆摘要"),
          facts: z.array(z.string()).optional().describe("事实列表"),
          tags: z.array(z.string()).optional().describe("索引标签"),
        },
      },
      promptAiConfig as any,
    );
    return {
      summary: normalizeScalarText((result as any)?.summary),
      facts: Array.isArray((result as any)?.facts) ? (result as any).facts.map((item: unknown) => normalizeScalarText(item)).filter(Boolean) : [],
      tags: Array.isArray((result as any)?.tags) ? (result as any).tags.map((item: unknown) => normalizeScalarText(item)).filter(Boolean) : [],
      source: "ai",
    };
  } catch (err) {
    console.warn("[story:memory] error", {
      manufacturer: (promptAiConfig as any)?.manufacturer || "",
      model: (promptAiConfig as any)?.model || "",
      message: (err as any)?.message || String(err),
    });
    throw createRuntimeModelError("memory", (err as any)?.message || String(err));
  }
}

export function applyMemoryResultToState(state: JsonRecord, memory: MemoryManagerResult) {
  state.memorySummary = memory.summary;
  state.memoryFacts = memory.facts;
  state.memoryTags = memory.tags;
}

export function applyOrchestratorResultToState(state: JsonRecord, result: OrchestratorResult) {
  applyStateDelta(state, result.stateDelta);
}

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
  let current = input.initialResult;

  for (let step = 0; step < maxAutoTurns; step += 1) {
    applyOrchestratorResultToState(input.state, current);

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

    const shouldYieldToPlayer = current.awaitUser || sanitizeRoleType(current.nextRoleType || "player") === "player";
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
      expectedRoleType: sanitizeRoleType(current.nextRoleType),
      expectedRole: normalizeScalarText(current.nextRole || current.role),
      lastSpeakerRoleType: sanitizeRoleType(current.roleType),
      lastSpeaker: normalizeScalarText(current.role),
    });

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

function hasEffectiveCondition(input: unknown): boolean {
  if (input === null || input === undefined) return false;
  if (typeof input === "string") return input.trim().length > 0;
  if (Array.isArray(input)) return input.length > 0;
  if (typeof input === "object") return Object.keys(input as Record<string, unknown>).length > 0;
  return true;
}

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

function extractDebugNextChapterId(input: unknown): number | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = (input as Record<string, unknown>).nextChapterId ?? (input as Record<string, unknown>).nextChapter;
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

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
    if (failureNode !== undefined && evaluateDebugConditionNode(failureNode, ctx)) {
      return { result: "failed", nextChapterId: extractDebugNextChapterId(node) };
    }
    const successNode = node.success ?? node.pass;
    if (successNode !== undefined && evaluateDebugConditionNode(successNode, ctx)) {
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
