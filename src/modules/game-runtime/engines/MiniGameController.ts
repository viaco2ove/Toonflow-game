import { z } from "zod";
import u from "@/utils";
import {
  JsonRecord,
  nowTs,
  parseJsonSafe,
} from "@/lib/gameEngine";
import { worldRoles } from "@/modules/game-runtime/engines/NarrativeOrchestrator";

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
  resultTags?: string[];
  rngUsed?: number[];
  rewardSummary?: JsonRecord;
  writeback?: JsonRecord;
  memorySummary?: string;
}

const CONTROL_ALIASES: Record<string, string[]> = {
  view_status: ["查看状态", "状态", "局势", "看看状态", "查看局势"],
  view_rules: ["查看规则", "规则", "看看规则"],
  resume: ["继续", "恢复小游戏", "恢复", "接着来"],
  request_quit: ["申请退出", "退出小游戏", "退出", "离开小游戏"],
  confirm_quit: ["确认退出", "确认离开", "确定退出", "退出确认"],
  suspend: ["暂停", "暂停小游戏", "先暂停"],
};

const PASSIVE_CONFIRM_PATTERNS = [
  /好/,
  /开始/,
  /来吧/,
  /可以/,
  /行/,
  /同意/,
  /参加/,
  /试试/,
  /那就/,
  /一起/,
  /继续/,
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
      playerOptions: asArray(ui.player_options),
      publicState: asRecord(session.public_state),
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

function detectGameTrigger(message: string, recentMessages: Array<Record<string, any>> = []): { gameType: string; source: string } | null {
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

function nextWerewolfPlayerPhase(session: JsonRecord): string {
  const hidden = asRecord(session.hidden_state);
  const roleMap = asRecord(hidden.role_map);
  const playerRole = scalarText(roleMap.player || roleMap["玩家"] || roleMap["用户"] || "村民");
  const dayCount = Number(asRecord(session.public_state).day_count || 1);
  if (dayCount <= 0) {
    asRecord(session.public_state).day_count = 1;
  }
  if (playerRole === "狼人") return "night_wolf";
  if (playerRole === "预言家") return "night_seer";
  if (playerRole === "女巫") return "night_witch";
  return "day_discussion";
}

function werewolfOptions(session: JsonRecord): MiniGameActionOption[] {
  const phase = normalizePhase(session.phase, "day_discussion");
  const publicState = asRecord(session.public_state);
  const aliveList = asArray<string>(publicState.alive_list);
  const selectable = aliveList.filter((item) => item && item !== "用户" && item !== "玩家");
  if (phase === "night_wolf") {
    return [
      ...selectable.map((item) => ({ action_id: `kill:${item}`, label: `击杀${item}`, desc: `夜间袭击 ${item}` })),
      { action_id: "skip_kill", label: "空刀", desc: "今晚不击杀目标" },
      { action_id: "view_status", label: "查看局势", desc: "查看当前存活与公开记录" },
    ];
  }
  if (phase === "night_seer") {
    return [
      ...selectable.map((item) => ({ action_id: `check:${item}`, label: `查验${item}`, desc: `查验 ${item} 的阵营` })),
      { action_id: "skip_check", label: "跳过", desc: "放弃本轮查验" },
      { action_id: "view_status", label: "查看局势", desc: "查看当前公开记录" },
    ];
  }
  if (phase === "night_witch") {
    const lastNightTarget = scalarText(asRecord(session.hidden_state).wolf_target);
    const options: MiniGameActionOption[] = [];
    if (lastNightTarget) {
      options.push({ action_id: `save:${lastNightTarget}`, label: `救${lastNightTarget}`, desc: `使用解药救下 ${lastNightTarget}` });
    }
    options.push(
      ...selectable.map((item) => ({ action_id: `poison:${item}`, label: `毒${item}`, desc: `使用毒药淘汰 ${item}` })),
      { action_id: "skip_witch", label: "双跳过", desc: "本轮不救人也不下毒" },
      { action_id: "view_status", label: "查看记录", desc: "查看已公开记录" },
    );
    return options;
  }
  if (phase === "day_vote") {
    return [
      { action_id: "speak", label: "发言", desc: "发表你的怀疑与判断" },
      ...selectable.map((item) => ({ action_id: `vote:${item}`, label: `投票${item}`, desc: `白天投票淘汰 ${item}` })),
      { action_id: "abstain", label: "弃票", desc: "本轮放弃投票" },
      { action_id: "view_record", label: "查看记录", desc: "查看昨夜结果与投票历史" },
    ];
  }
  return [
    { action_id: "speak", label: "发言", desc: "参与白天讨论" },
    { action_id: "begin_vote", label: "进入投票", desc: "结束讨论并进入投票" },
    { action_id: "view_record", label: "查看记录", desc: "查看公开死亡与投票记录" },
  ];
}

function resolveWerewolfNightNpc(session: JsonRecord) {
  const hidden = asRecord(session.hidden_state);
  const publicState = asRecord(session.public_state);
  const aliveList = asArray<string>(publicState.alive_list);
  const playerName = asArray<JsonRecord>(session.participants).find((item) => item.role_type === "player")?.role_name || "用户";
  const candidates = aliveList.filter((item) => item !== playerName);
  if (!scalarText(hidden.wolf_target) && candidates.length) {
    hidden.wolf_target = candidates[takeRng(session, 0, candidates.length - 1)];
  }
  if (!Array.isArray(hidden.seer_checks)) hidden.seer_checks = [];
  if (!Array.isArray(publicState.public_vote_history)) publicState.public_vote_history = [];
  session.hidden_state = hidden;
  session.public_state = publicState;
}

function finalizeWerewolfVote(session: JsonRecord, votedOut: string): string {
  const publicState = asRecord(session.public_state);
  const hidden = asRecord(session.hidden_state);
  const aliveList = asArray<string>(publicState.alive_list).filter((item) => item !== votedOut);
  const eliminatedList = asArray<string>(publicState.eliminated_list);
  eliminatedList.push(votedOut);
  publicState.alive_list = aliveList;
  publicState.eliminated_list = eliminatedList;
  const history = asArray<any>(publicState.public_vote_history);
  history.push({ round: Number(session.round || 1), votedOut });
  publicState.public_vote_history = history.slice(-10);
  publicState.last_night_result = votedOut ? `白天投票淘汰：${votedOut}` : "本轮无人出局";
  const roleMap = asRecord(hidden.role_map);
  const aliveRoles = aliveList.map((item) => scalarText(roleMap[item]));
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
  session.round = Number(session.round || 1) + 1;
  session.phase = nextWerewolfPlayerPhase(session);
  session.status = "active";
  resolveWerewolfNightNpc(session);
  return `${votedOut} 被票出局。天亮后将进入第 ${session.round} 轮。`;
}

function werewolfStep(session: JsonRecord, actionId: string): MiniGameStepResult {
  const phase = normalizePhase(session.phase, "day_discussion");
  const publicState = asRecord(session.public_state);
  const hidden = asRecord(session.hidden_state);
  const roleMap = asRecord(hidden.role_map);
  const playerName = asArray<JsonRecord>(session.participants).find((item) => item.role_type === "player")?.role_name || "用户";
  if (!Array.isArray(publicState.alive_list) || !publicState.alive_list.length) {
    publicState.alive_list = asArray<JsonRecord>(session.participants).filter((item) => item.alive !== false).map((item) => item.role_name);
  }
  if (phase === "night_wolf") {
    if (actionId.startsWith("kill:")) {
      const target = actionId.slice(5);
      hidden.wolf_target = target;
      session.phase = "day_announce";
      const aliveList = asArray<string>(publicState.alive_list).filter((item) => item !== target);
      publicState.alive_list = aliveList;
      publicState.eliminated_list = [...asArray<string>(publicState.eliminated_list), target];
      publicState.last_night_result = `昨夜 ${target} 倒下。`;
      session.phase = "day_discussion";
      return { narration: `夜色退去，昨夜 ${target} 被袭击出局。白天讨论开始。`, resultTags: ["night_kill"] };
    }
    if (actionId === "skip_kill") {
      publicState.last_night_result = "昨夜平安无事。";
      session.phase = "day_discussion";
      return { narration: "你选择空刀，昨夜平安无事。现在进入白天讨论。", resultTags: ["skip_kill"] };
    }
  }
  if (phase === "night_seer") {
    if (actionId.startsWith("check:")) {
      const target = actionId.slice(6);
      const targetRole = scalarText(roleMap[target]) || "村民";
      session.phase = "day_discussion";
      publicState.last_night_result = `你查验了 ${target}。`;
      return { narration: `你查验了 ${target}，对方阵营为：${targetRole}。天亮后进入白天讨论。`, resultTags: ["seer_check"] };
    }
    if (actionId === "skip_check") {
      session.phase = "day_discussion";
      return { narration: "你放弃了本轮查验。天亮后进入白天讨论。", resultTags: ["skip_check"] };
    }
  }
  if (phase === "night_witch") {
    if (actionId.startsWith("save:")) {
      const target = actionId.slice(5);
      publicState.alive_list = Array.from(new Set([...asArray<string>(publicState.alive_list), target]));
      publicState.eliminated_list = asArray<string>(publicState.eliminated_list).filter((item) => item !== target);
      publicState.last_night_result = `昨夜 ${target} 被救下。`;
      hidden.witch_save_used = true;
      session.phase = "day_discussion";
      return { narration: `你出手救下了 ${target}。天亮后进入白天讨论。`, resultTags: ["witch_save"] };
    }
    if (actionId.startsWith("poison:")) {
      const target = actionId.slice(7);
      publicState.alive_list = asArray<string>(publicState.alive_list).filter((item) => item !== target);
      publicState.eliminated_list = [...asArray<string>(publicState.eliminated_list), target];
      publicState.last_night_result = `昨夜 ${target} 被女巫毒杀。`;
      hidden.witch_poison_used = true;
      session.phase = "day_discussion";
      return { narration: `你对 ${target} 使用了毒药。天亮后进入白天讨论。`, resultTags: ["witch_poison"] };
    }
    if (actionId === "skip_witch") {
      session.phase = "day_discussion";
      return { narration: "你本轮没有使用解药或毒药。天亮后进入白天讨论。", resultTags: ["skip_witch"] };
    }
  }
  if (phase === "day_discussion") {
    if (actionId === "view_record") {
      const history = asArray<any>(publicState.public_vote_history)
        .map((item) => `第${item.round}轮：${item.votedOut}`)
        .join("；");
      return { narration: `当前存活：${asArray<string>(publicState.alive_list).join("、")}。公开记录：${history || "暂无"}。`, resultTags: ["view_record"] };
    }
    if (actionId === "begin_vote") {
      session.phase = "day_vote";
      return { narration: "讨论结束，进入白天投票。请选择你要票出的对象。", resultTags: ["begin_vote"] };
    }
    if (actionId === "speak") {
      session.phase = "day_vote";
      return { narration: "你表达了自己的怀疑。讨论推进后，现场进入投票环节。", resultTags: ["speak"] };
    }
  }
  if (phase === "day_vote") {
    if (actionId.startsWith("vote:")) {
      const votedOut = actionId.slice(5);
      const narration = finalizeWerewolfVote(session, votedOut);
      const rewardSummary = session.status === "finished"
        ? { exp: session.result === "villager_win" ? 30 : 10, relation: session.result === "villager_win" ? 3 : 1 }
        : {};
      const writeback = session.status === "finished"
        ? {
            relationshipDelta: { party: session.result === "villager_win" ? 3 : 1 },
            playerAttributePatch: { exp: session.result === "villager_win" ? 30 : 10 },
            memoryAdd: [`狼人杀结果：${session.result}`],
          }
        : {};
      return { narration, resultTags: ["vote"], rewardSummary, writeback, memorySummary: `狼人杀一局结束：${session.result || narration}` };
    }
    if (actionId === "abstain") {
      const narration = finalizeWerewolfVote(session, "无人出局");
      return { narration, resultTags: ["abstain"] };
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
      { action_id: "cast", label: "抛竿", desc: "开始本次垂钓" },
      { action_id: "change_bait", label: "换饵", desc: "更换当前鱼饵" },
      { action_id: "finish", label: "收杆结束", desc: "结束本次钓鱼" },
    ];
  }
  if (phase === "waiting") {
    return [
      { action_id: "lift_rod", label: "提竿", desc: "尝试中鱼" },
      { action_id: "wait_more", label: "继续等待", desc: "继续观察水面动静" },
      { action_id: "finish", label: "收杆结束", desc: "结束本次钓鱼" },
    ];
  }
  return [
    { action_id: "reel_in", label: "收线", desc: "拉近鱼的距离" },
    { action_id: "let_out", label: "放线", desc: "降低鱼线张力" },
    { action_id: "steady_rod", label: "稳杆", desc: "稳住鱼线和重心" },
    { action_id: "side_pull", label: "侧拉", desc: "压制冲刺方向" },
    { action_id: "strong_pull", label: "强拉", desc: "高风险快速收线" },
    { action_id: "finish", label: "收杆结束", desc: "结束本次钓鱼" },
  ];
}

function fishingStep(session: JsonRecord, actionId: string): MiniGameStepResult {
  const publicState = asRecord(session.public_state);
  const hidden = asRecord(session.hidden_state);
  const resource = asRecord(session.resource_state);
  const currentPhase = normalizePhase(session.phase, "prepare");
  if (actionId === "finish") {
    session.status = "finished";
    session.phase = "settling";
    session.result = publicState.hook_state === "landed" ? "completed" : "cancelled";
    session.finish_reason = publicState.hook_state === "landed" ? "成功收杆" : "玩家主动结束";
    const fishName = scalarText(hidden.target_fish_name);
    const writeback = publicState.hook_state === "landed" && fishName
      ? {
          inventoryAdd: [{ kind: "fish", name: fishName, rarity: scalarText(hidden.fish_rarity) || "普通" }],
          playerAttributePatch: { stamina: Math.max(0, 100 - Number(publicState.stamina || 100)) },
          memoryAdd: [`钓鱼收获：${fishName}`],
        }
      : {};
    return {
      narration: publicState.hook_state === "landed" && fishName ? `你成功收杆，获得了 ${fishName}。` : "你结束了本次钓鱼。",
      resultTags: ["finish"],
      rewardSummary: publicState.hook_state === "landed" && fishName ? { loot: fishName } : {},
      writeback,
      memorySummary: publicState.hook_state === "landed" && fishName ? `钓鱼成功，收获 ${fishName}` : "钓鱼提前结束",
    };
  }
  if (currentPhase === "prepare") {
    if (actionId === "change_bait") {
      const baitList = ["基础鱼饵", "谷香鱼饵", "灵性鱼饵"];
      publicState.bait_name = baitList[takeRng(session, 0, baitList.length - 1)];
      return { narration: `你更换了鱼饵，当前使用：${publicState.bait_name}。`, resultTags: ["change_bait"] };
    }
    if (actionId === "cast") {
      session.phase = "waiting";
      publicState.hook_state = "waiting";
      hidden.encounter_roll = takeRng(session, 1, 100);
      return { narration: `你将鱼钩抛入 ${scalarText(publicState.site_name) || "水面"}，等待鱼儿上钩。`, resultTags: ["cast"] };
    }
  }
  if (currentPhase === "waiting") {
    const hookChance = clamp(40 + (scalarText(publicState.bait_name).includes("灵") ? 20 : 0), 10, 95);
    const roll = Number(hidden.encounter_roll || takeRng(session, 1, 100));
    if (actionId === "wait_more") {
      hidden.encounter_roll = takeRng(session, 1, 100);
      return { narration: `水面传来轻微波动，你继续沉住气等待。当前中鱼机会约 ${hookChance}% 。`, resultTags: ["wait_more"] };
    }
    if (actionId === "lift_rod") {
      if (roll <= hookChance) {
        session.phase = "hook_fight";
        publicState.hook_state = "hooked";
        publicState.line_tension = 35;
        publicState.fish_distance = 85;
        hidden.fish_stamina = takeRng(session, 55, 85);
        hidden.fish_power = takeRng(session, 40, 75);
        hidden.fish_escape_rate = takeRng(session, 10, 30);
        hidden.target_fish_name = ["鲫鱼", "青鱼", "银鲤", "灵鱼", "古鳞鱼"][takeRng(session, 0, 4)];
        hidden.fish_rarity = hidden.target_fish_name === "灵鱼" || hidden.target_fish_name === "古鳞鱼" ? "稀有" : "普通";
        return { narration: `鱼线猛地一沉，你成功中鱼！目标似乎是 ${hidden.target_fish_name}。`, resultTags: ["hooked"] };
      }
      hidden.encounter_roll = takeRng(session, 1, 100);
      return { narration: "你提竿过早，水下没有真正咬钩，只泛起一圈涟漪。", resultTags: ["empty_hook"] };
    }
  }
  if (currentPhase === "hook_fight") {
    const tension = Number(publicState.line_tension || 0);
    const distance = Number(publicState.fish_distance || 0);
    const fishStamina = Number(hidden.fish_stamina || 0);
    const next = {
      line_tension: tension,
      fish_distance: distance,
      fish_stamina: fishStamina,
    };
    if (actionId === "reel_in") {
      next.fish_distance -= 20;
      next.line_tension += 20;
      next.fish_stamina -= 10;
    } else if (actionId === "let_out") {
      next.fish_distance += 10;
      next.line_tension -= 25;
    } else if (actionId === "steady_rod") {
      next.fish_distance -= 5;
      next.line_tension -= 15;
      next.fish_stamina -= 5;
    } else if (actionId === "side_pull") {
      next.fish_distance -= 15;
      next.line_tension += 10;
      next.fish_stamina -= 15;
    } else if (actionId === "strong_pull") {
      next.fish_distance -= 30;
      next.line_tension += 35;
      next.fish_stamina -= 25;
    } else {
      return { narration: "当前局面只能通过拉扯鱼线来处理，请选择一个合法动作。", resultTags: ["invalid"] };
    }
    next.line_tension = clamp(next.line_tension, 0, 140);
    next.fish_distance = clamp(next.fish_distance, -10, 150);
    next.fish_stamina = clamp(next.fish_stamina, -10, 120);
    publicState.line_tension = next.line_tension;
    publicState.fish_distance = next.fish_distance;
    hidden.fish_stamina = next.fish_stamina;
    publicState.stamina = clamp(Number(publicState.stamina || 100) - 8, 0, 100);
    publicState.focus = clamp(Number(publicState.focus || 80) - 5, 0, 100);
    if (next.line_tension >= 100) {
      session.status = "finished";
      session.phase = "settling";
      session.result = "failed";
      session.finish_reason = "断线失败";
      publicState.hook_state = "broken";
      return {
        narration: "鱼线承受不住巨大的拉力，当场崩断，这次钓鱼失败了。",
        resultTags: ["failed", "line_break"],
        memorySummary: "钓鱼失败，鱼线断裂",
      };
    }
    if (next.fish_distance > 120) {
      session.status = "finished";
      session.phase = "settling";
      session.result = "failed";
      session.finish_reason = "脱钩失败";
      publicState.hook_state = "escaped";
      return {
        narration: "鱼儿猛冲脱离控制，鱼钩被甩开，目标逃脱了。",
        resultTags: ["failed", "escape"],
        memorySummary: "钓鱼失败，目标脱钩逃走",
      };
    }
    if (next.fish_distance <= 0 && next.fish_stamina <= 0) {
      publicState.hook_state = "landed";
      session.status = "finished";
      session.phase = "settling";
      session.result = "success";
      session.finish_reason = "成功上岸";
      const fishName = scalarText(hidden.target_fish_name) || "鱼获";
      return {
        narration: `你稳稳收住鱼线，把 ${fishName} 拖上了岸。`,
        resultTags: ["success", "landed"],
        rewardSummary: { loot: fishName },
        writeback: {
          inventoryAdd: [{ kind: "fish", name: fishName, rarity: scalarText(hidden.fish_rarity) || "普通" }],
          memoryAdd: [`钓鱼收获：${fishName}`],
        },
        memorySummary: `钓鱼成功，钓到了 ${fishName}`,
      };
    }
    return {
      narration: `你继续与鱼儿角力。张力 ${publicState.line_tension}，距离 ${publicState.fish_distance}，鱼的体力还在下降。`,
      resultTags: ["hook_fight"],
    };
  }
  return { narration: "当前阶段无法执行该动作。", resultTags: ["invalid"] };
}

function cultivationOptions(): MiniGameActionOption[] {
  return [
    { action_id: "breathe", label: "吐纳", desc: "积攒灵气" },
    { action_id: "visualize", label: "观想", desc: "提升感悟" },
    { action_id: "steady", label: "稳息", desc: "稳定心神" },
    { action_id: "take_pill", label: "服丹", desc: "短时提高灵气" },
    { action_id: "breakthrough", label: "冲关", desc: "尝试突破当前瓶颈" },
    { action_id: "finish", label: "收功", desc: "安全结束本轮修炼" },
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
          narration: "你抓住了突破契机，经脉顺畅贯通，这次修炼突破成功。",
          resultTags: ["success", "breakthrough"],
          rewardSummary: { exp: 60, realmProgress: 1 },
          writeback: {
            playerAttributePatch: { cultivationExp: 60, realmProgress: 1 },
            flagsPatch: { cultivation_breakthrough: true },
            memoryAdd: ["修炼突破成功"],
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
    session.status = "finished";
    session.phase = "settling";
    session.result = "partial";
    session.finish_reason = "安全收功";
    return {
      narration: "你选择稳妥收功，把本轮修炼成果沉淀下来。",
      resultTags: ["finish"],
      rewardSummary: { exp: Math.max(10, Math.floor(Number(publicState.breakthrough_progress || 0) / 4)) },
      writeback: { playerAttributePatch: { cultivationExp: Math.max(10, Math.floor(Number(publicState.breakthrough_progress || 0) / 4)) }, memoryAdd: ["一次稳妥收功的修炼"] },
      memorySummary: "本次修炼平稳收功",
    };
  }
  return { narration: "当前无法执行该动作。", resultTags: ["invalid"] };
}

function researchOptions(): MiniGameActionOption[] {
  return [
    { action_id: "theory", label: "理论推演", desc: "提升理论进度" },
    { action_id: "sample", label: "样本拆解", desc: "拆解样本换取理论增益" },
    { action_id: "prototype", label: "原型实验", desc: "推进原型进度" },
    { action_id: "debug", label: "故障排查", desc: "恢复稳定性" },
    { action_id: "ask_partner", label: "请教同伴", desc: "请求协助" },
    { action_id: "force_iter", label: "强行迭代", desc: "高风险快速推进" },
    { action_id: "finalize", label: "定稿封存", desc: "达到条件后结束研发" },
  ];
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

function alchemyOptions(): MiniGameActionOption[] {
  return [
    { action_id: "heat_up", label: "升火", desc: "提高炉火温度" },
    { action_id: "cool_down", label: "降火", desc: "压低火候" },
    { action_id: "add_herb", label: "投药", desc: "投入下一份药材" },
    { action_id: "stir", label: "搅拌", desc: "促进药性融合" },
    { action_id: "steady_furnace", label: "稳炉", desc: "稳定丹炉" },
    { action_id: "purify", label: "提纯", desc: "提高药液纯度" },
    { action_id: "condense", label: "凝丹", desc: "尝试成丹" },
  ];
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
    { action_id: "survey", label: "勘探", desc: "寻找矿脉弱点" },
    { action_id: "excavate", label: "开采", desc: "稳定开采矿脉" },
    { action_id: "careful_excavate", label: "精挖", desc: "提高稀有掉率" },
    { action_id: "support", label: "支护", desc: "降低坍塌风险" },
    { action_id: "clear", label: "清障", desc: "减轻负重或整理矿道" },
    { action_id: "rest", label: "休息", desc: "恢复体力" },
    { action_id: "leave", label: "撤离", desc: "带着收益离开" },
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

function forgeOptions(): MiniGameActionOption[] {
  return [
    { action_id: "heat", label: "加热", desc: "提高锻造热度" },
    { action_id: "hammer", label: "锻打", desc: "推进锻造进度" },
    { action_id: "align", label: "校正", desc: "恢复稳定性" },
    { action_id: "quench", label: "淬火", desc: "同步装备灵性" },
    { action_id: "infuse", label: "注灵", desc: "提高灵性同步" },
    { action_id: "finalize", label: "收工定型", desc: "完成本次强化" },
  ];
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
      const roles = ["狼人", "预言家", "女巫", "村民", "村民"];
      const roleMap: Record<string, string> = {};
      names.forEach((name, index) => {
        roleMap[name] = roles[index] || "村民";
      });
      const player = participants.find((item) => item.role_type === "player");
      if (player && !roleMap[player.role_name]) {
        roleMap[player.role_name] = "村民";
      }
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
          role_map: roleMap,
          wolf_target: "",
          seer_checks: [],
          witch_save_used: false,
          witch_poison_used: false,
        },
        resource_state: {},
        rng_state: {
          seed: `${ctx.world?.id || 0}:${ctx.chapter?.id || 0}:werewolf:${sessionId}`,
          cursor: 0,
          queue: buildRngQueue(`${ctx.world?.id || 0}:${ctx.chapter?.id || 0}:werewolf:${sessionId}`),
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
      session.phase = nextWerewolfPlayerPhase(session);
      resolveWerewolfNightNpc(session);
      return session;
    },
    options: werewolfOptions,
    applyAction: werewolfStep,
  },
  fishing: {
    gameType: "fishing",
    displayName: "钓鱼",
    version: "1.0",
    goal: "通过控线与耐心把目标鱼获拉上岸",
    phaseOrder: ["prepare", "cast", "waiting", "hook_fight", "landing", "settling"],
    triggerTags: ["#钓鱼"],
    passivePatterns: [/钓鱼/, /去钓鱼/, /开始钓鱼/, /抛竿/],
    ruleSummary: "先抛竿等待，再控线与鱼角力。张力过高会断线，距离过远会脱钩。",
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
        bait_name: "基础鱼饵",
        stamina: 100,
        focus: 80,
        line_tension: 0,
        fish_distance: 0,
        hook_state: "idle",
      }),
      hidden_state: { target_fish_name: "", fish_stamina: 0, fish_power: 0, fish_escape_rate: 0, encounter_roll: 0, fish_rarity: "普通" },
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
    goal: "通过理论、原型与稳定性积累研发出技能蓝图",
    phaseOrder: ["theory_research", "prototype_test", "debug_refine", "finalize", "settling"],
    triggerTags: ["#研发技能"],
    passivePatterns: [/研发技能/, /研发.*技能/, /自创招式/, /开发技能/],
    ruleSummary: "理论、原型、稳定性三条线同时达标后才能定稿。轮次耗尽则只留下碎片或笔记。",
    setup: (ctx, sessionId, entrySource) => ({
      session_id: sessionId,
      game_type: "research_skill",
      rulebook_version: "1.0",
      status: "active",
      phase: "theory_research",
      round: 1,
      sub_turn: 0,
      entry_source: entrySource,
      chapter_id: Number(ctx.chapter?.id || 0) || null,
      scene_id: scalarText(ctx.chapter?.title) || "workbench",
      participants: buildParticipants(ctx, 1),
      public_state: buildSimplePublicState({ target_skill_name: "新技能蓝图", complexity: 2, theory_progress: 0, prototype_progress: 0, stability_score: 70, turn_left: 6 }),
      hidden_state: { inspiration_roll: 0, failure_threshold: 60, synergy_bonus: 0, mentor_bonus: 0 },
      resource_state: {},
      rng_state: { seed: `${ctx.world?.id || 0}:${ctx.chapter?.id || 0}:research_skill:${sessionId}`, cursor: 0, queue: buildRngQueue(`${ctx.world?.id || 0}:${ctx.chapter?.id || 0}:research_skill:${sessionId}`) },
      action_log_ids: [], result: "ongoing", finish_reason: "", reward_preview: {}, writeback_whitelist: ["skill_unlocks", "memory_state.mid_term"], can_suspend: true, can_quit: true, resume_token: `resume_${sessionId}`,
    }),
    options: researchOptions,
    applyAction: researchStep,
  },
  alchemy: {
    gameType: "alchemy",
    displayName: "炼药",
    version: "1.0",
    goal: "控制火候、药性与稳定度，最终成功凝丹",
    phaseOrder: ["heat_control", "fusion", "refine", "condense", "settling"],
    triggerTags: ["#炼药"],
    passivePatterns: [/炼药/, /炼丹/, /开炉炼药/],
    ruleSummary: "围绕热度、纯度、融合、毒性、稳定度推进。毒性爆表或稳定归零即失败。",
    setup: (ctx, sessionId, entrySource) => ({
      session_id: sessionId,
      game_type: "alchemy",
      rulebook_version: "1.0",
      status: "active",
      phase: "heat_control",
      round: 1,
      sub_turn: 0,
      entry_source: entrySource,
      chapter_id: Number(ctx.chapter?.id || 0) || null,
      scene_id: scalarText(ctx.chapter?.title) || "alchemy_furnace",
      participants: buildParticipants(ctx, 1),
      public_state: buildSimplePublicState({ heat: 50, purity: 20, fusion: 15, toxicity: 0, stability: 65 }),
      hidden_state: { recipe_name: "基础丹方", target_heat: 65 },
      resource_state: {},
      rng_state: { seed: `${ctx.world?.id || 0}:${ctx.chapter?.id || 0}:alchemy:${sessionId}`, cursor: 0, queue: buildRngQueue(`${ctx.world?.id || 0}:${ctx.chapter?.id || 0}:alchemy:${sessionId}`) },
      action_log_ids: [], result: "ongoing", finish_reason: "", reward_preview: {}, writeback_whitelist: ["player_state.inventory", "memory_state.mid_term"], can_suspend: true, can_quit: true, resume_token: `resume_${sessionId}`,
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
    ruleSummary: "危险度越高、稳定度越低，坍塌风险越大。优先允许玩家带伤撤离，不直接破坏主线。",
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
  upgrade_equipment: {
    gameType: "upgrade_equipment",
    displayName: "升级装备",
    version: "1.0",
    goal: "通过短回合锻造降低失败风险并完成装备升级",
    phaseOrder: ["heat_up", "forge", "temper", "infuse", "finalize", "settling"],
    triggerTags: ["#升级装备"],
    passivePatterns: [/升级装备/, /强化装备/, /锻造装备/],
    ruleSummary: "热度、进度、稳定、灵性同步共同决定结果。MVP 默认不掉级，失败主要扣材料与耐久。",
    setup: (ctx, sessionId, entrySource) => ({
      session_id: sessionId,
      game_type: "upgrade_equipment",
      rulebook_version: "1.0",
      status: "active",
      phase: "heat_up",
      round: 1,
      sub_turn: 0,
      entry_source: entrySource,
      chapter_id: Number(ctx.chapter?.id || 0) || null,
      scene_id: scalarText(ctx.chapter?.title) || "forge",
      participants: buildParticipants(ctx, 1),
      public_state: buildSimplePublicState({ equip_id: "equip_current", equip_name: "当前装备", equip_type: "武器", current_level: 0, target_level: 1, forge_heat: 40, forge_progress: 0, stability: 70, spirit_sync: 10 }),
      hidden_state: { optimal_heat_min: 60, optimal_heat_max: 80, failure_risk: 20, bonus_affix_roll: 0 },
      resource_state: {},
      rng_state: { seed: `${ctx.world?.id || 0}:${ctx.chapter?.id || 0}:upgrade_equipment:${sessionId}`, cursor: 0, queue: buildRngQueue(`${ctx.world?.id || 0}:${ctx.chapter?.id || 0}:upgrade_equipment:${sessionId}`) },
      action_log_ids: [], result: "ongoing", finish_reason: "", reward_preview: {}, writeback_whitelist: ["player_state.inventory", "memory_state.mid_term"], can_suspend: true, can_quit: true, resume_token: `resume_${sessionId}`,
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
  const options = rulebook.options(session);
  session.player_options = options;
  ui.narration = narration;
  ui.player_options = options;
  ui.status_text = `第 ${Number(session.round || 1)} 轮 · ${scalarText(session.phase) || "进行中"}`;
  ui.rule_summary = rulebook.ruleSummary;
  root.session = session;
  root.ui = ui;
}

function buildStartNarration(rulebook: MiniGameRulebook, session: JsonRecord): string {
  const publicState = asRecord(session.public_state);
  if (rulebook.gameType === "werewolf") {
    const player = asArray<JsonRecord>(session.participants).find((item) => item.role_type === "player");
    const roleMap = asRecord(asRecord(session.hidden_state).role_map);
    const playerRole = scalarText(roleMap[player?.role_name || "用户"]) || "村民";
    return `小游戏已开始：${rulebook.displayName}。你的身份是 ${playerRole}。当前阶段：${scalarText(session.phase)}。`;
  }
  return `小游戏已开始：${rulebook.displayName}。当前阶段：${scalarText(session.phase)}。可见状态：${summarizePublicState(publicState) || "暂无"}。`;
}

function normalizeActionId(input: string, options: MiniGameActionOption[]): string | null {
  const text = scalarText(input).replace(/^#/, "").trim();
  if (!text) return null;
  const exact = options.find((item) => text === item.action_id || text === item.label);
  if (exact) return exact.action_id;
  const aliasMatch = options.find((item) => (item.aliases || []).some((alias) => text === alias || text.includes(alias)));
  if (aliasMatch) return aliasMatch.action_id;
  const fuzzy = options.find((item) => text.includes(item.label) || item.label.includes(text) || text.includes(item.action_id));
  return fuzzy?.action_id || null;
}

function buildStatusNarration(root: JsonRecord, rulebook: MiniGameRulebook): string {
  const session = asRecord(root.session);
  const publicState = asRecord(session.public_state);
  return `${rulebook.displayName}当前处于 ${scalarText(session.phase)}，第 ${Number(session.round || 1)} 轮。公开状态：${summarizePublicState(publicState) || "暂无"}。`;
}

function buildRuleNarration(rulebook: MiniGameRulebook): string {
  return `${rulebook.displayName}规则：${rulebook.ruleSummary}`;
}

export async function handleMiniGameTurn(input: MiniGameControllerInput): Promise<MiniGameControllerResult | null> {
  const state = input.state;
  const root = ensureMiniGameRoot(state);
  const activeSession = asRecord(root.session);
  const hasActiveGame = isMiniGameActiveState(state);

  if (!hasActiveGame) {
    const detected = detectGameTrigger(input.playerMessage, input.recentMessages);
    if (!detected) return null;
    const rulebook = RULEBOOKS[detected.gameType];
    if (!rulebook) return null;
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
    return {
      intercepted: true,
      runtime: root,
      message: {
        role: scalarText(input.world?.narratorRole?.name) || "旁白",
        roleType: "narrator",
        eventType: "on_mini_game_start",
        content: narration,
        meta: buildMiniGameMeta(root),
      },
    };
  }

  const gameType = scalarText(activeSession.game_type);
  const rulebook = RULEBOOKS[gameType];
  if (!rulebook) return null;

  const controlAction = detectControlAction(input.playerMessage);
  if (controlAction === "view_status") {
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
      activeSession.status = "active";
    }
    const narration = buildStatusNarration(root, rulebook);
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
  if (controlAction === "request_quit") {
    activeSession.pending_exit = true;
    const narration = "当前小游戏仍在进行。若要放弃本局，请再输入“确认退出”。";
    refreshRuntimeUi(root, narration, rulebook);
    return {
      intercepted: true,
      runtime: root,
      message: {
        role: scalarText(input.world?.narratorRole?.name) || "旁白",
        roleType: "narrator",
        eventType: "on_mini_game_request_quit",
        content: narration,
        meta: buildMiniGameMeta(root),
      },
    };
  }
  if (controlAction === "confirm_quit" && activeSession.pending_exit) {
    activeSession.status = "aborted";
    activeSession.phase = "settling";
    activeSession.result = "aborted";
    activeSession.finish_reason = "玩家确认退出小游戏";
    activeSession.pending_exit = false;
    const narration = `你退出了 ${rulebook.displayName}。本局状态已保留为结束，可继续回到主线剧情。`;
    refreshRuntimeUi(root, narration, rulebook);
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
  const actionId = normalizeActionId(input.playerMessage, options);
  if (!actionId) {
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
