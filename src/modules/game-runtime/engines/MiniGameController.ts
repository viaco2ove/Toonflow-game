import { z } from "zod";
import u from "@/utils";
import {
  JsonRecord,
  nowTs,
  parseJsonSafe,
} from "@/lib/gameEngine";
import { worldRoles } from "@/modules/game-runtime/engines/NarrativeOrchestrator";
import { DebugLogUtil } from "@/utils/debugLogUtil";
import { resolveMiniGameIntentByAi } from "@/modules/game-runtime/services/MiniGameIntentService";

export interface MiniGameActionOption {
  action_id: string;
  label: string;
  desc: string;
  aliases?: string[];
}

export interface MiniGameControllerInput {
  userId: number;
  world: any;
  chapter: any;
  state: JsonRecord;
  recentMessages: Array<Record<string, any>>;
  playerMessage: string;
  mode: "session" | "debug";
}

export interface MiniGameControllerResult {
  intercepted: boolean;
  message: {
    role: string;
    roleType: string;
    eventType: string;
    content: string;
    meta: JsonRecord;
  } | null;
  messages?: Array<{
    role: string;
    roleType: string;
    eventType: string;
    content: string;
    meta: JsonRecord;
  }>;
  runtime: JsonRecord | null;
}

type MiniGameStatus = "idle" | "preparing" | "active" | "settling" | "finished" | "aborted" | "suspended";

interface MiniGameRulebook {
  gameType: string;
  displayName: string;
  version: string;
  goal: string;
  phaseOrder: string[];
  triggerTags: string[];
  passivePatterns: RegExp[];
  ruleSummary: string;
  setup: (ctx: MiniGameControllerInput, sessionId: string, entrySource: string) => JsonRecord;
  options: (session: JsonRecord) => MiniGameActionOption[];
  applyAction: (session: JsonRecord, actionId: string, ctx: MiniGameControllerInput) => MiniGameStepResult;
}

interface MiniGameStepResult {
  narration: string;
  speakerRole?: string;
  speakerRoleType?: string;
  messages?: Array<{
    role: string;
    roleType: string;
    eventType: string;
    content: string;
  }>;
  resultTags?: string[];
  rngUsed?: number[];
  rewardSummary?: JsonRecord;
  writeback?: JsonRecord;
  memorySummary?: string;
}

const CONTROL_ALIASES: Record<string, string[]> = {
  view_status: ["查看状态", "状态", "局势", "看看状态", "查看局势"],
  view_rules: ["查看规则", "规则", "看看规则"],
  resume: ["继续", "继续钓鱼", "恢复小游戏", "恢复", "接着来"],
  suspend: ["暂停", "暂停小游戏", "先暂停"],
};

const TEXT_INPUT_GAME_TYPES = new Set(["research_skill", "alchemy", "upgrade_equipment", "battle"]);

function isTextInputMiniGame(gameType: string) {
  return TEXT_INPUT_GAME_TYPES.has(scalarText(gameType));
}

/**
 * 判断当前小游戏是否是战斗玩法。
 * 这样可以在多个展示和状态同步函数里统一走战斗专用分支。
 */
function isBattleMiniGame(gameType: string) {
  return scalarText(gameType) === "battle";
}

function uniqueTexts(items: string[]) {
  return Array.from(new Set(items.map((item) => scalarText(item)).filter(Boolean)));
}

const PASSIVE_CONFIRM_PATTERNS = [
  /^(好|好的|好啊|好吧)$/,
  /^(开始|开始吧)$/,
  /^(来吧|来)$/,
  /^(可以|可以了|可以吧)$/,
  /^(行|行啊|行吧)$/,
  /^(同意|我同意)$/,
  /^(参加|我参加)$/,
  /^(试试|试一下|那就试试)$/,
  /^(那就|那就来吧)$/,
  /^(一起|一起吧)$/,
  /^(继续|继续吧)$/,
];

function asRecord(input: unknown): JsonRecord {
  return parseJsonSafe<JsonRecord>(input, {});
}

function asArray<T = unknown>(input: unknown): T[] {
  return Array.isArray(input) ? (input as T[]) : [];
}

function deepCloneRecord(input: JsonRecord): JsonRecord {
  try {
    return JSON.parse(JSON.stringify(input || {})) as JsonRecord;
  } catch {
    return { ...input };
  }
}

function scalarText(input: unknown): string {
  const text = String(input ?? "").trim();
  if (!text) return "";
  if (text === "null" || text === "undefined") return "";
  return text;
}

function gameSessionId(gameType: string) {
  return `mg_${gameType}_${Date.now()}_${u.uuid().replace(/-/g, "").slice(0, 8)}`;
}

