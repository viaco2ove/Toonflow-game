import {
  isFreeChapterRuntimeMode,
  JsonRecord,
  normalizeChapterRuntimeOutline,
  nowTs,
  parseJsonSafe,
  readChapterProgressState,
  readRuntimeCurrentEventState,
  setChapterProgressState,
  syncRuntimeCurrentEventFromChapterProgress,
  upsertRuntimeDynamicEventState,
  upsertRuntimeEventDigestState,
} from "@/lib/gameEngine";
import { DebugLogUtil } from "@/utils/debugLogUtil";
import u from "@/utils";

const FREE_TASK_MINI_GAME_TYPE = "task";

/**
 * 自由章节任务候选项。
 *
 * 用途：
 * - 把“给我推荐个任务”后旁白列出的 1~5 号选项结构化；
 * - 后续根据用户输入的序号或任务名，准确定位被领取的那一项。
 */
interface FreeChapterTaskOption {
  index: number;
  category: string;
  description: string;
  rawLine: string;
}

/**
 * 自由章节任务蓝图。
 *
 * 用途：
 * - 领取任务后，直接落成一个完整的动态事件；
 * - 供 UI、编排、事件进度检测统一读取“过程 / 成功条件 / 失败条件”。
 */
interface FreeChapterTaskBlueprint {
  taskTitle: string;
  eventSummary: string;
  objective: string;
  process: string[];
  successConditions: string[];
  failureConditions: string[];
  eventFacts: string[];
  source: "ai" | "fallback";
}

/**
 * 当前执行任务在参数卡里的展示结构。
 *
 * 用途：
 * - 角色详情需要直接展示“用户正在做什么任务”；
 * - 结构化保留标题、目标、成功/失败条件，便于后续记忆管理和调试复用。
 */
interface ExecutingTaskCardValue {
  title: string;
  category: string;
  objective: string;
  process: string[];
  successConditions: string[];
  failureConditions: string[];
  status: "doing" | "aborted" | "completed";
}

/**
 * 自由章节任务奖励。
 *
 * 用途：
 * - 任务成功后统一回写经验、金币和物品；
 * - 让旁白收尾文案与参数卡写回使用同一份奖励数据。
 */
interface FreeChapterTaskReward {
  exp: number;
  money: number;
  items: string[];
}

/**
 * 任务收尾后把当前事件指针切回“自由剧情等待输入”。
 *
 * 用途：
 * - 放弃/完成/失败任务后，旧的任务动态事件应只保留在历史窗口里，不能继续挂在当前事件指针上；
 * - 否则后续用户再说普通行动时，自由章节同步逻辑容易把静态“给我推荐个任务”引导 phase 重新捡回来。
 */
function enterFreeChapterWaitingState(state: JsonRecord, nextEventIndex: number): void {
  const currentProgress = readChapterProgressState(state);
  const normalizedEventIndex = Math.max(1, Number(nextEventIndex || 0));
  const waitingSummary = "自由剧情已开启，等待用户输入下一步行动";
  setChapterProgressState(state, {
    ...currentProgress,
    phaseId: "",
    phaseIndex: -1,
    eventIndex: normalizedEventIndex,
    eventKind: "scene",
    eventSummary: waitingSummary,
    eventStatus: "waiting_input",
    userNodeId: "",
    userNodeIndex: -1,
    userNodeStatus: "idle",
    pendingGoal: "自由剧情",
  });
  upsertRuntimeDynamicEventState(state, {
    eventIndex: normalizedEventIndex,
    phaseId: "",
    kind: "scene",
    flowType: "free_runtime",
    summary: waitingSummary,
    runtimeFacts: [],
    summarySource: "system",
    memorySummary: "",
    memoryFacts: [],
    status: "waiting_input",
    allowedRoles: [],
    userNodeId: "",
    updateTime: 0,
  });
  syncRuntimeCurrentEventFromChapterProgress(state);
}

/**
 * 在任务关键节点直接回写运行态记忆摘要，避免异步记忆刷新前仍沿用旧上下文。
 *
 * 用途：
 * - 用户刚接取 / 放弃 / 完成任务后，后续编排马上就会读取 memorySummary / memoryFacts；
 * - 如果这里只等异步记忆 agent 刷新，旁白很容易继续沿用“还在等推荐任务”这类旧语气；
 * - 因此这里先做一层即时、轻量的运行态记忆回写，异步记忆再在后台做长期整理。
 */
function updateImmediateTaskMemoryState(input: {
  state: JsonRecord;
  summary: string;
  facts: string[];
  addTags?: string[];
  removeTags?: string[];
}): void {
  input.state.memorySummary = scalarText(input.summary);
  input.state.memoryFacts = Array.from(new Set(
    (Array.isArray(input.facts) ? input.facts : [])
      .map((item) => scalarText(item))
      .filter(Boolean),
  ));
  const currentTags = Array.isArray(input.state.memoryTags)
    ? input.state.memoryTags.map((item) => scalarText(item)).filter(Boolean)
    : [];
  const removeTags = new Set((input.removeTags || []).map((item) => scalarText(item)).filter(Boolean));
  const nextTags = currentTags.filter((item) => !removeTags.has(item));
  for (const tag of (input.addTags || []).map((item) => scalarText(item)).filter(Boolean)) {
    if (!nextTags.includes(tag)) {
      nextTags.push(tag);
    }
  }
  input.state.memoryTags = nextTags;
}

/**
 * 自由章节任务结算结果。
 *
 * 用途：
 * - SessionService 需要知道本轮任务是否已经被判定为成功/失败；
 * - 如果已结算，还要拿到旁白收尾文案与奖励摘要，直接结束当前“任务小游戏”。
 */
export interface FreeChapterTaskResolutionResult {
  resolved: boolean;
  outcome: "success" | "failed";
  taskTitle: string;
  objective: string;
  narration: string;
  reward: FreeChapterTaskReward;
}

/**
 * 对单值文本做最小归一化，过滤 null / undefined / 空串。
 */
function scalarText(input: unknown): string {
  const text = String(input ?? "").trim();
  if (!text || text === "null" || text === "undefined") return "";
  return text;
}

/**
 * 将字符串数组做去重清洗。
 *
 * 用途：
 * - 奖励物品、参数卡物品、背包写回都需要避免重复空值；
 * - 这里统一做基础文本归一化，避免各处重复写过滤逻辑。
 */
