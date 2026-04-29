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
 * 对单值文本做最小归一化，过滤 null / undefined / 空串。
 */
function scalarText(input: unknown): string {
  const text = String(input ?? "").trim();
  if (!text || text === "null" || text === "undefined") return "";
  return text;
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
 * 判断故事编排模型是否已配置。
 */
function hasConfiguredNarrativeModel(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  return Boolean(scalarText((input as Record<string, unknown>).manufacturer));
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
}): void {
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
    memorySummary: "",
    memoryFacts: [],
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
  syncRuntimeCurrentEventFromChapterProgress(input.state);
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
  if (!input.chapter || !isFreeChapterRuntimeMode(input.chapter)) {
    return false;
  }
  const playerMessage = scalarText(input.playerMessage);
  if (!playerMessage) {
    return false;
  }
  const outline = normalizeChapterRuntimeOutline(input.chapter?.runtimeOutline);
  const currentProgress = readChapterProgressState(input.state);
  // 只有静态“任务推荐引导”阶段，才允许把用户输入解释成“领取某个任务”。
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