function hashSeed(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildRngQueue(seed: string, size = 64): number[] {
  let state = hashSeed(seed) || 1;
  const queue: number[] = [];
  for (let i = 0; i < size; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    queue.push(state % 100);
  }
  return queue;
}

function takeRng(session: JsonRecord, min = 0, max = 99): number {
  const rngState = asRecord(session.rng_state);
  const queue = asArray<number>(rngState.queue);
  let cursor = Number(rngState.cursor || 0);
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;
  let raw: number;
  if (queue.length > 0) {
    raw = Number(queue[cursor % queue.length] || 0);
  } else {
    raw = cursor % 100;
  }
  rngState.cursor = cursor + 1;
  session.rng_state = rngState;
  const lower = Math.min(min, max);
  const upper = Math.max(min, max);
  const span = upper - lower + 1;
  return lower + (Math.abs(raw) % span);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function ensureMiniGameRoot(state: JsonRecord): JsonRecord {
  const root = asRecord(state.miniGame);
  root.rulebook = asRecord(root.rulebook);
  root.session = asRecord(root.session);
  root.writeback = asRecord(root.writeback);
  root.ui = asRecord(root.ui);
  root.actionLog = asArray<JsonRecord>(root.actionLog);
  root.memorySummary = scalarText(root.memorySummary);
  root.passiveReentrySuppressed = Boolean(root.passiveReentrySuppressed);
  state.miniGame = root;
  return root;
}

function activeStatuses() {
  return new Set<MiniGameStatus>(["preparing", "active", "settling", "suspended"]);
}

function isMiniGameActiveState(state: JsonRecord): boolean {
  const session = asRecord(asRecord(state.miniGame).session);
  const status = scalarText(session.status) as MiniGameStatus;
  return activeStatuses().has(status);
}

/**
 * 强制结束小游戏后，彻底清掉本轮小游戏会话与 UI 残留。
 * 否则旧的 transcript 和面板状态仍可能让下一句普通输入再次误触发同一个小游戏。
 */
function clearMiniGameSession(root: JsonRecord) {
  root.session = {};
  root.rulebook = {};
  root.ui = {};
  root.actionLog = [];
  root.writeback = {};
  root.memorySummary = "";
}

/**
 * #退出 后阻止被动再次进入小游戏。
 * 只有显式的 #钓鱼 / #战斗 / 目录选择，才能重新开启小游戏。
 */
function suppressPassiveMiniGameReentry(root: JsonRecord) {
  root.passiveReentrySuppressed = true;
}

/**
 * 当用户显式要求进入小游戏时，解除被动重进抑制。
 * 这样后续新的小游戏流程仍然可以正常运行。
 */
function clearPassiveMiniGameReentrySuppression(root: JsonRecord) {
  root.passiveReentrySuppressed = false;
}

function detectControlAction(input: string): string | null {
  const text = scalarText(input);
  if (!text) return null;
  const normalized = text.replace(/^#/, "").trim();
  for (const [actionId, aliases] of Object.entries(CONTROL_ALIASES)) {
    if (aliases.some((alias) => normalized === alias || normalized.includes(alias))) {
      return actionId;
    }
  }
  return null;
}

function normalizePhase(value: unknown, fallback: string): string {
  const text = scalarText(value);
  return text || fallback;
}

function pushMiniGameLog(root: JsonRecord, entry: JsonRecord) {
  const list = asArray<JsonRecord>(root.actionLog);
  list.push(entry);
  root.actionLog = list.slice(-80);
}

function buildStateDelta(before: JsonRecord, after: JsonRecord): JsonRecord {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const delta: JsonRecord = {};
  Array.from(keys).forEach((key) => {
    const prev = (before || {})[key];
    const next = (after || {})[key];
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      delta[key] = next as any;
    }
  });
  return delta;
}

function buildMiniGameMeta(root: JsonRecord): JsonRecord {
  const session = asRecord(root.session);
  const ui = asRecord(root.ui);
  return {
    miniGame: {
      gameType: scalarText(session.game_type),
      displayName: scalarText(asRecord(root.rulebook).displayName),
      status: scalarText(session.status),
      phase: scalarText(session.phase),
      round: Number(session.round || 0),
      publicState: asRecord(session.public_state),
      acceptsTextInput: Boolean(ui.accepts_text_input),
      inputHint: scalarText(ui.input_hint),
    },
  };
}

function summarizePublicState(publicState: JsonRecord): string {
  const entries = Object.entries(publicState)
    .filter(([, value]) => value !== null && value !== undefined && `${value}`.trim() !== "")
    .slice(0, 6)
    .map(([key, value]) => `${key}:${Array.isArray(value) ? value.join("/") : value}`);
  return entries.join("，");
}

function buildMiniGameUiStateItems(session: JsonRecord, rulebook: MiniGameRulebook): JsonRecord[] {
  const publicState = asRecord(session.public_state);
  if (rulebook.gameType === "battle") {
    const enemyList = asArray<JsonRecord>(publicState.enemy_list)
      .map((item) => asRecord(item))
      .filter((item) => Number(item.hp || 0) > 0);
    return [
      { key: "当前目标", value: scalarText(publicState.current_target_name) || "待确认" },
      { key: "用户状态", value: `HP ${Number(publicState.user_hp || 0)}/${Number(publicState.user_max_hp || 0)} · MP ${Number(publicState.user_mp || 0)}/${Number(publicState.user_max_mp || 0)}` },
      { key: "敌人数量", value: `${enemyList.length}` },
      { key: "最近战报", value: scalarText(publicState.last_result) || "战斗尚未开始" },
    ].filter((item) => scalarText(item.value));
  }
  if (rulebook.gameType === "fishing") {
    return [
      { key: "当前水域", value: scalarText(publicState.site_name) || "当前水域" },
      { key: "当前状态", value: scalarText(publicState.current_status) || "准备抛竿" },
      { key: "本轮结果", value: scalarText(publicState.last_result) || "暂无" },
      { key: "最近收获", value: scalarText(publicState.last_reward) || "暂无" },
    ].filter((item) => scalarText(item.value));
  }
  if (rulebook.gameType === "research_skill") {
    return [
      { key: "目标技能", value: scalarText(publicState.target_skill_name) || "待输入" },
      { key: "当前方案", value: scalarText(publicState.last_plan) || "暂无" },
      { key: "本次结果", value: scalarText(publicState.last_result) || "待评估" },
      { key: "建议调整", value: scalarText(publicState.last_advice) || "暂无" },
    ].filter((item) => scalarText(item.value));
  }
  if (rulebook.gameType === "alchemy") {
    return [
      { key: "目标丹药", value: scalarText(publicState.recipe_name) || "待输入" },
      { key: "炼制方案", value: scalarText(publicState.last_formula) || "暂无" },
      { key: "本次结果", value: scalarText(publicState.last_result) || "待评估" },
      { key: "建议调整", value: scalarText(publicState.last_advice) || "暂无" },
    ].filter((item) => scalarText(item.value));
  }
  if (rulebook.gameType === "upgrade_equipment") {
    return [
      { key: "目标装备", value: scalarText(publicState.equip_name) || "当前装备" },
      { key: "升级方案", value: scalarText(publicState.last_plan) || "暂无" },
      { key: "当前等级", value: scalarText(publicState.current_level) || "0" },
      { key: "本次结果", value: scalarText(publicState.last_result) || "待评估" },
    ].filter((item) => scalarText(item.value));
  }
  return Object.entries(publicState)
    .map(([key, value]) => ({ key, value: Array.isArray(value) ? value.join("/") : scalarText(value) }))
    .filter((item) => scalarText(item.value))
    .slice(0, 10);
}

function buildMiniGamePhaseLabel(session: JsonRecord, rulebook: MiniGameRulebook): string {
  const phase = scalarText(session.phase);
  if (rulebook.gameType === "battle") {
    if (phase === "encounter") return "交战中";
    if (phase === "settling") return "已结算";
  }
  if (rulebook.gameType === "fishing") {
    if (phase === "prepare") return "准备中";
    if (phase === "waiting") return "等待结果";
    if (phase === "result") return "本轮结束";
    if (phase === "settling") return "已结束";
  }
  if (isTextInputMiniGame(rulebook.gameType)) {
    if (phase === "await_input") return "等待方案";
    if (phase === "result") return "已评估";
    if (phase === "settling") return "已结束";
  }
  return phase || "进行中";
}

function buildMiniGameInputHint(rulebook: MiniGameRulebook): string {
  if (rulebook.gameType === "werewolf") {
    return "直接输入动作，例如“发言”“进入投票”“投票萧炎”“查验美杜莎”“救萧炎”，#退出 可强制退出小游戏";
  }
  if (rulebook.gameType === "fishing") {
    return "直接输入动作，例如“抛竿”“收杆”“继续钓鱼”，#退出 可强制退出小游戏";
  }
  if (rulebook.gameType === "cultivation") {
    return "直接输入动作，例如“吐纳”“观想”“稳息”“服丹”“冲关”“收功”，#退出 可强制退出小游戏";
  }
  if (rulebook.gameType === "mining") {
    return "直接输入动作，例如“勘探”“开采”“精挖”“支护”“清障”“休息”“撤离”，#退出 可强制退出小游戏";
  }
  if (rulebook.gameType === "battle") {
    return "直接输入战斗动作，例如“攻击暴风狼”“施展灭魔步攻击”“防御”“调息回气”，#退出 可强制退出小游戏";
  }
  if (rulebook.gameType === "research_skill") {
    return "直接输入技能名称、思路或调整方案，#退出 可强制退出小游戏";
  }
  if (rulebook.gameType === "alchemy") {
    return "直接输入药方、药材搭配或火候思路，#退出 可强制退出小游戏";
  }
  if (rulebook.gameType === "upgrade_equipment") {
    return "直接输入装备名称和强化方案，#退出 可强制退出小游戏";
  }
  return "";
}

function normalizeInlineText(input: unknown): string {
  return scalarText(input).replace(/\s+/g, " ").trim();
}

/**
 * 统一压缩小游戏文本输入，尽量消除口语化前后缀和标点干扰。
 * 这样“我想先抛竿试试”“帮我投票萧炎”这类输入也能命中动作。
 */
function normalizeMiniGameActionText(input: unknown): string {
  const source = normalizeInlineText(input)
    .replace(/^#/, "")
    .replace(/[，。！？、,.!?\s]/g, "")
    .trim();
  if (!source) return "";
  return source
    .replace(/^(我想|我要|我先|先|请|请帮我|帮我|让我|现在|这就|准备|尝试|试着)+/u, "")
    .replace(/(一下|一手|试试|看看|吧|呀|啦|呢|哦)+$/u, "")
    .trim();
}

function createPlayerParameterCard(state: JsonRecord) {
  const player = asRecord(state.player);
  const card = asRecord(player.parameterCardJson);
  card.skills = uniqueTexts(asArray<string>(card.skills));
  card.items = uniqueTexts(asArray<string>(card.items));
  card.equipment = uniqueTexts(asArray<string>(card.equipment));
  player.parameterCardJson = card;
  state.player = player;
  return card;
}

function appendParameterCardList(state: JsonRecord, key: "skills" | "items" | "equipment", additions: string[]) {
  const next = uniqueTexts([
    ...asArray<string>(createPlayerParameterCard(state)[key]),
    ...additions,
  ]);
  const player = asRecord(state.player);
  const card = createPlayerParameterCard(state);
  card[key] = next;
  player.parameterCardJson = card;
  state.player = player;
}

function replaceParameterCardEquipment(state: JsonRecord, fromName: string, toName: string) {
  const player = asRecord(state.player);
  const card = createPlayerParameterCard(state);
  const current = uniqueTexts(asArray<string>(card.equipment));
  const next = current.map((item) => (item === fromName ? toName : item));
  if (!next.includes(toName)) {
    next.push(toName);
  }
  card.equipment = uniqueTexts(next);
  player.parameterCardJson = card;
  state.player = player;
}

function collectPlayerEquipmentNames(state: JsonRecord): string[] {
  const card = createPlayerParameterCard(state);
  const fromInventory = asArray<JsonRecord>(state.inventory)
    .map((item) => scalarText(item.name || item.itemName || item.title))
    .filter(Boolean);
  return uniqueTexts([...asArray<string>(card.equipment), ...fromInventory]);
}

function simpleSlug(input: string): string {
  return scalarText(input)
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48)
    .toLowerCase();
}

function countKeywordHits(text: string, keywords: string[]) {
  return keywords.reduce((count, keyword) => count + (text.includes(keyword) ? 1 : 0), 0);
}

function extractQuotedName(text: string): string {
  const matched = normalizeInlineText(text).match(/[“"《](.{2,24}?)[”"》]/);
  return scalarText(matched?.[1]);
}

function inferSkillName(text: string): string {
  const quoted = extractQuotedName(text);
  if (quoted) return quoted;
  const normalized = normalizeInlineText(text);
  const matched = normalized.match(/(?:技能|招式|术式|功法|法术|绝招)[：:\s]*([\p{L}\p{N}一-龥]{2,24})/u);
  if (matched?.[1]) return scalarText(matched[1]);
  return scalarText(normalized.split(/[，。！？!?,；;：:\s]/)[0]).slice(0, 16);
}

function inferPotionName(text: string): string {
  const quoted = extractQuotedName(text);
  if (quoted) return quoted;
  const normalized = normalizeInlineText(text);
  const matched = normalized.match(/([\p{L}\p{N}一-龥]{2,20}(?:丹|药|液|散|丸))/u);
  if (matched?.[1]) return scalarText(matched[1]);
  const base = scalarText(normalized.split(/[，。！？!?,；;：:\s]/)[0]).slice(0, 12);
  return base ? `${base}丹` : "自拟丹药";
}

function parseEquipmentLevel(name: string): number {
  const text = scalarText(name);
  const levelMatch = text.match(/(\d+)级/u);
  if (levelMatch?.[1]) return Number(levelMatch[1] || 0);
  const plusMatch = text.match(/\+(\d+)$/u);
  if (plusMatch?.[1]) return Number(plusMatch[1] || 0);
  return 0;
}

function extractAffix(text: string): string {
  const affixes = ["火焰", "雷霆", "寒霜", "破魔", "穿透", "护体", "回灵", "爆裂", "锋锐", "附魔"];
  return affixes.find((item) => text.includes(item)) || "";
}

function upgradeEquipmentName(name: string, affix = ""): string {
  const current = scalarText(name);
  const level = parseEquipmentLevel(current);
  let next = current;
  if (/(\d+)级/u.test(current)) {
    next = current.replace(/(\d+)级/u, `${level + 1}级`);
  } else if (/\+\d+$/u.test(current)) {
    next = current.replace(/\+(\d+)$/u, `+${level + 1}`);
  } else {
    next = `${current}${level + 1}级`;
  }
  return affix && !next.includes(affix) ? `${next}（${affix}）` : next;
}

function matchEquipmentName(text: string, candidates: string[]): string {
  const normalized = normalizeInlineText(text);
  if (!normalized) return "";
  const exact = candidates.find((item) => normalized.includes(item) || item.includes(normalized));
  return scalarText(exact);
}

function buildTextMiniGameAdvice(gameType: string, text: string): string {
  const hints: string[] = [];
  if (text.length < 10) {
    hints.push("把方案写得更具体一些");
  }
  if (gameType === "research_skill" && !/(原理|思路|测试|稳定|改良|控制|连招|法阵|回路)/.test(text)) {
    hints.push("补充技能原理、测试方式或稳定性设计");
  }
  if (gameType === "alchemy" && !/(药材|主药|辅药|药引|火候|提纯|稳炉|凝丹)/.test(text)) {
    hints.push("补上药材搭配、火候和稳炉步骤");
  }
  if (gameType === "upgrade_equipment" && !/(加热|锻打|校正|淬火|注灵|强化|附魔|稳固)/.test(text)) {
    hints.push("说明加热、锻打或注灵等强化步骤");
  }
  return hints.length ? `建议你${hints.join("，")}。` : "建议你把资源、步骤和风险控制说得更完整一些。";
}

/**
 * 从角色参数卡或属性里读取数值型等级。
 * 战斗小游戏需要统一读取角色等级、血量、蓝量作为初始战斗数据。
 */
function roleNumericStat(role: JsonRecord, key: "level" | "hp" | "mp" | "money", fallback: number): number {
  const card = asRecord(role.parameterCardJson);
  const attrs = asRecord(role.attributes);
  const raw = Number(card[key] ?? attrs[key] ?? fallback);
  return Number.isFinite(raw) ? raw : fallback;
}

/**
 * 解析 `#战斗 xxx` / `#对战 xxx` 里的敌人名称列表。
 * 支持单个名称，也支持用顿号、逗号、“和/与”分隔多个敌人。
 */
function parseBattleTargetNames(input: string): string[] {
  const text = normalizeInlineText(input);
  const withoutTrigger = text.replace(/^#(?:战斗|对战)/u, "").trim();
  if (!withoutTrigger) {
    return ["野怪"];
  }
  return withoutTrigger
    .split(/[，,、/]|(?:\s+和\s+)|(?:\s+与\s+)/u)
    .map((item) => scalarText(item))
    .filter(Boolean);
}

/**
 * 统一战斗角色名匹配用的文本。
 * 这里会顺手去掉空白，避免“萧 薰儿”这种输入影响命中。
 */
function normalizeBattleRoleLookupText(input: unknown): string {
  return scalarText(input).replace(/\s+/g, "").trim();
}

/**
 * 从角色显示名里提取一组可用于战斗匹配的候选名称。
 *
 * 例子：
 * - `熏儿（萧薰儿|古薰儿）` -> `["熏儿（萧薰儿|古薰儿）", "熏儿", "萧薰儿", "古薰儿"]`
 * - `萧炎` -> `["萧炎"]`
 */
function battleRoleCandidateNames(role: JsonRecord): string[] {
  const rawName = scalarText(role.name);
  if (!rawName) return [];
  const names = new Set<string>();
  names.add(rawName);
  const compactRawName = normalizeBattleRoleLookupText(rawName);
  if (compactRawName) {
    names.add(compactRawName);
  }
  const strippedName = scalarText(rawName.replace(/[（(][^（）()]*[）)]/gu, ""));
  if (strippedName) {
    names.add(strippedName);
    const compactStrippedName = normalizeBattleRoleLookupText(strippedName);
    if (compactStrippedName) {
      names.add(compactStrippedName);
    }
  }
  const bracketMatches = rawName.match(/[（(]([^（）()]*)[）)]/gu) || [];
  for (const item of bracketMatches) {
    const inner = scalarText(item.replace(/^[（(]|[）)]$/gu, ""));
    if (!inner) continue;
    for (const alias of inner.split(/[|｜/、，,]/u).map((part) => scalarText(part)).filter(Boolean)) {
      names.add(alias);
      const compactAlias = normalizeBattleRoleLookupText(alias);
      if (compactAlias) {
        names.add(compactAlias);
      }
    }
  }
  return Array.from(names);
}

/**
 * 计算输入名与候选角色名的匹配分值。
 * 分值越高代表命中越可靠；精确别名优先，包含匹配只作兜底。
 */
function battleRoleMatchScore(inputName: string, candidateNames: string[]): number {
  const normalizedInput = normalizeBattleRoleLookupText(inputName);
  if (!normalizedInput) return -1;
  let bestScore = -1;
  for (const candidate of candidateNames) {
    const normalizedCandidate = normalizeBattleRoleLookupText(candidate);
    if (!normalizedCandidate) continue;
    if (normalizedCandidate === normalizedInput) {
      bestScore = Math.max(bestScore, 300);
      continue;
    }
    if (normalizedCandidate.startsWith(normalizedInput) || normalizedInput.startsWith(normalizedCandidate)) {
      bestScore = Math.max(bestScore, 220);
      continue;
    }
    if (normalizedCandidate.includes(normalizedInput) || normalizedInput.includes(normalizedCandidate)) {
      bestScore = Math.max(bestScore, 120);
    }
  }
  return bestScore;
}

/**
 * 从世界角色里按名称匹配敌人来源角色。
 * 如果能匹配到现有角色，就复用其头像、简介和参数卡。
 */
function resolveWorldRoleByName(ctx: MiniGameControllerInput, name: string): JsonRecord | null {
  const normalized = scalarText(name);
  if (!normalized) return null;
  const roles = worldRoles(ctx.world).map((item) => asRecord(item));
  let bestRole: JsonRecord | null = null;
  let bestScore = -1;
  for (const role of roles) {
    const score = battleRoleMatchScore(normalized, battleRoleCandidateNames(role));
    if (score > bestScore) {
      bestScore = score;
      bestRole = role;
    }
  }
  return bestScore >= 0 ? bestRole : null;
}

/**
 * 判断一个世界角色是否能承担“万能角色”兜底发言职责。
 * 当敌人只是野怪且故事里存在万能角色时，优先让万能角色代替野怪发言。
 */
function isWildcardWorldRole(role: JsonRecord): boolean {
  const haystack = [
    scalarText(role.name),
    scalarText(role.description),
    scalarText(role.sample),
    typeof role.parameterCardJson === "string" ? scalarText(role.parameterCardJson) : "",
  ]
    .filter(Boolean)
    .join("\n");
  return /万能角色|万能/u.test(haystack);
}

/**
 * 为当前战斗敌人选择一个真正负责说话的角色。
 *
 * 规则：
 * - 敌人本身就是故事角色时，让该角色自己说话；
 * - 敌人是野怪但世界里存在万能角色时，让万能角色代替野怪发言；
 * - 只有找不到可发言角色时，才回退到旁白。
 */
function resolveBattleSpeaker(
  session: JsonRecord,
  ctx: MiniGameControllerInput,
  preferredEnemy?: JsonRecord | null,
): { role: string; roleType: string; speakerName: string; proxyEnemyName: string; viaWildcard: boolean; narratorFallback: boolean } {
  const narratorName = scalarText(ctx.world?.narratorRole?.name) || "旁白";
  const candidateEnemy = preferredEnemy || aliveBattleEnemies(session)[0] || null;
  const proxyEnemyName = scalarText(candidateEnemy?.name) || "敌人";
  const rolePool = worldRoles(ctx.world).map((item) => asRecord(item));
  const roleEnemyId = scalarText(candidateEnemy?.role_id);
  const roleEnemyName = scalarText(candidateEnemy?.name);
  const exactRoleEnemy = rolePool.find((item) => {
    const roleId = scalarText(item.id);
    const roleName = scalarText(item.name);
    return (roleEnemyId && roleId && roleId === roleEnemyId)
      || (roleEnemyName && roleName && roleName === roleEnemyName);
  });
  if (exactRoleEnemy) {
    return {
      role: scalarText(exactRoleEnemy.name) || proxyEnemyName,
      roleType: scalarText(exactRoleEnemy.roleType) || "npc",
      speakerName: scalarText(exactRoleEnemy.name) || proxyEnemyName,
      proxyEnemyName,
      viaWildcard: false,
      narratorFallback: false,
    };
  }
  const wildcardRole = rolePool.find((item) => isWildcardWorldRole(item));
  if (wildcardRole) {
    return {
      role: scalarText(wildcardRole.name) || narratorName,
      roleType: scalarText(wildcardRole.roleType) || "npc",
      speakerName: scalarText(wildcardRole.name) || narratorName,
      proxyEnemyName,
      viaWildcard: true,
      narratorFallback: false,
    };
  }
  return {
    role: narratorName,
    roleType: "narrator",
    speakerName: narratorName,
    proxyEnemyName,
    viaWildcard: false,
    narratorFallback: true,
  };
}

/**
 * 为野怪或未命中世界角色的名称生成一份默认敌人简介。
 * 这样在敌人状态面板里不会只看到一个空名字。
 */
function defaultEnemyDescription(name: string): string {
  const normalized = scalarText(name) || "野怪";
  if (normalized.includes("狼")) return `${normalized}盘踞在周围，行动迅捷，擅长撕咬与突袭。`;
  if (normalized.includes("魔")) return `${normalized}散发着危险气息，力量强横，擅长正面压制。`;
  if (normalized.includes("怪")) return `${normalized}正盘踞在前方，已经摆出攻击姿态。`;
  return `${normalized}已经出现在你面前，正准备与你展开一场正面对战。`;
}

/**
 * 把世界角色或临时敌人统一映射成战斗敌人快照。
 * 这个快照会写进 public_state.enemy_list，供 Web/安卓直接展示。
 */
function buildBattleEnemy(ctx: MiniGameControllerInput, name: string, index: number): JsonRecord {
  const role = resolveWorldRoleByName(ctx, name);
  if (role) {
    return {
      enemy_id: scalarText(role.id) || `enemy_role_${index + 1}`,
      role_id: scalarText(role.id),
      name: scalarText(role.name) || `敌人${index + 1}`,
      description: scalarText(role.description) || defaultEnemyDescription(scalarText(role.name)),
      level: roleNumericStat(role, "level", 1),
      hp: Math.max(1, roleNumericStat(role, "hp", 100)),
      max_hp: Math.max(1, roleNumericStat(role, "hp", 100)),
      mp: Math.max(0, roleNumericStat(role, "mp", 0)),
      max_mp: Math.max(0, roleNumericStat(role, "mp", 0)),
      avatar_path: scalarText(role.avatarPath),
      avatar_bg_path: scalarText(role.avatarBgPath),
      is_role_enemy: true,
      reward_money: clamp(roleNumericStat(role, "level", 1) * 12 + 16, 12, 320),
      reward_items: [],
    };
  }
  const normalized = scalarText(name) || `野怪${index + 1}`;
  const isWolf = normalized.includes("狼");
  const isMonster = normalized.includes("魔") || normalized.includes("兽");
  const level = isWolf ? 6 : isMonster ? 8 : 4;
  const hp = isWolf ? 95 : isMonster ? 140 : 80;
  const mp = isMonster ? 36 : 12;
  return {
    enemy_id: `enemy_temp_${simpleSlug(normalized) || index + 1}_${index + 1}`,
    role_id: "",
    name: normalized,
    description: defaultEnemyDescription(normalized),
    level,
    hp,
    max_hp: hp,
    mp,
    max_mp: mp,
    avatar_path: "",
    avatar_bg_path: "",
    is_role_enemy: false,
    reward_money: clamp(level * 10 + 10, 10, 260),
    reward_items: normalized.includes("狼") ? ["狼牙", "狼皮"] : isMonster ? ["魔核"] : ["战利品"],
  };
}

/**
 * 读取当前战斗里的存活敌人列表。
 * 所有战斗结算、按钮生成和 UI 同步都依赖这个函数。
 */
function aliveBattleEnemies(session: JsonRecord): JsonRecord[] {
  const publicState = asRecord(session.public_state);
  return asArray<JsonRecord>(publicState.enemy_list)
    .map((item) => asRecord(item))
    .filter((item) => Number(item.hp || 0) > 0);
}

/**
 * 让战斗 public_state 和 hidden_state 保持一致。
 * 每回合动作后都要刷新当前目标、敌人数、最近战报等可见信息。
 */
function syncBattlePublicState(session: JsonRecord) {
  const publicState = asRecord(session.public_state);
  const aliveEnemies = aliveBattleEnemies(session);
  const currentTargetId = scalarText(publicState.current_target_id);
  const currentTarget = aliveEnemies.find((item) => scalarText(item.enemy_id) === currentTargetId) || aliveEnemies[0] || null;
  publicState.enemy_list = asArray<JsonRecord>(publicState.enemy_list).map((item) => asRecord(item));
  publicState.alive_enemy_count = aliveEnemies.length;
  publicState.current_target_id = scalarText(currentTarget?.enemy_id);
  publicState.current_target_name = scalarText(currentTarget?.name);
  publicState.user_hp = clamp(Number(publicState.user_hp || 0), 0, Math.max(1, Number(publicState.user_max_hp || 1)));
  publicState.user_mp = clamp(Number(publicState.user_mp || 0), 0, Math.max(0, Number(publicState.user_max_mp || 0)));
  session.public_state = publicState;
}

/**
 * 根据战斗 public_state 生成一段可直接展示的状态摘要。
 * 这段文字会喂给状态查看和回合结算 narration。
 */
function battleStatusSummary(session: JsonRecord): string {
  const publicState = asRecord(session.public_state);
  const aliveEnemies = aliveBattleEnemies(session);
  const enemySummary = aliveEnemies.length
    ? aliveEnemies.map((enemy) => `${scalarText(enemy.name)}(HP ${Number(enemy.hp || 0)})`).join("、")
    : "无存活敌人";
  return `用户 HP ${Number(publicState.user_hp || 0)}/${Number(publicState.user_max_hp || 0)}，MP ${Number(publicState.user_mp || 0)}/${Number(publicState.user_max_mp || 0)}；敌人：${enemySummary}。`;
}

/**
 * 解析攻击动作里的目标 enemy_id。
 * 这样 battleStep 不需要自己反复处理 action_id 的字符串拆分。
 */
function battleActionTargetId(actionId: string): string {
  return scalarText(actionId.split(":")[1]);
}

/**
 * 在文本战斗模式下，根据用户输入匹配当前攻击目标。
 * 这里优先按敌人名字命中；没有显式提及敌人时，再回退当前锁定目标。
 */
function resolveBattleTextTarget(session: JsonRecord, playerMessage: string): JsonRecord | null {
  const aliveEnemies = aliveBattleEnemies(session);
  if (!aliveEnemies.length) return null;
  const normalized = normalizeInlineText(playerMessage);
  let namedTarget: JsonRecord | null = null;
  let bestScore = -1;
  for (const enemy of aliveEnemies) {
    const score = battleRoleMatchScore(normalized, [scalarText(enemy.name)]);
    if (score > bestScore) {
      bestScore = score;
      namedTarget = enemy;
    }
  }
  if (namedTarget) return namedTarget;
  const publicState = asRecord(session.public_state);
  const currentTargetId = scalarText(publicState.current_target_id);
  const currentTarget = aliveEnemies.find((enemy) => scalarText(enemy.enemy_id) === currentTargetId);
  return currentTarget || aliveEnemies[0];
}

/**
 * 优先按 AI 返回的目标名锁定战斗目标。
 *
 * 用途：
 * - 小游戏 agent 可能只给出“攻击萧炎”里的目标名称；
 * - 程序侧仍然需要把它落到具体 enemy_id，保证战斗状态机不直接吃自然语言。
 */
function resolveBattleTargetByName(session: JsonRecord, targetName: string): JsonRecord | null {
  const aliveEnemies = aliveBattleEnemies(session);
  if (!aliveEnemies.length) return null;
  const normalizedTargetName = normalizeInlineText(targetName);
  if (!normalizedTargetName) return null;
  let bestTarget: JsonRecord | null = null;
  let bestScore = -1;
  for (const enemy of aliveEnemies) {
    const score = battleRoleMatchScore(normalizedTargetName, [scalarText(enemy.name)]);
    if (score > bestScore) {
      bestScore = score;
      bestTarget = enemy;
    }
  }
  return bestScore >= 0 ? bestTarget : null;
}

/**
 * 把文本战斗指令归一成 battleStep 可识别的动作。
 * 文档要求战斗不走面板式玩法，所以这里负责把自然语言转换成攻击/技能/防御/回气。
 */
function resolveBattleTextAction(session: JsonRecord, playerMessage: string): { actionId: string; targetName: string } | null {
  const normalized = normalizeInlineText(playerMessage);
  if (!normalized) return null;
  if (CONTROL_ALIASES.view_status.some((alias) => normalized.includes(alias))) {
    return { actionId: "view_status", targetName: "" };
  }
  if (/(?:防御|格挡|招架|闪避|护体)/u.test(normalized)) {
    return { actionId: "guard", targetName: "" };
  }
  if (/(?:回气|调息|回蓝|恢复法力|恢复蓝量|冥想|吐纳)/u.test(normalized)) {
    return { actionId: "recover", targetName: "" };
  }
  const target = resolveBattleTextTarget(session, normalized);
  if (!target) return null;
  const targetId = scalarText(target.enemy_id);
  const targetName = scalarText(target.name) || "敌人";
  const useSkill = /(?:施展|使出|发动|运转|释放|催动|招式|技能|法术|功法|武技|斗技)/u.test(normalized);
  return {
    actionId: `${useSkill ? "skill" : "attack"}:${targetId}`,
    targetName,
  };
}

/**
 * 生成给小游戏 agent 的合法动作清单。
 *
 * 用途：
 * - 让模型只在当前合法动作里做归一化，不去发明不存在的玩法；
 * - 战斗没有按钮动作列表，所以这里要补一份固定的程序动作。
 */
function buildMiniGameIntentOptions(session: JsonRecord, rulebook: MiniGameRulebook): MiniGameActionOption[] {
  if (rulebook.gameType === "battle") {
    return [
      { action_id: "attack", label: "普通攻击", desc: "对当前目标或指定目标发起普通攻击", aliases: ["攻击", "平A", "普通攻击", "砍他", "打他"] },
      { action_id: "skill", label: "技能攻击", desc: "施展功法、斗技或技能攻击目标", aliases: ["技能", "施展技能", "施展斗技", "用功法打", "放技能"] },
      { action_id: "guard", label: "防御", desc: "本回合防御，降低承受伤害", aliases: ["防御", "格挡", "招架", "护体", "闪避"] },
      { action_id: "recover", label: "回气", desc: "调息回气，恢复法力", aliases: ["回气", "调息", "回蓝", "恢复法力", "吐纳"] },
      { action_id: "view_status", label: "查看状态", desc: "查看当前战斗状态", aliases: ["查看状态", "状态", "看看状态"] },
    ];
  }
  return rulebook.options(session);
}

/**
 * 使用小游戏 agent 尝试把自然语言解析成战斗动作。
 *
 * 用途：
 * - 先让大模型理解“乾坤大挪移钓法”“帮我砍暴风狼”这类自由说法；
 * - 解析失败时再回退当前规则匹配，保证行为稳定。
 */
async function resolveBattleActionByAgent(
  session: JsonRecord,
  rulebook: MiniGameRulebook,
  ctx: MiniGameControllerInput,
  latestNarration: string,
): Promise<{ actionId: string; targetName: string; resolverSource: string; resolverReason: string } | null> {
  const options = buildMiniGameIntentOptions(session, rulebook);
  const intent = await resolveMiniGameIntentByAi({
    userId: ctx.userId,
    gameType: rulebook.gameType,
    phase: scalarText(session.phase),
    status: scalarText(session.status),
    publicStateSummary: battleStatusSummary(session),
    latestNarration,
    userInput: ctx.playerMessage,
    options: options.map((item) => ({
      actionId: item.action_id,
      label: item.label,
      desc: item.desc,
      aliases: item.aliases || [],
    })),
  });
  if (!intent) return null;
  if (intent.actionId === "view_status" || intent.actionId === "guard" || intent.actionId === "recover") {
    return {
      actionId: intent.actionId,
      targetName: intent.targetName,
      resolverSource: "ai",
      resolverReason: intent.reason,
    };
  }
  if (intent.actionId === "attack" || intent.actionId === "skill") {
    const explicitTarget = resolveBattleTargetByName(session, intent.targetName);
    const fallbackTarget = explicitTarget || resolveBattleTextTarget(session, intent.targetName || ctx.playerMessage);
    if (!fallbackTarget) return null;
    return {
      actionId: `${intent.actionId}:${scalarText(fallbackTarget.enemy_id)}`,
      targetName: scalarText(fallbackTarget.name),
      resolverSource: "ai",
      resolverReason: intent.reason,
    };
  }
  return null;
}

/**
 * 为战斗胜利生成写回补丁。
 * 这里统一处理奖励金钱、物品、升级概率，以及战后回满血蓝。
 */
function buildBattleVictoryWriteback(session: JsonRecord, levelUp: boolean): JsonRecord {
  const publicState = asRecord(session.public_state);
  const allEnemies = asArray<JsonRecord>(publicState.enemy_list).map((item) => asRecord(item));
  const totalMoney = allEnemies.reduce((sum, enemy) => sum + Number(enemy.reward_money || 0), 0);
  const rewardItems = uniqueTexts(
    allEnemies.flatMap((enemy) => asArray<string>(enemy.reward_items).map((item) => scalarText(item)).filter(Boolean)),
  );
  return {
    inventoryAdd: rewardItems.map((item) => ({ kind: "loot", name: item })),
    playerParameterPatch: {
      money: totalMoney,
      hp: Number(publicState.user_max_hp || 0),
      mp: Number(publicState.user_max_mp || 0),
      level: levelUp ? 1 : 0,
    },
    memoryAdd: [
      `完成战斗：${allEnemies.map((enemy) => scalarText(enemy.name)).filter(Boolean).join("、")}`,
      ...(rewardItems.length ? [`获得战利品：${rewardItems.join("、")}`] : []),
      ...(levelUp ? ["战斗结束后完成了一次升级"] : []),
    ],
  };
}

/**
 * 统一生成战斗胜利结算。
 * 当所有敌人的血量都归零后，战斗会立即结束并播报战报。
 */
function finalizeBattleVictory(session: JsonRecord): MiniGameStepResult {
  const publicState = asRecord(session.public_state);
  const levelUp = takeRng(session, 0, 99) < 35;
  const allEnemies = asArray<JsonRecord>(publicState.enemy_list).map((item) => asRecord(item));
  const totalMoney = allEnemies.reduce((sum, enemy) => sum + Number(enemy.reward_money || 0), 0);
  const rewardItems = uniqueTexts(
    allEnemies.flatMap((enemy) => asArray<string>(enemy.reward_items).map((item) => scalarText(item)).filter(Boolean)),
  );
  session.status = "finished";
  session.phase = "settling";
  session.result = "success";
  session.finish_reason = "全部敌人已被击败";
  publicState.user_hp = Number(publicState.user_max_hp || 0);
  publicState.user_mp = Number(publicState.user_max_mp || 0);
  publicState.last_result = `战斗结束，已击败全部敌人，获得 ${totalMoney} 金钱${rewardItems.length ? ` 与 ${rewardItems.join("、")}` : ""}${levelUp ? "，并触发升级。" : "。"} `;
  session.public_state = publicState;
  return {
    narration: `旁白播报战报：你已经击败全部敌人。${rewardItems.length ? `本次战利品为 ${rewardItems.join("、")}。` : ""}获得 ${totalMoney} 金钱。${levelUp ? "同时，你在战斗中突破瓶颈，等级提升了一级。" : ""}战斗结束后，你的气血与法力都已经恢复到最佳状态。`,
    speakerRole: "旁白",
    speakerRoleType: "narrator",
    resultTags: ["success", "battle_victory"],
    rewardSummary: { money: totalMoney, items: rewardItems, levelUp },
    writeback: buildBattleVictoryWriteback(session, levelUp),
    memorySummary: `战斗胜利：击败 ${allEnemies.map((enemy) => scalarText(enemy.name)).filter(Boolean).join("、")}`,
  };
}

/**
 * 统一生成战斗失败结算。
 * 为避免主线直接卡死，战败后会按败退处理，并把用户血蓝恢复到可继续剧情的安全值。
 */
function finalizeBattleDefeat(session: JsonRecord): MiniGameStepResult {
  const publicState = asRecord(session.public_state);
  const safeHp = Math.max(1, Math.floor(Number(publicState.user_max_hp || 100) * 0.4));
  const safeMp = Math.max(0, Math.floor(Number(publicState.user_max_mp || 0) * 0.4));
  session.status = "finished";
  session.phase = "settling";
  session.result = "failed";
  session.finish_reason = "用户在战斗中败退";
  publicState.user_hp = safeHp;
  publicState.user_mp = safeMp;
  publicState.last_result = "战斗失利，已暂时撤退。";
  session.public_state = publicState;
  return {
    narration: "旁白播报战报：你在这场战斗中被彻底压制，只能暂时撤退。为了避免主线中断，你已经强行调息，恢复了部分气血与法力，随时可以重新规划下一步行动。",
    speakerRole: "旁白",
    speakerRoleType: "narrator",
    resultTags: ["failed", "battle_defeat"],
    rewardSummary: { retreat: true },
    writeback: {
      playerParameterPatch: { hp: safeHp, mp: safeMp },
      memoryAdd: ["一次战斗失利后被迫撤退"],
    },
    memorySummary: "战斗失利，暂时撤退",
  };
}

/**
 * 执行一轮战斗动作。
 * 用户动作和敌人反击都会在这一轮内完成，并同步写回敌我血蓝状态。
 */
function battleStep(session: JsonRecord, actionId: string, ctx: MiniGameControllerInput): MiniGameStepResult {
  const publicState = asRecord(session.public_state);
  const enemyList = asArray<JsonRecord>(publicState.enemy_list).map((item) => asRecord(item));
  const aliveEnemies = enemyList.filter((enemy) => Number(enemy.hp || 0) > 0);
  if (!aliveEnemies.length) {
    return finalizeBattleVictory(session);
  }
  const userName = scalarText(publicState.user_name) || "用户";
  const userMaxHp = Math.max(1, Number(publicState.user_max_hp || 100));
  const userMaxMp = Math.max(0, Number(publicState.user_max_mp || 0));
  let userHp = clamp(Number(publicState.user_hp || userMaxHp), 0, userMaxHp);
  let userMp = clamp(Number(publicState.user_mp || userMaxMp), 0, userMaxMp);
  let guarding = false;
  const narrations: string[] = [];
  if (actionId === "recover") {
    const recoverMp = clamp(12 + takeRng(session, 0, 10), 8, 24);
    userMp = clamp(userMp + recoverMp, 0, userMaxMp);
    const recoverHp = clamp(6 + takeRng(session, 0, 6), 4, 18);
    userHp = clamp(userHp + recoverHp, 0, userMaxHp);
    narrations.push(`${userName}稳住呼吸，快速回气，恢复了 ${recoverHp} 点气血与 ${recoverMp} 点法力。`);
  } else if (actionId === "guard") {
    guarding = true;
    narrations.push(`${userName}沉下重心展开防御，准备硬接敌人的下一轮攻击。`);
  } else {
    const targetId = battleActionTargetId(actionId);
    const target = enemyList.find((enemy) => scalarText(enemy.enemy_id) === targetId) || aliveEnemies[0];
    if (!target) {
      return {
        narration: "当前没有可攻击的敌人，战斗会自动转入结算。",
        resultTags: ["invalid"],
      };
    }
    const targetName = scalarText(target.name) || "敌人";
    const userLevel = Math.max(1, Number(publicState.user_level || 1));
    const isSkill = actionId.startsWith("skill:");
    const requiredMp = isSkill ? 18 : 0;
    if (isSkill && userMp < requiredMp) {
      narrations.push(`${userName}想要施展技能攻击 ${targetName}，但法力不足，只能仓促改为普通攻击。`);
    }
    const useSkill = isSkill && userMp >= requiredMp;
    if (useSkill) {
      userMp = clamp(userMp - requiredMp, 0, userMaxMp);
    }
    const baseDamage = useSkill
      ? 18 + userLevel * 3 + takeRng(session, 6, 18)
      : 10 + userLevel * 2 + takeRng(session, 2, 12);
    target.hp = clamp(Number(target.hp || 0) - baseDamage, 0, Number(target.max_hp || 0));
    publicState.current_target_id = scalarText(target.enemy_id);
    publicState.current_target_name = targetName;
    narrations.push(`${userName}${useSkill ? "施展技能" : "挥出攻击"}命中 ${targetName}，造成了 ${baseDamage} 点伤害。`);
    if (Number(target.hp || 0) <= 0) {
      narrations.push(`${targetName}当场倒下，已经失去战斗能力。`);
    }
  }
  publicState.enemy_list = enemyList;
  syncBattlePublicState(session);
  if (!aliveBattleEnemies(session).length) {
    publicState.user_hp = userHp;
    publicState.user_mp = userMp;
    session.public_state = publicState;
    const victory = finalizeBattleVictory(session);
    victory.narration = `${narrations.join("")}${victory.narration}`;
    return victory;
  }
  const counterAttackLines: string[] = [];
  let leadCounterEnemy: JsonRecord | null = null;
  aliveBattleEnemies(session).forEach((enemy) => {
    const name = scalarText(enemy.name) || "敌人";
    const level = Math.max(1, Number(enemy.level || 1));
    let damage = 6 + level * 2 + takeRng(session, 0, 10);
    if (guarding) {
      damage = Math.max(1, Math.floor(damage * 0.45));
    }
    userHp = clamp(userHp - damage, 0, userMaxHp);
    if (!leadCounterEnemy) {
      leadCounterEnemy = enemy;
    }
    counterAttackLines.push(`${name}趁势反击，打掉了你 ${damage} 点气血。`);
  });
  publicState.user_hp = userHp;
  publicState.user_mp = userMp;
  publicState.last_result = `${narrations.join("")}${counterAttackLines.join("")}`.trim();
  session.round = Number(session.round || 1) + 1;
  session.phase = "encounter";
  session.public_state = publicState;
  if (userHp <= 0) {
    const defeat = finalizeBattleDefeat(session);
    defeat.narration = `${narrations.join("")}${counterAttackLines.join("")}${defeat.narration}`;
    return defeat;
  }
  syncBattlePublicState(session);
  const battleSpeaker = resolveBattleSpeaker(session, ctx, leadCounterEnemy);
  const counterSpeech = leadCounterEnemy
    ? battleSpeaker.narratorFallback
      ? `旁白播报：${battleSpeaker.proxyEnemyName}${battleSpeaker.viaWildcard ? "借由万能角色的气势" : ""}发起了下一轮攻击。`
      : battleSpeaker.viaWildcard
        ? `“${battleSpeaker.proxyEnemyName}可不会给你喘息的机会。”`
        : `“你还不配在这里放肆。”`
    : "";
  const battleReport = `${narrations.join("")}${counterAttackLines.join("")}旁白播报：当前战斗仍在继续，${battleStatusSummary(session)}`;
  return {
    narration: counterSpeech ? `${counterSpeech}${battleReport}` : battleReport,
    speakerRole: battleSpeaker.role,
    speakerRoleType: battleSpeaker.roleType,
    messages: counterSpeech
      ? [
        {
          role: battleSpeaker.role,
          roleType: battleSpeaker.roleType,
          eventType: "on_mini_game",
          content: counterSpeech,
        },
        {
          role: scalarText(ctx.world?.narratorRole?.name) || "旁白",
          roleType: "narrator",
          eventType: "on_mini_game",
          content: battleReport,
        },
      ]
      : [
        {
          role: scalarText(ctx.world?.narratorRole?.name) || "旁白",
          roleType: "narrator",
          eventType: "on_mini_game",
          content: battleReport,
        },
      ],
    resultTags: ["ongoing", "battle_round"],
    rewardSummary: {},
    memorySummary: `战斗推进一轮：${scalarText(publicState.current_target_name) || "敌人"}`,
  };
}

function evaluateResearchSkillInput(session: JsonRecord, input: MiniGameControllerInput): MiniGameStepResult {
  const publicState = asRecord(session.public_state);
  const plan = normalizeInlineText(input.playerMessage);
  const skillName = inferSkillName(plan) || "新技能蓝图";
  const keywordHits = countKeywordHits(plan, ["技能", "招式", "术式", "原理", "控制", "连招", "测试", "稳定", "改良", "回路", "法阵", "压缩"]);
  const score = clamp(20 + Math.min(24, Math.floor(plan.length / 4)) + keywordHits * 7 + takeRng(session, 0, 22), 0, 100);
  publicState.target_skill_name = skillName;
  publicState.last_plan = plan;
  publicState.last_result = score >= 68 ? `成功研发：${skillName}` : score >= 48 ? `保留了 ${skillName} 的技能碎片` : "研发失败";
  publicState.last_advice = score >= 68 ? "建议进入实战测试，继续打磨冷却与连段。" : buildTextMiniGameAdvice("research_skill", plan);
  session.round = Number(session.round || 1) + 1;
  session.status = "finished";
  session.phase = "settling";
  if (score >= 68) {
    session.result = "success";
    session.finish_reason = "研发技能成功";
    return {
      narration: `我检查了你的研发方案。恭喜你获得技能《${skillName}》；理论闭环和稳定性都已经成立，已经可以记入角色参数。`,
      resultTags: ["success"],
      rewardSummary: { unlock: skillName },
      writeback: {
        parameterCardSkillAdd: [skillName],
        flagsPatch: { [`skill_unlock_${simpleSlug(skillName)}`]: true },
        memoryAdd: [`研发技能成功：${skillName}`],
      },
      memorySummary: `研发技能成功：${skillName}`,
    };
  }
  if (score >= 48) {
    session.result = "partial";
    session.finish_reason = "得到技能碎片";
    return {
      narration: `我检查了你的研发方案。你已经摸到了《${skillName}》的雏形，但还差最后一口气；${publicState.last_advice}`,
      resultTags: ["partial"],
      rewardSummary: { fragment: skillName },
      writeback: {
        flagsPatch: { [`skill_fragment_${simpleSlug(skillName)}`]: true },
        memoryAdd: [`研发得到技能碎片：${skillName}`],
      },
      memorySummary: `研发半成功：${skillName}`,
    };
  }
  session.result = "failed";
  session.finish_reason = "研发失败";
  return {
    narration: `我检查了你的研发方案。研发失败，暂时还无法稳定成型；${publicState.last_advice}`,
    resultTags: ["failed"],
    writeback: { memoryAdd: ["一次失败的技能研发尝试"] },
    memorySummary: "研发技能失败",
  };
}

function evaluateAlchemyInput(session: JsonRecord, input: MiniGameControllerInput): MiniGameStepResult {
  const publicState = asRecord(session.public_state);
  const formula = normalizeInlineText(input.playerMessage);
  const recipeName = inferPotionName(formula);
  const keywordHits = countKeywordHits(formula, ["药材", "主药", "辅药", "药引", "火候", "提纯", "稳炉", "搅拌", "融合", "凝丹", "文火", "武火"]);
  const score = clamp(18 + Math.min(26, Math.floor(formula.length / 4)) + keywordHits * 7 + takeRng(session, 0, 24), 0, 100);
  publicState.recipe_name = recipeName;
  publicState.last_formula = formula;
  publicState.last_result = score >= 68 ? `炼成上品${recipeName}` : score >= 50 ? `勉强炼成${recipeName}` : "炼制失败";
  publicState.last_advice = score >= 50 ? "可以继续优化药性层次与丹香稳定度。" : buildTextMiniGameAdvice("alchemy", formula);
  session.round = Number(session.round || 1) + 1;
  session.status = "finished";
  session.phase = "settling";
  if (score >= 50) {
    session.result = score >= 68 ? "success" : "partial";
    session.finish_reason = "炼药完成";
    const pillName = score >= 68 ? recipeName : `粗炼${recipeName}`;
    return {
      narration: `我检查了你的炼药方案。恭喜你获得药品《${pillName}》；丹炉状态和药性融合都达到了成药标准。`,
      resultTags: [score >= 68 ? "success" : "partial"],
      rewardSummary: { item: pillName },
      writeback: {
        inventoryAdd: [{ kind: "pill", name: pillName }],
        parameterCardItemAdd: [pillName],
        memoryAdd: [`炼药获得：${pillName}`],
      },
      memorySummary: `炼药完成：${pillName}`,
    };
  }
  session.result = "failed";
  session.finish_reason = "炼药失败";
  return {
    narration: `我检查了你的炼药方案。炼药失败；${publicState.last_advice}`,
    resultTags: ["failed"],
    writeback: { memoryAdd: ["一次失败的炼药尝试"] },
    memorySummary: "炼药失败",
  };
}

function evaluateEquipmentInput(session: JsonRecord, input: MiniGameControllerInput): MiniGameStepResult {
  const publicState = asRecord(session.public_state);
  const plan = normalizeInlineText(input.playerMessage);
  const candidates = collectPlayerEquipmentNames(input.state);
  const matched = matchEquipmentName(plan, candidates);
  publicState.last_plan = plan;
  publicState.equip_name = matched || scalarText(publicState.equip_name) || "当前装备";
  publicState.current_level = parseEquipmentLevel(publicState.equip_name);
  publicState.target_level = Number(publicState.current_level || 0) + 1;
  session.round = Number(session.round || 1) + 1;
  session.status = "finished";
  session.phase = "settling";
  if (!matched) {
    session.result = "failed";
    session.finish_reason = "未找到目标装备";
    const recommend = candidates[0] ? `你没有这件装备，要不试试升级 ${candidates[0]} 吧。` : "你当前没有可升级的装备，先准备一件装备再来。";
    publicState.last_result = "没有对应装备";
    publicState.last_advice = recommend;
    return {
      narration: `我检查了你的升级方案。不好意思，你没有这个装备；${recommend}`,
      resultTags: ["failed"],
      writeback: { memoryAdd: ["一次未命中目标装备的强化尝试"] },
      memorySummary: "升级装备失败：未找到目标装备",
    };
  }
  const keywordHits = countKeywordHits(plan, ["加热", "锻打", "校正", "淬火", "注灵", "强化", "附魔", "稳固", "炉温", "灵石"]);
  const score = clamp(20 + Math.min(24, Math.floor(plan.length / 4)) + keywordHits * 7 + takeRng(session, 0, 22), 0, 100);
  const affix = extractAffix(plan);
  if (score >= 58) {
    session.result = score >= 78 ? "perfect" : "success";
    session.finish_reason = "升级装备成功";
    const upgraded = upgradeEquipmentName(matched, affix);
    publicState.last_result = `升级成功：${upgraded}`;
    publicState.last_advice = "建议再进行一次实战检验，确认附魔是否稳定。";
    return {
      narration: `我检查了你的升级方案。恭喜你升级成功，${matched} 已提升为 ${upgraded}。`,
      resultTags: [score >= 78 ? "perfect" : "success"],
      rewardSummary: { equipment: upgraded },
      writeback: {
        parameterCardEquipmentReplace: [{ from: matched, to: upgraded }],
        flagsPatch: { equipment_upgrade_success: true },
        memoryAdd: [`装备升级成功：${upgraded}`],
      },
      memorySummary: `装备升级成功：${upgraded}`,
    };
  }
  session.result = "failed";
  session.finish_reason = "升级装备失败";
  publicState.last_result = "升级失败";
  publicState.last_advice = buildTextMiniGameAdvice("upgrade_equipment", plan);
  return {
    narration: `我检查了你的升级方案。升级失败；${publicState.last_advice}`,
    resultTags: ["failed"],
    writeback: { memoryAdd: [`一次失败的装备升级尝试：${matched}`] },
    memorySummary: `装备升级失败：${matched}`,
  };
}

function gameTypeChinese(gameType: string): string {
  return RULEBOOKS[gameType]?.displayName || gameType;
}

function buildParticipants(ctx: MiniGameControllerInput, count: number): JsonRecord[] {
  const roles = worldRoles(ctx.world)
    .filter((item) => item.roleType === "player" || item.roleType === "npc")
    .map((item) => ({
      role_id: item.id,
      role_type: item.roleType,
      role_name: item.name,
      alive: true,
    }));
  const player = roles.find((item) => item.role_type === "player") || {
    role_id: "player",
    role_type: "player",
    role_name: "用户",
    alive: true,
  };
  const npcs = roles.filter((item) => item.role_type !== "player");
  while (npcs.length < count - 1) {
    npcs.push({
      role_id: `npc_fill_${npcs.length + 1}`,
      role_type: "npc",
      role_name: `角色${npcs.length + 1}`,
      alive: true,
    });
  }
  return [player, ...npcs.slice(0, Math.max(0, count - 1))];
}

function detectGameTrigger(
  message: string,
  recentMessages: Array<Record<string, any>> = [],
  root: JsonRecord = {},
): { gameType: string; source: string } | null {
  const text = scalarText(message);
  const transcript = [
    ...recentMessages.slice(-8).map((item) => `${scalarText(item.role)}:${scalarText(item.content)}`.trim()).filter(Boolean),
    text,
  ].join("\n");
  if (!transcript.trim()) return null;
  for (const rulebook of Object.values(RULEBOOKS)) {
    if (rulebook.triggerTags.some((tag) => text.includes(tag))) {
      return { gameType: rulebook.gameType, source: "active" };
    }
  }
  // #退出 后只允许显式命令重新进入小游戏，禁止继续依赖最近消息被动重触发。
  if (Boolean(root.passiveReentrySuppressed)) {
    return null;
  }
  const currentConfirmsPassive = PASSIVE_CONFIRM_PATTERNS.some((pattern) => pattern.test(text));
  for (const rulebook of Object.values(RULEBOOKS)) {
    const mentionedInTranscript = rulebook.passivePatterns.some((pattern) => pattern.test(transcript));
    const directMentionInText = rulebook.passivePatterns.some((pattern) => pattern.test(text));
    if (directMentionInText || (mentionedInTranscript && currentConfirmsPassive)) {
      return { gameType: rulebook.gameType, source: "passive" };
    }
  }
  return null;
}

function isMiniGameCatalogCommand(input: string): boolean {
  const text = scalarText(input);
  if (!text) return false;
  return text.replace(/^#/, "").trim() === "小游戏";
}

function isForceQuitMiniGameCommand(input: string): boolean {
  const text = scalarText(input);
  if (!text.startsWith("#")) return false;
  const normalized = text.replace(/^#/, "").trim();
  return normalized === "退出" || normalized === "exit";
}

function availableMiniGameCatalog() {
  return Object.values(RULEBOOKS).map((rulebook, index) => ({
    index: index + 1,
    gameType: rulebook.gameType,
    displayName: rulebook.displayName,
    triggerTags: rulebook.triggerTags,
    aliases: [
      rulebook.displayName,
      rulebook.gameType,
      ...rulebook.triggerTags.map((tag) => tag.replace(/^#/, "")),
    ].map((item) => scalarText(item)).filter(Boolean),
    ruleSummary: scalarText(rulebook.ruleSummary),
  }));
}

function openMiniGameCatalog(state: JsonRecord): JsonRecord {
  const catalog = {
    open: true,
    updateTime: nowTs(),
    options: availableMiniGameCatalog().map((item) => ({
      index: item.index,
      gameType: item.gameType,
      displayName: item.displayName,
      commands: item.triggerTags,
      ruleSummary: item.ruleSummary,
    })),
  };
  state.miniGameCatalog = catalog;
  return catalog;
}

function clearMiniGameCatalog(state: JsonRecord) {
  delete state.miniGameCatalog;
}

function buildMiniGameCatalogNarration(prefix = ""): string {
  return [
    prefix,
    "（输入 #狼人杀 / #钓鱼 / #修炼 / #研发技能 / #炼药 / #挖矿 / #升级装备 / #战斗 进入小游戏。",
    "游戏中 #退出 可以强制退出小游戏）请输入 #+小游戏名称，如 #钓鱼。",
  ].filter(Boolean).join("\n");
}

function resolveMiniGameCatalogSelection(state: JsonRecord, input: string): {
  detected: { gameType: string; source: string } | null;
  attempted: boolean;
} {
  const catalog = asRecord(state.miniGameCatalog);
  const options = asArray<JsonRecord>(catalog.options);
  if (!options.length) return { detected: null, attempted: false };
  const text = scalarText(input);
  if (!text) return { detected: null, attempted: false };
  const normalized = text.replace(/^#/, "").trim();
  if (!normalized) return { detected: null, attempted: false };
  if (/^\d+$/.test(normalized)) {
    const index = Number(normalized);
    const matched = options.find((item) => Number(item.index || 0) === index);
    return {
      detected: matched ? { gameType: scalarText(matched.gameType), source: "catalog" } : null,
      attempted: true,
    };
  }
  const matched = options.find((item) => {
    const aliases = [
      scalarText(item.displayName),
      scalarText(item.gameType),
      ...asArray<string>(item.commands).map((command) => scalarText(command).replace(/^#/, "")),
    ].filter(Boolean);
    return aliases.some((alias) => normalized === alias || normalized.includes(alias));
  });
  const attempted = text.startsWith("#")
    || options.some((item) => {
      const name = scalarText(item.displayName);
      return Boolean(name) && (normalized.includes(name) || name.includes(normalized));
    });
  return {
    detected: matched ? { gameType: scalarText(matched.gameType), source: "catalog" } : null,
    attempted,
  };
}

function nextWerewolfPlayerPhase(session: JsonRecord): string {
  const hidden = asRecord(session.hidden_state);
  const roleMap = asRecord(hidden.role_map);
  const playerName = werewolfPlayerName(session);
  const playerRole = scalarText(roleMap[playerName] || roleMap.player || roleMap["用户"] || "村民");
  const dayCount = Number(asRecord(session.public_state).day_count || 1);
  if (dayCount <= 0) {
    asRecord(session.public_state).day_count = 1;
  }
  if (!isWerewolfPlayerAlive(session)) return "day_discussion";
  if (playerRole === "狼人") return "night_wolf";
  if (playerRole === "预言家") return "night_seer";
  if (playerRole === "女巫") return "night_witch";
  return "day_discussion";
}

/**
 * 统一读取狼人杀里的用户名称。
 *
 * 用途：
 * - 避免同一文件里反复手写“从 participants 里找用户”的样板代码；
 * - 让旁观、投票、夜晚结算都能稳定拿到同一个用户名。
 */
function werewolfPlayerName(session: JsonRecord): string {
  return scalarText(
    asArray<JsonRecord>(session.participants).find((item) => item.role_type === "player")?.role_name,
  ) || "用户";
}

/**
 * 读取用户在本局狼人杀中的身份。
 *
 * 用途：
 * - 把“用户现在应该进入哪个夜晚阶段”统一从 role_map 推导；
 * - 让旁观模式和起始阶段初始化不再各自重复解析身份。
 */
function werewolfPlayerRole(session: JsonRecord): string {
  const hidden = asRecord(session.hidden_state);
  const roleMap = asRecord(hidden.role_map);
  const playerName = werewolfPlayerName(session);
  return scalarText(roleMap[playerName] || roleMap.player || roleMap["用户"] || "村民") || "村民";
}

/**
 * 判断用户当前是否还存活。
 *
 * 用途：
 * - 用户出局后，不再允许继续发言和投票；
 * - 由此切换到“继续旁观”模式，直到本局结算结束。
 */
function isWerewolfPlayerAlive(session: JsonRecord): boolean {
  const publicState = asRecord(session.public_state);
  const aliveList = asArray<string>(publicState.alive_list);
  return aliveList.includes(werewolfPlayerName(session));
}

/**
 * 按当前 alive_list 同步 participants 里的 alive 标记。
 *
 * 用途：
 * - UI 面板和写回状态都依赖 participants.alive；
 * - 如果只改 alive_list 不回写 participants，旁观和存活头像会继续显示旧状态。
 */
function syncWerewolfParticipantsAlive(session: JsonRecord) {
  const publicState = asRecord(session.public_state);
  const aliveSet = new Set(asArray<string>(publicState.alive_list).filter(Boolean));
  session.participants = asArray<JsonRecord>(session.participants).map((item) => ({
    ...item,
    alive: aliveSet.has(scalarText(item.role_name)),
  }));
}

/**
 * 返回当前仍然存活、且属于指定身份的角色名列表。
 *
 * 用途：
 * - 狼人、女巫、预言家的 NPC 自动行动都需要先确认该身份是否仍然存活；
 * - 这里统一走 alive_list + role_map，避免遗漏“角色已经白天出局”的情况。
 */
function aliveWerewolfNamesByRole(session: JsonRecord, roleName: string): string[] {
  const publicState = asRecord(session.public_state);
  const roleMap = asRecord(asRecord(session.hidden_state).role_map);
  return asArray<string>(publicState.alive_list).filter((name) => scalarText(roleMap[name]) === roleName);
}

/**
 * 把数组按当前 session RNG 打乱。
 *
 * 用途：
 * - 狼人杀身份分配不能再按固定顺序落到用户/NPC 身上；
 * - 仍然复用现有种子队列，保证同局内随机过程可复现。
 */
function shuffleWerewolfItems<T>(session: JsonRecord, items: T[]): T[] {
  const result = items.slice();
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = takeRng(session, 0, index);
    const current = result[index];
    result[index] = result[swapIndex] as T;
    result[swapIndex] = current as T;
  }
  return result;
}

/**
 * 清空上一夜残留的待结算字段。
 *
 * 用途：
 * - 夜晚结算改成显式的 pending/save/poison 三段状态后，
 *   每轮开始前必须先把旧目标清掉，避免上一轮数据串到下一轮。
 */
function resetWerewolfNightState(session: JsonRecord) {
  const hidden = asRecord(session.hidden_state);
  hidden.wolf_target = "";
  hidden.saved_target = "";
  hidden.poison_target = "";
  hidden.seer_last_check = "";
  hidden.seer_last_role = "";
  session.hidden_state = hidden;
}

/**
 * 统一应用狼人杀里的出局结果，并同步 alive/participants 状态。
 *
 * 用途：
 * - 狼人击杀、女巫毒杀、白天票出都复用同一套名单更新逻辑；
 * - 避免同一个角色重复写入 eliminated_list，或 alive_list/participants 不一致。
 */
function eliminateWerewolfTargets(session: JsonRecord, targets: string[]) {
  const publicState = asRecord(session.public_state);
  const uniqueTargets = Array.from(new Set(targets.map((item) => scalarText(item)).filter(Boolean)));
  if (!uniqueTargets.length) return;
  publicState.alive_list = asArray<string>(publicState.alive_list).filter((name) => !uniqueTargets.includes(name));
  publicState.eliminated_list = Array.from(new Set([
    ...asArray<string>(publicState.eliminated_list),
    ...uniqueTargets,
  ]));
  session.public_state = publicState;
  syncWerewolfParticipantsAlive(session);
}

/**
 * 根据当前存活身份统一检查本局是否已经分出胜负。
 *
 * 用途：
 * - 白天票出、夜晚刀人、女巫毒杀后都要立即检查；
 * - 这样可以避免“其实已经满足胜负条件，但仍继续进入下一白天”的漏判。
 */
function evaluateWerewolfVictory(session: JsonRecord): string {
  const publicState = asRecord(session.public_state);
  const hidden = asRecord(session.hidden_state);
  const roleMap = asRecord(hidden.role_map);
  const aliveRoles = asArray<string>(publicState.alive_list).map((item) => scalarText(roleMap[item]));
  const wolfAlive = aliveRoles.filter((item) => item === "狼人").length;
  const othersAlive = aliveRoles.filter((item) => item && item !== "狼人").length;
  if (wolfAlive <= 0) {
    session.status = "finished";
    session.phase = "settling";
    session.result = "villager_win";
    session.finish_reason = "所有狼人已出局";
    return "村民阵营获胜，狼人全部出局。";
  }
  if (wolfAlive >= othersAlive) {
    session.status = "finished";
    session.phase = "settling";
    session.result = "wolf_win";
    session.finish_reason = "狼人数量已达到或超过其他存活人数";
    return "狼人阵营获胜，人数优势已形成。";
  }
  return "";
}

/**
 * 为狼人杀结算结果补齐统一的奖励和记忆写回。
 *
 * 用途：
 * - 之前只有白天投票结束才会发奖励，夜晚直接分胜负时会漏掉；
 * - 现在无论是白天还是夜晚结束，都会走同一套结算出口。
 */
function withWerewolfFinishReward(session: JsonRecord, result: MiniGameStepResult): MiniGameStepResult {
  if (scalarText(session.status) !== "finished") return result;
  const villagerWin = scalarText(session.result) === "villager_win";
  return {
    ...result,
    rewardSummary: result.rewardSummary && Object.keys(result.rewardSummary).length
      ? result.rewardSummary
      : { exp: villagerWin ? 30 : 10, relation: villagerWin ? 3 : 1 },
    writeback: result.writeback && Object.keys(result.writeback).length
      ? result.writeback
      : {
          relationshipDelta: { party: villagerWin ? 3 : 1 },
          playerAttributePatch: { exp: villagerWin ? 30 : 10 },
          memoryAdd: [`狼人杀结果：${session.result}`],
        },
    memorySummary: scalarText(result.memorySummary) || `狼人杀一局结束：${session.result || result.narration}`,
  };
}

/**
 * 为 NPC 狼人在本轮夜晚挑选目标。
 *
 * 用途：
 * - 当用户不是狼人时，夜晚击杀不能再只停留在 wolf_target 预填；
 * - 这里会确保 target 只从非狼人、且仍存活的目标里产生。
 */
function resolveWerewolfNpcWolfTarget(session: JsonRecord) {
  const hidden = asRecord(session.hidden_state);
  if (scalarText(hidden.wolf_target)) return;
  const publicState = asRecord(session.public_state);
  const roleMap = asRecord(hidden.role_map);
  const candidates = asArray<string>(publicState.alive_list).filter((name) => scalarText(roleMap[name]) !== "狼人");
  if (!candidates.length) return;
  hidden.wolf_target = candidates[takeRng(session, 0, candidates.length - 1)];
  session.hidden_state = hidden;
}

/**
 * 记录 NPC 预言家的查验结果，供局内状态和后续调试查看。
 *
 * 用途：
 * - 预言家即使不是用户，也应该完整走一遍夜晚行动；
 * - 这里只写 hidden_state，不直接公开给白天讨论文本。
 */
function resolveWerewolfNpcSeerCheck(session: JsonRecord) {
  if (werewolfPlayerRole(session) === "预言家" && isWerewolfPlayerAlive(session)) return;
  const seers = aliveWerewolfNamesByRole(session, "预言家");
  if (!seers.length) return;
  const seerName = seers[0] || "";
  const publicState = asRecord(session.public_state);
  const candidates = asArray<string>(publicState.alive_list).filter((name) => name && name !== seerName);
  if (!candidates.length) return;
  const hidden = asRecord(session.hidden_state);
  const roleMap = asRecord(hidden.role_map);
  const target = candidates[takeRng(session, 0, candidates.length - 1)];
  hidden.seer_last_check = target;
  hidden.seer_last_role = scalarText(roleMap[target]) || "村民";
  hidden.seer_checks = [
    ...asArray<any>(hidden.seer_checks),
    { round: Number(session.round || 1), seer: seerName, target, role: hidden.seer_last_role },
  ].slice(-8);
  session.hidden_state = hidden;
}

/**
 * 让 NPC 女巫在用户不是女巫时完成自动行动。
 *
 * 用途：
 * - 夜晚闭环里，NPC 女巫必须能决定“救 / 不救 / 毒 / 不毒”；
 * - 同时严格尊重解药和毒药的一次性次数限制。
 */
function resolveWerewolfNpcWitchTurn(session: JsonRecord) {
  if (werewolfPlayerRole(session) === "女巫" && isWerewolfPlayerAlive(session)) return;
  const witches = aliveWerewolfNamesByRole(session, "女巫");
  if (!witches.length) return;
  const hidden = asRecord(session.hidden_state);
  const publicState = asRecord(session.public_state);
  const target = scalarText(hidden.wolf_target);
  const roleMap = asRecord(hidden.role_map);
  if (target && !Boolean(hidden.witch_save_used) && scalarText(roleMap[target]) !== "狼人" && takeRng(session, 1, 100) <= 38) {
    hidden.saved_target = target;
    hidden.witch_save_used = true;
  }
  if (!Boolean(hidden.witch_poison_used) && takeRng(session, 1, 100) <= 22) {
    const candidates = asArray<string>(publicState.alive_list).filter((name) => name && name !== witches[0]);
    if (candidates.length) {
      hidden.poison_target = candidates[takeRng(session, 0, candidates.length - 1)];
      hidden.witch_poison_used = true;
    }
  }
  session.hidden_state = hidden;
}

/**
 * 统一结算一整夜的狼人击杀 / 女巫救人 / 女巫毒人。
 *
 * 用途：
 * - 之前白天和夜晚分别散落在多个 phase 里直接改名单，导致逻辑容易漏；
 * - 现在夜晚统一收口后，再一次性更新 last_night_result 和胜负状态。
 */
function settleWerewolfNight(session: JsonRecord): string {
  const hidden = asRecord(session.hidden_state);
  const publicState = asRecord(session.public_state);
  const nightLines: string[] = [];
  const eliminated: string[] = [];
  const target = scalarText(hidden.wolf_target);
  const savedTarget = scalarText(hidden.saved_target);
  const poisonTarget = scalarText(hidden.poison_target);
  if (target) {
    if (savedTarget && savedTarget === target) {
      nightLines.push(`昨夜 ${target} 遭到袭击，但被女巫救下。`);
    } else {
      eliminated.push(target);
      nightLines.push(`昨夜 ${target} 被狼人袭击出局。`);
    }
  }
  if (poisonTarget) {
    eliminated.push(poisonTarget);
    nightLines.push(`昨夜 ${poisonTarget} 被女巫毒杀。`);
  }
  eliminateWerewolfTargets(session, eliminated);
  const victoryNarration = evaluateWerewolfVictory(session);
  publicState.last_night_result = nightLines.length ? nightLines.join("") : "昨夜平安无事。";
  session.public_state = publicState;
  resetWerewolfNightState(session);
  if (victoryNarration) return `${publicState.last_night_result}${victoryNarration}`;
  session.phase = "day_discussion";
  session.status = "active";
  return `${publicState.last_night_result}${isWerewolfPlayerAlive(session) ? "白天讨论开始。" : "你已出局，当前进入旁观模式，白天讨论开始。"}`;
}

/**
 * 在用户行动前后，把本轮夜晚剩余的 NPC 行动补齐。
 *
 * 用途：
 * - 用户只负责自己身份对应的那一步；
 * - 其余身份如果由 NPC 持有，必须在这里自动走完，才能形成完整的夜晚闭环。
 */
function finishWerewolfNightAfterPlayerAction(session: JsonRecord): string {
  resolveWerewolfNpcSeerCheck(session);
  resolveWerewolfNpcWitchTurn(session);
  return settleWerewolfNight(session);
}

/**
 * 准备新一轮狼人杀阶段。
 *
 * 用途：
 * - 开局首夜和白天投票结束后都走这一套；
 * - 如果用户是普通村民或已经出局，则自动把整晚走完，直接进入白天/旁观。
 */
function prepareWerewolfRound(session: JsonRecord, opening = false): string {
  const publicState = asRecord(session.public_state);
  publicState.day_count = Math.max(1, Number(session.round || 1));
  session.public_state = publicState;
  resetWerewolfNightState(session);
  const playerRole = werewolfPlayerRole(session);
  const playerAlive = isWerewolfPlayerAlive(session);
  if (!playerAlive) {
    resolveWerewolfNpcWolfTarget(session);
    resolveWerewolfNpcSeerCheck(session);
    resolveWerewolfNpcWitchTurn(session);
    return settleWerewolfNight(session);
  }
  if (playerRole === "狼人") {
    session.phase = "night_wolf";
    session.status = "active";
    return opening ? "首夜降临，你的狼人行动开始了。请选择今晚要袭击的目标。" : `夜幕再次降临，进入第 ${Number(session.round || 1)} 轮狼人行动。`;
  }
  resolveWerewolfNpcWolfTarget(session);
  if (playerRole === "预言家") {
    session.phase = "night_seer";
    session.status = "active";
    return opening ? "首夜降临，你可以选择一名角色进行查验。" : `夜幕再次降临，进入第 ${Number(session.round || 1)} 轮查验阶段。`;
  }
  resolveWerewolfNpcSeerCheck(session);
  if (playerRole === "女巫") {
    session.phase = "night_witch";
    session.status = "active";
    return opening ? "首夜降临，女巫请决定是否救人或下毒。" : `夜幕再次降临，进入第 ${Number(session.round || 1)} 轮女巫阶段。`;
  }
  resolveWerewolfNpcWitchTurn(session);
  return settleWerewolfNight(session);
}

function werewolfOptions(session: JsonRecord): MiniGameActionOption[] {
  const phase = normalizePhase(session.phase, "day_discussion");
  const publicState = asRecord(session.public_state);
  const aliveList = asArray<string>(publicState.alive_list);
  const playerName = werewolfPlayerName(session);
  const playerAlive = aliveList.includes(playerName);
  const selectable = aliveList.filter((item) => item && item !== playerName);
  if (!playerAlive && scalarText(session.status) !== "finished") {
    return [
      {
        action_id: "spectate_continue",
        label: "继续旁观",
        desc: phase === "day_vote" ? "继续旁观本轮投票结算" : "继续旁观后续讨论与投票",
        aliases: ["旁观继续", "继续旁观", "继续", "看下去"],
      },
      { action_id: "view_record", label: "查看记录", desc: "查看昨夜结果与公开记录", aliases: ["查看状态", "状态", "查看局势"] },
    ];
  }
  if (phase === "night_wolf") {
    return [
      ...selectable.map((item) => ({
        action_id: `kill:${item}`,
        label: `击杀${item}`,
        desc: `夜间袭击 ${item}`,
        aliases: [`刀${item}`, `袭击${item}`, `杀${item}`],
      })),
      { action_id: "skip_kill", label: "空刀", desc: "今晚不击杀目标", aliases: ["跳过击杀", "不杀人", "今夜空刀"] },
      { action_id: "view_status", label: "查看局势", desc: "查看当前存活与公开记录", aliases: ["查看状态", "状态", "查看记录"] },
    ];
  }
  if (phase === "night_seer") {
    return [
      ...selectable.map((item) => ({
        action_id: `check:${item}`,
        label: `查验${item}`,
        desc: `查验 ${item} 的阵营`,
        aliases: [`验${item}`, `看${item}`, `查${item}`],
      })),
      { action_id: "skip_check", label: "跳过", desc: "放弃本轮查验", aliases: ["不查验", "跳过查验"] },
      { action_id: "view_status", label: "查看局势", desc: "查看当前公开记录", aliases: ["查看状态", "状态", "查看记录"] },
    ];
  }
  if (phase === "night_witch") {
    const lastNightTarget = scalarText(asRecord(session.hidden_state).wolf_target);
    const options: MiniGameActionOption[] = [];
    const hidden = asRecord(session.hidden_state);
    if (lastNightTarget && !Boolean(hidden.witch_save_used)) {
      options.push({
        action_id: `save:${lastNightTarget}`,
        label: `救${lastNightTarget}`,
        desc: `使用解药救下 ${lastNightTarget}`,
        aliases: [`解药${lastNightTarget}`, `救人${lastNightTarget}`],
      });
    }
    if (!Boolean(hidden.witch_poison_used)) {
      options.push(
        ...selectable.map((item) => ({
          action_id: `poison:${item}`,
          label: `毒${item}`,
          desc: `使用毒药淘汰 ${item}`,
          aliases: [`下毒${item}`, `毒杀${item}`],
        })),
      );
    }
    options.push(
      { action_id: "skip_witch", label: "双跳过", desc: "本轮不救人也不下毒", aliases: ["跳过女巫", "不救不毒", "跳过"] },
      { action_id: "view_status", label: "查看记录", desc: "查看已公开记录", aliases: ["查看状态", "状态", "查看局势"] },
    );
    return options;
  }
  if (phase === "day_vote") {
    return [
      ...selectable.map((item) => ({
        action_id: `vote:${item}`,
        label: `投票${item}`,
        desc: `白天投票淘汰 ${item}`,
        aliases: [`票${item}`, `投${item}`, `投给${item}`],
      })),
      { action_id: "abstain", label: "弃票", desc: "本轮放弃投票", aliases: ["不投票", "跳过投票"] },
      { action_id: "view_record", label: "查看记录", desc: "查看昨夜结果与投票历史", aliases: ["查看状态", "状态", "查看局势"] },
    ];
  }
  return [
    { action_id: "speak", label: "发言", desc: "参与白天讨论", aliases: ["说话", "讨论", "表态"] },
    { action_id: "begin_vote", label: "进入投票", desc: "结束讨论并进入投票", aliases: ["开始投票", "投票阶段", "结束讨论"] },
    { action_id: "view_record", label: "查看记录", desc: "查看公开死亡与投票记录", aliases: ["查看状态", "状态", "查看局势"] },
  ];
}

function ensureWerewolfNpcState(session: JsonRecord) {
  const hidden = asRecord(session.hidden_state);
  const publicState = asRecord(session.public_state);
  const aliveList = asArray<string>(publicState.alive_list);
  const playerName = scalarText(
    asArray<JsonRecord>(session.participants).find((item) => item.role_type === "player")?.role_name,
  ) || "用户";
  const suspicionMatrix = asRecord(hidden.npc_suspicion_matrix);
  const personality = asRecord(hidden.npc_personality_weight);
  aliveList
    .filter((name) => name && name !== playerName)
    .forEach((name) => {
      if (!personality[name]) {
        personality[name] = {
          logic: takeRng(session, 35, 80),
          aggressive: takeRng(session, 25, 75),
          trust_player: takeRng(session, -20, 20),
          lie_skill: takeRng(session, 10, 70),
        };
      }
      const npcMatrix = asRecord(suspicionMatrix[name]);
      aliveList
        .filter((target) => target && target !== name)
        .forEach((target) => {
          if (npcMatrix[target] === undefined) {
            npcMatrix[target] = takeRng(session, 15, 55);
          }
        });
      suspicionMatrix[name] = npcMatrix;
    });
  hidden.npc_suspicion_matrix = suspicionMatrix;
  hidden.npc_personality_weight = personality;
  session.hidden_state = hidden;
}

function buildWerewolfDiscussionNarration(session: JsonRecord, includePlayerLead: boolean): string {
  ensureWerewolfNpcState(session);
  const hidden = asRecord(session.hidden_state);
  const publicState = asRecord(session.public_state);
  const suspicionMatrix = asRecord(hidden.npc_suspicion_matrix);
  const personality = asRecord(hidden.npc_personality_weight);
  const playerName = scalarText(
    asArray<JsonRecord>(session.participants).find((item) => item.role_type === "player")?.role_name,
  ) || "用户";
  const aliveList = asArray<string>(publicState.alive_list);
  const npcNames = aliveList.filter((name) => name && name !== playerName);
  const snippets = npcNames.map((name) => {
    const matrix = asRecord(suspicionMatrix[name]);
    const weights = asRecord(personality[name]);
    const suspect = aliveList
      .filter((target) => target && target !== name)
      .sort((a, b) => Number(matrix[b] || 0) - Number(matrix[a] || 0))[0] || playerName;
    if (Number(weights.aggressive || 0) >= 65) {
      return `${name}率先拍桌，直指${suspect}昨夜反应最不对劲。`;
    }
    if (Number(weights.logic || 0) >= 65) {
      return `${name}冷静梳理线索后，认为${suspect}的行动逻辑最可疑。`;
    }
    return `${name}反复权衡后，还是把怀疑落在了${suspect}身上。`;
  });
  publicState.last_discussion_summary = snippets.join("");
  session.public_state = publicState;
  return [
    includePlayerLead ? "你先说出了自己的判断，火堆旁的气氛一下被点燃。" : "众人迅速围着昨夜的结果展开了讨论。",
    ...snippets,
    "一轮发言结束，现场准备进入投票。",
  ].filter(Boolean).join("");
}

function chooseWerewolfNpcVoteTarget(session: JsonRecord, voterName: string, candidates: string[], playerVote: string): string {
  ensureWerewolfNpcState(session);
  const hidden = asRecord(session.hidden_state);
  const suspicionMatrix = asRecord(hidden.npc_suspicion_matrix);
  const personality = asRecord(hidden.npc_personality_weight);
  const matrix = asRecord(suspicionMatrix[voterName]);
  const weights = asRecord(personality[voterName]);
  return candidates
    .map((candidate) => {
      let score = Number(matrix[candidate] || 0);
      if (candidate === playerVote) {
        score += Math.max(0, Number(weights.trust_player || 0));
      }
      score += takeRng(session, 0, 12);
      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score)[0]?.candidate || candidates[0] || "";
}

function resolveWerewolfVoteRound(session: JsonRecord, playerVote: string): { votedOut: string; narration: string } {
  ensureWerewolfNpcState(session);
  const publicState = asRecord(session.public_state);
  const playerName = werewolfPlayerName(session);
  const aliveList = asArray<string>(publicState.alive_list).filter(Boolean);
  const playerAlive = aliveList.includes(playerName);
  const voteCount = new Map<string, number>();
  const voteDetails: string[] = [];
  const pushVote = (voter: string, target: string) => {
    if (!target) return;
    voteCount.set(target, Number(voteCount.get(target) || 0) + 1);
    voteDetails.push(`${voter} 投给了 ${target}`);
  };
  if (playerAlive && playerVote && playerVote !== "弃票") {
    pushVote(playerName, playerVote);
  } else if (playerAlive) {
    voteDetails.push(`${playerName} 选择弃票`);
  }
  aliveList
    .filter((name) => name !== playerName)
    .forEach((name) => {
      const target = chooseWerewolfNpcVoteTarget(
        session,
        name,
        aliveList.filter((item) => item !== name),
        playerVote,
      );
      pushVote(name, target);
    });
  const sorted = Array.from(voteCount.entries()).sort((a, b) => b[1] - a[1]);
  const topCount = Number(sorted[0]?.[1] || 0);
  const tied = sorted.filter((item) => item[1] === topCount).map((item) => item[0]);
  if (tied.length <= 1) {
    return {
      votedOut: tied[0] || "",
      narration: `众人完成投票：${voteDetails.join("，")}。`,
    };
  }
  const revoteCount = new Map<string, number>();
  const revoteDetails: string[] = [];
  const pushRevote = (voter: string, target: string) => {
    if (!target) return;
    revoteCount.set(target, Number(revoteCount.get(target) || 0) + 1);
    revoteDetails.push(`${voter} 在复投时投给了 ${target}`);
  };
  if (playerAlive && playerVote && tied.includes(playerVote)) {
    pushRevote(playerName, playerVote);
  }
  aliveList
    .filter((name) => name !== playerName)
    .forEach((name) => {
      const target = chooseWerewolfNpcVoteTarget(session, name, tied.filter((item) => item !== name), playerVote);
      pushRevote(name, target);
    });
  const revoteSorted = Array.from(revoteCount.entries()).sort((a, b) => b[1] - a[1]);
  const revoteTop = Number(revoteSorted[0]?.[1] || 0);
  const revoteTied = revoteSorted.filter((item) => item[1] === revoteTop).map((item) => item[0]);
  return {
    votedOut: revoteTied.length === 1 ? revoteTied[0] || "" : "",
    narration: `众人完成首轮投票：${voteDetails.join("，")}。由于 ${tied.join("、")} 平票，随后进行复投：${revoteDetails.join("，")}。`,
  };
}

function finalizeWerewolfVote(session: JsonRecord, votedOut: string): string {
  const publicState = asRecord(session.public_state);
  const noElimination = !scalarText(votedOut) || scalarText(votedOut) === "无人出局";
  const aliveList = noElimination
    ? asArray<string>(publicState.alive_list)
    : asArray<string>(publicState.alive_list).filter((item) => item !== votedOut);
  const eliminatedList = asArray<string>(publicState.eliminated_list);
  if (!noElimination) {
    eliminatedList.push(votedOut);
  }
  publicState.alive_list = aliveList;
  publicState.eliminated_list = eliminatedList;
  syncWerewolfParticipantsAlive(session);
  const history = asArray<any>(publicState.public_vote_history);
  history.push({ round: Number(session.round || 1), votedOut: scalarText(votedOut) || "无人出局" });
  publicState.public_vote_history = history.slice(-10);
  publicState.last_night_result = noElimination ? "本轮无人出局" : `白天投票淘汰：${votedOut}`;
  const victoryNarration = evaluateWerewolfVictory(session);
  if (victoryNarration) return victoryNarration;
  session.round = Number(session.round || 1) + 1;
  const nextRoundNarration = prepareWerewolfRound(session);
  return noElimination
    ? `两轮投票都未能形成结果，本轮无人出局。${nextRoundNarration}`
    : `${votedOut} 被票出局。${nextRoundNarration}`;
}

function werewolfStep(session: JsonRecord, actionId: string): MiniGameStepResult {
  const phase = normalizePhase(session.phase, "day_discussion");
  const publicState = asRecord(session.public_state);
  const hidden = asRecord(session.hidden_state);
  const roleMap = asRecord(hidden.role_map);
  const playerName = werewolfPlayerName(session);
  const playerAlive = isWerewolfPlayerAlive(session);
  if (!Array.isArray(publicState.alive_list) || !publicState.alive_list.length) {
    publicState.alive_list = asArray<JsonRecord>(session.participants).filter((item) => item.alive !== false).map((item) => item.role_name);
  }
  if (actionId === "view_record" || actionId === "view_status") {
    const history = asArray<any>(publicState.public_vote_history)
      .map((item) => `第${item.round}轮：${item.votedOut}`)
      .join("；");
    return {
      narration: `当前存活：${asArray<string>(publicState.alive_list).join("、")}。昨夜结果：${scalarText(publicState.last_night_result) || "暂无"}。公开记录：${history || "暂无"}。`,
      resultTags: ["view_record"],
    };
  }
  if (!playerAlive) {
    if (actionId === "spectate_continue") {
      if (phase === "day_vote") {
        const voteRound = resolveWerewolfVoteRound(session, "");
        const narration = `${voteRound.narration}${finalizeWerewolfVote(session, voteRound.votedOut)}`;
        return withWerewolfFinishReward(session, { narration, resultTags: ["spectator_continue", "vote"] });
      }
      if (phase === "day_discussion") {
        session.phase = "day_vote";
        return {
          narration: `${buildWerewolfDiscussionNarration(session, false)}你已出局，本轮将以旁观身份观看投票结算。`,
          resultTags: ["spectator_continue", "discussion"],
        };
      }
      return withWerewolfFinishReward(session, {
        narration: finishWerewolfNightAfterPlayerAction(session),
        resultTags: ["spectator_continue"],
      });
    }
    return { narration: "你已经出局，本局只能继续旁观或查看记录。", resultTags: ["spectator_blocked"] };
  }
  if (phase === "night_wolf") {
    if (actionId.startsWith("kill:")) {
      const target = actionId.slice(5);
      hidden.wolf_target = target;
      return withWerewolfFinishReward(session, {
        narration: finishWerewolfNightAfterPlayerAction(session),
        resultTags: ["night_kill"],
      });
    }
    if (actionId === "skip_kill") {
      hidden.wolf_target = "";
      return withWerewolfFinishReward(session, {
        narration: finishWerewolfNightAfterPlayerAction(session),
        resultTags: ["skip_kill"],
      });
    }
  }
  if (phase === "night_seer") {
    if (actionId.startsWith("check:")) {
      const target = actionId.slice(6);
      const targetRole = scalarText(roleMap[target]) || "村民";
      hidden.seer_last_check = target;
      hidden.seer_last_role = targetRole;
      return withWerewolfFinishReward(session, {
        narration: `你查验了 ${target}，对方阵营为：${targetRole}。${finishWerewolfNightAfterPlayerAction(session)}`,
        resultTags: ["seer_check"],
      });
    }
    if (actionId === "skip_check") {
      return withWerewolfFinishReward(session, {
        narration: finishWerewolfNightAfterPlayerAction(session),
        resultTags: ["skip_check"],
      });
    }
  }
  if (phase === "night_witch") {
    if (actionId.startsWith("save:")) {
      const target = actionId.slice(5);
      if (Boolean(hidden.witch_save_used)) {
        return { narration: "你的解药已经在之前用掉了，本局不能再次救人。", resultTags: ["invalid"] };
      }
      hidden.saved_target = target;
      hidden.witch_save_used = true;
      return withWerewolfFinishReward(session, {
        narration: finishWerewolfNightAfterPlayerAction(session),
        resultTags: ["witch_save"],
      });
    }
    if (actionId.startsWith("poison:")) {
      const target = actionId.slice(7);
      if (Boolean(hidden.witch_poison_used)) {
        return { narration: "你的毒药已经在之前用掉了，本局不能再次下毒。", resultTags: ["invalid"] };
      }
      hidden.poison_target = target;
      hidden.witch_poison_used = true;
      return withWerewolfFinishReward(session, {
        narration: finishWerewolfNightAfterPlayerAction(session),
        resultTags: ["witch_poison"],
      });
    }
    if (actionId === "skip_witch") {
      return withWerewolfFinishReward(session, {
        narration: finishWerewolfNightAfterPlayerAction(session),
        resultTags: ["skip_witch"],
      });
    }
  }
  if (phase === "day_discussion") {
    if (actionId === "view_record") {
      const history = asArray<any>(publicState.public_vote_history)
        .map((item) => `第${item.round}轮：${item.votedOut}`)
        .join("；");
      return {
        narration: `当前存活：${asArray<string>(publicState.alive_list).join("、")}。昨夜结果：${scalarText(publicState.last_night_result) || "暂无"}。公开记录：${history || "暂无"}。`,
        resultTags: ["view_record"],
      };
    }
    if (actionId === "begin_vote") {
      session.phase = "day_vote";
      return {
        narration: `${buildWerewolfDiscussionNarration(session, false)}请选择你要票出的对象。`,
        resultTags: ["begin_vote"],
      };
    }
    if (actionId === "speak") {
      session.phase = "day_vote";
      return {
        narration: `${buildWerewolfDiscussionNarration(session, true)}请选择你要票出的对象。`,
        resultTags: ["speak"],
      };
    }
  }
  if (phase === "day_vote") {
    if (actionId.startsWith("vote:")) {
      const voteTarget = actionId.slice(5);
      const voteRound = resolveWerewolfVoteRound(session, voteTarget);
      const narration = `${voteRound.narration}${finalizeWerewolfVote(session, voteRound.votedOut)}`;
      return withWerewolfFinishReward(session, { narration, resultTags: ["vote"] });
    }
    if (actionId === "abstain") {
      const voteRound = resolveWerewolfVoteRound(session, "弃票");
      const narration = `${voteRound.narration}${finalizeWerewolfVote(session, voteRound.votedOut)}`;
      return withWerewolfFinishReward(session, { narration, resultTags: ["abstain"] });
    }
    if (actionId === "view_record") {
      const history = asArray<any>(publicState.public_vote_history)
        .map((item) => `第${item.round}轮：${item.votedOut}`)
        .join("；");
      return { narration: `当前公开投票记录：${history || "暂无"}。存活：${asArray<string>(publicState.alive_list).join("、")}。`, resultTags: ["view_record"] };
    }
  }
  return { narration: "当前阶段无法执行该动作，请从合法动作里选择。", resultTags: ["invalid"] };
}

function fishingOptions(session: JsonRecord): MiniGameActionOption[] {
  const phase = normalizePhase(session.phase, "prepare");
  if (phase === "prepare") {
    return [
      { action_id: "cast", label: "抛竿", desc: "开始本次垂钓", aliases: ["开始钓鱼", "甩竿", "下钩"] },
      { action_id: "finish", label: "#退出结束", desc: "输入 #退出 结束当前钓鱼", aliases: ["收摊", "结束钓鱼", "离开水边"] },
    ];
  }
  if (phase === "waiting") {
    return [
      { action_id: "wait_more", label: "收杆看结果", desc: "立即查看这一竿有没有收获", aliases: ["收杆", "起竿", "看结果"] },
      { action_id: "finish", label: "#退出结束", desc: "输入 #退出 结束当前钓鱼", aliases: ["结束钓鱼", "离开水边"] },
    ];
  }
  return [
    { action_id: "cast", label: "继续钓鱼", desc: "继续下一轮垂钓", aliases: ["继续", "再来一竿", "继续抛竿", "抛竿", "甩竿", "下钩"] },
    { action_id: "finish", label: "#退出结束", desc: "输入 #退出 结束当前钓鱼", aliases: ["结束钓鱼", "离开水边"] },
  ];
}

function resolveFishingReward(session: JsonRecord): { kind: string; name: string; rarity: string; narrationType: string } {
  const fishPool = [
    { name: "鲫鱼", rarity: "普通" },
    { name: "青鱼", rarity: "普通" },
    { name: "银鲤", rarity: "普通" },
    { name: "灵纹鱼", rarity: "稀有" },
    { name: "古鳞鱼", rarity: "稀有" },
  ];
  const treasurePool = [
    { name: "旧铜箱", rarity: "稀有" },
    { name: "水灵石", rarity: "稀有" },
    { name: "漂流补给箱", rarity: "普通" },
    { name: "古旧金币", rarity: "普通" },
  ];
  const rewardTypeRoll = takeRng(session, 1, 100);
  if (rewardTypeRoll > 82) {
    const treasure = treasurePool[takeRng(session, 0, treasurePool.length - 1)];
    return {
      kind: "treasure",
      name: treasure.name,
      rarity: treasure.rarity,
      narrationType: "宝物",
    };
  }
  const fish = fishPool[takeRng(session, 0, fishPool.length - 1)];
  return {
    kind: "fish",
    name: fish.name,
    rarity: fish.rarity,
    narrationType: "鱼获",
  };
}

function resolveFishingRound(session: JsonRecord, siteName: string): MiniGameStepResult {
  const publicState = asRecord(session.public_state);
  const hidden = asRecord(session.hidden_state);
  const roll = Number(hidden.encounter_roll || takeRng(session, 1, 100));
  session.phase = "result";
  if (roll <= 38) {
    publicState.current_status = "空竿";
    publicState.last_result = "这次空竿了";
    publicState.last_reward = "";
    hidden.target_fish_name = "";
    hidden.fish_rarity = "";
    hidden.reward_kind = "";
    return {
      narration: `你把鱼钩抛进 ${siteName}，片刻后水面恢复了平静，这一竿没有鱼也没有宝物。你可以继续钓鱼，或输入 #退出 结束当前钓鱼。`,
      resultTags: ["cast", "empty_hook"],
      memorySummary: "钓鱼空竿一次",
    };
  }
  const reward = resolveFishingReward(session);
  hidden.target_fish_name = reward.name;
  hidden.fish_rarity = reward.rarity;
  hidden.reward_kind = reward.kind;
  publicState.current_status = reward.narrationType === "宝物" ? "钓到宝物" : "钓到鱼获";
  publicState.last_reward = reward.name;
  publicState.last_result = reward.narrationType === "宝物" ? `钓到宝物：${reward.name}` : `钓到：${reward.name}`;
  return {
    narration: reward.narrationType === "宝物"
      ? `你把鱼钩抛进 ${siteName}，水面猛地一晃，你顺势收杆，意外捞到了 ${reward.name}，已放入物品。你可以继续钓鱼，或输入 #退出 结束当前钓鱼。`
      : `你把鱼钩抛进 ${siteName}，鱼漂一沉，你顺势收杆，钓到了 ${reward.name}，已放入物品。你可以继续钓鱼，或输入 #退出 结束当前钓鱼。`,
    resultTags: ["cast", "success", reward.kind],
    rewardSummary: { loot: reward.name },
    writeback: {
      inventoryAdd: [{ kind: reward.kind, name: reward.name, rarity: reward.rarity }],
      memoryAdd: [`钓鱼收获：${reward.name}`],
    },
    memorySummary: `钓鱼成功，收获 ${reward.name}`,
  };
}

function fishingStep(session: JsonRecord, actionId: string): MiniGameStepResult {
  const publicState = asRecord(session.public_state);
  const hidden = asRecord(session.hidden_state);
  const currentPhase = normalizePhase(session.phase, "prepare");
  const siteName = scalarText(publicState.site_name) || "水面";
  if (actionId === "finish") {
    session.status = "finished";
    session.phase = "settling";
    session.result = scalarText(publicState.last_reward) ? "completed" : "cancelled";
    session.finish_reason = "用户结束钓鱼";
    publicState.current_status = "已结束";
    return {
      narration: scalarText(publicState.last_reward)
        ? `你收起鱼竿，带着 ${scalarText(publicState.last_reward)} 结束了这次钓鱼。`
        : "你收起鱼竿，结束了这次钓鱼。",
      resultTags: ["finish"],
      rewardSummary: scalarText(publicState.last_reward) ? { loot: scalarText(publicState.last_reward) } : {},
      memorySummary: scalarText(publicState.last_reward)
        ? `钓鱼结束，最近收获 ${scalarText(publicState.last_reward)}`
        : "钓鱼提前结束",
    };
  }
  if (currentPhase === "prepare" || currentPhase === "result") {
    if (actionId === "cast") {
      if (currentPhase === "result") {
        session.round = Number(session.round || 1) + 1;
      }
      publicState.last_result = "";
      publicState.last_reward = "";
      hidden.encounter_roll = takeRng(session, 1, 100);
      return resolveFishingRound(session, siteName);
    }
  }
  if (currentPhase === "waiting") {
    if (actionId === "wait_more" || actionId === "cast") {
      return resolveFishingRound(session, siteName);
    }
  }
  return { narration: "当前阶段无法执行该动作。", resultTags: ["invalid"] };
}

function cultivationOptions(): MiniGameActionOption[] {
  return [
    { action_id: "breathe", label: "吐纳", desc: "积攒灵气", aliases: ["吸收灵气", "运转灵气"] },
    { action_id: "visualize", label: "观想", desc: "提升感悟", aliases: ["冥想", "参悟"] },
    { action_id: "steady", label: "稳息", desc: "稳定心神", aliases: ["稳固气息", "稳住心神"] },
    { action_id: "take_pill", label: "服丹", desc: "短时提高灵气", aliases: ["吃丹药", "服用丹药"] },
    { action_id: "breakthrough", label: "冲关", desc: "尝试突破当前瓶颈", aliases: ["突破", "尝试突破"] },
    { action_id: "finish", label: "收功", desc: "安全结束本轮修炼", aliases: ["结束修炼", "停下修炼"] },
  ];
}

function cultivationStep(session: JsonRecord, actionId: string): MiniGameStepResult {
  const publicState = asRecord(session.public_state);
  const hidden = asRecord(session.hidden_state);
  const add = (field: string, delta: number, min = 0, max = 100) => {
    publicState[field] = clamp(Number(publicState[field] || 0) + delta, min, max);
  };
  const addHidden = (field: string, delta: number, min = 0, max = 100) => {
    hidden[field] = clamp(Number(hidden[field] || 0) + delta, min, max);
  };
  if (actionId === "breathe") {
    add("qi", 18); add("fatigue", 8); addHidden("deviation_risk", 4); session.round = Number(session.round || 1) + 1;
    return { narration: `你沉心吐纳，体内灵气逐渐汇聚。当前灵气 ${publicState.qi}。`, resultTags: ["breathe"] };
  }
  if (actionId === "visualize") {
    add("insight", 15); add("fatigue", 6); addHidden("deviation_risk", 3); session.round = Number(session.round || 1) + 1;
    return { narration: `你凝神观想，灵识澄澈了几分。感悟提升至 ${publicState.insight}。`, resultTags: ["visualize"] };
  }
  if (actionId === "steady") {
    add("stability", 18); addHidden("deviation_risk", -12); session.round = Number(session.round || 1) + 1;
    return { narration: `你收束气息，心境重新稳定。稳定度上升到 ${publicState.stability}。`, resultTags: ["steady"] };
  }
  if (actionId === "take_pill") {
    if (hidden.pill_used) {
      return { narration: "本局你已经服过一次丹药了，药力无法再次叠加。", resultTags: ["invalid"] };
    }
    hidden.pill_used = true;
    add("qi", 25); add("stability", -5); addHidden("deviation_risk", 8); session.round = Number(session.round || 1) + 1;
    return { narration: `丹药化开，你的灵气暴涨，但也让经脉承受了更多压力。`, resultTags: ["take_pill"] };
  }
  if (actionId === "breakthrough") {
    const qi = Number(publicState.qi || 0);
    const insight = Number(publicState.insight || 0);
    const stability = Number(publicState.stability || 0);
    const fatigue = Number(publicState.fatigue || 0);
    if (fatigue > 70) addHidden("deviation_risk", 15);
    if (qi >= 60 && insight >= 40 && stability >= 50) {
      const gain = takeRng(session, 25, 45);
      add("breakthrough_progress", gain);
      addHidden("deviation_risk", stability < 60 ? 12 : 6);
      session.round = Number(session.round || 1) + 1;
      if (Number(publicState.breakthrough_progress || 0) >= 100 && Number(hidden.deviation_risk || 0) < 60) {
        session.status = "finished";
        session.phase = "settling";
        session.result = "success";
        session.finish_reason = "突破成功";
        return {
          narration: "你抓住了突破契机，经脉顺畅贯通，这次修炼突破成功，并在破境时获得了一层新的感悟。",
          resultTags: ["success", "breakthrough"],
          rewardSummary: { exp: 60, realmProgress: 1, insight: 20 },
          writeback: {
            playerAttributePatch: { cultivationExp: 60, realmProgress: 1, cultivationInsight: 20 },
            flagsPatch: { cultivation_breakthrough: true, cultivation_insight_awake: true },
            memoryAdd: ["修炼突破成功", "修炼时获得新感悟"],
          },
          memorySummary: "本次修炼突破成功",
        };
      }
      return { narration: `你强行冲关，突破进度推进到了 ${publicState.breakthrough_progress}。`, resultTags: ["breakthrough"] };
    }
    addHidden("deviation_risk", 20);
    add("stability", -10);
    add("fatigue", 10);
    session.round = Number(session.round || 1) + 1;
    if (Number(hidden.deviation_risk || 0) >= 100) {
      session.status = "finished";
      session.phase = "settling";
      session.result = "failed";
      session.finish_reason = "走火入魔";
      return {
        narration: "你在条件不足时强行冲关，气息紊乱，修炼以失败告终。",
        resultTags: ["failed", "deviation"],
        writeback: { playerAttributePatch: { fatigue: 25 }, flagsPatch: { cultivation_debuff: true }, memoryAdd: ["修炼冲关失败"] },
        memorySummary: "修炼冲关失败",
      };
    }
    return { narration: "这次冲关准备仍然不足，你感到经脉微微刺痛，只能暂时压住反噬。", resultTags: ["risky_breakthrough"] };
  }
  if (actionId === "finish") {
    const expGain = Math.max(10, Math.floor(Number(publicState.breakthrough_progress || 0) / 4));
    const insightGain = Math.max(6, Math.floor(Number(publicState.insight || 0) / 5));
    session.status = "finished";
    session.phase = "settling";
    session.result = "partial";
    session.finish_reason = "安全收功";
    return {
      narration: "你选择稳妥收功，把本轮修炼成果沉淀下来，也顺势理清了几分修行感悟。",
      resultTags: ["finish"],
      rewardSummary: { exp: expGain, insight: insightGain },
      writeback: {
        playerAttributePatch: { cultivationExp: expGain, cultivationInsight: insightGain },
        memoryAdd: ["一次稳妥收功的修炼", "修炼收功后整理出新的感悟"],
      },
      memorySummary: "本次修炼平稳收功",
    };
  }
  return { narration: "当前无法执行该动作。", resultTags: ["invalid"] };
}

function researchOptions(session?: JsonRecord): MiniGameActionOption[] {
  const phase = normalizePhase(session?.phase, "await_input");
  if (["await_input", "result", "settling"].includes(phase)) {
    return [];
  }
  return [];
}

function researchStep(session: JsonRecord, actionId: string): MiniGameStepResult {
  const publicState = asRecord(session.public_state);
  const hidden = asRecord(session.hidden_state);
  const complexity = clamp(Number(publicState.complexity || 2), 1, 5);
  const add = (field: string, delta: number, min = 0, max = 120) => {
    publicState[field] = clamp(Number(publicState[field] || 0) + delta, min, max);
  };
  if (actionId === "theory") add("theory_progress", 20);
  else if (actionId === "sample") add("theory_progress", 15);
  else if (actionId === "prototype") { add("prototype_progress", 25); add("stability_score", -10); }
  else if (actionId === "debug") add("stability_score", 20);
  else if (actionId === "ask_partner") { add("theory_progress", 10); hidden.inspiration_roll = clamp(Number(hidden.inspiration_roll || 0) + 15, 0, 100); }
  else if (actionId === "force_iter") { add("prototype_progress", 35); add("stability_score", -20); }
  else if (actionId === "finalize") {
    const theoryNeed = 60 + complexity * 10;
    const prototypeNeed = 50 + complexity * 10;
    if (Number(publicState.theory_progress || 0) >= theoryNeed && Number(publicState.prototype_progress || 0) >= prototypeNeed && Number(publicState.stability_score || 0) >= 40) {
      session.status = "finished";
      session.phase = "settling";
      session.result = "success";
      session.finish_reason = "研发成功";
      const skillName = scalarText(publicState.target_skill_name) || "新技能蓝图";
      return {
        narration: `你整理完最后一版蓝图，${skillName} 研发成功。`,
        resultTags: ["success"],
        rewardSummary: { unlock: skillName },
        writeback: { flagsPatch: { [`skill_unlock_${skillName}`]: true }, memoryAdd: [`研发完成：${skillName}`] },
        memorySummary: `研发技能成功：${skillName}`,
      };
    }
    return { narration: "当前理论、原型或稳定性还不达标，暂时无法定稿。", resultTags: ["invalid"] };
  } else return { narration: "当前无法执行该动作。", resultTags: ["invalid"] };

  publicState.turn_left = clamp(Number(publicState.turn_left || 6) - 1, 0, 10);
  session.round = Number(session.round || 1) + 1;
  if (Number(publicState.turn_left || 0) <= 0) {
    session.status = "finished";
    session.phase = "settling";
    session.result = Number(publicState.prototype_progress || 0) >= 40 ? "partial" : "failed";
    session.finish_reason = "研发轮次耗尽";
    return {
      narration: session.result === "partial" ? "研发时限到了，你保留下了一份可继续完善的技能碎片。" : "研发时限耗尽，只留下了一些失败笔记。",
      resultTags: [session.result],
      writeback: session.result === "partial" ? { memoryAdd: ["保留了一份技能碎片"], flagsPatch: { skill_fragment_saved: true } } : { memoryAdd: ["一次失败的技能研发尝试"] },
      memorySummary: session.result === "partial" ? "研发半成功，得到技能碎片" : "研发失败，仅留下笔记",
    };
  }
  return { narration: `研发继续推进。理论 ${publicState.theory_progress}，原型 ${publicState.prototype_progress}，稳定 ${publicState.stability_score}。`, resultTags: [actionId] };
}

function alchemyOptions(session?: JsonRecord): MiniGameActionOption[] {
  const phase = normalizePhase(session?.phase, "await_input");
  if (["await_input", "result", "settling"].includes(phase)) {
    return [];
  }
  return [];
}

function alchemyStep(session: JsonRecord, actionId: string): MiniGameStepResult {
  const publicState = asRecord(session.public_state);
  const hidden = asRecord(session.hidden_state);
  const add = (field: string, delta: number, min = 0, max = 120) => {
    publicState[field] = clamp(Number(publicState[field] || 0) + delta, min, max);
  };
  if (actionId === "heat_up") add("heat", 15);
  else if (actionId === "cool_down") add("heat", -15);
  else if (actionId === "add_herb") {
    const orderOk = takeRng(session, 1, 100) >= 35;
    if (orderOk) add("fusion", 20); else add("toxicity", 15);
  }
  else if (actionId === "stir") { add("fusion", 10); add("stability", 5); }
  else if (actionId === "steady_furnace") { add("stability", 15); add("heat", -5); }
  else if (actionId === "purify") { add("purity", 15); add("fusion", -5); }
  else if (actionId === "condense") {
    const quality = Number(publicState.purity || 0) * 0.35 + Number(publicState.fusion || 0) * 0.35 + Number(publicState.stability || 0) * 0.2 - Number(publicState.toxicity || 0) * 0.2 + 10;
    session.status = "finished";
    session.phase = "settling";
    session.result = quality >= 70 ? "success" : quality >= 45 ? "partial" : "failed";
    session.finish_reason = session.result === "success" ? "成功成丹" : session.result === "partial" ? "勉强成丹" : "炼制失败";
    const pillName = quality >= 85 ? "上品丹药" : quality >= 70 ? "成品丹药" : quality >= 45 ? "残次丹药" : "报废药液";
    return {
      narration: session.result === "failed" ? "你尝试凝丹，但药液失稳，最终炼制失败。" : `炉火渐稳，最终凝出了一枚 ${pillName}。`,
      resultTags: [session.result],
      rewardSummary: session.result === "failed" ? {} : { item: pillName },
      writeback: session.result === "failed" ? { memoryAdd: ["一次失败的炼药尝试"] } : { inventoryAdd: [{ kind: "pill", name: pillName }], memoryAdd: [`炼制获得：${pillName}`] },
      memorySummary: session.result === "failed" ? "炼药失败" : `炼药完成：${pillName}`,
    };
  } else return { narration: "当前无法执行该动作。", resultTags: ["invalid"] };

  if (Number(publicState.heat || 0) - Number(hidden.target_heat || 65) > 20) {
    add("stability", -10);
    add("toxicity", 10);
  }
  if (Number(publicState.toxicity || 0) >= 100 || Number(publicState.stability || 0) <= 0) {
    session.status = "finished";
    session.phase = "settling";
    session.result = "failed";
    session.finish_reason = Number(publicState.toxicity || 0) >= 100 ? "炸炉失败" : "药液报废";
    return { narration: "炉火与药性彻底失控，本轮炼药失败。", resultTags: ["failed"], memorySummary: "炼药失败" };
  }
  session.round = Number(session.round || 1) + 1;
  return { narration: `火候 ${publicState.heat}，纯度 ${publicState.purity}，融合 ${publicState.fusion}，毒性 ${publicState.toxicity}。`, resultTags: [actionId] };
}

function miningOptions(): MiniGameActionOption[] {
  return [
    { action_id: "survey", label: "勘探", desc: "寻找矿脉弱点", aliases: ["探矿", "查看矿脉"] },
    { action_id: "excavate", label: "开采", desc: "稳定开采矿脉", aliases: ["挖矿", "挖掘"] },
    { action_id: "careful_excavate", label: "精挖", desc: "提高稀有掉率", aliases: ["精细开采", "慢慢挖"] },
    { action_id: "support", label: "支护", desc: "降低坍塌风险", aliases: ["加固", "支撑矿道"] },
    { action_id: "clear", label: "清障", desc: "减轻负重或整理矿道", aliases: ["清理障碍", "整理矿道"] },
    { action_id: "rest", label: "休息", desc: "恢复体力", aliases: ["休整", "恢复体力"] },
    { action_id: "leave", label: "撤离", desc: "带着收益离开", aliases: ["离开矿洞", "带矿离开"] },
  ];
}

function miningStep(session: JsonRecord, actionId: string): MiniGameStepResult {
  const publicState = asRecord(session.public_state);
  const hidden = asRecord(session.hidden_state);
  const add = (field: string, delta: number, min = 0, max = 160) => {
    publicState[field] = clamp(Number(publicState[field] || 0) + delta, min, max);
  };
  if (actionId === "survey") {
    hidden.weakness_point = true;
    session.round = Number(session.round || 1) + 1;
    return { narration: "你仔细勘探矿脉，找到了更容易下镐的薄弱点。", resultTags: ["survey"] };
  }
  if (actionId === "excavate") {
    const bonus = hidden.weakness_point ? 12 : 0;
    add("vein_hp", -(20 + bonus), 0, 100);
    add("player_stamina", -15, 0, 100);
    add("danger", 10, 0, 100);
    add("bag_load", 12, 0, 100);
    hidden.weakness_point = false;
  } else if (actionId === "careful_excavate") {
    add("vein_hp", -12, 0, 100);
    add("player_stamina", -20, 0, 100);
    add("danger", 12, 0, 100);
    add("bag_load", 10, 0, 100);
    hidden.rare_drop_roll = clamp(Number(hidden.rare_drop_roll || 0) + 15, 0, 100);
  } else if (actionId === "support") {
    add("stability", 20, 0, 100);
    add("danger", -15, 0, 100);
  } else if (actionId === "clear") {
    add("bag_load", -10, 0, 100);
    add("danger", -5, 0, 100);
  } else if (actionId === "rest") {
    add("player_stamina", 20, 0, 100);
  } else if (actionId === "leave") {
    session.status = "finished";
    session.phase = "settling";
    session.result = Number(publicState.bag_load || 0) > 0 ? "success" : "partial";
    session.finish_reason = "主动撤离";
    return {
      narration: "你选择及时撤离，把当前矿石安全带离了矿区。",
      resultTags: ["leave"],
      rewardSummary: { ore: Math.max(1, Math.floor(Number(publicState.bag_load || 0) / 10)) },
      writeback: { inventoryAdd: [{ kind: "ore", amount: Math.max(1, Math.floor(Number(publicState.bag_load || 0) / 10)) }], memoryAdd: ["矿区采掘后安全撤离"] },
      memorySummary: "挖矿后主动撤离",
    };
  } else return { narration: "当前无法执行该动作。", resultTags: ["invalid"] };

  if (Number(publicState.danger || 0) >= 70 && (Number(publicState.stability || 0) <= 20 || takeRng(session, 1, 100) <= Number(publicState.danger || 0) - 50)) {
    session.status = "finished";
    session.phase = "settling";
    session.result = "failed";
    session.finish_reason = "矿脉坍塌";
    return { narration: "矿道突然坍塌，你只能狼狈撤出，损失了不少采集成果。", resultTags: ["failed", "collapse"], writeback: { playerAttributePatch: { staminaLoss: 20 }, memoryAdd: ["一次危险的矿脉坍塌"] }, memorySummary: "挖矿时遭遇坍塌" };
  }
  if (Number(publicState.vein_hp || 0) <= 0) {
    session.status = "finished";
    session.phase = "settling";
    session.result = "success";
    session.finish_reason = "矿脉采尽";
    const oreAmount = Math.max(2, Math.floor(Number(publicState.bag_load || 0) / 8));
    return { narration: "你成功采空了这条矿脉，带走了一批矿石。", resultTags: ["success"], rewardSummary: { ore: oreAmount }, writeback: { inventoryAdd: [{ kind: "ore", amount: oreAmount }], memoryAdd: ["采尽了一条矿脉"] }, memorySummary: "挖矿成功，采尽矿脉" };
  }
  session.round = Number(session.round || 1) + 1;
  return { narration: `矿脉剩余 ${publicState.vein_hp}，危险度 ${publicState.danger}，负重 ${publicState.bag_load}。`, resultTags: [actionId] };
}

function forgeOptions(session?: JsonRecord): MiniGameActionOption[] {
  const phase = normalizePhase(session?.phase, "await_input");
  if (["await_input", "result", "settling"].includes(phase)) {
    return [];
  }
  return [];
}

function forgeStep(session: JsonRecord, actionId: string): MiniGameStepResult {
  const publicState = asRecord(session.public_state);
  const hidden = asRecord(session.hidden_state);
  const add = (field: string, delta: number, min = 0, max = 160) => {
    publicState[field] = clamp(Number(publicState[field] || 0) + delta, min, max);
  };
  if (actionId === "heat") { add("forge_heat", 20); add("forge_progress", 5); }
  else if (actionId === "hammer") {
    const heat = Number(publicState.forge_heat || 0);
    const minHeat = Number(hidden.optimal_heat_min || 60);
    const maxHeat = Number(hidden.optimal_heat_max || 80);
    if (heat >= minHeat && heat <= maxHeat) add("forge_progress", 20); else add("stability", -10);
  }
  else if (actionId === "align") { add("stability", 15); add("forge_heat", -10); }
  else if (actionId === "quench") {
    const good = takeRng(session, 1, 100) >= 35;
    if (good) add("spirit_sync", takeRng(session, 10, 25)); else add("stability", -15);
  }
  else if (actionId === "infuse") { add("spirit_sync", 20); hidden.failure_risk = clamp(Number(hidden.failure_risk || 0) + 10, 0, 100); }
  else if (actionId === "finalize") {
    const progress = Number(publicState.forge_progress || 0);
    const stability = Number(publicState.stability || 0);
    const spirit = Number(publicState.spirit_sync || 0);
    session.status = "finished";
    session.phase = "settling";
    if (progress >= 80 && stability >= 50 && spirit >= 40) {
      session.result = spirit >= 70 && stability >= 70 ? "perfect" : "success";
      session.finish_reason = "强化成功";
      const levelGain = 1;
      return {
        narration: session.result === "perfect" ? "锻造火候与灵性完美契合，装备强化得极其顺利。" : "你完成了最后的定型，装备强化成功。",
        resultTags: [session.result],
        rewardSummary: { levelUp: levelGain },
        writeback: { flagsPatch: { equipment_upgrade_success: true }, memoryAdd: ["装备强化成功"] },
        memorySummary: "装备强化成功",
      };
    }
    session.result = progress >= 60 ? "partial" : "failed";
    session.finish_reason = session.result === "partial" ? "半成功" : "锻造失败";
    return {
      narration: session.result === "partial" ? "你勉强保住了装备本体，但本次强化没有真正提升等级。" : "锻造过程失控，材料和耐久都遭到了损耗。",
      resultTags: [session.result],
      writeback: { memoryAdd: [session.result === "partial" ? "装备强化半成功" : "一次失败的装备强化"] },
      memorySummary: session.result === "partial" ? "装备强化半成功" : "装备强化失败",
    };
  } else return { narration: "当前无法执行该动作。", resultTags: ["invalid"] };

  session.round = Number(session.round || 1) + 1;
  return { narration: `热度 ${publicState.forge_heat}，进度 ${publicState.forge_progress}，稳定 ${publicState.stability}，灵性同步 ${publicState.spirit_sync}。`, resultTags: [actionId] };
}

function buildSimplePublicState(fields: Record<string, any>): JsonRecord {
  return { ...fields };
}

const RULEBOOKS: Record<string, MiniGameRulebook> = {
  werewolf: {
    gameType: "werewolf",
    displayName: "狼人杀",
    version: "1.0",
    goal: "完成一局 5 人标准狼人杀",
    phaseOrder: ["setup", "night_wolf", "night_seer", "night_witch", "day_announce", "day_discussion", "day_vote", "settling"],
    triggerTags: ["#狼人杀"],
    passivePatterns: [/狼人杀/, /来一局.*狼人杀/, /玩.*狼人杀/, /提议.*狼人杀/],
    ruleSummary: "5人标准局。夜间按身份行动，白天讨论投票。所有狼人出局则村民胜；狼人数量大于等于其他存活人数则狼人胜。",
    setup: (ctx, sessionId, entrySource) => {
      const participants = buildParticipants(ctx, 5);
      const names = participants.map((item) => String(item.role_name || "")).filter(Boolean);
      const rngSeed = `${ctx.world?.id || 0}:${ctx.chapter?.id || 0}:werewolf:${sessionId}`;
      const session: JsonRecord = {
        session_id: sessionId,
        game_type: "werewolf",
        rulebook_version: "1.0",
        status: "active",
        phase: "setup",
        round: 1,
        sub_turn: 0,
        entry_source: entrySource,
        chapter_id: Number(ctx.chapter?.id || 0) || null,
        scene_id: scalarText(ctx.chapter?.title) || "current_scene",
        participants,
        public_state: buildSimplePublicState({
          day_count: 1,
          alive_list: participants.map((item) => item.role_name),
          eliminated_list: [],
          public_vote_history: [],
          discussion_order: participants.map((item) => item.role_name),
          last_night_result: "首夜尚未开始。",
        }),
        hidden_state: {
          role_map: {},
          wolf_target: "",
          saved_target: "",
          poison_target: "",
          seer_last_check: "",
          seer_last_role: "",
          seer_checks: [],
          witch_save_used: false,
          witch_poison_used: false,
        },
        resource_state: {},
        rng_state: {
          seed: rngSeed,
          cursor: 0,
          queue: buildRngQueue(rngSeed),
        },
        action_log_ids: [],
        result: "ongoing",
        finish_reason: "",
        reward_preview: {},
        writeback_whitelist: ["relationship_state", "event_pool.done", "memory_state.mid_term"],
        can_suspend: true,
        can_quit: true,
        resume_token: `resume_${sessionId}`,
      };
      const roleMap: Record<string, string> = {};
      const shuffledRoles = shuffleWerewolfItems(session, ["狼人", "预言家", "女巫", "村民", "村民"]);
      names.forEach((name, index) => {
        roleMap[name] = shuffledRoles[index] || "村民";
      });
      asRecord(session.hidden_state).role_map = roleMap;
      session.phase = nextWerewolfPlayerPhase(session);
      const openingNarration = prepareWerewolfRound(session, true);
      asRecord(session.public_state).opening_narration = openingNarration;
      return session;
    },
    options: werewolfOptions,
    applyAction: werewolfStep,
  },
  fishing: {
    gameType: "fishing",
    displayName: "钓鱼",
    version: "1.0",
    goal: "抛竿后立即结算，看看能否钓到鱼或宝物",
    phaseOrder: ["prepare", "waiting", "result", "settling"],
    triggerTags: ["#钓鱼"],
    passivePatterns: [/钓鱼/, /去钓鱼/, /开始钓鱼/, /抛竿/],
    ruleSummary: "直接输入“抛竿”“收杆”“继续钓鱼”等动作。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。",
    setup: (ctx, sessionId, entrySource) => ({
      session_id: sessionId,
      game_type: "fishing",
      rulebook_version: "1.0",
      status: "active",
      phase: "prepare",
      round: 1,
      sub_turn: 0,
      entry_source: entrySource,
      chapter_id: Number(ctx.chapter?.id || 0) || null,
      scene_id: scalarText(ctx.chapter?.title) || "river_bank",
      participants: buildParticipants(ctx, 1),
      public_state: buildSimplePublicState({
        site_name: "当前水域",
        current_status: "准备抛竿",
        last_result: "",
        last_reward: "",
      }),
      hidden_state: { target_fish_name: "", encounter_roll: 0, fish_rarity: "", reward_kind: "" },
      resource_state: {},
      rng_state: { seed: `${ctx.world?.id || 0}:${ctx.chapter?.id || 0}:fishing:${sessionId}`, cursor: 0, queue: buildRngQueue(`${ctx.world?.id || 0}:${ctx.chapter?.id || 0}:fishing:${sessionId}`) },
      action_log_ids: [], result: "ongoing", finish_reason: "", reward_preview: {}, writeback_whitelist: ["player_state.inventory", "memory_state.mid_term"], can_suspend: true, can_quit: true, resume_token: `resume_${sessionId}`,
    }),
    options: fishingOptions,
    applyAction: fishingStep,
  },
  cultivation: {
    gameType: "cultivation",
    displayName: "修炼",
    version: "1.0",
    goal: "通过灵气、感悟与稳定度管理完成突破或平稳收功",
    phaseOrder: ["gather_qi", "circulate", "breakthrough", "settling"],
    triggerTags: ["#修炼"],
    passivePatterns: [/修炼/, /开始修炼/, /闭关/, /冲关/],
    ruleSummary: "围绕灵气、感悟、稳定与疲劳做管理。贸然冲关会提高偏差风险。",
    setup: (ctx, sessionId, entrySource) => ({
      session_id: sessionId,
      game_type: "cultivation",
      rulebook_version: "1.0",
      status: "active",
      phase: "gather_qi",
      round: 1,
      sub_turn: 0,
      entry_source: entrySource,
      chapter_id: Number(ctx.chapter?.id || 0) || null,
      scene_id: scalarText(ctx.chapter?.title) || "quiet_room",
      participants: buildParticipants(ctx, 1),
      public_state: buildSimplePublicState({ qi: 20, insight: 15, stability: 60, fatigue: 0, breakthrough_progress: 0, current_method: "基础吐纳法" }),
      hidden_state: { deviation_risk: 10, bonus_event_roll: 0, environment_bonus: 5, bottleneck_level: 1, pill_used: false },
      resource_state: {},
      rng_state: { seed: `${ctx.world?.id || 0}:${ctx.chapter?.id || 0}:cultivation:${sessionId}`, cursor: 0, queue: buildRngQueue(`${ctx.world?.id || 0}:${ctx.chapter?.id || 0}:cultivation:${sessionId}`) },
      action_log_ids: [], result: "ongoing", finish_reason: "", reward_preview: {}, writeback_whitelist: ["player_state.resources", "player_state.flags", "memory_state.mid_term"], can_suspend: true, can_quit: true, resume_token: `resume_${sessionId}`,
    }),
    options: cultivationOptions,
    applyAction: cultivationStep,
  },
  research_skill: {
    gameType: "research_skill",
    displayName: "研发技能",
    version: "1.0",
    goal: "输入技能研发方案，由系统判断是否成功并写回角色参数",
    phaseOrder: ["await_input", "result", "settling"],
    triggerTags: ["#研发技能"],
    passivePatterns: [/研发技能/, /研发.*技能/, /自创招式/, /开发技能/],
    ruleSummary: "旁白先交代研发目标，随后直接输入技能名称、原理与测试思路。系统会判断成功、半成功或失败，并给出建议。",
    setup: (ctx, sessionId, entrySource) => ({
      session_id: sessionId,
      game_type: "research_skill",
      rulebook_version: "1.0",
      status: "active",
      phase: "await_input",
      round: 1,
      sub_turn: 0,
      entry_source: entrySource,
      chapter_id: Number(ctx.chapter?.id || 0) || null,
      scene_id: scalarText(ctx.chapter?.title) || "workbench",
      participants: buildParticipants(ctx, 1),
      public_state: buildSimplePublicState({
        target_skill_name: "新技能蓝图",
        complexity: 2,
        last_plan: "",
        last_result: "",
        last_advice: "",
      }),
      hidden_state: { inspiration_roll: 0, failure_threshold: 60, synergy_bonus: 0, mentor_bonus: 0 },
      resource_state: {},
      rng_state: { seed: `${ctx.world?.id || 0}:${ctx.chapter?.id || 0}:research_skill:${sessionId}`, cursor: 0, queue: buildRngQueue(`${ctx.world?.id || 0}:${ctx.chapter?.id || 0}:research_skill:${sessionId}`) },
      action_log_ids: [], result: "ongoing", finish_reason: "", reward_preview: {}, writeback_whitelist: ["player_state.parameter_card", "player_state.flags", "memory_state.mid_term"], can_suspend: true, can_quit: true, resume_token: `resume_${sessionId}`,
    }),
    options: researchOptions,
    applyAction: researchStep,
  },
  alchemy: {
    gameType: "alchemy",
    displayName: "炼药",
    version: "1.0",
    goal: "输入炼药方案，由系统判断是否成丹并写回物品与参数卡",
    phaseOrder: ["await_input", "result", "settling"],
    triggerTags: ["#炼药"],
    passivePatterns: [/炼药/, /炼丹/, /开炉炼药/],
    ruleSummary: "旁白先说明当前丹炉局势，随后直接输入药方、药材搭配和火候思路。系统会评估成丹结果并给出建议。",
    setup: (ctx, sessionId, entrySource) => ({
      session_id: sessionId,
      game_type: "alchemy",
      rulebook_version: "1.0",
      status: "active",
      phase: "await_input",
      round: 1,
      sub_turn: 0,
      entry_source: entrySource,
      chapter_id: Number(ctx.chapter?.id || 0) || null,
      scene_id: scalarText(ctx.chapter?.title) || "alchemy_furnace",
      participants: buildParticipants(ctx, 1),
      public_state: buildSimplePublicState({
        recipe_name: "基础丹方",
        last_formula: "",
        last_result: "",
        last_advice: "",
      }),
      hidden_state: { recipe_name: "基础丹方", target_heat: 65 },
      resource_state: {},
      rng_state: { seed: `${ctx.world?.id || 0}:${ctx.chapter?.id || 0}:alchemy:${sessionId}`, cursor: 0, queue: buildRngQueue(`${ctx.world?.id || 0}:${ctx.chapter?.id || 0}:alchemy:${sessionId}`) },
      action_log_ids: [], result: "ongoing", finish_reason: "", reward_preview: {}, writeback_whitelist: ["player_state.inventory", "player_state.parameter_card", "memory_state.mid_term"], can_suspend: true, can_quit: true, resume_token: `resume_${sessionId}`,
    }),
    options: alchemyOptions,
    applyAction: alchemyStep,
  },
  mining: {
    gameType: "mining",
    displayName: "挖矿",
    version: "1.0",
    goal: "在风险可控的前提下尽量带走矿石与稀有产物",
    phaseOrder: ["survey", "excavate", "risk_check", "haul", "settling"],
    triggerTags: ["#挖矿"],
    passivePatterns: [/挖矿/, /采矿/, /下矿/],
    ruleSummary: "危险度越高、稳定度越低，坍塌风险越大。优先允许用户带伤撤离，不直接破坏主线。",
    setup: (ctx, sessionId, entrySource) => ({
      session_id: sessionId,
      game_type: "mining",
      rulebook_version: "1.0",
      status: "active",
      phase: "survey",
      round: 1,
      sub_turn: 0,
      entry_source: entrySource,
      chapter_id: Number(ctx.chapter?.id || 0) || null,
      scene_id: scalarText(ctx.chapter?.title) || "mine",
      participants: buildParticipants(ctx, 1),
      public_state: buildSimplePublicState({ mine_name: "当前矿脉", vein_hp: 100, stability: 60, danger: 10, player_stamina: 100, tool_durability: 100, bag_load: 0 }),
      hidden_state: { ore_table: ["铁矿", "铜矿", "灵石"], rare_drop_roll: 0, weakness_point: false, collapse_threshold: 75 },
      resource_state: {},
      rng_state: { seed: `${ctx.world?.id || 0}:${ctx.chapter?.id || 0}:mining:${sessionId}`, cursor: 0, queue: buildRngQueue(`${ctx.world?.id || 0}:${ctx.chapter?.id || 0}:mining:${sessionId}`) },
      action_log_ids: [], result: "ongoing", finish_reason: "", reward_preview: {}, writeback_whitelist: ["player_state.inventory", "player_state.resources", "memory_state.mid_term"], can_suspend: true, can_quit: true, resume_token: `resume_${sessionId}`,
    }),
    options: miningOptions,
    applyAction: miningStep,
  },
  battle: {
    gameType: "battle",
    displayName: "战斗",
    version: "1.0",
    goal: "击败当前全部敌人，并结算战利品、金钱与升级收益",
    phaseOrder: ["encounter", "settling"],
    triggerTags: ["#战斗", "#对战"],
    passivePatterns: [/对战/, /战斗/, /迎战/, /开打/, /交手/],
    ruleSummary: "输入 #战斗 目标 进入战斗。战斗开始后只通过文字输入动作推进，不再使用按钮式面板操作。",
    setup: (ctx, sessionId, entrySource) => {
      const targetNames = parseBattleTargetNames(ctx.playerMessage);
      const enemyList = targetNames.map((name, index) => buildBattleEnemy(ctx, name, index));
      const userCard = asRecord(asRecord(ctx.state.player).parameterCardJson);
      const userLevel = Math.max(1, Number(userCard.level ?? 1));
      const userHp = Math.max(1, Number(userCard.hp ?? 100));
      const userMp = Math.max(0, Number(userCard.mp ?? 0));
      const session: JsonRecord = {
        session_id: sessionId,
        game_type: "battle",
        rulebook_version: "1.0",
        status: "active",
        phase: "encounter",
        round: 1,
        sub_turn: 0,
        entry_source: entrySource,
        chapter_id: Number(ctx.chapter?.id || 0) || null,
        scene_id: scalarText(ctx.chapter?.title) || "battlefield",
        participants: buildParticipants(ctx, 1),
        public_state: buildSimplePublicState({
          battle_title: enemyList.length > 1 ? `战斗 ${enemyList.length} 名敌人` : `战斗 ${scalarText(enemyList[0]?.name) || "敌人"}`,
          enemy_list: enemyList,
          alive_enemy_count: enemyList.length,
          current_target_id: scalarText(enemyList[0]?.enemy_id),
          current_target_name: scalarText(enemyList[0]?.name),
          user_name: scalarText(asRecord(ctx.state.player).name) || "用户",
          user_level: userLevel,
          user_hp: userHp,
          user_max_hp: userHp,
          user_mp: userMp,
          user_max_mp: userMp,
          last_result: enemyList.length > 1
            ? `你已经被 ${enemyList.map((enemy) => scalarText(enemy.name)).filter(Boolean).join("、")} 包围，准备开始战斗。`
            : `你已经锁定敌人 ${scalarText(enemyList[0]?.name) || "敌人"}，准备开始战斗。`,
        }),
        hidden_state: {},
        resource_state: {},
        rng_state: {
          seed: `${ctx.world?.id || 0}:${ctx.chapter?.id || 0}:battle:${sessionId}`,
          cursor: 0,
          queue: buildRngQueue(`${ctx.world?.id || 0}:${ctx.chapter?.id || 0}:battle:${sessionId}`),
        },
        action_log_ids: [],
        result: "ongoing",
        finish_reason: "",
        reward_preview: {},
        writeback_whitelist: ["player_state.parameter_card", "player_state.inventory", "memory_state.mid_term"],
        can_suspend: true,
        can_quit: true,
        resume_token: `resume_${sessionId}`,
      };
      syncBattlePublicState(session);
      return session;
    },
    // 战斗统一改成聊天框动作输入，规则本不再生成按钮式操作列表。
    options: () => [],
    applyAction: battleStep,
  },
  upgrade_equipment: {
    gameType: "upgrade_equipment",
    displayName: "升级装备",
    version: "1.0",
    goal: "输入装备强化方案，由系统判断升级结果并写回装备参数",
    phaseOrder: ["await_input", "result", "settling"],
    triggerTags: ["#升级装备"],
    passivePatterns: [/升级装备/, /强化装备/, /锻造装备/],
    ruleSummary: "旁白先说明锻造场景，随后直接输入要强化的装备和方案。系统会给出成功、失败或改进建议，并写回装备结果。",
    setup: (ctx, sessionId, entrySource) => ({
      session_id: sessionId,
      game_type: "upgrade_equipment",
      rulebook_version: "1.0",
      status: "active",
      phase: "await_input",
      round: 1,
      sub_turn: 0,
      entry_source: entrySource,
      chapter_id: Number(ctx.chapter?.id || 0) || null,
      scene_id: scalarText(ctx.chapter?.title) || "forge",
      participants: buildParticipants(ctx, 1),
      public_state: buildSimplePublicState({
        equip_id: "equip_current",
        equip_name: "当前装备",
        equip_type: "武器",
        current_level: 0,
        last_plan: "",
        last_result: "",
        last_advice: "",
      }),
      hidden_state: { optimal_heat_min: 60, optimal_heat_max: 80, failure_risk: 20, bonus_affix_roll: 0 },
      resource_state: {},
      rng_state: { seed: `${ctx.world?.id || 0}:${ctx.chapter?.id || 0}:upgrade_equipment:${sessionId}`, cursor: 0, queue: buildRngQueue(`${ctx.world?.id || 0}:${ctx.chapter?.id || 0}:upgrade_equipment:${sessionId}`) },
      action_log_ids: [], result: "ongoing", finish_reason: "", reward_preview: {}, writeback_whitelist: ["player_state.parameter_card", "player_state.flags", "memory_state.mid_term"], can_suspend: true, can_quit: true, resume_token: `resume_${sessionId}`,
    }),
    options: forgeOptions,
    applyAction: forgeStep,
  },
};

function applyMiniGameWriteback(state: JsonRecord, writeback: JsonRecord) {
  if (!writeback || typeof writeback !== "object") return;
  const session = asRecord(asRecord(state.miniGame).session);
  const allowList = new Set(
    asArray<string>(session.writeback_whitelist)
      .map((item) => scalarText(item))
      .filter(Boolean),
  );
  const allow = (path: string) => allowList.size <= 0 || allowList.has(path);
  const inventoryAdd = asArray<JsonRecord>(writeback.inventoryAdd);
  if (inventoryAdd.length && allow("player_state.inventory")) {
    const currentInventory = asArray<any>(state.inventory);
    state.inventory = [...currentInventory, ...inventoryAdd];
  }
  const parameterCardSkillAdd = uniqueTexts(asArray<string>(writeback.parameterCardSkillAdd));
  if (parameterCardSkillAdd.length && allow("player_state.parameter_card")) {
    appendParameterCardList(state, "skills", parameterCardSkillAdd);
  }
  const parameterCardItemAdd = uniqueTexts(asArray<string>(writeback.parameterCardItemAdd));
  if (parameterCardItemAdd.length && allow("player_state.parameter_card")) {
    appendParameterCardList(state, "items", parameterCardItemAdd);
  }
  const parameterCardEquipmentReplace = asArray<JsonRecord>(writeback.parameterCardEquipmentReplace);
  if (parameterCardEquipmentReplace.length && allow("player_state.parameter_card")) {
    parameterCardEquipmentReplace.forEach((item) => {
      const fromName = scalarText(item.from);
      const toName = scalarText(item.to);
      if (fromName && toName) {
        replaceParameterCardEquipment(state, fromName, toName);
      }
    });
  }
  const playerParameterPatch = asRecord(writeback.playerParameterPatch);
  if (Object.keys(playerParameterPatch).length && allow("player_state.parameter_card")) {
    const player = asRecord(state.player);
    const card = createPlayerParameterCard(state);
    Object.entries(playerParameterPatch).forEach(([key, value]) => {
      const current = Number(card[key] ?? 0);
      const next = typeof value === "number" && ["money", "level"].includes(key)
        ? current + Number(value)
        : value;
      card[key] = next;
    });
    player.parameterCardJson = card;
    state.player = player;
  }
  const playerAttributePatch = asRecord(writeback.playerAttributePatch);
  if (Object.keys(playerAttributePatch).length && allow("player_state.resources")) {
    const player = asRecord(state.player);
    const attrs = asRecord(player.attributes);
    Object.entries(playerAttributePatch).forEach(([key, value]) => {
      const current = Number(attrs[key] || 0);
      const next = typeof value === "number" ? current + Number(value) : value;
      attrs[key] = next;
    });
    player.attributes = attrs;
    state.player = player;
  }
  const flagsPatch = asRecord(writeback.flagsPatch);
  if (Object.keys(flagsPatch).length && allow("player_state.flags")) {
    state.flags = { ...asRecord(state.flags), ...flagsPatch };
  }
  const relationshipDelta = asRecord(writeback.relationshipDelta);
  if (Object.keys(relationshipDelta).length && allow("relationship_state")) {
    const vars = asRecord(state.vars);
    const relationshipState = asRecord(vars.relationshipState);
    Object.entries(relationshipDelta).forEach(([key, value]) => {
      relationshipState[key] = Number(relationshipState[key] || 0) + Number(value || 0);
    });
    vars.relationshipState = relationshipState;
    state.vars = vars;
  }
  const eventDoneAdd = asArray<string>(writeback.eventDoneAdd);
  if (eventDoneAdd.length && allow("event_pool.done")) {
    const vars = asRecord(state.vars);
    const current = new Set(asArray<string>(vars.eventPoolDone));
    eventDoneAdd.forEach((item) => current.add(item));
    vars.eventPoolDone = Array.from(current);
    state.vars = vars;
  }
  const eventFailedAdd = asArray<string>(writeback.eventFailedAdd);
  if (eventFailedAdd.length && allow("event_pool.failed")) {
    const vars = asRecord(state.vars);
    const current = new Set(asArray<string>(vars.eventPoolFailed));
    eventFailedAdd.forEach((item) => current.add(item));
    vars.eventPoolFailed = Array.from(current);
    state.vars = vars;
  }
  const sideQuestProgressPatch = asRecord(writeback.sideQuestProgressPatch);
  if (Object.keys(sideQuestProgressPatch).length && allow("progress.side_quests")) {
    const vars = asRecord(state.vars);
    vars.sideQuestProgress = { ...asRecord(vars.sideQuestProgress), ...sideQuestProgressPatch };
    state.vars = vars;
  }
  const memoryAdd = asArray<string>(writeback.memoryAdd);
  if (memoryAdd.length && allow("memory_state.mid_term")) {
    const vars = asRecord(state.vars);
    const current = asArray<string>(vars.memoryMidTerm);
    vars.memoryMidTerm = [...current, ...memoryAdd].slice(-30);
    state.vars = vars;
  }
}

function refreshRuntimeUi(root: JsonRecord, narration: string, rulebook: MiniGameRulebook) {
  const session = asRecord(root.session);
  const ui = asRecord(root.ui);
  // 小游戏统一走聊天框交互，面板只负责展示状态，不再承担操作入口。
  const acceptsTextInput = !["finished", "aborted"].includes(scalarText(session.status));
  const options: MiniGameActionOption[] = [];
  session.player_options = options;
  ui.narration = narration;
  ui.player_options = options;
  ui.status_text = `第 ${Number(session.round || 1)} 轮 · ${scalarText(session.phase) || "进行中"}`;
  ui.phase_label = buildMiniGamePhaseLabel(session, rulebook);
  ui.rule_summary = rulebook.ruleSummary;
  ui.state_items = buildMiniGameUiStateItems(session, rulebook);
  ui.accepts_text_input = acceptsTextInput;
  ui.input_hint = acceptsTextInput ? buildMiniGameInputHint(rulebook) : "";
  root.session = session;
  root.ui = ui;
}

function buildStartNarration(rulebook: MiniGameRulebook, session: JsonRecord): string {
  const publicState = asRecord(session.public_state);
  if (rulebook.gameType === "werewolf") {
    const player = asArray<JsonRecord>(session.participants).find((item) => item.role_type === "player");
    const roleMap = asRecord(asRecord(session.hidden_state).role_map);
    const playerRole = scalarText(roleMap[player?.role_name || "用户"]) || "村民";
    const openingNarration = scalarText(publicState.opening_narration);
    return `小游戏已开始：${rulebook.displayName}。你的身份是 ${playerRole}。当前阶段：${scalarText(session.phase)}。${openingNarration}请直接输入“发言”“进入投票”“投票某人”“查验某人”“救某人”等动作。`;
  }
  if (rulebook.gameType === "fishing") {
    return `你来到 ${scalarText(publicState.site_name) || "水边"}，准备开始钓鱼。现在可以直接输入“抛竿”“收杆”或“继续钓鱼”。`;
  }
  if (rulebook.gameType === "research_skill") {
    return "研发技能开始了。直接输入技能名称、研发思路和测试方案，我会立即帮你判断能否成型。";
  }
  if (rulebook.gameType === "alchemy") {
    return "炼药开始了。直接输入药方、药材搭配和火候思路，我会立刻检查这次能否成丹。";
  }
  if (rulebook.gameType === "upgrade_equipment") {
    return "升级装备开始了。直接输入你要强化的装备和方案，我会立即检查这次强化是否成功。";
  }
  if (rulebook.gameType === "battle") {
    const publicState = asRecord(session.public_state);
    const aliveEnemies = aliveBattleEnemies(session);
    const enemyNames = aliveEnemies.map((enemy) => scalarText(enemy.name)).filter(Boolean).join("、") || "敌人";
    const leadTarget = aliveEnemies[0] || null;
    const leadTargetName = scalarText(leadTarget?.name) || enemyNames;
    const leadTargetLevel = Math.max(1, Number(leadTarget?.level || 1));
    return `旁白：准备好与 ${leadTargetName}(lv${leadTargetLevel}) 进行战斗了吗？当前敌人有 ${enemyNames}。从现在开始请直接输入文字战斗指令，例如“攻击${leadTargetName}”“施展技能攻击${leadTargetName}”“防御”或“调息回气”。`;
  }
  return `小游戏已开始：${rulebook.displayName}。当前阶段：${scalarText(session.phase)}。可见状态：${summarizePublicState(publicState) || "暂无"}。`;
}

/**
 * 为战斗开场生成带角色主体的发言内容。
 * 角色敌人/万能角色优先承担宣战台词，旁白只在确实没有可发言角色时兜底。
 */
function buildBattleStartSpeech(session: JsonRecord, ctx: MiniGameControllerInput): { role: string; roleType: string; content: string } {
  const aliveEnemies = aliveBattleEnemies(session);
  const enemyNames = aliveEnemies.map((enemy) => scalarText(enemy.name)).filter(Boolean).join("、") || "敌人";
  const leadTarget = aliveEnemies[0] || null;
  const leadTargetName = scalarText(leadTarget?.name) || enemyNames;
  const leadTargetLevel = Math.max(1, Number(leadTarget?.level || 1));
  const speaker = resolveBattleSpeaker(session, ctx, leadTarget);
  const content = speaker.narratorFallback
    ? `旁白：准备好与 ${leadTargetName}(lv${leadTargetLevel}) 进行战斗了吗？当前敌人有 ${enemyNames}。从现在开始请直接输入文字战斗指令，例如“攻击${leadTargetName}”“施展技能攻击${leadTargetName}”“防御”或“调息回气”。`
    : speaker.viaWildcard
      ? `“${speaker.proxyEnemyName}已经盯上你了。”当前敌人有 ${enemyNames}。你现在可以直接输入文字战斗指令，例如“攻击${leadTargetName}”“施展技能攻击${leadTargetName}”“防御”或“调息回气”。`
      : `“准备好接招了吗？”${speaker.speakerName}已经摆出战斗姿态。当前敌人有 ${enemyNames}。你现在可以直接输入文字战斗指令，例如“攻击${leadTargetName}”“施展技能攻击${leadTargetName}”“防御”或“调息回气”。`;
  return {
    role: speaker.role,
    roleType: speaker.roleType,
    content,
  };
}

/**
 * 给小游戏消息批量补齐统一 meta。
 * 多条消息共用同一份小游戏状态快照，避免前端收到的每条消息元数据不一致。
 */
function attachMiniGameMeta(
  messages: Array<{ role: string; roleType: string; eventType: string; content: string }>,
  meta: JsonRecord,
) {
  return messages.map((item) => ({
    role: item.role,
    roleType: item.roleType,
    eventType: item.eventType,
    content: item.content,
    meta,
  }));
}

function normalizeActionId(input: string, options: MiniGameActionOption[]): string | null {
  const text = scalarText(input).replace(/^#/, "").trim();
  const normalizedText = normalizeMiniGameActionText(input);
  if (!text) return null;
  const exact = options.find((item) => {
    const actionId = normalizeMiniGameActionText(item.action_id);
    const label = normalizeMiniGameActionText(item.label);
    return text === item.action_id || text === item.label || normalizedText === actionId || normalizedText === label;
  });
  if (exact) return exact.action_id;
  const aliasMatch = options.find((item) => (item.aliases || []).some((alias) => {
    const normalizedAlias = normalizeMiniGameActionText(alias);
    return text === alias || text.includes(alias) || normalizedText === normalizedAlias || normalizedText.includes(normalizedAlias);
  }));
  if (aliasMatch) return aliasMatch.action_id;
  const fuzzy = options.find((item) => {
    const label = normalizeMiniGameActionText(item.label);
    const actionId = normalizeMiniGameActionText(item.action_id);
    return text.includes(item.label)
      || item.label.includes(text)
      || text.includes(item.action_id)
      || normalizedText.includes(label)
      || label.includes(normalizedText)
      || normalizedText.includes(actionId);
  });
  return fuzzy?.action_id || null;
}

function buildStatusNarration(root: JsonRecord, rulebook: MiniGameRulebook): string {
  const session = asRecord(root.session);
  const publicState = asRecord(session.public_state);
  if (rulebook.gameType === "werewolf") {
    return `${rulebook.displayName}状态：当前阶段 ${scalarText(session.phase) || "进行中"}。可直接输入“发言”“进入投票”“投票某人”“查验某人”“救某人”或“查看记录”。`;
  }
  if (rulebook.gameType === "fishing") {
    const reward = scalarText(publicState.last_reward);
    return [
      `钓鱼状态：${scalarText(publicState.current_status) || "准备抛竿"}。`,
      scalarText(publicState.last_result) ? `本轮结果：${scalarText(publicState.last_result)}。` : "",
      reward ? `最近收获：${reward}。` : "",
      "可直接输入“抛竿”“收杆”或“继续钓鱼”。",
    ].filter(Boolean).join("");
  }
  if (rulebook.gameType === "cultivation") {
    return `修炼状态：第 ${Number(session.round || 1)} 轮。可直接输入“吐纳”“观想”“稳息”“服丹”“冲关”“收功”。`;
  }
  if (rulebook.gameType === "mining") {
    return `挖矿状态：矿脉剩余 ${Number(publicState.vein_hp || 0)}，危险度 ${Number(publicState.danger || 0)}。可直接输入“勘探”“开采”“精挖”“支护”“清障”“休息”“撤离”。`;
  }
  if (rulebook.gameType === "research_skill") {
    return `研发状态：${scalarText(publicState.last_result) || "等待方案"}。${scalarText(publicState.last_advice) || "直接输入技能名称、原理和测试思路。"}。`;
  }
  if (rulebook.gameType === "alchemy") {
    return `炼药状态：${scalarText(publicState.last_result) || "等待方案"}。${scalarText(publicState.last_advice) || "直接输入药材搭配、火候与凝丹思路。"}。`;
  }
  if (rulebook.gameType === "upgrade_equipment") {
    return `强化状态：${scalarText(publicState.last_result) || "等待方案"}。${scalarText(publicState.last_advice) || "直接输入装备名称以及加热、锻打、注灵方案。"}。`;
  }
  if (rulebook.gameType === "battle") {
    return `战斗状态：${scalarText(publicState.last_result) || "双方已经进入交战状态。"}${battleStatusSummary(session)}`;
  }
  return `${rulebook.displayName}当前处于 ${scalarText(session.phase)}，第 ${Number(session.round || 1)} 轮。公开状态：${summarizePublicState(publicState) || "暂无"}。`;
}

function buildRuleNarration(rulebook: MiniGameRulebook): string {
  if (rulebook.gameType === "werewolf") {
    return "狼人杀规则：通过聊天框直接输入“发言”“进入投票”“投票某人”“查验某人”“救某人”等动作，系统会根据当前阶段自动判断是否合法。";
  }
  if (rulebook.gameType === "fishing") {
    return "钓鱼规则：通过聊天框直接输入“抛竿”“收杆”“继续钓鱼”等动作推进。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。";
  }
  if (rulebook.gameType === "cultivation") {
    return "修炼规则：通过聊天框直接输入“吐纳”“观想”“稳息”“服丹”“冲关”“收功”等动作，系统会根据当前灵气、感悟和稳定度结算结果。";
  }
  if (rulebook.gameType === "mining") {
    return "挖矿规则：通过聊天框直接输入“勘探”“开采”“精挖”“支护”“清障”“休息”“撤离”等动作，系统会实时更新矿脉剩余、危险度和负重。";
  }
  if (rulebook.gameType === "research_skill") {
    return "研发技能规则：直接输入技能名称、原理、测试方式和改良思路。我会判断是成功研发、保留碎片还是失败，并把结果写回角色参数或记忆。";
  }
  if (rulebook.gameType === "alchemy") {
    return "炼药规则：直接输入药方、药材搭配、火候与稳炉思路。我会判断是成丹、勉强成丹还是失败，并把结果写回背包和参数卡。";
  }
  if (rulebook.gameType === "upgrade_equipment") {
    return "升级装备规则：直接输入目标装备和强化方案。我会判断升级结果，并把新装备名称或失败记录写回角色参数。";
  }
  if (rulebook.gameType === "battle") {
    return "战斗规则：通过文字输入攻击、技能、防御和回气推进战斗。系统会实时更新敌我血量与法力；击败全部敌人后会结算战利品、金钱、升级概率，并在战后恢复用户血量与法力。";
  }
  return `${rulebook.displayName}规则：${rulebook.ruleSummary}`;
}

export async function handleMiniGameTurn(input: MiniGameControllerInput): Promise<MiniGameControllerResult | null> {
  const state = input.state;
  const root = ensureMiniGameRoot(state);
  const activeSession = asRecord(root.session);
  const hasActiveGame = isMiniGameActiveState(state);

  if (!hasActiveGame) {
    // #退出 在没有激活小游戏时也要有稳定语义，不能再落到“未识别小游戏”分支。
    // 这里顺手关闭目录态，并彻底清掉可能残留的小游戏状态。
    // 否则后端虽然判断“当前没有进行中的小游戏”，前端仍可能继续拿着旧 miniGame 状态挂面板。
    if (isForceQuitMiniGameCommand(input.playerMessage)) {
      clearMiniGameCatalog(state);
      clearMiniGameSession(root);
      // 已经显式退出过小游戏后，后续普通文本只能回到主线，
      // 只有再次显式输入 #钓鱼 / #战斗 / 目录选择时才允许重新进入。
      suppressPassiveMiniGameReentry(root);
      return {
        intercepted: true,
        runtime: root,
        message: {
          role: scalarText(input.world?.narratorRole?.name) || "旁白",
          roleType: "narrator",
          eventType: "on_mini_game_abort",
          content: "当前没有进行中的小游戏。若要进入小游戏，请输入 #+小游戏名称，如 #钓鱼。",
          meta: { miniGameCatalog: asRecord(state.miniGameCatalog) },
        },
      };
    }

    if (isMiniGameCatalogCommand(input.playerMessage)) {
      const catalog = openMiniGameCatalog(state);
      return {
        intercepted: true,
        runtime: root,
        message: {
          role: scalarText(input.world?.narratorRole?.name) || "旁白",
          roleType: "narrator",
          eventType: "on_mini_game_catalog",
          content: buildMiniGameCatalogNarration(),
          meta: { miniGameCatalog: catalog },
        },
      };
    }

    const catalogSelection = resolveMiniGameCatalogSelection(state, input.playerMessage);
    if (catalogSelection.attempted && !catalogSelection.detected) {
      const catalog = openMiniGameCatalog(state);
      return {
        intercepted: true,
        runtime: root,
        message: {
          role: scalarText(input.world?.narratorRole?.name) || "旁白",
          roleType: "narrator",
          eventType: "on_mini_game_catalog_invalid",
          content: buildMiniGameCatalogNarration("未识别到对应小游戏。"),
          meta: { miniGameCatalog: catalog },
        },
      };
    }

    const detected = catalogSelection.detected || detectGameTrigger(input.playerMessage, input.recentMessages, root);
    if (!detected) return null;
    const rulebook = RULEBOOKS[detected.gameType];
    if (!rulebook) return null;
    // 只有显式标签或目录选择真正进入小游戏时，才解除退出后的被动重进抑制。
    clearPassiveMiniGameReentrySuppression(root);
    clearMiniGameCatalog(state);
    const session = rulebook.setup(input, gameSessionId(detected.gameType), detected.source);
    root.rulebook = {
      gameType: rulebook.gameType,
      displayName: rulebook.displayName,
      version: rulebook.version,
      goal: rulebook.goal,
      phaseOrder: rulebook.phaseOrder,
      ruleSummary: rulebook.ruleSummary,
    };
    root.session = session;
    root.actionLog = [];
    root.writeback = {};
    root.memorySummary = "";
    const narration = buildStartNarration(rulebook, session);
    refreshRuntimeUi(root, narration, rulebook);
    pushMiniGameLog(root, {
      round: Number(session.round || 1),
      phase: scalarText(session.phase),
      actor_id: "player",
      action_id: "enter",
      action_payload_json: { source: detected.source, trigger: input.playerMessage },
      result_json: { narration },
      created_at: nowTs(),
    });
    const battleStartSpeech = rulebook.gameType === "battle"
      ? buildBattleStartSpeech(session, input)
      : null;
    const startMeta = buildMiniGameMeta(root);
    return {
      intercepted: true,
      runtime: root,
      message: {
        role: battleStartSpeech?.role || scalarText(input.world?.narratorRole?.name) || "旁白",
        roleType: battleStartSpeech?.roleType || "narrator",
        eventType: "on_mini_game_start",
        content: battleStartSpeech?.content || narration,
        meta: startMeta,
      },
      messages: battleStartSpeech
        ? attachMiniGameMeta([
          {
            role: battleStartSpeech.role,
            roleType: battleStartSpeech.roleType,
            eventType: "on_mini_game_start",
            content: battleStartSpeech.content,
          },
        ], startMeta)
        : undefined,
    };
  }

  const gameType = scalarText(activeSession.game_type);
  const rulebook = RULEBOOKS[gameType];
  if (!rulebook) return null;
  const logMiniGameAction = (payload: {
    normalizedInput?: string;
    controlAction?: string;
    actionId?: string;
    battleActionId?: string;
    resolverSource?: string;
    resolverReason?: string;
    resultTags?: string[];
    intercepted?: boolean;
  }) => {
    DebugLogUtil.logMiniGameActionResolution("story:mini_game:stats", {
      gameType: rulebook.gameType,
      phase: scalarText(activeSession.phase),
      status: scalarText(activeSession.status),
      input: input.playerMessage,
      normalizedInput: payload.normalizedInput || "",
      controlAction: payload.controlAction || "",
      actionId: payload.actionId || "",
      battleActionId: payload.battleActionId || "",
      resolverSource: payload.resolverSource || "",
      resolverReason: payload.resolverReason || "",
      resultTags: payload.resultTags || [],
      intercepted: payload.intercepted,
    });
  };

  const controlAction = detectControlAction(input.playerMessage);
  if (controlAction === "view_status") {
    logMiniGameAction({
      normalizedInput: normalizeMiniGameActionText(input.playerMessage),
      controlAction,
      intercepted: true,
      resultTags: ["view_status"],
    });
    const narration = buildStatusNarration(root, rulebook);
    refreshRuntimeUi(root, narration, rulebook);
    return {
      intercepted: true,
      runtime: root,
      message: {
        role: scalarText(input.world?.narratorRole?.name) || "旁白",
        roleType: "narrator",
        eventType: "on_mini_game_status",
        content: narration,
        meta: buildMiniGameMeta(root),
      },
    };
  }
  if (controlAction === "view_rules") {
    logMiniGameAction({
      normalizedInput: normalizeMiniGameActionText(input.playerMessage),
      controlAction,
      intercepted: true,
      resultTags: ["view_rules"],
    });
    const narration = buildRuleNarration(rulebook);
    refreshRuntimeUi(root, narration, rulebook);
    return {
      intercepted: true,
      runtime: root,
      message: {
        role: scalarText(input.world?.narratorRole?.name) || "旁白",
        roleType: "narrator",
        eventType: "on_mini_game_rule",
        content: narration,
        meta: buildMiniGameMeta(root),
      },
    };
  }
  if (controlAction === "suspend") {
    logMiniGameAction({
      normalizedInput: normalizeMiniGameActionText(input.playerMessage),
      controlAction,
      intercepted: true,
      resultTags: ["suspend"],
    });
    activeSession.status = "suspended";
    const narration = `小游戏已暂停。输入“恢复小游戏”或“继续”可返回当前局面。`;
    refreshRuntimeUi(root, narration, rulebook);
    return {
      intercepted: true,
      runtime: root,
      message: {
        role: scalarText(input.world?.narratorRole?.name) || "旁白",
        roleType: "narrator",
        eventType: "on_mini_game_suspend",
        content: narration,
        meta: buildMiniGameMeta(root),
      },
    };
  }
  if (controlAction === "resume") {
    if (scalarText(activeSession.status) === "suspended") {
      logMiniGameAction({
        normalizedInput: normalizeMiniGameActionText(input.playerMessage),
        controlAction,
        intercepted: true,
        resultTags: ["resume"],
      });
      activeSession.status = "active";
      if (activeSession.pending_exit) {
        activeSession.pending_exit = false;
      }
      const narration = rulebook.gameType === "fishing"
        ? "继续钓鱼吧，直接在聊天框输入“抛竿”“收杆”或“继续钓鱼”。"
        : buildStatusNarration(root, rulebook);
      refreshRuntimeUi(root, narration, rulebook);
      return {
        intercepted: true,
        runtime: root,
        message: {
          role: scalarText(input.world?.narratorRole?.name) || "旁白",
          roleType: "narrator",
          eventType: "on_mini_game_resume",
          content: narration,
          meta: buildMiniGameMeta(root),
        },
      };
    }
  }
  if (isForceQuitMiniGameCommand(input.playerMessage)) {
    logMiniGameAction({
      normalizedInput: normalizeMiniGameActionText(input.playerMessage),
      controlAction: "force_quit",
      intercepted: true,
      resultTags: ["force_quit"],
    });
    activeSession.status = "aborted";
    activeSession.phase = "settling";
    activeSession.result = "aborted";
    activeSession.finish_reason = "用户使用 #退出 强制结束小游戏";
    activeSession.pending_exit = false;
    const narration = `你已强制退出 ${rulebook.displayName}，当前可继续回到主线剧情。`;
    refreshRuntimeUi(root, narration, rulebook);
    // 生成退出播报后，立刻清空小游戏运行态，避免后续普通输入再次被旧小游戏上下文误触发。
    clearMiniGameSession(root);
    // 退出后进入主线阶段，只允许显式 #小游戏 / #钓鱼 这类命令重新进入，禁止被动再次命中。
    suppressPassiveMiniGameReentry(root);
    return {
      intercepted: true,
      runtime: root,
      message: {
        role: scalarText(input.world?.narratorRole?.name) || "旁白",
        roleType: "narrator",
        eventType: "on_mini_game_abort",
        content: narration,
        meta: buildMiniGameMeta(root),
      },
    };
  }
  if (scalarText(activeSession.status) === "suspended") {
    logMiniGameAction({
      normalizedInput: normalizeMiniGameActionText(input.playerMessage),
      intercepted: true,
      resultTags: ["blocked_suspended"],
    });
    const narration = "当前小游戏已暂停。请先输入“恢复小游戏”或“继续”，然后再执行局内动作。";
    refreshRuntimeUi(root, narration, rulebook);
    return {
      intercepted: true,
      runtime: root,
      message: {
        role: scalarText(input.world?.narratorRole?.name) || "旁白",
        roleType: "narrator",
        eventType: "on_mini_game_blocked",
        content: narration,
        meta: buildMiniGameMeta(root),
      },
    };
  }

  const options = rulebook.options(activeSession);
  if (isTextInputMiniGame(rulebook.gameType)) {
    const textInput = normalizeInlineText(input.playerMessage);
    const normalizedInput = normalizeMiniGameActionText(input.playerMessage);
    if (!textInput) {
      logMiniGameAction({
        normalizedInput,
        intercepted: true,
        resultTags: ["invalid_empty_input"],
      });
      const narration = `当前仍在 ${rulebook.displayName} 中，请直接输入你的方案。${buildMiniGameInputHint(rulebook)}。`;
      refreshRuntimeUi(root, narration, rulebook);
      return {
        intercepted: true,
        runtime: root,
        message: {
          role: scalarText(input.world?.narratorRole?.name) || "旁白",
          roleType: "narrator",
          eventType: "on_mini_game_invalid",
          content: narration,
          meta: buildMiniGameMeta(root),
        },
      };
    }
    const beforePublicState = deepCloneRecord(asRecord(activeSession.public_state));
    const beforeHiddenState = deepCloneRecord(asRecord(activeSession.hidden_state));
    const beforeResourceState = deepCloneRecord(asRecord(activeSession.resource_state));
    let step: MiniGameStepResult;
    if (rulebook.gameType === "battle") {
      const aiBattleAction = await resolveBattleActionByAgent(
        activeSession,
        rulebook,
        input,
        scalarText(asRecord(root.ui).narration),
      );
      const battleAction = aiBattleAction || resolveBattleTextAction(activeSession, input.playerMessage);
      if (!battleAction) {
        logMiniGameAction({
          normalizedInput,
          resolverSource: aiBattleAction ? "ai" : "rule",
          intercepted: true,
          resultTags: ["invalid_battle_input"],
        });
        const narration = `当前战斗只接受文字战斗指令。${buildMiniGameInputHint(rulebook)}。`;
        refreshRuntimeUi(root, narration, rulebook);
        return {
          intercepted: true,
          runtime: root,
          message: {
            role: scalarText(input.world?.narratorRole?.name) || "旁白",
            roleType: "narrator",
            eventType: "on_mini_game_invalid",
            content: narration,
            meta: buildMiniGameMeta(root),
          },
        };
      }
      if (battleAction.actionId === "view_status") {
        logMiniGameAction({
          normalizedInput,
          battleActionId: battleAction.actionId,
          resolverSource: aiBattleAction?.resolverSource || "rule",
          resolverReason: aiBattleAction?.resolverReason || "",
          intercepted: true,
          resultTags: ["view_status"],
        });
        const narration = buildStatusNarration(root, rulebook);
        refreshRuntimeUi(root, narration, rulebook);
        return {
          intercepted: true,
          runtime: root,
          message: {
            role: scalarText(input.world?.narratorRole?.name) || "旁白",
            roleType: "narrator",
            eventType: "on_mini_game_status",
            content: narration,
            meta: buildMiniGameMeta(root),
          },
        };
      }
      step = battleStep(activeSession, battleAction.actionId, input);
      logMiniGameAction({
        normalizedInput,
        battleActionId: battleAction.actionId,
        resolverSource: aiBattleAction?.resolverSource || "rule",
        resolverReason: aiBattleAction?.resolverReason || "",
        intercepted: true,
        resultTags: step.resultTags || [],
      });
    } else if (rulebook.gameType === "research_skill") {
      step = evaluateResearchSkillInput(activeSession, input);
      logMiniGameAction({
        normalizedInput,
        intercepted: true,
        resultTags: step.resultTags || [],
      });
    } else if (rulebook.gameType === "alchemy") {
      step = evaluateAlchemyInput(activeSession, input);
      logMiniGameAction({
        normalizedInput,
        intercepted: true,
        resultTags: step.resultTags || [],
      });
    } else {
      step = evaluateEquipmentInput(activeSession, input);
      logMiniGameAction({
        normalizedInput,
        intercepted: true,
        resultTags: step.resultTags || [],
      });
    }
    const stateDelta = {
      public_state: buildStateDelta(beforePublicState, asRecord(activeSession.public_state)),
      hidden_state: buildStateDelta(beforeHiddenState, asRecord(activeSession.hidden_state)),
      resource_state: buildStateDelta(beforeResourceState, asRecord(activeSession.resource_state)),
    };
    if (step.writeback && Object.keys(step.writeback).length) {
      root.writeback = step.writeback;
      applyMiniGameWriteback(state, step.writeback);
    }
    if (scalarText(step.memorySummary)) {
      root.memorySummary = scalarText(step.memorySummary);
    }
    const narration = scalarText(step.narration) || `${rulebook.displayName}继续进行中。`;
    refreshRuntimeUi(root, narration, rulebook);
    const ui = asRecord(root.ui);
    ui.last_state_delta = stateDelta;
    ui.reward_summary = step.rewardSummary || {};
    ui.memory_summary = scalarText(step.memorySummary);
    root.ui = ui;
    pushMiniGameLog(root, {
      round: Number(activeSession.round || 1),
      phase: scalarText(activeSession.phase),
      actor_id: "player",
      action_id: "text_input",
      action_payload_json: { input: input.playerMessage },
      rng_used: step.rngUsed || [],
      result_json: {
        narration,
        resultTags: step.resultTags || [],
        stateDelta,
        rewardSummary: step.rewardSummary || {},
        writebackDelta: step.writeback || {},
        memorySummary: scalarText(step.memorySummary),
      },
      created_at: nowTs(),
    });
    const eventType = scalarText(activeSession.status) === "finished" || scalarText(activeSession.status) === "aborted"
      ? "on_mini_game_finish"
      : "on_mini_game";
    const stepMeta = buildMiniGameMeta(root);
    return {
      intercepted: true,
      runtime: root,
      message: {
        role: step.speakerRole || scalarText(input.world?.narratorRole?.name) || "旁白",
        roleType: step.speakerRoleType || "narrator",
        eventType,
        content: narration,
        meta: stepMeta,
      },
      messages: step.messages?.length ? attachMiniGameMeta(step.messages, stepMeta) : undefined,
    };
  }
  const aiIntent = await resolveMiniGameIntentByAi({
    userId: input.userId,
    gameType: rulebook.gameType,
    phase: scalarText(activeSession.phase),
    status: scalarText(activeSession.status),
    publicStateSummary: summarizePublicState(asRecord(activeSession.public_state)),
    latestNarration: scalarText(asRecord(root.ui).narration),
    userInput: input.playerMessage,
    options: options.map((item) => ({
      actionId: item.action_id,
      label: item.label,
      desc: item.desc,
      aliases: item.aliases || [],
    })),
  });
  const actionId = aiIntent?.actionId || normalizeActionId(input.playerMessage, options);
  if (!actionId) {
    logMiniGameAction({
      normalizedInput: normalizeMiniGameActionText(input.playerMessage),
      resolverSource: aiIntent ? "ai" : "rule",
      resolverReason: aiIntent?.reason || "",
      intercepted: true,
      resultTags: ["invalid_action"],
    });
    const narration = `当前仍在 ${rulebook.displayName} 中，请先完成、暂停或退出小游戏。当前合法动作：${options.map((item) => item.label).join("、")}。`;
    refreshRuntimeUi(root, narration, rulebook);
    return {
      intercepted: true,
      runtime: root,
      message: {
        role: scalarText(input.world?.narratorRole?.name) || "旁白",
        roleType: "narrator",
        eventType: "on_mini_game_invalid",
        content: narration,
        meta: buildMiniGameMeta(root),
      },
    };
  }

  const beforePublicState = deepCloneRecord(asRecord(activeSession.public_state));
  const beforeHiddenState = deepCloneRecord(asRecord(activeSession.hidden_state));
  const beforeResourceState = deepCloneRecord(asRecord(activeSession.resource_state));
  const step = rulebook.applyAction(activeSession, actionId, input);
  logMiniGameAction({
    normalizedInput: normalizeMiniGameActionText(input.playerMessage),
    actionId,
    resolverSource: aiIntent ? "ai" : "rule",
    resolverReason: aiIntent?.reason || "",
    intercepted: true,
    resultTags: step.resultTags || [],
  });
  const stateDelta = {
    public_state: buildStateDelta(beforePublicState, asRecord(activeSession.public_state)),
    hidden_state: buildStateDelta(beforeHiddenState, asRecord(activeSession.hidden_state)),
    resource_state: buildStateDelta(beforeResourceState, asRecord(activeSession.resource_state)),
  };
  if (step.writeback && Object.keys(step.writeback).length) {
    root.writeback = step.writeback;
    applyMiniGameWriteback(state, step.writeback);
  }
  if (scalarText(step.memorySummary)) {
    root.memorySummary = scalarText(step.memorySummary);
  }
  const narration = scalarText(step.narration) || `${rulebook.displayName}继续进行中。`;
  refreshRuntimeUi(root, narration, rulebook);
  const ui = asRecord(root.ui);
  ui.last_state_delta = stateDelta;
  ui.reward_summary = step.rewardSummary || {};
  ui.memory_summary = scalarText(step.memorySummary);
  root.ui = ui;
  pushMiniGameLog(root, {
    round: Number(activeSession.round || 1),
    phase: scalarText(activeSession.phase),
    actor_id: "player",
    action_id: actionId,
    action_payload_json: { input: input.playerMessage },
    rng_used: step.rngUsed || [],
    result_json: {
      narration,
      resultTags: step.resultTags || [],
      stateDelta,
      rewardSummary: step.rewardSummary || {},
      writebackDelta: step.writeback || {},
      memorySummary: scalarText(step.memorySummary),
    },
    created_at: nowTs(),
  });

  const eventType = scalarText(activeSession.status) === "finished" || scalarText(activeSession.status) === "aborted"
    ? "on_mini_game_finish"
    : "on_mini_game";
  return {
    intercepted: true,
    runtime: root,
    message: {
      role: scalarText(input.world?.narratorRole?.name) || "旁白",
      roleType: "narrator",
      eventType,
      content: narration,
      meta: buildMiniGameMeta(root),
    },
  };
}