function uniqueTexts(input: unknown[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of input) {
    const text = scalarText(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
  }
  return output;
}

/**
 * 把未知输入安全转成对象，避免多处重复判空。
 */
function asRecord(input: unknown): JsonRecord {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as JsonRecord
    : {};
}

/**
 * 把任务卡片压成一行可读文本，供参数卡和记忆摘要直接展示。
 */
function formatExecutingTaskSummary(task: ExecutingTaskCardValue): string {
  const title = scalarText(task.title);
  const objective = scalarText(task.objective);
  const statusLabel = task.status === "aborted"
    ? "已放弃"
    : task.status === "completed"
      ? "已完成"
      : "进行中";
  return [`${title}`, objective ? `目标：${objective}` : "", `状态：${statusLabel}`]
    .filter(Boolean)
    .join("｜");
}

/**
 * 读取或创建用户参数卡。
 *
 * 用途：
 * - 自由章节任务会直接把“正在执行的任务”写进参数卡；
 * - 这里统一兜底参数卡对象，避免每次都手动创建。
 */
function ensurePlayerParameterCard(state: JsonRecord): JsonRecord {
  const player = asRecord(state.player);
  const card = asRecord(player.parameterCardJson);
  player.parameterCardJson = card;
  state.player = player;
  return card;
}

/**
 * 计算任务奖励写入后的升级阈值。
 *
 * 用途：
 * - 自由任务奖励与小游戏奖励遵循同一套升级规则；
 * - 默认阈值采用 `level * 100`，最低不低于 100。
 */
function resolveTaskNextLevelExp(levelInput: number): number {
  const level = Math.max(1, Math.floor(levelInput));
  return Math.max(100, level * 100);
}

/**
 * 计算任务升级后的满血满蓝资源。
 *
 * 用途：
 * - 当任务奖励触发升级时，需要把 hp/mp 恢复到当前等级满值；
 * - 当前参数卡没有独立 max 字段，这里沿用现有统一公式。
 */
function resolveTaskFullResource(levelInput: number): number {
  const level = Math.max(1, Math.floor(levelInput));
  return 100 + level * 10;
}

/**
 * 规范化参数卡里的经验与升级结果。
 *
 * 用途：
 * - 任务奖励可能一次给出多段经验；
 * - 这里统一负责连续升级、扣减旧阈值，并在升级后恢复 hp/mp。
 */
function normalizeTaskParameterCardProgress(cardInput: JsonRecord): { card: JsonRecord; levelUps: number } {
  const card = { ...cardInput };
  const rawLevel = Number(card.level);
  let level = Number.isFinite(rawLevel) && rawLevel > 0 ? Math.floor(rawLevel) : 1;
  let exp = Math.max(0, Number(card.exp || 0));
  let nextLevelExp = Number(card.next_level_exp);
  if (!Number.isFinite(nextLevelExp) || nextLevelExp <= 0) {
    nextLevelExp = resolveTaskNextLevelExp(level);
  }
  nextLevelExp = Math.max(resolveTaskNextLevelExp(level), nextLevelExp);
  let levelUps = 0;
  while (exp >= nextLevelExp) {
    exp -= nextLevelExp;
    level += 1;
    nextLevelExp = resolveTaskNextLevelExp(level);
    levelUps += 1;
  }
  card.level = level;
  card.exp = exp;
  card.next_level_exp = nextLevelExp;
  if (levelUps > 0) {
    const fullResource = resolveTaskFullResource(level);
    card.hp = fullResource;
    card.mp = fullResource;
  }
  return { card, levelUps };
}

/**
 * 把“当前正在执行的任务”同步到用户参数卡。
 *
 * 用途：
 * - 角色详情和记忆管理都能直接从参数卡看到用户当前任务；
 * - 任务退出/完成时也能统一清理或改状态。
 */
function setExecutingTaskCardValue(state: JsonRecord, task: ExecutingTaskCardValue | null): void {
  const card = ensurePlayerParameterCard(state);
  if (!task) {
    delete card.executing_task;
    delete card.executingTask;
    return;
  }
  card.executing_task = {
    title: task.title,
    category: task.category,
    objective: task.objective,
    process: task.process,
    successConditions: task.successConditions,
    failureConditions: task.failureConditions,
    status: task.status,
    summary: formatExecutingTaskSummary(task),
  };
  console.log("[task-system] setExecutingTaskCardValue", {
    title: task.title,
    hasCard: !!card,
    hasCardActiveTaskId: !!card.activeTaskId,
    hasCardExecutingTask: !!card.executing_task,
    stateHasCard: !!(state.player as any)?.parameterCardJson,
  });
}

/**
 * 把任务追加到 taskList，并更新 activeTaskId 为新任务（如果是新激活的话）。
 *
 * 行为：
 * - 已有同 task_id 的项 → 仅更新 status 和 lastUpdate（避免重复追加）
 * - 没有同 task_id 的项 → 追加到 taskList 末尾
 * - 总长度超过 20 时，把最旧的"非 doing"任务归档（删除）
 *
 * 与 setExecutingTaskCardValue 互补：那个只管"当前焦点"，这个管"全部历史"。
 */
function appendTaskListEntry(
  state: JsonRecord,
  entry: {
    task_id: string;
    title: string;
    category: string;
    objective: string;
    status: "doing" | "completed" | "failed" | "aborted";
    createdAt?: number;
  },
  options?: { setActive?: boolean },
): void {
  const card = ensurePlayerParameterCard(state);
  const list = Array.isArray(card.taskList) ? (card.taskList as JsonRecord[]) : [];
  const existsIdx = list.findIndex((item) => scalarText((item as any)?.task_id) === entry.task_id);
  const record: JsonRecord = {
    task_id: entry.task_id,
    title: entry.title,
    category: entry.category,
    objective: entry.objective,
    status: entry.status,
    createdAt: entry.createdAt || nowTs(),
    updatedAt: nowTs(),
  };
  if (existsIdx >= 0) {
    list[existsIdx] = { ...list[existsIdx], ...record };
  } else {
    list.push(record);
  }
  // 超过 20 条时，归档最旧的非 doing 项
  if (list.length > 20) {
    const archiveIdx = list.findIndex((item) => scalarText((item as any)?.status) !== "doing");
    if (archiveIdx >= 0) list.splice(archiveIdx, 1);
  }
  card.taskList = list;
  if (options?.setActive) {
    card.activeTaskId = entry.task_id;
  }
  console.log("[task-system] appendTaskListEntry 写入", {
    taskId: entry.task_id,
    setActive: options?.setActive,
    finalActiveTaskId: card.activeTaskId,
    listLength: list.length,
  });
}

/**
 * 更新指定 task_id 在 taskList 中的状态（如 completed / failed / aborted）。
 * 同时如果该任务是当前 activeTaskId，则清空 activeTaskId（任务已结束）。
 */
function updateTaskListEntryStatus(
  state: JsonRecord,
  taskId: string,
  status: "doing" | "completed" | "failed" | "aborted",
): void {
  if (!taskId) return;
  const card = ensurePlayerParameterCard(state);
  const list = Array.isArray(card.taskList) ? (card.taskList as JsonRecord[]) : [];
  const idx = list.findIndex((item) => scalarText((item as any)?.task_id) === taskId);
  if (idx >= 0) {
    list[idx] = { ...list[idx], status, updatedAt: nowTs() };
    card.taskList = list;
  }
  if (scalarText(card.activeTaskId) === taskId && status !== "doing") {
    delete card.activeTaskId;
  }
}

/**
 * 将当前任务写入任务面板运行态，复用小游戏面板展示任务信息。
 *
 * 用途：
 * - 用户接任务后直接复用现有 miniGame 面板，不再额外造一套“任务面板”；
 * - 但任务本身不拦截普通输入，只用面板展示当前任务状态，并通过 #退出 放弃任务。
 */
function setFreeTaskMiniGameState(input: {
  state: JsonRecord;
  blueprint: FreeChapterTaskBlueprint;
  option: FreeChapterTaskOption;
  eventIndex: number;
}): void {
  const root = asRecord(input.state.miniGame);
  root.rulebook = {
    gameType: FREE_TASK_MINI_GAME_TYPE,
    displayName: "任务",
    version: "v1",
  };
  root.session = {
    game_type: FREE_TASK_MINI_GAME_TYPE,
    status: "active",
    phase: "执行中",
    round: 1,
    event_index: input.eventIndex,
    can_suspend: false,
    can_quit: true,
    public_state: {
      task_title: input.blueprint.taskTitle,
      task_category: scalarText(input.option.category) || "自由任务",
      task_description: scalarText(input.option.description),
      current_objective: input.blueprint.objective,
      process_steps: input.blueprint.process,
      success_conditions: input.blueprint.successConditions,
      failure_conditions: input.blueprint.failureConditions,
      current_status: "进行中",
    },
    writeback_whitelist: [],
  };
  root.writeback = {};
  root.memorySummary = `正在执行任务：${input.blueprint.taskTitle}`;
  root.ui = {
    narration: scalarText(input.blueprint.eventSummary),
    phase_label: "任务进行中",
    rule_summary: "当前处于任务执行状态。直接输入你的行动推进任务；输入 #退出 视为放弃当前任务并退出任务面板。",
    accepts_text_input: true,
    input_hint: "当前正在执行任务。直接输入你的行动推进任务；输入 #退出 可放弃当前任务。",
    state_items: [
      { key: "任务标题", value: input.blueprint.taskTitle },
      { key: "任务分类", value: scalarText(input.option.category) || "自由任务" },
      { key: "当前目标", value: input.blueprint.objective },
      { key: "推进过程", value: input.blueprint.process.join("；") },
      { key: "成功条件", value: input.blueprint.successConditions.join("；") },
      { key: "失败条件", value: input.blueprint.failureConditions.join("；") },
    ],
  };
  input.state.miniGame = root;
}

/**
 * 清空任务面板运行态。
 *
 * 用途：
 * - 任务被放弃或结束后，面板不能继续残留在会话里；
 * - 复用小游戏面板时，必须明确把 task 类型运行态回收干净。
 */
function clearFreeTaskMiniGameState(state: JsonRecord): void {
  const root = asRecord(state.miniGame);
  const session = asRecord(root.session);
  if (scalarText(session.game_type) !== FREE_TASK_MINI_GAME_TYPE) {
    return;
  }
  root.session = {};
  root.rulebook = {};
  root.ui = {};
  root.writeback = {};
  root.memorySummary = "";
  root.actionLog = [];
  state.miniGame = root;
}

/**
 * 去掉模型可能包裹的 markdown 代码块，方便做 JSON 解析。
 */
function unwrapModelText(input: unknown): string {
  return scalarText(input)
    .replace(/^```(?:json|yaml|txt|text|markdown)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

/**
 * 将自由章节的任务名称压成适合展示的短标题。
 *
 * 用途：
 * - 原始推荐任务往往是一整句自然语言；
 * - 事件面板需要一个稳定、可读的标题，而不是把整句都塞进标题栏。
 */
function buildTaskTitle(option: FreeChapterTaskOption): string {
  const category = scalarText(option.category);
  const description = scalarText(option.description);
  const shortDescription = description
    .replace(/[。！!？?].*$/u, "")
    .replace(/[，,；;].*$/u, "")
    .trim();
  if (category && shortDescription) {
    return `【${category}】${shortDescription}`;
  }
  return shortDescription || category || `任务${option.index}`;
}

/**
 * 归一化成“便于模糊匹配”的文本。
 */
function normalizeSelectionText(input: unknown): string {
  return scalarText(input)
    .replace(/[【】\[\]\(\)（）\s:：,.，。!！?？"'“”‘’、;；\-—]/gu, "")
    .toLowerCase();
}

/**
 * 解析单段旁白文本里的任务选项列表。
 *
 * 用途：
 * - 支持 `1. 【历练类】：...` / `2、【探索类】：...` 这类格式；
 * - 同时容忍模型把任务列表拆成多段消息发出来。
 */
function parseFreeChapterTaskOptionsFromText(content: string): FreeChapterTaskOption[] {
  const lines = scalarText(content)
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  const options: FreeChapterTaskOption[] = [];
  for (const line of lines) {
    const matched = line.match(/^(\d{1,2})\s*[\.、]\s*(?:【([^】]+)】\s*[:：]?)?\s*(.+)$/u);
    if (!matched) continue;
    const index = Number(matched[1] || 0);
    const category = scalarText(matched[2]);
    const description = scalarText(matched[3]);
    if (!Number.isFinite(index) || index <= 0 || !description) continue;
    options.push({
      index,
      category,
      description,
      rawLine: line,
    });
  }
  return options;
}

/**
 * 从最近对话里收集最近一轮任务推荐产生的全部候选项。
 *
 * 用途：
 * - 旁白可能把 5 个任务拆成两条消息发出；
 * - 这里按序号合并，拿到完整的 1~5 候选任务。
 */
function collectRecentFreeChapterTaskOptions(
  recentMessages: Array<{
    role?: string | null;
    roleType?: string | null;
    content?: string | null;
  }>,
): FreeChapterTaskOption[] {
  const taskMap = new Map<number, FreeChapterTaskOption>();
  const narratorMessages = recentMessages
    .filter((item) => scalarText(item.roleType).toLowerCase() === "narrator")
    .slice(-6);
  for (const message of narratorMessages) {
    const parsed = parseFreeChapterTaskOptionsFromText(scalarText(message.content));
    for (const item of parsed) {
      taskMap.set(item.index, item);
    }
  }
  return [...taskMap.values()].sort((a, b) => a.index - b.index);
}

/**
 * 根据用户这次输入，定位他领取的是哪一个任务。
 *
 * 用途：
 * - 优先识别纯数字输入 `1/2/3`；
 * - 再回退到任务标题、分类名、描述片段匹配，兼容用户直接点整句任务名。
 */
function resolveSelectedFreeChapterTask(
  playerMessage: string,
  options: FreeChapterTaskOption[],
): FreeChapterTaskOption | null {
  const normalizedMessage = scalarText(playerMessage);
  if (!normalizedMessage || !options.length) return null;
  const matchedIndex = normalizedMessage.match(/^\s*(\d{1,2})\s*$/u);
  if (matchedIndex) {
    const index = Number(matchedIndex[1] || 0);
    return options.find((item) => item.index === index) || null;
  }
  const normalizedNeedle = normalizeSelectionText(normalizedMessage);
  if (!normalizedNeedle) return null;
  return options.find((item) => {
    const rawLine = normalizeSelectionText(item.rawLine);
    const category = normalizeSelectionText(item.category);
    const description = normalizeSelectionText(item.description);
    const title = normalizeSelectionText(buildTaskTitle(item));
    return (
      rawLine.includes(normalizedNeedle)
      || title.includes(normalizedNeedle)
      || (category && normalizedNeedle.includes(category))
      || (description && normalizedNeedle.includes(description.slice(0, Math.min(description.length, 12))))
    );
  }) || null;
}

/**
 * 生成规则兜底版任务过程。
 *
 * 用途：
 * - AI 失败时，仍给自由任务一个可以推进的结构化过程；
 * - 保证任务领取逻辑不会因为模型不可用而退化成“一句确认”。
 */
function buildFallbackTaskProcess(option: FreeChapterTaskOption): string[] {
  const description = scalarText(option.description);
  if (/(护送|押运|送达|运回)/u.test(description)) {
    return [
      "前往约定地点与委托方会合，确认护送目标与路线。",
      "护送途中警戒埋伏、魔兽或流寇干扰，确保人员与物资安全。",
      "把目标安全送达指定地点后，回报任务结果并领取后续反馈。",
    ];
  }
  if (/(采集|收集|寻找药材|矿石|材料)/u.test(description)) {
    return [
      "前往任务指定区域，先确认目标素材的分布和周边风险。",
      "在保证自身安全的前提下完成采集，并处理沿途突发威胁。",
      "带着足量目标素材返回交付点，完成验收与结算。",
    ];
  }
  if (/(调查|探查|搜索|侦查|打听)/u.test(description)) {
    return [
      "前往目标区域，优先确认地形、人员与异常气息分布。",
      "逐步搜集关键线索、痕迹或证物，避免惊动潜在威胁。",
      "带着可验证的情报返回汇报，推动后续行动展开。",
    ];
  }
  if (/(切磋|挑战|击退|清理|剿灭|对抗)/u.test(description)) {
    return [
      "先抵达任务区域并确认对手或威胁的真实强度。",
      "根据自身修为选择正面应战、试探压制或逐步清理。",
      "完成指定战斗目标后退出战场，确认战果并回报结果。",
    ];
  }
  return [
    "前往任务指定地点，与相关人物或目标建立联系。",
    "按任务要求逐步推进过程，处理途中出现的阻碍与变化。",
    "完成交付、确认或回报后，判定任务是否正式结束。",
  ];
}

/**
 * 生成规则兜底版成功条件。
 */
function buildFallbackSuccessConditions(option: FreeChapterTaskOption): string[] {
  const description = scalarText(option.description);
  return [
    `完成任务核心要求：${description}`,
    "关键目标、关键人物或关键物资保持可交付状态。",
    "返回交付点并得到任务相关方确认，视为本事件完成。",
  ];
}

/**
 * 生成规则兜底版失败条件。
 */
function buildFallbackFailureConditions(option: FreeChapterTaskOption): string[] {
  const description = scalarText(option.description);
  return [
    `未能完成任务核心要求：${description}`,
    "关键目标丢失、被毁、死亡或失去交付价值。",
    "用户主动放弃任务，或因重伤撤退导致任务中断。",
  ];
}

/**
 * 构造无模型时的自由任务蓝图。
 */
function buildFallbackFreeChapterTaskBlueprint(option: FreeChapterTaskOption): FreeChapterTaskBlueprint {
  const taskTitle = buildTaskTitle(option);
  const objective = scalarText(option.description) || taskTitle;
  const process = buildFallbackTaskProcess(option);
  const successConditions = buildFallbackSuccessConditions(option);
  const failureConditions = buildFallbackFailureConditions(option);
  return {
    taskTitle,
    eventSummary: `@旁白：任务【${taskTitle}】已开启。${objective}`,
    objective,
    process,
    successConditions,
    failureConditions,
    eventFacts: [
      `任务标题：${taskTitle}`,
      `当前目标：${objective}`,
      `过程：${process.join("；")}`,
      `成功条件：${successConditions.join("；")}`,
      `失败条件：${failureConditions.join("；")}`,
    ],
    source: "fallback",
  };
}

/**
 * 读取当前正在执行的自由章节任务。
 */
export function readActiveFreeTaskState(state: JsonRecord): JsonRecord {
  return asRecord(asRecord(state.vars).activeFreeTask);
}

/**
 * 判断故事编排模型是否已配置。
 */
function hasConfiguredNarrativeModel(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  return Boolean(scalarText((input as Record<string, unknown>).manufacturer));
}

/**
 * 根据任务分类生成默认奖励。
 *
 * 用途：
 * - 当模型没有明确给出奖励时，任务系统仍需能稳定发放一套基础奖励；
 * - 保证任务完成后一定有经验/金币反馈，并可按任务类型附带少量物品。
 */
function buildDefaultFreeTaskReward(activeTask: JsonRecord): FreeChapterTaskReward {
  const category = scalarText(activeTask.category);
  const title = scalarText(activeTask.title);
  const composite = `${category} ${title}`;
  if (/(恩怨|对抗|剿灭|战斗|历练)/u.test(composite)) {
    return { exp: 56, money: 22, items: ["战利品"] };
  }
  if (/(药材|采集)/u.test(composite)) {
    return { exp: 42, money: 18, items: ["基础药材"] };
  }
  if (/(交易|坊市|押运)/u.test(composite)) {
    return { exp: 36, money: 28, items: ["委托凭据"] };
  }
  if (/(修炼|成长)/u.test(composite)) {
    return { exp: 48, money: 10, items: ["修炼心得"] };
  }
  if (/(探索|探查|侦查)/u.test(composite)) {
    return { exp: 44, money: 16, items: ["情报记录"] };
  }
  return { exp: 32, money: 12, items: [] };
}

/**
 * 把任务奖励写回到用户参数卡与背包。
 *
 * 用途：
 * - 自由任务成功后要即时发放经验、金币和战利品；
 * - 这里统一处理升级、背包去重和参数卡同步，避免 SessionService 里堆业务细节。
 */
function applyFreeTaskRewardToState(state: JsonRecord, reward: FreeChapterTaskReward): { reward: FreeChapterTaskReward; levelUps: number } {
  const normalizedReward: FreeChapterTaskReward = {
    exp: Math.max(0, Math.floor(Number(reward.exp || 0))),
    money: Math.max(0, Math.floor(Number(reward.money || 0))),
    items: uniqueTexts(Array.isArray(reward.items) ? reward.items : []),
  };
  const card = ensurePlayerParameterCard(state);
  card.level = Number.isFinite(Number(card.level)) ? Number(card.level) : 1;
  card.exp = Math.max(0, Number(card.exp || 0)) + normalizedReward.exp;
  card.money = Math.max(0, Number(card.money || 0)) + normalizedReward.money;
  card.items = uniqueTexts([
    ...((Array.isArray(card.items) ? card.items : []) as unknown[]),
    ...normalizedReward.items,
  ]);
  const normalizedProgress = normalizeTaskParameterCardProgress(card);
  const player = asRecord(state.player);
  player.parameterCardJson = normalizedProgress.card;
  state.player = player;
  if (normalizedReward.items.length) {
    const inventory = Array.isArray(state.inventory) ? state.inventory : [];
    const existedNames = new Set(
      inventory.map((item) => scalarText(asRecord(item).name)).filter(Boolean),
    );
    for (const itemName of normalizedReward.items) {
      if (existedNames.has(itemName)) continue;
      inventory.push({ kind: "task_reward", name: itemName });
      existedNames.add(itemName);
    }
    state.inventory = inventory;
  }
  return {
    reward: normalizedReward,
    levelUps: normalizedProgress.levelUps,
  };
}

/**
 * 依据当前任务与用户动作，做一层规则兜底判定。
 *
 * 用途：
 * - 即使模型不可用，也要能识别“拿下头目 / 击败首领 / 主动撤退”这类关键动作；
 * - 至少保证自由任务不会一直悬空，能在核心完成/失败动作时顺利收尾。
 */
function evaluateFreeTaskResolutionByRules(activeTask: JsonRecord, playerMessage: string): "success" | "failed" | "continue" {
  const normalizedMessage = normalizeSelectionText(playerMessage);
  if (!normalizedMessage) return "continue";
  if (/(#退出|放弃|撤退|逃跑|逃离|认输|中断任务|任务失败|被击退|重伤撤回)/u.test(playerMessage)) {
    return "failed";
  }
  const objective = scalarText(activeTask.objective);
  const successText = uniqueTexts([
    objective,
    ...((Array.isArray(activeTask.successConditions) ? activeTask.successConditions : []) as unknown[]),
    ...((Array.isArray(activeTask.process) ? activeTask.process : []) as unknown[]),
  ]).join("；");
  const normalizedSuccess = normalizeSelectionText(successText);
  const bossKeywords = /(头目|首领|核心头目|领头|匪首|首脑)/u;
  const killKeywords = /(暗杀|拿下|击败|斩杀|解决|制服|干掉|诛杀|除掉|教训|收拾)/u;
  if (bossKeywords.test(successText) && killKeywords.test(playerMessage)) {
    return "success";
  }
  if (/(交付|带回|送达|验收|汇报|回报|确认完成|完成委托|完成任务)/u.test(playerMessage) && /(返回|交付|汇报|确认)/u.test(successText)) {
    return "success";
  }
  if (normalizedSuccess && normalizedMessage.length >= 2 && normalizedSuccess.includes(normalizedMessage)) {
    return "success";
  }
  return "continue";
}

/**
 * 用模型判断当前任务是否已经成功/失败。
 *
 * 用途：
 * - 自由任务的完成动作高度开放，单靠规则无法覆盖；
 * - 这里把任务描述、成功/失败条件、最近对话和本轮动作一起交给模型判定。
 */
async function evaluateFreeTaskResolutionByAi(input: {
  userId: number;
  world: any;
  chapter: any;
  state: JsonRecord;
  recentMessages: Array<{
    role?: string | null;
    roleType?: string | null;
    content?: string | null;
  }>;
  playerMessage: string;
  activeTask: JsonRecord;
}): Promise<{
  decision: "success" | "failed" | "continue";
  narration: string;
  reward: FreeChapterTaskReward;
} | null> {
  const modelConfig = await u.getPromptAi("storyOrchestratorModel", input.userId);
  if (!hasConfiguredNarrativeModel(modelConfig)) {
    return null;
  }
  const worldName = scalarText(input.world?.name);
  const chapterTitle = scalarText(input.chapter?.title);
  const playerCard = ensurePlayerParameterCard(input.state);
  const prompt = JSON.stringify({
    worldName,
    chapterTitle,
    activeTask: {
      title: scalarText(input.activeTask.title),
      category: scalarText(input.activeTask.category),
      objective: scalarText(input.activeTask.objective),
      process: Array.isArray(input.activeTask.process) ? input.activeTask.process : [],
      successConditions: Array.isArray(input.activeTask.successConditions) ? input.activeTask.successConditions : [],
      failureConditions: Array.isArray(input.activeTask.failureConditions) ? input.activeTask.failureConditions : [],
    },
    playerCard,
    recentMessages: input.recentMessages.slice(-8).map((item) => ({
      role: scalarText(item.role),
      roleType: scalarText(item.roleType),
      content: scalarText(item.content),
    })),
    currentUserAction: scalarText(input.playerMessage),
  }, null, 2);
  try {
    const result = await u.ai.text.invoke(
      {
        plainTextOutput: true,
        usageType: "自由任务结算判定",
        usageRemark: `${chapterTitle || "自由章节"} / ${scalarText(input.activeTask.title) || "任务结算"}`,
        usageMeta: {
          stage: "freeChapterTaskResolution",
          chapterId: Number(input.chapter?.id || 0),
          taskTitle: scalarText(input.activeTask.title),
        },
        messages: [
          {
            role: "system",
            content: [
              "你是互动故事中的任务裁决器。",
              "当前用户已经处于一个自由任务中，你要判断本轮动作是否已达成成功条件、触发失败条件，或仍应继续任务。",
              "只输出 JSON，不要解释，不要 markdown。",
              "JSON 结构固定为：",
              "{",
              '  "decision": "success | failed | continue",',
              '  "narration": "如果 success / failed，需要给出一段旁白收尾文案；continue 时返回空串即可",',
              '  "reward": { "exp": 经验整数, "money": 金钱整数, "items": ["物品1", "物品2"] }',
              "}",
              "规则：",
              "1. 只有明确满足成功条件时，decision 才能是 success。",
              "2. 只有明确命中失败条件或明显撤退/放弃/重伤败退时，decision 才能是 failed。",
              "3. 若用户动作只是过程推进，不足以完成任务，必须返回 continue。",
              "4. continue 时 narration 置空，reward 置为 0 和空数组。",
              "5. success 时 narration 必须是旁白收尾语气，并明确奖励已到账、任务结束。",
              "6. 失败时 narration 必须说明失败原因，并明确任务已结束。",
            ].join("\n"),
          },
          { role: "user", content: prompt },
        ],
        maxRetries: 0,
      },
      modelConfig as any,
    );
    const parsed = parseJsonSafe<JsonRecord>(unwrapModelText((result as any)?.text || ""), {});
    const decisionText = scalarText(parsed.decision).toLowerCase();
    const decision = decisionText === "success" || decisionText === "failed" || decisionText === "continue"
      ? decisionText as "success" | "failed" | "continue"
      : "continue";
    return {
      decision,
      narration: scalarText(parsed.narration),
      reward: {
        exp: Math.max(0, Math.floor(Number(asRecord(parsed.reward).exp || 0))),
        money: Math.max(0, Math.floor(Number(asRecord(parsed.reward).money || 0))),
        items: uniqueTexts(Array.isArray(asRecord(parsed.reward).items) ? asRecord(parsed.reward).items as unknown[] : []),
      },
    };
  } catch (error) {
    if (DebugLogUtil.isDebugLogEnabled()) {
      console.log("[story:free_task:resolution:error]", JSON.stringify({
        taskTitle: scalarText(input.activeTask.title),
        message: String((error as Error)?.message || error || ""),
      }));
    }
    return null;
  }
}

/**
 * 生成任务结算后的旁白文案。
 *
 * 用途：
 * - 任务成功/失败后，如果模型没有给出可直接展示的旁白文案，仍要有一段清晰收尾；
 * - 统一把奖励摘要、失败原因和“任务已结束”写清楚。
 */
function buildFallbackFreeTaskResolutionNarration(input: {
  outcome: "success" | "failed";
  activeTask: JsonRecord;
  reward: FreeChapterTaskReward;
  playerMessage: string;
}): string {
  const title = scalarText(input.activeTask.title) || "当前任务";
  if (input.outcome === "failed") {
    return `（局势骤然收紧，原本可掌控的节奏被打断）任务【${title}】已判定失败。你这次行动未能满足委托要求，当前任务就此结束，你已退出任务面板。`;
  }
  const rewardParts = [
    input.reward.exp > 0 ? `${input.reward.exp}经验` : "",
    input.reward.money > 0 ? `${input.reward.money}金钱` : "",
    input.reward.items.length ? input.reward.items.join("、") : "",
  ].filter(Boolean);
  return `（你刚才的行动已击中任务关键环节，局势迅速尘埃落定）任务【${title}】完成。奖励已发放：${rewardParts.join("、") || "基础战果"}。当前任务结束，你已退出任务面板，可继续自由行动。`;
}

/**
 * 为自由任务生成任务蓝图。
 *
 * 用途：
 * - 在用户正式领取任务时，把“任务简介”升级为可执行事件；
 * - 让当前事件拥有过程说明、成功条件和失败条件。
 */
async function generateFreeChapterTaskBlueprintByAi(input: {
  userId: number;
  world: any;
  chapter: any;
  state: JsonRecord;
  option: FreeChapterTaskOption;
}): Promise<FreeChapterTaskBlueprint | null> {
  const modelConfig = await u.getPromptAi("storyOrchestratorModel", input.userId);
  if (!hasConfiguredNarrativeModel(modelConfig)) {
    return null;
  }
  const taskTitle = buildTaskTitle(input.option);
  const playerCard = parseJsonSafe<JsonRecord>(input.state?.player?.parameterCardJson, {});
  const prompt = JSON.stringify({
    worldName: scalarText(input.world?.name),
    worldIntro: scalarText(input.world?.intro),
    chapterTitle: scalarText(input.chapter?.title),
    chapterDirective: scalarText(input.chapter?.content),
    memorySummary: scalarText(input.state?.memorySummary),
    memoryFacts: Array.isArray(input.state?.memoryFacts) ? input.state.memoryFacts : [],
    currentUserCard: playerCard,
    selectedTask: {
      index: input.option.index,
      category: input.option.category,
      description: input.option.description,
      rawLine: input.option.rawLine,
      taskTitle,
    },
    outputRules: {
      language: "zh-CN",
      maxProcessSteps: 4,
      maxSuccessConditions: 3,
      maxFailureConditions: 3,
    },
  }, null, 2);
  try {
    const result = await u.ai.text.invoke(
      {
        plainTextOutput: true,
        usageType: "自由章节任务蓝图",
        usageRemark: `${scalarText(input.chapter?.title) || "自由章节"} / ${taskTitle}`,
        usageMeta: {
          stage: "freeChapterTaskBlueprint",
          chapterId: Number(input.chapter?.id || 0),
          taskTitle,
        },
        messages: [
          {
            role: "system",
            content: [
              "你是互动故事中的自由章节任务设计器。",
              "用户已经正式选中了一个推荐任务，你要把这个任务扩展成一个当前可执行的事件蓝图。",
              "必须只输出 JSON，不要解释，不要 markdown，不要额外文本。",
              "JSON 结构固定为：",
              "{",
              '  "taskTitle": "任务标题",',
              '  "eventSummary": "@旁白：任务开启时本轮要展示的正文摘要",',
              '  "objective": "用户当前要完成的核心目标",',
              '  "process": ["过程1", "过程2", "过程3"],',
              '  "successConditions": ["成功条件1", "成功条件2"],',
              '  "failureConditions": ["失败条件1", "失败条件2"],',
              '  "eventFacts": ["任务标题：...", "当前目标：...", "过程：...", "成功条件：...", "失败条件：..."]',
              "}",
              "规则：",
              "1. 所有字段都必须使用中文。",
              "2. eventSummary 必须是当前事件开场摘要，不要写成系统提示，不要超过 90 字。",
              "3. objective 必须具体，直接说明用户现在要做什么。",
              "4. process 必须是 3~4 条可推进的过程，不要空泛。",
              "5. successConditions / failureConditions 必须能用于后续事件进度判断。",
              "6. 不要改动任务原意，只能细化任务。",
            ].join("\n"),
          },
          { role: "user", content: prompt },
        ],
        maxRetries: 0,
      },
      modelConfig as any,
    );
    const rawText = unwrapModelText((result as any)?.text || "");
    const parsed = parseJsonSafe<JsonRecord>(rawText, {});
    const process = Array.isArray(parsed.process)
      ? parsed.process.map((item) => scalarText(item)).filter(Boolean).slice(0, 4)
      : [];
    const successConditions = Array.isArray(parsed.successConditions)
      ? parsed.successConditions.map((item) => scalarText(item)).filter(Boolean).slice(0, 3)
      : [];
    const failureConditions = Array.isArray(parsed.failureConditions)
      ? parsed.failureConditions.map((item) => scalarText(item)).filter(Boolean).slice(0, 3)
      : [];
    const eventFacts = Array.isArray(parsed.eventFacts)
      ? parsed.eventFacts.map((item) => scalarText(item)).filter(Boolean).slice(0, 8)
      : [];
    const blueprint: FreeChapterTaskBlueprint = {
      taskTitle: scalarText(parsed.taskTitle) || taskTitle,
      eventSummary: scalarText(parsed.eventSummary),
      objective: scalarText(parsed.objective),
      process,
      successConditions,
      failureConditions,
      eventFacts,
      source: "ai",
    };
    if (!blueprint.eventSummary || !blueprint.objective || !blueprint.process.length || !blueprint.successConditions.length || !blueprint.failureConditions.length) {
      return null;
    }
    return blueprint;
  } catch (error) {
    if (DebugLogUtil.isDebugLogEnabled()) {
      console.log("[story:free_task:blueprint:error]", JSON.stringify({
        taskTitle,
        message: String((error as Error)?.message || error || ""),
      }));
    }
    return null;
  }
}

/**
 * 把自由任务蓝图写进当前运行态，正式创建一个新的动态事件。
 *
 * 用途：
 * - 当前静态“任务推荐”引导结束后，切换到真正的任务事件；
 * - 后续 UI / 编排 / 事件进度检测都围绕这个动态任务事件运行。
 */
function applyFreeChapterTaskBlueprintToState(input: {
  chapter: any;
  state: JsonRecord;
  option: FreeChapterTaskOption;
  blueprint: FreeChapterTaskBlueprint;
  /** T2.2: 可选 task_id；不传则自动生成。用于支持多任务列表追踪。 */
  taskId?: string;
}): { taskId: string } {
  const outline = normalizeChapterRuntimeOutline(input.chapter?.runtimeOutline);
  const currentProgress = readChapterProgressState(input.state);
  const currentEvent = readRuntimeCurrentEventState(input.state);
  const eventIndex = Math.max(
    outline.phases.length + 1,
    Number(currentProgress.eventIndex || currentEvent.index || 1) + 1,
  );
  const eventSummary = scalarText(input.blueprint.eventSummary) || `@旁白：任务【${input.blueprint.taskTitle}】已开启。`;
  const eventFacts = input.blueprint.eventFacts.length
    ? input.blueprint.eventFacts
    : [
      `任务标题：${input.blueprint.taskTitle}`,
      `当前目标：${input.blueprint.objective}`,
      `过程：${input.blueprint.process.join("；")}`,
      `成功条件：${input.blueprint.successConditions.join("；")}`,
      `失败条件：${input.blueprint.failureConditions.join("；")}`,
    ];
  setChapterProgressState(input.state, {
    phaseId: "",
    phaseIndex: outline.phases.length,
    eventIndex,
    eventKind: "scene",
    eventSummary,
    eventStatus: "active",
    userNodeId: "",
    userNodeIndex: -1,
    userNodeStatus: "idle",
    pendingGoal: input.blueprint.objective,
  });
  upsertRuntimeDynamicEventState(input.state, {
    eventIndex,
    phaseId: "",
    kind: "scene",
    flowType: "free_runtime",
    summary: eventSummary,
    runtimeFacts: eventFacts,
    summarySource: input.blueprint.source === "ai" ? "ai" : "system",
    memorySummary: `当前正在执行任务：${input.blueprint.taskTitle}`,
    memoryFacts: eventFacts,
    status: "active",
    allowedRoles: [],
    userNodeId: "",
    updateTime: nowTs(),
  });
  upsertRuntimeEventDigestState(input.state, {
    eventIndex,
    eventKind: "scene",
    eventFlowType: "free_runtime",
    eventSummary,
    eventFacts,
    eventStatus: "active",
    summarySource: input.blueprint.source === "ai" ? "ai" : "system",
    memorySummary: `当前正在执行任务：${input.blueprint.taskTitle}`,
    memoryFacts: eventFacts,
    updateTime: nowTs(),
  });
  const vars = typeof input.state.vars === "object" && input.state.vars && !Array.isArray(input.state.vars)
    ? input.state.vars as JsonRecord
    : {};
  vars.activeFreeTask = {
    title: input.blueprint.taskTitle,
    category: input.option.category,
    description: input.option.description,
    objective: input.blueprint.objective,
    process: input.blueprint.process,
    successConditions: input.blueprint.successConditions,
    failureConditions: input.blueprint.failureConditions,
    status: "doing",
    eventIndex,
    updateTime: nowTs(),
  };
  input.state.vars = vars;
  updateImmediateTaskMemoryState({
    state: input.state,
    summary: `用户已接取任务：${input.blueprint.taskTitle}`,
    facts: [
      `当前正在执行任务：${input.blueprint.taskTitle}`,
      `任务目标：${input.blueprint.objective}`,
      `任务分类：${scalarText(input.option.category) || "自由任务"}`,
    ],
    addTags: ["任务进行中", "自由行动阶段"],
    removeTags: ["等待任务推荐请求", "等待任务选择", "等待进入任务流程"],
  });
  setExecutingTaskCardValue(input.state, {
    title: input.blueprint.taskTitle,
    category: scalarText(input.option.category) || "自由任务",
    objective: input.blueprint.objective,
    process: input.blueprint.process,
    successConditions: input.blueprint.successConditions,
    failureConditions: input.blueprint.failureConditions,
    status: "doing",
  });
  // T2.2: 多任务列表追踪 —— 把新任务追加到 taskList 并设为 active
  const generatedTaskId = scalarText(input.taskId) || `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  appendTaskListEntry(input.state, {
    task_id: generatedTaskId,
    title: input.blueprint.taskTitle,
    category: scalarText(input.option.category) || "自由任务",
    objective: input.blueprint.objective,
    status: "doing",
  }, { setActive: true });
  // 校验 setActive 是否真的生效
  const cardForVerify = ensurePlayerParameterCard(input.state);
  console.log("[story:mini_game:task] applyFreeChapterTaskBlueprintToState 已写入", {
    taskId: generatedTaskId,
    activeTaskId: scalarText(cardForVerify.activeTaskId),
    taskListLength: Array.isArray(cardForVerify.taskList) ? cardForVerify.taskList.length : 0,
    executingTask: cardForVerify.executing_task ? scalarText((cardForVerify.executing_task as any).title) : null,
  });
  setFreeTaskMiniGameState({
    state: input.state,
    blueprint: input.blueprint,
    option: input.option,
    eventIndex,
  });
  syncRuntimeCurrentEventFromChapterProgress(input.state);
  return { taskId: generatedTaskId };
}

/**
 * 放弃当前自由章节任务。
 *
 * 用途：
 * - 用户在“任务面板”里输入 #退出 时，视为主动放弃当前任务；
 * - 需要同步更新参数卡、当前事件摘要和任务面板状态。
 */
export function abandonActiveFreeChapterTaskEvent(state: JsonRecord): JsonRecord | null {
  const activeTask = readActiveFreeTaskState(state);
  const title = scalarText(activeTask.title);
  const objective = scalarText(activeTask.objective);
  const eventIndex = Number(activeTask.eventIndex || 0);
  if (!title || !eventIndex) {
    clearFreeTaskMiniGameState(state);
    setExecutingTaskCardValue(state, null);
    return null;
  }
  const failureFacts = [
    `任务标题：${title}`,
    `当前目标：${objective || "未设置"}`,
    "任务状态：已放弃",
    "失败判定：用户主动输入 #退出，视为放弃当前任务",
  ];
  const currentProgress = readChapterProgressState(state);
  if (Number(currentProgress.eventIndex || 0) === eventIndex) {
    setChapterProgressState(state, {
      ...currentProgress,
      eventSummary: `@旁白：任务【${title}】已放弃。`,
      eventStatus: "completed",
      pendingGoal: "自由剧情",
    });
  }
  upsertRuntimeDynamicEventState(state, {
    eventIndex,
    phaseId: "",
    kind: "scene",
    flowType: "free_runtime",
    summary: `@旁白：任务【${title}】已放弃。`,
    runtimeFacts: failureFacts,
    summarySource: "system",
    memorySummary: `已放弃任务：${title}`,
    memoryFacts: failureFacts,
    status: "completed",
    allowedRoles: [],
    userNodeId: "",
    updateTime: nowTs(),
  });
  upsertRuntimeEventDigestState(state, {
    eventIndex,
    eventKind: "scene",
    eventFlowType: "free_runtime",
    eventSummary: `@旁白：任务【${title}】已放弃。`,
    eventFacts: failureFacts,
    eventStatus: "completed",
    summarySource: "system",
    memorySummary: `已放弃任务：${title}`,
    memoryFacts: failureFacts,
    updateTime: nowTs(),
  });
  const vars = asRecord(state.vars);
  vars.activeFreeTask = {
    ...activeTask,
    status: "aborted",
    updateTime: nowTs(),
  };
  state.vars = vars;
  updateImmediateTaskMemoryState({
    state,
    summary: `用户已放弃任务：${title}`,
    facts: failureFacts,
    addTags: ["自由行动阶段", "任务已放弃"],
    removeTags: ["任务进行中", "等待任务选择", "等待进入任务流程"],
  });
  setExecutingTaskCardValue(state, null);
  // T2.2: 标记 taskList 中对应 task 为 aborted（找当前 activeTaskId）
  const activeTaskIdForAbort = scalarText(ensurePlayerParameterCard(state).activeTaskId);
  if (activeTaskIdForAbort) {
    updateTaskListEntryStatus(state, activeTaskIdForAbort, "aborted");
  }
  clearFreeTaskMiniGameState(state);
  enterFreeChapterWaitingState(
    state,
    Math.max(Number(currentProgress.eventIndex || 0), eventIndex) + 1,
  );
  return {
    title,
    objective,
  };
}

/**
 * 尝试结算当前正在执行的自由章节任务。
 *
 * 用途：
 * - 用户在任务面板内输入普通行动后，优先判断这次动作是否已满足任务成功/失败条件；
 * - 一旦命中，就立刻发放奖励、结束任务事件、关闭任务面板，并阻止后续旁白继续把它当“自由剧情”处理。
 */
export async function maybeResolveActiveFreeChapterTaskEvent(input: {
  userId: number;
  world: any;
  chapter: any;
  state: JsonRecord;
  recentMessages: Array<{
    role?: string | null;
    roleType?: string | null;
    content?: string | null;
  }>;
  playerMessage: string;
}): Promise<FreeChapterTaskResolutionResult | null> {
  // T2.1: 移除 isFreeChapterRuntimeMode 检查 —— 任何章节里只要有活跃任务都需结算
  if (!input.chapter) {
    return null;
  }
  const activeTask = readActiveFreeTaskState(input.state);
  if (scalarText(activeTask.status) !== "doing") {
    return null;
  }
  const taskTitle = scalarText(activeTask.title);
  const objective = scalarText(activeTask.objective);
  const eventIndex = Number(activeTask.eventIndex || 0);
  if (!taskTitle || !objective || !Number.isFinite(eventIndex) || eventIndex <= 0) {
    return null;
  }
  const playerMessage = scalarText(input.playerMessage);
  if (!playerMessage) {
    return null;
  }
  const aiResolution = await evaluateFreeTaskResolutionByAi({
    userId: input.userId,
    world: input.world,
    chapter: input.chapter,
    state: input.state,
    recentMessages: input.recentMessages,
    playerMessage,
    activeTask,
  });
  const fallbackDecision = evaluateFreeTaskResolutionByRules(activeTask, playerMessage);
  const decision = aiResolution?.decision && aiResolution.decision !== "continue"
    ? aiResolution.decision
    : fallbackDecision;
  if (decision === "continue") {
    return null;
  }
  const currentProgress = readChapterProgressState(input.state);
  const resultReward = decision === "success"
    ? applyFreeTaskRewardToState(
      input.state,
      aiResolution?.reward && (aiResolution.reward.exp > 0 || aiResolution.reward.money > 0 || aiResolution.reward.items.length > 0)
        ? aiResolution.reward
        : buildDefaultFreeTaskReward(activeTask),
    )
    : { reward: { exp: 0, money: 0, items: [] }, levelUps: 0 };
  const rewardText = [
    resultReward.reward.exp > 0 ? `获得经验：${resultReward.reward.exp}` : "",
    resultReward.reward.money > 0 ? `获得金钱：${resultReward.reward.money}` : "",
    resultReward.reward.items.length ? `获得物品：${resultReward.reward.items.join("、")}` : "",
    resultReward.levelUps > 0 ? `等级提升：+${resultReward.levelUps}` : "",
  ].filter(Boolean);
  const resolvedFacts = [
    `任务标题：${taskTitle}`,
    `当前目标：${objective}`,
    `任务状态：${decision === "success" ? "已完成" : "失败"}`,
    `本轮动作：${playerMessage}`,
    ...(rewardText.length ? rewardText : []),
  ];
  const summary = decision === "success"
    ? `@旁白：任务【${taskTitle}】已完成。`
    : `@旁白：任务【${taskTitle}】失败。`;
  if (Number(currentProgress.eventIndex || 0) === eventIndex) {
    setChapterProgressState(input.state, {
      ...currentProgress,
      eventSummary: summary,
      eventStatus: "completed",
      pendingGoal: "自由剧情",
    });
  }
  upsertRuntimeDynamicEventState(input.state, {
    eventIndex,
    phaseId: "",
    kind: "scene",
    flowType: "free_runtime",
    summary,
    runtimeFacts: resolvedFacts,
    summarySource: "system",
    memorySummary: decision === "success" ? `已完成任务：${taskTitle}` : `任务失败：${taskTitle}`,
    memoryFacts: resolvedFacts,
    status: "completed",
    allowedRoles: [],
    userNodeId: "",
    updateTime: nowTs(),
  });
  upsertRuntimeEventDigestState(input.state, {
    eventIndex,
    eventKind: "scene",
    eventFlowType: "free_runtime",
    eventSummary: summary,
    eventFacts: resolvedFacts,
    eventStatus: "completed",
    summarySource: "system",
    memorySummary: decision === "success" ? `已完成任务：${taskTitle}` : `任务失败：${taskTitle}`,
    memoryFacts: resolvedFacts,
    updateTime: nowTs(),
  });
  const vars = asRecord(input.state.vars);
  vars.activeFreeTask = {
    ...activeTask,
    status: decision === "success" ? "completed" : "failed",
    reward: resultReward.reward,
    resolvedBy: playerMessage,
    updateTime: nowTs(),
  };
  input.state.vars = vars;
  updateImmediateTaskMemoryState({
    state: input.state,
    summary: decision === "success"
      ? `用户已完成任务：${taskTitle}`
      : `用户任务失败：${taskTitle}`,
    facts: resolvedFacts,
    addTags: ["自由行动阶段", decision === "success" ? "任务已完成" : "任务失败"],
    removeTags: ["任务进行中", "等待任务选择", "等待进入任务流程"],
  });
  setExecutingTaskCardValue(input.state, null);
  clearFreeTaskMiniGameState(input.state);
  enterFreeChapterWaitingState(
    input.state,
    Math.max(Number(currentProgress.eventIndex || 0), eventIndex) + 1,
  );
  const narration = scalarText(aiResolution?.narration) || buildFallbackFreeTaskResolutionNarration({
    outcome: decision,
    activeTask,
    reward: resultReward.reward,
    playerMessage,
  });
  return {
    resolved: true,
    outcome: decision,
    taskTitle,
    objective,
    narration,
    reward: resultReward.reward,
  };
}

/**
 * 检测“用户是否刚刚从自由章节推荐列表里选中了某个任务”，
 * 命中后立刻创建动态任务事件。
 */
export async function maybeActivateFreeChapterTaskEvent(input: {
  userId: number;
  world: any;
  chapter: any;
  state: JsonRecord;
  recentMessages: Array<{
    role?: string | null;
    roleType?: string | null;
    content?: string | null;
  }>;
  playerMessage: string;
}): Promise<boolean> {
  // T2.1: 移除 isFreeChapterRuntimeMode 检查 —— 任何章节都能创建任务
  if (!input.chapter) {
    return false;
  }
  const playerMessage = scalarText(input.playerMessage);
  if (!playerMessage) {
    return false;
  }
  const outline = normalizeChapterRuntimeOutline(input.chapter?.runtimeOutline);
  const currentProgress = readChapterProgressState(input.state);
  // 只有静态"任务推荐引导"阶段，才允许把用户输入解释成"领取某个任务"。
  // 一旦已经进入真正的动态任务事件，就不能再拿旧推荐列表重复抢占输入。
  if (Number(currentProgress.eventIndex || 0) > outline.phases.length) {
    return false;
  }
  const options = collectRecentFreeChapterTaskOptions(input.recentMessages);
  if (!options.length) {
    return false;
  }
  const selected = resolveSelectedFreeChapterTask(playerMessage, options);
  if (!selected) {
    return false;
  }
  const blueprint = await generateFreeChapterTaskBlueprintByAi({
    userId: input.userId,
    world: input.world,
    chapter: input.chapter,
    state: input.state,
    option: selected,
  }) || buildFallbackFreeChapterTaskBlueprint(selected);
  applyFreeChapterTaskBlueprintToState({
    chapter: input.chapter,
    state: input.state,
    option: selected,
    blueprint,
  });
  if (DebugLogUtil.isDebugLogEnabled()) {
    console.log("[story:free_task:activated]", JSON.stringify({
      title: blueprint.taskTitle,
      objective: blueprint.objective,
      source: blueprint.source,
      eventIndex: readChapterProgressState(input.state).eventIndex,
    }));
  }
  return true;
}

/**
 * 从用户直接输入创建任务（无需自由章节、无需旁白推荐列表）。
 *
 * 用法：用户输入 "#任务:到村长家偷鸡" 时调用本函数。
 * 与 maybeActivateFreeChapterTaskEvent 的区别：
 *   1) 不依赖 isFreeChapterRuntimeMode —— 任何章节都能创建
 *   2) 不依赖 collectRecentFreeChapterTaskOptions —— 不需要旁白先推荐
 *   3) 不依赖 resolveSelectedFreeChapterTask —— 直接用用户描述当 task_description
 *
 * 并发任务处理：
 *   - 如果已有 executing_task，会把新任务追加到 taskList，executing_task 保持不变
 *   - 新任务的 task_id 用 uuid 区分
 *   - 当前活跃 task 仍由 miniGame session 承载
 */
export interface CreateTaskFromUserRequestInput {
  userId: number;
  world: any;
  chapter: any;
  state: JsonRecord;
  userRequest: string;
  recentMessages?: Array<{ role?: string | null; content?: string | null }>;
}

export interface CreateTaskFromUserRequestResult {
  task_id: string;
  title: string;
  category: string;
  objective: string;
  process: string[];
  successConditions: string[];
  failureConditions: string[];
  status: "doing";
  /** 触发的选项来源: ai / fallback */
  source: "ai" | "fallback";
  /** 之前是否已有活跃任务（true 表示本次是追加） */
  hasActiveTask: boolean;
}

export async function createTaskFromUserRequest(
  input: CreateTaskFromUserRequestInput,
): Promise<CreateTaskFromUserRequestResult | null> {
  const description = scalarText(input.userRequest);
  if (!description) return null;

  // 合成 FreeChapterTaskOption（兼容现有 API）
  const syntheticOption: FreeChapterTaskOption = {
    index: 0,
    category: "自由任务",
    description,
    rawLine: description,
  };

  // T2.2: 在写 state 之前先检查是否已有活跃任务（之后 active 会被覆盖）
  const previousActive = readActiveFreeTaskState(input.state);
  const hadActive = Boolean(previousActive && scalarText((previousActive as any).title));

  // 调用 AI 生成 blueprint（如果失败用 fallback）
  let blueprint = await generateFreeChapterTaskBlueprintByAi({
    userId: input.userId,
    world: input.world,
    chapter: input.chapter,
    state: input.state,
    option: syntheticOption,
  });
  if (!blueprint) {
    blueprint = buildFallbackFreeChapterTaskBlueprint(syntheticOption);
  }

  // 写 state（不依赖 isFreeChapterRuntimeMode）—— applyFreeChapterTaskBlueprintToState
  // 已经把任务追加到 taskList 并 setActive，并返回最终的 taskId
  const { taskId } = applyFreeChapterTaskBlueprintToState({
    chapter: input.chapter,
    state: input.state,
    option: syntheticOption,
    blueprint,
  });

  return {
    task_id: taskId,
    title: blueprint.taskTitle,
    category: scalarText(syntheticOption.category) || "自由任务",
    objective: blueprint.objective,
    process: blueprint.process,
    successConditions: blueprint.successConditions,
    failureConditions: blueprint.failureConditions,
    status: "doing",
    source: blueprint.source === "ai" ? "ai" : "fallback",
    hasActiveTask: hadActive,
  };
}
