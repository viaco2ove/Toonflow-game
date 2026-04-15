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

export interface ChapterDialogueLine {
  role: string;
  line: string;
}

export interface ChapterProgressState {
  chapterId: number; // 当前章节ID，用于区分不同章节的事件状态
  phaseId: string;
  phaseIndex: number;
  eventIndex: number;
  eventKind: "opening" | "scene" | "user" | "fixed" | "ending";
  eventSummary: string;
  eventStatus: "idle" | "active" | "waiting_input" | "completed";
  userNodeId: string;
  userNodeIndex: number;
  userNodeStatus: "idle" | "waiting_input" | "completed" | "skipped";
  completedEvents: string[]; // 格式: ["phase:{phaseId}", "userNode:{userNodeId}"]
  pendingGoal: string;
  fixedOutcomeLocked: boolean;
  lastEvaluatedMessageId: number;
}

export interface RuntimeCurrentEventState {
  index: number;
  kind: "opening" | "scene" | "user" | "fixed" | "ending";
  summary: string;
  facts: string[];
  status: "idle" | "active" | "waiting_input" | "completed";
}

export interface RuntimeDynamicEventState {
  eventIndex: number;
  phaseId: string;
  kind: "opening" | "scene" | "user" | "fixed" | "ending";
  flowType: "introduction" | "chapter_content" | "chapter_ending_check" | "free_runtime";
  summary: string;
  runtimeFacts: string[];
  summarySource: "phase" | "ai" | "memory" | "system";
  memorySummary: string;
  memoryFacts: string[];
  updateTime: number;
  status: "idle" | "active" | "waiting_input" | "completed";
  allowedRoles: string[];
  userNodeId: string;
}

export interface RuntimeEventDigestState {
  eventIndex: number;
  eventKind: RuntimeCurrentEventState["kind"];
  eventFlowType: RuntimeDynamicEventState["flowType"];
  eventSummary: string;
  eventFacts: string[];
  eventStatus: RuntimeCurrentEventState["status"];
  summarySource: RuntimeDynamicEventState["summarySource"];
  memorySummary: string;
  memoryFacts: string[];
  updateTime: number;
  allowedRoles: string[];
  userNodeId: string;
}

export interface RuntimeEventViewState {
  currentEventDigest: RuntimeEventDigestState;
  eventDigestWindow: RuntimeEventDigestState[];
  eventDigestWindowText: string;
}

// 根据事件类型和 phase 信息推断运行时事件所属的流程类型，
// 供事件窗口、编排输入和日志展示统一使用。
function resolveRuntimeEventFlowType(input: {
  eventKind: RuntimeCurrentEventState["kind"];
  phaseId?: string | null;
}): RuntimeDynamicEventState["flowType"] {
  if (input.eventKind === "opening") return "introduction";
  if (input.eventKind === "fixed" || input.eventKind === "ending") return "chapter_ending_check";
  if (!String(input.phaseId || "").trim()) return "free_runtime";
  return "chapter_content";
}

export interface RuntimeEventViewOptions {
  windowSize?: number | null;
  includeMemory?: boolean | null;
  summaryLimit?: number | null;
  factLimit?: number | null;
  memoryFactLimit?: number | null;
}

export interface ResolvedRuntimeEventViewOptions {
  windowSize: number;
  includeMemory: boolean;
  summaryLimit: number;
  factLimit: number;
  memoryFactLimit: number;
}

export const DEFAULT_RUNTIME_EVENT_VIEW_OPTIONS: ResolvedRuntimeEventViewOptions = {
  windowSize: 10,
  includeMemory: true,
  summaryLimit: 60,
  factLimit: 2,
  memoryFactLimit: 2,
};

export interface ChapterRuntimeUserNode {
  id: string;
  label: string;
  triggerHint: string;
  promptRole: string;
  promptText: string;
  suggestions: string[];
}

export interface ChapterRuntimePhase {
  id: string;
  label: string;
  kind: "opening" | "scene" | "user" | "fixed";
  targetSummary: string;
  userNodeId: string | null;
  allowedSpeakers: string[];
  nextPhaseIds: string[];
  defaultNextPhaseId: string | null;
  requiredEventIds: string[];
  completionEventIds: string[];
  advanceSignals: string[];
  relatedFixedEventIds: string[];
}

export interface ChapterRuntimeOutline {
  openingMessages: Array<{
    role: string;
    roleType: string;
    content: string;
  }>;
  phases: ChapterRuntimePhase[];
  userNodes: ChapterRuntimeUserNode[];
  fixedEvents: Array<{
    id: string;
    label: string;
    requiredBeforeFinish: boolean;
    conditionExpr?: unknown;
  }>;
  endingRules: {
    success: string[];
    failure: string[];
    nextChapterId: number | null;
  };
}

const DEFAULT_PLAYER_ROLE: JsonRecord = {
  id: "player",
  name: "用户",
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

// 判断任意 unknown 是否可以安全当作普通对象使用，
// 这是整份文件里所有 JSON 归一化的基础保护。
function isRecord(input: unknown): input is JsonRecord {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

// 将编辑器里可能出现的 string/number/boolean/object 统一压成可比较文本，
// 避免后续章节解析因为输入类型飘忽而出现 undefined/null 干扰。
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

// 判断一个字符串是否只是 null/undefined 这类“空值文本”，
// 用于区分“真的填了内容”和“只是字符串化的空值”。
function isNullLikeText(input: string): boolean {
  const text = String(input || "").trim().toLowerCase();
  return !text || text === "null" || text === "undefined";
}

// 从章节正文里提取“开场白：角色：台词”结构，
// 兼容编辑器里把开场白直接写在 content 顶部的旧数据。
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

// 提取正文里第一条 `@角色: 台词` 结构化对白，
// 主要用于章节解析和自动补齐运行时首个对白事件。
export function extractFirstChapterDialogueLine(input: unknown): ChapterDialogueLine | null {
  const text = normalizeEditorText(input);
  if (!text) return null;
  const paragraphs = splitParagraphs(text);
  for (const paragraph of paragraphs) {
    const lines = String(paragraph || "")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
    for (const line of lines) {
      const matched = line.match(/^@([^:\n：]+)\s*[:：]\s*(.+)$/);
      if (!matched) continue;
      const role = String(matched[1] || "").trim();
      const content = String(matched[2] || "").trim();
      if (!role || !content) continue;
      return {
        role,
        line: content,
      };
    }
  }
  return null;
}

// 将长文本按空行切成逻辑段落，
// 后续章节提纲、开场白清洗、运行时 section 提取都复用它。
function splitParagraphs(input: string): string[] {
  return String(input || "")
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// 把任意标题/标签压成稳定 runtime key，
// 便于生成 phase/userNode/fixedEvent 等可复用 ID。
function slugifyRuntimeKey(input: unknown, fallback: string): string {
  const text = normalizeEditorText(input)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return text || fallback;
}

// 解析正文里 `- 建议项` 列表，提取为用户建议数组。
function normalizeSuggestionList(input: string): string[] {
  return String(input || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => /^[-*]\s+/.test(item))
    .map((item) => item.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}

// 将一段正文压缩成适合事件摘要展示的短文本。
// 这里不能再把 `@旁白：` 这类显式说话者标记直接删掉，否则运行时 phase/事件摘要会丢失“谁在说”的关键信息。
function normalizeRuntimeSummary(input: string, fallback: string): string {
  const text = String(input || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const dialogueMatched = line.match(/^@([^:\n：]+)\s*[:：]\s*(.+)$/);
      if (dialogueMatched) {
        const speaker = String(dialogueMatched[1] || "").trim();
        const content = String(dialogueMatched[2] || "").trim();
        return speaker && content ? `@${speaker}：${content}` : line;
      }
      return line.replace(/^[-*]\s+/, "").trim();
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 80) || fallback;
}

// 去重并截断 phase 的推进信号，
// 防止正文太长时把 advanceSignals 塞爆。
function normalizePhaseSignalList(input: unknown[]): string[] {
  return Array.from(new Set(
    (Array.isArray(input) ? input : [])
      .map((item) => normalizeEditorText(item))
      .filter(Boolean)
      // 纯“旁白/用户/系统”这类角色占位词过宽，
      // 一旦被塞进 advanceSignals，就会在任意发言时误触发 phase 推进。
      .filter((item) => !isOverBroadPhaseSignal(item))
      .map((item) => item.slice(0, 80)),
  ));
}

// 过滤过宽的通用角色名信号，避免“只要旁白说话就进入下一事件”这类误推进。
function isOverBroadPhaseSignal(input: string): boolean {
  const text = normalizeEditorText(input).toLowerCase();
  if (!text) return false;
  return [
    "旁白",
    "用户",
    "系统",
    "narrator",
    "player",
    "system",
  ].includes(text);
}

// 将指令参数按换行、逗号、分号等分隔成数组，
// 供 `@phase_next`、`@allowed_speakers` 这类行内 DSL 复用。
function splitRuntimeDirectiveItems(input: string): string[] {
  return String(input || "")
    .replace(/\r\n/g, "\n")
    .split(/[\n,，;；|]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// 为用户节点生成统一的运行时完成标记。
function getUserNodeRuntimeMarker(userNodeId: string): string {
  return `user_node:${String(userNodeId || "").trim()}`;
}

// 为 phase 生成统一的运行时完成标记。
function getPhaseRuntimeMarker(phaseId: string): string {
  return `phase:${String(phaseId || "").trim()}`;
}

// 判断 section 标题是否是“用户行动/用户节点”一类交互段，
// 决定该段在运行时应转成 user phase。
function isUserNodeHeading(input: string): boolean {
  return /用户行动|用户交互|用户节点|唯一干预机会/u.test(String(input || ""));
}

// 判断 section 标题是否显式声明为“非事件”说明块。
// 这类块允许作者写补充说明、任务备注或编写提示，但不能进入运行时事件系统。
function isNonEventHeading(input: string): boolean {
  const heading = String(input || "").trim();
  if (!heading) return false;
  return /^非事件(?:\s*[:：].*)?$/u.test(heading);
}

// 将 markdown 风格的 `## 标题` 正文切成运行时 section，
// 章节运行时提纲解析完全依赖这个分段结果。
function extractRuntimeSections(input: unknown): Array<{ heading: string; body: string }> {
  const text = normalizeEditorText(input);
  if (!text) return [];
  const headingRegex = /^##\s*(.+)$/gm;
  const sections: Array<{ heading: string; body: string }> = [];
  const matches = Array.from(text.matchAll(headingRegex));
  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i];
    const next = matches[i + 1];
    const bodyStart = (current.index ?? 0) + current[0].length;
    const bodyEnd = next?.index ?? text.length;
    sections.push({
      heading: String(current[1] || "").trim(),
      body: text.slice(bodyStart, bodyEnd).trim(),
    });
  }
  return sections;
}

// 解析 section 正文里的运行时指令行，
// 把允许角色、下一阶段、阶段信号等 DSL 从正文里剥离出来。
function parsePhaseDirectiveLines(input: string): {
  cleanedBody: string;
  allowedSpeakers: string[];
  nextPhaseRefs: string[];
  defaultNextPhaseRef: string | null;
  requiredEventIds: string[];
  completionEventIds: string[];
  advanceSignals: string[];
  relatedFixedEventIds: string[];
} {
  const lines = String(input || "").replace(/\r\n/g, "\n").split("\n");
  const cleanedLines: string[] = [];
  const allowedSpeakers: string[] = [];
  const nextPhaseRefs: string[] = [];
  let defaultNextPhaseRef = "";
  const requiredEventIds: string[] = [];
  const completionEventIds: string[] = [];
  const advanceSignals: string[] = [];
  const relatedFixedEventIds: string[] = [];
  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line) {
      cleanedLines.push(rawLine);
      continue;
    }
    let matched = line.match(/^@(?:下一阶段|phase_next)\s*[:：]\s*(.+)$/i);
    if (matched) {
      nextPhaseRefs.push(...splitRuntimeDirectiveItems(String(matched[1] || "")));
      continue;
    }
    matched = line.match(/^@(?:默认下一阶段|default_next_phase)\s*[:：]\s*(.+)$/i);
    if (matched) {
      defaultNextPhaseRef = splitRuntimeDirectiveItems(String(matched[1] || ""))[0] || "";
      continue;
    }
    matched = line.match(/^@(?:允许角色|allowed_speakers)\s*[:：]\s*(.+)$/i);
    if (matched) {
      allowedSpeakers.push(...splitRuntimeDirectiveItems(String(matched[1] || "")));
      continue;
    }
    matched = line.match(/^@(?:阶段前置|phase_requires)\s*[:：]\s*(.+)$/i);
    if (matched) {
      requiredEventIds.push(...splitRuntimeDirectiveItems(String(matched[1] || "")));
      continue;
    }
    matched = line.match(/^@(?:阶段完成|phase_completion)\s*[:：]\s*(.+)$/i);
    if (matched) {
      completionEventIds.push(...splitRuntimeDirectiveItems(String(matched[1] || "")));
      continue;
    }
    matched = line.match(/^@(?:阶段信号|phase_signals)\s*[:：]\s*(.+)$/i);
    if (matched) {
      advanceSignals.push(...splitRuntimeDirectiveItems(String(matched[1] || "")));
      continue;
    }
    matched = line.match(/^@(?:关联结果|phase_fixed_events)\s*[:：]\s*(.+)$/i);
    if (matched) {
      relatedFixedEventIds.push(...splitRuntimeDirectiveItems(String(matched[1] || "")));
      continue;
    }
    cleanedLines.push(rawLine);
  }
  return {
    cleanedBody: cleanedLines.join("\n").trim(),
    allowedSpeakers: Array.from(new Set(allowedSpeakers)),
    nextPhaseRefs: Array.from(new Set(nextPhaseRefs)),
    defaultNextPhaseRef: defaultNextPhaseRef.trim() || null,
    requiredEventIds: Array.from(new Set(requiredEventIds)),
    completionEventIds: Array.from(new Set(completionEventIds)),
    advanceSignals: normalizePhaseSignalList(advanceSignals),
    relatedFixedEventIds: Array.from(new Set(relatedFixedEventIds)),
  };
}

// 将“阶段标题/slug/id”这类引用解析成真实 phaseId，
// 让正文里写的人类可读名称能正确指向运行时 phase。
function resolvePhaseReference(
  input: unknown,
  phases: Array<{ id: string; label: string }>,
): string | null {
  const raw = normalizeEditorText(input);
  if (!raw) return null;
  const normalizedRaw = raw.toLowerCase();
  const slug = slugifyRuntimeKey(raw, "");
  const matched = phases.find((item) => {
    const id = String(item.id || "").trim();
    const label = String(item.label || "").trim();
    return id === raw
      || id.toLowerCase() === normalizedRaw
      || label === raw
      || label.toLowerCase() === normalizedRaw
      || slugifyRuntimeKey(label, "") === slug;
  });
  return matched?.id || null;
}

// 从正文 section 中抽取用户节点定义，
// 用户节点会被挂到对应 user phase，用于后续等待输入和完成判定。
function extractRuntimeUserNodesFromContent(input: unknown): ChapterRuntimeUserNode[] {
  return extractRuntimeSections(input)
    // `## 非事件` 只作为章节编写说明存在，不能被识别成可交互用户节点。
    .filter((section) => !isNonEventHeading(section.heading))
    .filter((section) => isUserNodeHeading(section.heading))
    .map((section, index) => {
      const phaseDirectives = parsePhaseDirectiveLines(section.body);
      const promptRoleMatch = phaseDirectives.cleanedBody.match(/@([^:\n：]+)\s*[:：]/);
      return {
        id: `user_node_${index + 1}_${slugifyRuntimeKey(section.heading, String(index + 1))}`,
        label: section.heading,
        triggerHint: section.heading,
        promptRole: String(promptRoleMatch?.[1] || "系统").trim() || "系统",
        promptText: phaseDirectives.cleanedBody,
        suggestions: normalizeSuggestionList(phaseDirectives.cleanedBody),
      };
    });
}

// 从正文 section 的对白里提取角色和短句信号，
// 用于自动补足 phase 的推进信号，减少章节作者显式配置成本。
function extractDialogueSignalsFromSectionBody(input: string): string[] {
  const lines = String(input || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
  const signals: string[] = [];
  for (const line of lines) {
    const matched = line.match(/^@([^:\n：]+)\s*[:：]\s*(.+)$/);
    if (!matched) continue;
    const content = String(matched[2] || "").trim();
    // 这里只保留台词正文，不再把“旁白/用户”等角色名自动当作推进信号，
    // 否则同一角色任意开口都会把当前事件错误推进到下一阶段。
    if (content) signals.push(content.slice(0, 80));
  }
  return normalizePhaseSignalList(signals);
}

// 用 section 文本去猜测和哪些固定结果事件相关，
// 这是旧章节没有显式 `relatedFixedEventIds` 时的兜底关联策略。
function collectRelatedFixedEventIds(
  section: { heading: string; body: string },
  fixedEvents: ChapterRuntimeOutline["fixedEvents"],
): string[] {
  const sectionText = normalizeRuntimeSummary(`${section.heading}\n${section.body}`, section.heading);
  return fixedEvents
    .filter((item) => {
      const label = String(item.label || "").trim();
      if (!label) return false;
      return sectionText.includes(label) || label.includes(section.heading) || section.heading.includes(label);
    })
    .map((item) => item.id);
}

// 将章节正文解析成运行时 phase 列表。
// 如果章节作者没有显式写 runtimeOutline.phases，这里会根据 section 自动生成。
function extractRuntimePhasesFromContent(
  input: unknown,
  userNodes: ChapterRuntimeUserNode[],
  fixedEvents: ChapterRuntimeOutline["fixedEvents"],
): ChapterRuntimePhase[] {
  const sections = extractRuntimeSections(input)
    // `## 非事件` 是纯说明块，不参与 phase 生成，也不应该进入事件推进链。
    .filter((section) => !isNonEventHeading(section.heading));
  if (!sections.length) return [];
  const phaseDrafts: Array<ChapterRuntimePhase & {
    nextPhaseRefs: string[];
    defaultNextPhaseRef: string | null;
  }> = [];
  let userNodeCursor = 0;
  let previousPhaseId = "";
  sections.forEach((section, index) => {
    const phaseDirectives = parsePhaseDirectiveLines(section.body);
    const isUserPhase = isUserNodeHeading(section.heading);
    const userNode = isUserPhase ? userNodes[userNodeCursor] || null : null;
    if (isUserPhase) {
      userNodeCursor += 1;
    }
    const phaseId = `phase_${index + 1}_${slugifyRuntimeKey(section.heading, String(index + 1))}`;
    const relatedFixedEventIds = phaseDirectives.relatedFixedEventIds.length
      ? phaseDirectives.relatedFixedEventIds
      : collectRelatedFixedEventIds({
        heading: section.heading,
        body: phaseDirectives.cleanedBody,
      }, fixedEvents);
    phaseDrafts.push({
      id: phaseId,
      label: section.heading || `阶段 ${index + 1}`,
      kind: isUserPhase ? "user" : "scene",
      targetSummary: normalizeRuntimeSummary(phaseDirectives.cleanedBody, section.heading || `阶段 ${index + 1}`),
      userNodeId: userNode?.id || null,
      allowedSpeakers: Array.from(new Set([
        ...phaseDirectives.allowedSpeakers,
        ...(isUserPhase ? [userNode?.promptRole || "系统"] : []),
      ].filter(Boolean))),
      nextPhaseIds: [],
      defaultNextPhaseId: null,
    // 没有显式前置时，默认顺序串联上一个 phase，
    // 这样普通章节只写正文也能形成线性推进链。
      requiredEventIds: phaseDirectives.requiredEventIds.length
        ? phaseDirectives.requiredEventIds
        : (previousPhaseId ? [getPhaseRuntimeMarker(previousPhaseId)] : []),
      // user phase 默认由对应 userNode 完成；scene phase 默认由关联 fixedEvent/信号推进。
      completionEventIds: phaseDirectives.completionEventIds.length
        ? phaseDirectives.completionEventIds
        : (isUserPhase
          ? (userNode?.id ? [getUserNodeRuntimeMarker(userNode.id)] : [])
          : relatedFixedEventIds),
      advanceSignals: normalizePhaseSignalList([
        section.heading,
        normalizeRuntimeSummary(phaseDirectives.cleanedBody, section.heading || `阶段 ${index + 1}`),
        ...phaseDirectives.advanceSignals,
        ...extractDialogueSignalsFromSectionBody(phaseDirectives.cleanedBody),
      ]),
      relatedFixedEventIds,
      nextPhaseRefs: phaseDirectives.nextPhaseRefs,
      defaultNextPhaseRef: phaseDirectives.defaultNextPhaseRef,
    });
    previousPhaseId = phaseId;
  });
  return phaseDrafts.map((draft, index) => {
    const sequentialNextId = phaseDrafts[index + 1]?.id || null;
    const nextPhaseIds = draft.nextPhaseRefs
      .map((item) => resolvePhaseReference(item, phaseDrafts))
      .filter((item): item is string => Boolean(item));
    // 没写下一阶段时，按正文顺序串成默认流程，保证运行时不会断链。
    const defaultNextPhaseId = resolvePhaseReference(draft.defaultNextPhaseRef, phaseDrafts)
      || nextPhaseIds[0]
      || sequentialNextId;
    return {
      id: draft.id,
      label: draft.label,
      kind: draft.kind,
      targetSummary: draft.targetSummary,
      userNodeId: draft.userNodeId,
      allowedSpeakers: draft.allowedSpeakers,
      nextPhaseIds: nextPhaseIds.length ? Array.from(new Set(nextPhaseIds)) : (sequentialNextId ? [sequentialNextId] : []),
      defaultNextPhaseId,
      requiredEventIds: draft.requiredEventIds,
      completionEventIds: draft.completionEventIds,
      advanceSignals: draft.advanceSignals,
      relatedFixedEventIds: draft.relatedFixedEventIds,
    };
  });
}

interface CompletionConditionArtifacts {
  fixedEvents: ChapterRuntimeOutline["fixedEvents"];
  successEventIds: string[];
  failureEventIds: string[];
}

// 将“成功条件（失败条件）”这种一行写法拆成 success/failure 两段，
// 兼容编辑器里常见的自然语言配置。
function splitCompletionConditionText(input: string): {
  successText: string;
  failureText: string;
} {
  const rawText = String(input || "").trim();
  if (!rawText) {
    return {
      successText: "",
      failureText: "",
    };
  }
  const matched = rawText.match(/^(.*?)[（(]\s*([^()（）]+?)\s*[)）]\s*$/);
  if (!matched) {
    return {
      successText: rawText,
      failureText: "",
    };
  }
  const successText = String(matched[1] || "").trim();
  const failureText = String(matched[2] || "").trim();
  if (!successText || !failureText || !/失败|fail|failed|failure/iu.test(failureText)) {
    return {
      successText: rawText,
      failureText: "",
    };
  }
  return {
    successText,
    failureText,
  };
}

// 将中文数字/阿拉伯数字的“几次”解析成 number，
// 主要服务于“输入不符合要求 3 次即失败”这类章节规则。
function parseChineseCountToken(input: string): number | null {
  const text = String(input || "").trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const value = Number(text);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const digits: Record<string, number> = {
    "零": 0,
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
    "十": 10,
  };
  if (text === "十") return 10;
  if (/^十[一二三四五六七八九]$/.test(text)) {
    return 10 + (digits[text.slice(1)] || 0);
  }
  if (/^[一二三四五六七八九]十$/.test(text)) {
    return (digits[text[0]] || 0) * 10;
  }
  if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(text)) {
    return (digits[text[0]] || 0) * 10 + (digits[text[2]] || 0);
  }
  return digits[text] ?? null;
}

// 从自然语言结束条件中推断出隐式结构化条件表达式，
// 让“姓名/性别/年龄输入完成”与“失败 N 次”能落到状态字段上，而不是纯文本猜测。
function buildImplicitConditionExprFromText(input: unknown): unknown | null {
  const normalized = normalizeConditionText(input);
  if (!normalized) return null;
  const asksIdentity =
    (normalized.includes("输入") || normalized.includes("填写") || normalized.includes("提供") || normalized.includes("告知") || normalized.includes("绑定"))
    && (normalized.includes("姓名") || normalized.includes("名称") || normalized.includes("名字"))
    && normalized.includes("性别")
    && normalized.includes("年龄");
  const mentionsIdentityBound =
    (normalized.includes("身份绑定") || normalized.includes("绑定身份") || normalized.includes("完成绑定"))
    && (normalized.includes("姓名") || normalized.includes("名称") || normalized.includes("性别") || normalized.includes("年龄"));
  if (asksIdentity || mentionsIdentityBound) {
    return {
      type: "equals",
      field: "state.player.identity_bound",
      value: true,
    };
  }
  const asksIdentityFailure =
    (normalized.includes("失败") || normalized.includes("错误"))
    && /([0-9一二三四五六七八九十两]+)次/.test(normalized)
    && (normalized.includes("姓名") || normalized.includes("名称") || normalized.includes("性别") || normalized.includes("年龄") || normalized.includes("角色创建"));
  if (asksIdentityFailure) {
    const countToken = normalized.match(/([0-9一二三四五六七八九十两]+)次/)?.[1] || "";
    const requiredAttempts = parseChineseCountToken(countToken);
    if (requiredAttempts != null) {
      return {
        type: "gte",
        field: "state.player.identity_invalid_attempts",
        value: requiredAttempts,
      };
    }
    return {
      type: "state_text_contains_all",
      value: ["失败", "名称", "性别", "年龄"],
    };
  }
  return null;
}

// 把 completionCondition 归一化成 fixedEvents + success/failure 事件集合，
// 这是把自然语言章节结局桥接到运行时事件系统的关键入口。
function normalizeCompletionConditionArtifacts(input: unknown): CompletionConditionArtifacts {
  const condition = tryParseCondition(input);
  const fixedEvents: ChapterRuntimeOutline["fixedEvents"] = [];
  const successEventIds: string[] = [];
  const failureEventIds: string[] = [];
  const appendFixedEvent = (label: unknown, requiredBeforeFinish: boolean, bucket: string[]) => {
    const text = String(label || "").trim();
    if (!text) return;
    const id = `fixed_event_${slugifyRuntimeKey(text, requiredBeforeFinish ? "success" : "failure")}`;
    const conditionExpr = buildImplicitConditionExprFromText(text);
    if (!bucket.includes(id)) {
      bucket.push(id);
    }
    // 每条自然语言结束条件都会转成固定事件，
    // 后续运行时只需要判断 fixedEvent 是否命中即可。
    if (!fixedEvents.some((item) => item.id === id)) {
      fixedEvents.push({
        id,
        label: text,
        requiredBeforeFinish,
        conditionExpr,
      });
    }
  };

  if (typeof condition === "string" && condition.trim()) {
    const branches = splitCompletionConditionText(condition);
    appendFixedEvent(branches.successText, true, successEventIds);
    appendFixedEvent(branches.failureText, false, failureEventIds);
    return {
      fixedEvents,
      successEventIds,
      failureEventIds,
    };
  }

  if (isRecord(condition)) {
    const successCondition = condition.success ?? condition.pass ?? condition.result ?? condition.outcome;
    const failureCondition = condition.failure ?? condition.failed ?? condition.fail;
    if (typeof successCondition === "string" && successCondition.trim()) {
      const branches = splitCompletionConditionText(successCondition);
      appendFixedEvent(branches.successText, true, successEventIds);
      appendFixedEvent(branches.failureText, false, failureEventIds);
    }
    if (typeof failureCondition === "string" && failureCondition.trim()) {
      appendFixedEvent(failureCondition, false, failureEventIds);
    }
  }

  return {
    fixedEvents,
    successEventIds,
    failureEventIds,
  };
}

// 从 completionCondition 直接生成固定事件列表，
// 供旧代码需要 fixedEvents 但不关心 success/failure 细节时使用。
function buildFixedEventsFromCompletionCondition(input: unknown): ChapterRuntimeOutline["fixedEvents"] {
  return normalizeCompletionConditionArtifacts(input).fixedEvents;
}

// 合并章节已有 fixedEvents 与 completionCondition 推导出的 fixedEvents，
// 既保留作者手写配置，也补齐自然语言转换出的规则。
function mergeRuntimeFixedEvents(
  existingFixedEvents: ChapterRuntimeOutline["fixedEvents"],
  generatedFixedEvents: ChapterRuntimeOutline["fixedEvents"],
): ChapterRuntimeOutline["fixedEvents"] {
  const merged: ChapterRuntimeOutline["fixedEvents"] = [];
  const append = (item: ChapterRuntimeOutline["fixedEvents"][number]) => {
    const label = String(item.label || "").trim();
    const id = String(item.id || "").trim();
    if (!label || !id) return;
    const existingIndex = merged.findIndex((entry) => entry.id === id);
    if (existingIndex >= 0) {
      merged[existingIndex] = {
        ...merged[existingIndex],
        ...item,
        requiredBeforeFinish: merged[existingIndex].requiredBeforeFinish || item.requiredBeforeFinish,
      };
      return;
    }
    merged.push({
      id,
      label,
      requiredBeforeFinish: item.requiredBeforeFinish !== false,
      conditionExpr: item.conditionExpr,
    });
  };
  existingFixedEvents.forEach(append);
  generatedFixedEvents.forEach(append);
  return merged;
}

// 将任意 runtimeOutline 输入压成标准运行时结构，
// 供数据库读取、接口输出、章节初始化统一复用。
export function normalizeChapterRuntimeOutline(input: unknown): ChapterRuntimeOutline {
  const base = parseJsonSafe<JsonRecord>(input, {});
  const openingMessages = Array.isArray(base.openingMessages)
    ? base.openingMessages
      .map((item) => ({
        role: String((item as any)?.role || "").trim(),
        roleType: String((item as any)?.roleType || "narrator").trim() || "narrator",
        content: String((item as any)?.content || "").trim(),
      }))
      .filter((item) => item.role && item.content)
    : [];
  const phases = Array.isArray(base.phases)
    ? base.phases.map((item, index) => ({
      id: String((item as any)?.id || `phase_${index + 1}`).trim() || `phase_${index + 1}`,
      label: String((item as any)?.label || `阶段 ${index + 1}`).trim() || `阶段 ${index + 1}`,
      kind: ["opening", "scene", "user", "fixed"].includes(String((item as any)?.kind || "").trim())
        ? String((item as any)?.kind || "").trim() as ChapterRuntimePhase["kind"]
        : "scene",
      targetSummary: String((item as any)?.targetSummary || "").trim(),
      userNodeId: String((item as any)?.userNodeId || "").trim() || null,
      allowedSpeakers: Array.isArray((item as any)?.allowedSpeakers)
        ? (item as any).allowedSpeakers.map((entry: unknown) => String(entry || "").trim()).filter(Boolean)
        : [],
      nextPhaseIds: Array.isArray((item as any)?.nextPhaseIds)
        ? (item as any).nextPhaseIds.map((entry: unknown) => String(entry || "").trim()).filter(Boolean)
        : [],
      defaultNextPhaseId: String((item as any)?.defaultNextPhaseId || "").trim() || null,
      requiredEventIds: Array.isArray((item as any)?.requiredEventIds)
        ? (item as any).requiredEventIds.map((entry: unknown) => String(entry || "").trim()).filter(Boolean)
        : [],
      completionEventIds: Array.isArray((item as any)?.completionEventIds)
        ? (item as any).completionEventIds.map((entry: unknown) => String(entry || "").trim()).filter(Boolean)
        : [],
      advanceSignals: Array.isArray((item as any)?.advanceSignals)
        ? (item as any).advanceSignals.map((entry: unknown) => String(entry || "").trim()).filter(Boolean)
        : [],
      relatedFixedEventIds: Array.isArray((item as any)?.relatedFixedEventIds)
        ? (item as any).relatedFixedEventIds.map((entry: unknown) => String(entry || "").trim()).filter(Boolean)
        : [],
    }))
    : [];
  const userNodes = Array.isArray(base.userNodes)
    ? base.userNodes.map((item, index) => ({
      id: String((item as any)?.id || `user_node_${index + 1}`).trim() || `user_node_${index + 1}`,
      label: String((item as any)?.label || "").trim(),
      triggerHint: String((item as any)?.triggerHint || "").trim(),
      promptRole: String((item as any)?.promptRole || "系统").trim() || "系统",
      promptText: String((item as any)?.promptText || "").trim(),
      suggestions: Array.isArray((item as any)?.suggestions)
        ? (item as any).suggestions.map((entry: unknown) => String(entry || "").trim()).filter(Boolean)
        : [],
    }))
    : [];
  const fixedEvents = Array.isArray(base.fixedEvents)
    ? base.fixedEvents.map((item, index) => ({
      id: String((item as any)?.id || `fixed_event_${index + 1}`).trim() || `fixed_event_${index + 1}`,
      label: String((item as any)?.label || "").trim(),
      requiredBeforeFinish: (item as any)?.requiredBeforeFinish !== false,
      conditionExpr: (() => {
        const rawExpr = tryParseCondition((item as any)?.conditionExpr);
        return rawExpr == null ? undefined : rawExpr;
      })(),
    })).filter((item) => item.label)
    : [];
  const endingRulesRaw = isRecord(base.endingRules) ? base.endingRules : {};
  const success = Array.isArray(endingRulesRaw.success)
    ? endingRulesRaw.success.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const failure = Array.isArray(endingRulesRaw.failure)
    ? endingRulesRaw.failure.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const nextChapterId = Number(endingRulesRaw.nextChapterId || 0);
  return {
    openingMessages,
    phases,
    userNodes,
    fixedEvents,
    endingRules: {
      success,
      failure,
      nextChapterId: Number.isFinite(nextChapterId) && nextChapterId > 0 ? nextChapterId : null,
    },
  };
}

// 自由章节没有结束条件，也不依赖 endingRules 切章。
// 这类章节在静态事件耗尽后，允许继续生成新的动态事件。
export function isFreeChapterRuntimeMode(chapter: any): boolean {
  if (!chapter) return false;
  const outline = normalizeChapterRuntimeOutline(chapter?.runtimeOutline);
  const normalizedFields = normalizeChapterFields({
    completionCondition: chapter?.completionCondition,
  });
  const hasCompletionCondition = normalizedFields.completionCondition != null;
  const hasEndingRules = Boolean(
    outline.endingRules.success.length
    || outline.endingRules.failure.length
    || Number(outline.endingRules.nextChapterId || 0) > 0,
  );
  return !hasCompletionCondition && !hasEndingRules;
}

// 组合章节运行时提纲。
// 优先使用作者显式配置的 runtimeOutline；缺失时再从章节字段自动补全 opening/userNodes/phases/fixedEvents。
export function buildChapterRuntimeOutline(input: {
  openingRole?: unknown;
  openingText?: unknown;
  content?: unknown;
  completionCondition?: unknown;
  runtimeOutline?: unknown;
}): ChapterRuntimeOutline {
  const normalizedExisting = normalizeChapterRuntimeOutline(input.runtimeOutline);
  const completionArtifacts = normalizeCompletionConditionArtifacts(input.completionCondition);
  const openingMessages = normalizedExisting.openingMessages.length
    ? normalizedExisting.openingMessages
    : (() => {
      const role = normalizeEditorText(input.openingRole) || "旁白";
      const content = normalizeEditorText(input.openingText);
      if (!content) return [];
      return [{
        role,
        roleType: role === "旁白" ? "narrator" : "npc",
        content,
      }];
    })();
  const userNodes = normalizedExisting.userNodes.length
    ? normalizedExisting.userNodes
    : extractRuntimeUserNodesFromContent(input.content);
  const fixedEvents = mergeRuntimeFixedEvents(
    normalizedExisting.fixedEvents,
    completionArtifacts.fixedEvents,
  );
  const phases = normalizedExisting.phases.length
    ? normalizedExisting.phases
    : extractRuntimePhasesFromContent(input.content, userNodes, fixedEvents);
  // success 事件默认会并入 requiredBeforeFinish 的 fixedEvents，
  // 保证“必须先完成的固定条件”能自动反映到 endingRules.success。
  const normalizedSuccessIds = Array.from(new Set([
    ...normalizedExisting.endingRules.success,
    ...completionArtifacts.successEventIds,
    ...fixedEvents.filter((item) => item.requiredBeforeFinish).map((item) => item.id),
  ].filter(Boolean)));
  const normalizedFailureIds = Array.from(new Set([
    ...normalizedExisting.endingRules.failure,
    ...completionArtifacts.failureEventIds,
  ].filter(Boolean)));
  return {
    openingMessages,
    phases,
    userNodes,
    fixedEvents,
    endingRules: {
      success: normalizedSuccessIds,
      failure: normalizedFailureIds,
      nextChapterId: normalizedExisting.endingRules.nextChapterId,
    },
  };
}

// 章节标题归一化：优先保留用户可读标题，兜底按 sort 生成“第 N 章”。
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

// 正则转义工具，供开场白头部清洗构造动态正则时使用。
function escapeRegExp(input: string): string {
  return String(input || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 去除正文前缀中的“开场白: ...”头部。
function stripOpeningHeader(input: string, openingRole?: unknown): string {
  const text = String(input || "").trimStart();
  if (!text) return "";
  const role = normalizeEditorText(openingRole);
  const header = role
    ? new RegExp(`^开场白(?:\\[${escapeRegExp(role)}\\]|${escapeRegExp(role)})?\\s*[:：]\\s*`)
    : /^开场白(?:\[(.+?)\]|([^\[\]:：\r\n]+))?\s*[:：]\s*/;
  return text.replace(header, "").replace(/^\s*[\r\n]+/, "");
}

// 从正文头部剔除已经抽到 openingText 里的段落，
// 防止开场白既显示在 opening，又重复残留在正文 content。
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

// 清洗章节正文里前置的开场白痕迹，
// 兼容多轮编辑后正文/开场字段混写的旧数据。
export function stripLeadingOpeningArtifacts(input: unknown, openingRole?: unknown, openingText?: unknown): string {
  let text = normalizeEditorText(input);
  if (!text) return "";
  const expectedRole = normalizeEditorText(openingRole);
  const expectedText = normalizeEditorText(openingText);
  const expectedParagraphs = splitParagraphs(expectedText).sort((a, b) => b.length - a.length);

// 这里循环多次是为了兼容“开场白头 + 开场白段落 + 提取后的残留空行”多种混合情况，
// 每轮都尝试剥离一层，直到文本稳定为止。
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

// 将章节字段压成编辑器/运行时都能接受的标准结构，
// 包括开场白剥离、entry/completionCondition 的 JSON/文本兼容解析。
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

// 获取游戏库实例，统一收敛对 `u.db` 的访问入口。
export function getGameDb(): any {
  return u.db as any;
}

// 安全 JSON 解析。
// 字符串会尝试 JSON.parse，对象直接透传，其他类型返回 fallback。
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

// 将任意值稳定序列化成 JSON 文本，
// 失败时退回 fallback，避免接口输出直接炸掉。
export function toJsonText(input: unknown, fallback: unknown = {}): string {
  try {
    return JSON.stringify(input ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

// 解析可选数字字段，仅接受有限数字或纯数字文本。
function normalizeOptionalNumber(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  const text = normalizeEditorText(input);
  if (!text) return null;
  const matched = text.match(/^\d{1,6}$/);
  if (!matched) return null;
  const value = Number(matched[0]);
  return Number.isFinite(value) ? value : null;
}

// 将数组压成非空字符串列表，并限制长度，避免角色参数卡过大。
function normalizeStringList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => normalizeEditorText(item))
    .filter(Boolean)
    .slice(0, 64);
}

// 从角色描述中按正则提取参数卡字段文本。
function extractParameterCardText(source: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const matched = source.match(pattern);
    const value = normalizeEditorText(matched?.[1]);
    if (value) return value;
  }
  return "";
}

// 从自然语言描述里推断性别，供缺省参数卡补全。
function inferGenderFromText(source: string): string {
  const explicit = extractParameterCardText(source, [
    /性别\s*[:：]\s*(男|女)/i,
  ]);
  if (explicit === "男" || explicit === "女") return explicit;
  if (/(少女|女子|女性|女人|女孩|女生|御姐|她\b|女主)/.test(source)) return "女";
  if (/(少年|男子|男性|男人|男孩|男生|他\b|男主)/.test(source)) return "男";
  return "";
}

// 从自然语言描述里推断年龄，供缺省参数卡补全。
function inferAgeFromText(source: string): number | null {
  const matched = source.match(/(\d{1,3})\s*岁/);
  if (!matched) return null;
  const value = Number(matched[1]);
  return Number.isFinite(value) ? value : null;
}

// 为缺省角色生成最基础的参数卡。
// 这层不是为了精确建模，而是保证后续展示/语音/编排输入至少有稳定字段。
function createBasicParameterCard(input: {
  existing?: unknown;
  name?: unknown;
  description?: unknown;
  voice?: unknown;
}): JsonRecord | null {
  const hasExisting = input.existing !== null
    && input.existing !== undefined
    && !(typeof input.existing === "string" && !String(input.existing).trim());
  if (!hasExisting) {
    return null;
  }
  const existing = parseJsonSafe<JsonRecord>(input.existing, {});
  const name = normalizeEditorText(existing.name ?? input.name);
  const rawSetting = normalizeEditorText((existing as any).raw_setting ?? (existing as any).rawSetting ?? input.description);
  const voice = normalizeEditorText(existing.voice ?? input.voice);
  const inferredGender = inferGenderFromText(rawSetting);
  const inferredAge = inferAgeFromText(rawSetting);
  const gender = normalizeEditorText(existing.gender) || inferredGender;
  const age = normalizeOptionalNumber(existing.age) ?? inferredAge;
  const level = normalizeOptionalNumber(existing.level);
  const levelDesc = normalizeEditorText(existing.level_desc ?? (existing as any).levelDesc)
    || extractParameterCardText(rawSetting, [/境界\s*[:：]\s*([^\n，。；;]+)/, /等级(?:称号)?\s*[:：]\s*([^\n，。；;]+)/, /修为\s*[:：]\s*([^\n，。；;]+)/]);
  const hp = normalizeOptionalNumber(existing.hp);
  const mp = normalizeOptionalNumber(existing.mp);
  const money = normalizeOptionalNumber(existing.money);
  const next: JsonRecord = {
    ...existing,
    name: name || "",
    raw_setting: rawSetting || "",
    gender: gender || "",
    age,
    level: level ?? 1,
    level_desc: levelDesc || "初入此界",
    personality: normalizeEditorText(existing.personality)
      || extractParameterCardText(rawSetting, [/性格\s*[:：]\s*([^\n]+)/, /特点\s*[:：]\s*([^\n]+)/]),
    appearance: normalizeEditorText(existing.appearance)
      || extractParameterCardText(rawSetting, [/外貌\s*[:：]\s*([^\n]+)/, /形象\s*[:：]\s*([^\n]+)/, /长相\s*[:：]\s*([^\n]+)/]),
    voice: voice || "",
    skills: normalizeStringList(existing.skills),
    items: normalizeStringList(existing.items),
    equipment: normalizeStringList(existing.equipment),
    hp: hp ?? 100,
    mp: mp ?? 0,
    money: money ?? 0,
    other: Array.isArray(existing.other) ? normalizeStringList(existing.other) : [],
  };

  delete (next as any).rawSetting;
  delete (next as any).levelDesc;
  return next;
}

// 将 story role 归一化成运行时可直接使用的角色对象。
function normalizeStoryRole(roleRaw: unknown, defaults: JsonRecord): JsonRecord {
  const raw = parseJsonSafe<JsonRecord>(roleRaw, {});
  const normalized: JsonRecord = {
    ...defaults,
    ...raw,
    roleType: String(defaults.roleType || raw.roleType || "").trim() || String(defaults.roleType || ""),
    attributes: {
      ...parseJsonSafe<JsonRecord>(defaults.attributes, {}),
      ...parseJsonSafe<JsonRecord>(raw.attributes, {}),
    },
  };
  normalized.parameterCardJson = createBasicParameterCard({
    existing: raw.parameterCardJson,
    name: normalized.name,
    description: normalized.description,
    voice: normalized.voice,
  });
  return normalized;
}

// 判断参数卡是否真的包含有效信息，而不是空壳对象。
function hasUsableParameterCard(input: unknown): boolean {
  if (!isRecord(input)) return false;
  return Object.values(input).some((value) => {
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "number") return Number.isFinite(value);
    return !isNullLikeText(normalizeEditorText(value));
  });
}

// 合并故事静态角色与运行时角色覆盖层，
// 保证运行态能继承到静态角色的完整描述和参数卡。
function mergeRuntimeRoleWithStoryRole(storyRole: JsonRecord, runtimeRoleRaw: unknown, fallbackName?: string): JsonRecord {
  const runtimeRole = parseJsonSafe<JsonRecord>(runtimeRoleRaw, {});
  const runtimeAttributes = parseJsonSafe<JsonRecord>(runtimeRole.attributes, {});
  const merged: JsonRecord = {
    ...storyRole,
    ...runtimeRole,
    name: normalizeEditorText(runtimeRole.name) || normalizeEditorText(storyRole.name) || fallbackName || "",
    roleType: normalizeEditorText(runtimeRole.roleType) || normalizeEditorText(storyRole.roleType),
    attributes: {
      ...parseJsonSafe<JsonRecord>(storyRole.attributes, {}),
      ...runtimeAttributes,
    },
  };
  merged.parameterCardJson = hasUsableParameterCard(runtimeRole.parameterCardJson)
    ? runtimeRole.parameterCardJson
    : (hasUsableParameterCard(storyRole.parameterCardJson) ? storyRole.parameterCardJson : null);
  return merged;
}

// 归一化 settings.roles，确保每个角色都有稳定 id/roleType/name。
function normalizeSettingsRoles(input: unknown): JsonRecord[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((item): item is JsonRecord => isRecord(item))
    .map((item, index) => normalizeStoryRole(item, {
      id: String(item.id || `npc_${index + 1}`),
      roleType: String(item.roleType || "npc") || "npc",
      name: String(item.name || `角色${index + 1}`),
      description: String(item.description || ""),
      attributes: {},
    }));
}

// 统一获取故事里的“用户/旁白”角色对。
export function normalizeRolePair(playerRoleRaw: unknown, narratorRoleRaw: unknown): RolePair {
  return {
    playerRole: normalizeStoryRole(playerRoleRaw, DEFAULT_PLAYER_ROLE),
    narratorRole: normalizeStoryRole(narratorRoleRaw, DEFAULT_NARRATOR_ROLE),
  };
}

// 从运行时 npc 覆盖层里找到与静态角色对应的覆盖对象。
function findNpcRuntimeOverlay(source: JsonRecord, role: JsonRecord): JsonRecord {
  const candidates = [
    source[String(role.id || "").trim()],
    source[String(role.name || "").trim()],
  ];
  for (const item of candidates) {
    if (isRecord(item)) return item;
  }
  const matchedEntry = Object.values(source).find((item) => {
    if (!isRecord(item)) return false;
    return String(item.id || "").trim() === String(role.id || "").trim()
      || String(item.name || "").trim() === String(role.name || "").trim();
  });
  return isRecord(matchedEntry) ? matchedEntry : {};
}

// 合并运行时 NPC Map 与世界静态角色列表，
// 既支持已有静态角色，也兼容运行时新增/补录的 NPC。
function normalizeRuntimeNpcMap(rawNpcs: unknown, npcRolesRaw: unknown): JsonRecord {
  const source = parseJsonSafe<JsonRecord>(rawNpcs, {});
  const defaults = normalizeSettingsRoles(npcRolesRaw).filter((item) => item.roleType === "npc");
  const normalized: JsonRecord = {};
  const consumedKeys = new Set<string>();

  defaults.forEach((role) => {
    const runtimeOverlay = findNpcRuntimeOverlay(source, role);
    const normalizedRole = mergeRuntimeRoleWithStoryRole(role, runtimeOverlay, String(role.name || role.id || ""));
    const roleId = String(normalizedRole.id || role.id || normalizedRole.name || "").trim();
    if (!roleId) return;
    normalized[roleId] = normalizedRole;
    consumedKeys.add(String(role.id || "").trim());
    consumedKeys.add(String(role.name || "").trim());
  });

  Object.entries(source).forEach(([key, value]) => {
    if (consumedKeys.has(String(key || "").trim()) || !isRecord(value)) return;
    const fallbackDefaults: JsonRecord = {
      id: String(value.id || key || "").trim() || key,
      roleType: String(value.roleType || "npc").trim() || "npc",
      name: String(value.name || key || "").trim() || key,
      description: String(value.description || "").trim(),
      attributes: {},
    };
    const normalizedFallback = normalizeStoryRole(value, fallbackDefaults);
    const normalizedRole = mergeRuntimeRoleWithStoryRole(normalizedFallback, value, String(fallbackDefaults.name || key || ""));
    const roleId = String(normalizedRole.id || key || normalizedRole.name || "").trim();
    if (!roleId) return;
    normalized[roleId] = normalizedRole;
  });

  return normalized;
}

const DEFAULT_CHAPTER_PROGRESS_STATE: ChapterProgressState = {
  chapterId: 0,
  phaseId: "",
  phaseIndex: 0,
  eventIndex: 1,
  eventKind: "scene",
  eventSummary: "",
  eventStatus: "idle",
  userNodeId: "",
  userNodeIndex: -1,
  userNodeStatus: "idle",
  completedEvents: [],
  pendingGoal: "",
  fixedOutcomeLocked: false,
  lastEvaluatedMessageId: 0,
};

const DEFAULT_RUNTIME_CURRENT_EVENT_STATE: RuntimeCurrentEventState = {
  index: 1,
  kind: "scene",
  summary: "",
  facts: [],
  status: "idle",
};

const DEFAULT_RUNTIME_DYNAMIC_EVENT_STATE: RuntimeDynamicEventState = {
  eventIndex: 1,
  phaseId: "",
  kind: "scene",
  flowType: "chapter_content",
  summary: "",
  runtimeFacts: [],
  summarySource: "phase",
  memorySummary: "",
  memoryFacts: [],
  updateTime: 0,
  status: "idle",
  allowedRoles: [],
  userNodeId: "",
};

// 将章节里的用户节点状态归一化成有限枚举。
function normalizeChapterProgressStatus(input: unknown): ChapterProgressState["userNodeStatus"] {
  const status = String(input || "").trim().toLowerCase();
  if (status === "waiting_input") return "waiting_input";
  if (status === "completed") return "completed";
  if (status === "skipped") return "skipped";
  return "idle";
}

// 将章节事件状态归一化成有限枚举。
function normalizeChapterEventStatus(input: unknown): ChapterProgressState["eventStatus"] {
  const status = String(input || "").trim().toLowerCase();
  if (status === "active") return "active";
  if (status === "waiting_input") return "waiting_input";
  if (status === "completed") return "completed";
  return "idle";
}

// 将运行时事件 kind 归一化成受控枚举。
function normalizeRuntimeEventKind(input: unknown): RuntimeCurrentEventState["kind"] {
  const kind = String(input || "").trim();
  if (kind === "opening" || kind === "scene" || kind === "user" || kind === "fixed" || kind === "ending") {
    return kind;
  }
  return DEFAULT_RUNTIME_CURRENT_EVENT_STATE.kind;
}

// 归一化 `currentEvent`，并在缺字段时用 fallback 兜底。
export function normalizeRuntimeCurrentEventState(
  raw: unknown,
  fallback?: Partial<RuntimeCurrentEventState> | null,
): RuntimeCurrentEventState {
  const base = parseJsonSafe<JsonRecord>(raw, {});
  const merged = {
    ...(fallback || {}),
    ...base,
  } as JsonRecord;
  return {
    index: Number.isFinite(Number(merged.index))
      ? Math.max(1, Number(merged.index))
      : DEFAULT_RUNTIME_CURRENT_EVENT_STATE.index,
    kind: normalizeRuntimeEventKind(merged.kind),
    summary: String(merged.summary || "").trim(),
    facts: Array.isArray(merged.facts)
      ? merged.facts.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
    status: normalizeChapterEventStatus(merged.status),
  };
}

// 归一化动态事件对象。
// flowType 会优先尊重已有值，否则按 eventKind + phaseId 自动推断。
export function normalizeRuntimeDynamicEventState(raw: unknown): RuntimeDynamicEventState {
  const base = parseJsonSafe<JsonRecord>(raw, {});
  const phaseId = String(base.phaseId || "").trim();
  const kind = normalizeRuntimeEventKind(base.kind);
  return {
    eventIndex: Number.isFinite(Number(base.eventIndex))
      ? Math.max(1, Number(base.eventIndex))
      : DEFAULT_RUNTIME_DYNAMIC_EVENT_STATE.eventIndex,
    phaseId,
    kind,
    flowType: ["introduction", "chapter_content", "chapter_ending_check", "free_runtime"].includes(String(base.flowType || "").trim())
      ? String(base.flowType || "").trim() as RuntimeDynamicEventState["flowType"]
      : resolveRuntimeEventFlowType({ eventKind: kind, phaseId }),
    summary: String(base.summary || "").trim(),
    runtimeFacts: Array.isArray(base.runtimeFacts)
      ? base.runtimeFacts.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
    summarySource: base.summarySource === "ai"
      ? "ai"
      : base.summarySource === "memory"
        ? "memory"
        : base.summarySource === "system"
          ? "system"
          : "phase",
    memorySummary: String(base.memorySummary || "").trim(),
    memoryFacts: Array.isArray(base.memoryFacts)
      ? base.memoryFacts.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
    updateTime: Number.isFinite(Number(base.updateTime))
      ? Math.max(0, Number(base.updateTime))
      : 0,
    status: normalizeChapterEventStatus(base.status),
    allowedRoles: Array.isArray(base.allowedRoles)
      ? base.allowedRoles.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
    userNodeId: String(base.userNodeId || "").trim(),
  };
}

// 归一化动态事件列表，并过滤掉完全没有信息的空事件。
export function normalizeRuntimeDynamicEventList(raw: unknown): RuntimeDynamicEventState[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => normalizeRuntimeDynamicEventState(item))
    .filter((item) => item.phaseId || item.summary);
}

// 按 eventIndex 读取指定动态事件。
export function readRuntimeDynamicEventByIndex(state: unknown, eventIndex: number): RuntimeDynamicEventState | null {
  if (!isRecord(state)) return null;
  const normalizedEventIndex = Number.isFinite(Number(eventIndex)) ? Math.max(1, Number(eventIndex)) : 0;
  if (!normalizedEventIndex) return null;
  const dynamicEvents = normalizeRuntimeDynamicEventList(state.dynamicEvents);
  return dynamicEvents.find((item) => item.eventIndex === normalizedEventIndex) || null;
}

// 读取当前 chapterProgress 指向的动态事件。
export function readRuntimeCurrentDynamicEventState(state: unknown): RuntimeDynamicEventState | null {
  if (!isRecord(state)) return null;
  const progress = readChapterProgressState(state);
  return readRuntimeDynamicEventByIndex(state, progress.eventIndex);
}

// 将动态事件/当前事件信息映射成 digest 结构，
// 供 UI 事件窗口、编排输入和日志视图复用。
function buildRuntimeEventDigestState(input: {
  eventIndex: number;
  eventKind: RuntimeCurrentEventState["kind"];
  eventFlowType?: RuntimeDynamicEventState["flowType"] | null;
  eventSummary: string;
  eventFacts: string[];
  eventStatus: RuntimeCurrentEventState["status"];
  summarySource?: RuntimeDynamicEventState["summarySource"] | null;
  memorySummary?: string | null;
  memoryFacts?: string[] | null;
  updateTime?: number | null;
  allowedRoles?: string[] | null;
  userNodeId?: string | null;
}): RuntimeEventDigestState {
  return {
    eventIndex: Number.isFinite(Number(input.eventIndex)) ? Math.max(1, Number(input.eventIndex)) : 1,
    eventKind: input.eventKind,
    eventFlowType: input.eventFlowType || resolveRuntimeEventFlowType({ eventKind: input.eventKind }),
    eventSummary: String(input.eventSummary || "").trim(),
    eventFacts: Array.isArray(input.eventFacts)
      ? input.eventFacts.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
    eventStatus: input.eventStatus,
    summarySource: input.summarySource || "system",
    memorySummary: String(input.memorySummary || "").trim(),
    memoryFacts: Array.isArray(input.memoryFacts)
      ? input.memoryFacts.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
    updateTime: Number.isFinite(Number(input.updateTime)) ? Math.max(0, Number(input.updateTime)) : 0,
    allowedRoles: Array.isArray(input.allowedRoles)
      ? input.allowedRoles.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
    userNodeId: String(input.userNodeId || "").trim(),
  };
}

// 读取指定索引的事件 digest。
// 优先使用动态事件；没有时再退到 currentEvent + chapterProgress。
export function readRuntimeEventDigestByIndexState(state: unknown, eventIndex: number): RuntimeEventDigestState | null {
  if (!isRecord(state)) return null;
  const normalizedEventIndex = Number.isFinite(Number(eventIndex)) ? Math.max(1, Number(eventIndex)) : 0;
  if (!normalizedEventIndex) return null;
  const dynamicEvent = readRuntimeDynamicEventByIndex(state, normalizedEventIndex);
  if (dynamicEvent) {
    return buildRuntimeEventDigestState({
      eventIndex: dynamicEvent.eventIndex,
      eventKind: dynamicEvent.kind,
      eventFlowType: dynamicEvent.flowType,
      eventSummary: dynamicEvent.summary,
      eventFacts: dynamicEvent.runtimeFacts,
      eventStatus: dynamicEvent.status,
      summarySource: dynamicEvent.summarySource,
      memorySummary: dynamicEvent.memorySummary,
      memoryFacts: dynamicEvent.memoryFacts,
      updateTime: dynamicEvent.updateTime,
      allowedRoles: dynamicEvent.allowedRoles,
      userNodeId: dynamicEvent.userNodeId,
    });
  }
  const currentEvent = readRuntimeCurrentEventState(state);
  if (currentEvent.index !== normalizedEventIndex) {
    return null;
  }
  return buildRuntimeEventDigestState({
    eventIndex: currentEvent.index,
    eventKind: currentEvent.kind,
    eventFlowType: resolveRuntimeEventFlowType({
      eventKind: currentEvent.kind,
      phaseId: readChapterProgressState(state).phaseId,
    }),
    eventSummary: currentEvent.summary,
    eventFacts: currentEvent.facts,
    eventStatus: currentEvent.status,
  });
}

// 读取当前事件 digest。
export function readRuntimeCurrentEventDigestState(state: unknown): RuntimeEventDigestState {
  const currentEvent = readRuntimeCurrentEventState(state);
  return readRuntimeEventDigestByIndexState(state, currentEvent.index)
    || buildRuntimeEventDigestState({
      eventIndex: currentEvent.index,
      eventKind: currentEvent.kind,
      eventFlowType: resolveRuntimeEventFlowType({
        eventKind: currentEvent.kind,
        phaseId: readChapterProgressState(state).phaseId,
      }),
      eventSummary: currentEvent.summary,
      eventFacts: currentEvent.facts,
      eventStatus: currentEvent.status,
    });
}

// 读取当前事件附近的事件窗口。
// 这是事件时间线视图的核心数据源。
export function readRuntimeEventDigestWindowState(state: unknown, windowSize = 10): RuntimeEventDigestState[] {
  if (!isRecord(state)) return [];
  const currentEvent = readRuntimeCurrentEventState(state);
  const dynamicEvents = normalizeRuntimeDynamicEventList(state.dynamicEvents);
  const normalizedWindowSize = Number.isFinite(Number(windowSize)) ? Math.max(1, Number(windowSize)) : 10;
  const currentIndex = dynamicEvents.findIndex((item) => Number(item.eventIndex || 0) === Number(currentEvent.index || 0));
  if (currentIndex < 0) {
    return [readRuntimeCurrentEventDigestState(state)];
  }
  const beforeCount = Math.floor((normalizedWindowSize - 1) / 2);
  let start = Math.max(0, currentIndex - beforeCount);
  let end = Math.min(dynamicEvents.length, start + normalizedWindowSize);
  if (end - start < normalizedWindowSize) {
    start = Math.max(0, end - normalizedWindowSize);
  }
  const items = dynamicEvents.slice(start, end);
  if (!items.length) {
    return [readRuntimeCurrentEventDigestState(state)];
  }
  return items
    .map((item) => readRuntimeEventDigestByIndexState(state, item.eventIndex))
    .filter((item): item is RuntimeEventDigestState => Boolean(item));
}

// 将事件窗口压成文本摘要，
// 供提示词、日志、兜底展示等文本场景复用。
export function readRuntimeEventDigestWindowTextState(state: unknown, options?: RuntimeEventViewOptions): string {
  const windowSize = Number.isFinite(Number(options?.windowSize))
    ? Math.max(1, Number(options?.windowSize))
    : DEFAULT_RUNTIME_EVENT_VIEW_OPTIONS.windowSize;
  const includeMemory = options?.includeMemory == null
    ? DEFAULT_RUNTIME_EVENT_VIEW_OPTIONS.includeMemory
    : options.includeMemory !== false;
  const summaryLimit = Number.isFinite(Number(options?.summaryLimit))
    ? Math.max(12, Number(options?.summaryLimit))
    : DEFAULT_RUNTIME_EVENT_VIEW_OPTIONS.summaryLimit;
  const factLimit = Number.isFinite(Number(options?.factLimit))
    ? Math.max(1, Number(options?.factLimit))
    : DEFAULT_RUNTIME_EVENT_VIEW_OPTIONS.factLimit;
  const memoryFactLimit = Number.isFinite(Number(options?.memoryFactLimit))
    ? Math.max(1, Number(options?.memoryFactLimit))
    : DEFAULT_RUNTIME_EVENT_VIEW_OPTIONS.memoryFactLimit;
  const items = readRuntimeEventDigestWindowState(state, windowSize);
  if (!items.length) return "";
  const shortText = (input: unknown, limit: number): string => {
    const text = String(input || "").trim();
    if (!text) return "";
    return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
  };
  return items
    .map((item) => {
      const status = item.eventStatus === "waiting_input"
        ? "等待输入"
        : item.eventStatus === "completed"
          ? "已完成"
          : item.eventStatus === "active"
            ? "进行中"
            : "未开始";
      const flowType = String(item.eventFlowType || "").trim() || "chapter_content";
      const parts = [`${item.eventIndex}. [${flowType}/${item.eventKind}/${status}] ${shortText(item.eventSummary, summaryLimit)}`];
      const factsText = Array.isArray(item.eventFacts)
        ? item.eventFacts.map((fact) => String(fact || "").trim()).filter(Boolean).slice(0, factLimit).join("；")
        : "";
      if (factsText) {
        parts.push(`事实:${factsText}`);
      }
      if (includeMemory) {
        const memorySummary = String(item.memorySummary || "").trim();
        const memoryFactsText = Array.isArray(item.memoryFacts)
          ? item.memoryFacts.map((fact) => String(fact || "").trim()).filter(Boolean).slice(0, memoryFactLimit).join("；")
          : "";
        if (memorySummary) {
          parts.push(`记忆:${shortText(memorySummary, 36)}`);
        }
        if (memoryFactsText) {
          parts.push(`记忆事实:${memoryFactsText}`);
        }
      }
      return parts.join(" | ");
    })
    .join("\n");
}

// 构造完整的事件视图对象。
export function readRuntimeEventViewState(state: unknown, options?: RuntimeEventViewOptions): RuntimeEventViewState {
  return {
    currentEventDigest: readRuntimeCurrentEventDigestState(state),
    eventDigestWindow: readRuntimeEventDigestWindowState(
      state,
      Number.isFinite(Number(options?.windowSize))
        ? Math.max(1, Number(options?.windowSize))
        : DEFAULT_RUNTIME_EVENT_VIEW_OPTIONS.windowSize,
    ),
    eventDigestWindowText: readRuntimeEventDigestWindowTextState(state, options),
  };
}

// 使用默认窗口配置读取事件视图。
export function readDefaultRuntimeEventViewState(state: unknown): RuntimeEventViewState {
  return readRuntimeEventViewState(state, DEFAULT_RUNTIME_EVENT_VIEW_OPTIONS);
}

// 使用默认窗口配置读取事件窗口文本。
export function readDefaultRuntimeEventDigestWindowTextState(state: unknown): string {
  return readRuntimeEventDigestWindowTextState(state, DEFAULT_RUNTIME_EVENT_VIEW_OPTIONS);
}

// 归一化 chapterProgress，保证运行态状态字段始终可读。
export function normalizeChapterProgressState(raw: unknown): ChapterProgressState {
  const base = parseJsonSafe<JsonRecord>(raw, {});
  const completedEvents = Array.isArray(base.completedEvents)
    ? base.completedEvents.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  return {
    chapterId: Number.isFinite(Number(base.chapterId)) ? Math.max(0, Number(base.chapterId)) : DEFAULT_CHAPTER_PROGRESS_STATE.chapterId,
    phaseId: String(base.phaseId || "").trim(),
    phaseIndex: Number.isFinite(Number(base.phaseIndex)) ? Math.max(0, Number(base.phaseIndex)) : DEFAULT_CHAPTER_PROGRESS_STATE.phaseIndex,
    eventIndex: Number.isFinite(Number(base.eventIndex)) ? Math.max(1, Number(base.eventIndex)) : DEFAULT_CHAPTER_PROGRESS_STATE.eventIndex,
    eventKind: ["opening", "scene", "user", "fixed", "ending"].includes(String(base.eventKind || "").trim())
      ? String(base.eventKind || "").trim() as ChapterProgressState["eventKind"]
      : DEFAULT_CHAPTER_PROGRESS_STATE.eventKind,
    eventSummary: String(base.eventSummary || "").trim(),
    eventStatus: normalizeChapterEventStatus(base.eventStatus),
    userNodeId: String(base.userNodeId || "").trim(),
    userNodeIndex: Number.isFinite(Number(base.userNodeIndex)) ? Number(base.userNodeIndex) : DEFAULT_CHAPTER_PROGRESS_STATE.userNodeIndex,
    userNodeStatus: normalizeChapterProgressStatus(base.userNodeStatus),
    completedEvents: Array.from(new Set(completedEvents)),
    pendingGoal: String(base.pendingGoal || "").trim(),
    fixedOutcomeLocked: base.fixedOutcomeLocked === true,
    lastEvaluatedMessageId: Number.isFinite(Number(base.lastEvaluatedMessageId))
      ? Math.max(0, Number(base.lastEvaluatedMessageId))
      : DEFAULT_CHAPTER_PROGRESS_STATE.lastEvaluatedMessageId,
  };
}

// 从 state 中安全读取 chapterProgress。
export function readChapterProgressState(state: unknown): ChapterProgressState {
  if (!isRecord(state)) return normalizeChapterProgressState(undefined);
  return normalizeChapterProgressState(state.chapterProgress);
}

// 从 state 中读取当前事件，
// 并优先用当前 eventIndex 命中的动态事件来补足 summary/facts/status。
export function readRuntimeCurrentEventState(state: unknown): RuntimeCurrentEventState {
  if (!isRecord(state)) {
    return normalizeRuntimeCurrentEventState(undefined);
  }
  const progress = readChapterProgressState(state);
  const dynamicEvents = normalizeRuntimeDynamicEventList(state.dynamicEvents);
  const matchedDynamicEvent = dynamicEvents.find((item) => item.eventIndex === progress.eventIndex) || null;
  return normalizeRuntimeCurrentEventState(state.currentEvent, {
    index: progress.eventIndex,
    kind: progress.eventKind,
    summary: matchedDynamicEvent?.summary || progress.eventSummary,
    facts: matchedDynamicEvent?.runtimeFacts || [],
    status: progress.eventStatus,
  });
}

// 将 chapterProgress 当前指向的事件同步回 `state.currentEvent`，
// 避免 UI/提示词继续读取到过期 currentEvent。
export function syncRuntimeCurrentEventFromChapterProgress(state: JsonRecord): RuntimeCurrentEventState {
  const progress = readChapterProgressState(state);
  const dynamicEvents = normalizeRuntimeDynamicEventList(state.dynamicEvents);
  const matchedDynamicEvent = dynamicEvents.find((item) => item.eventIndex === progress.eventIndex) || null;
  const next = normalizeRuntimeCurrentEventState(state.currentEvent, {
    index: progress.eventIndex,
    kind: progress.eventKind,
    summary: matchedDynamicEvent?.summary || progress.eventSummary,
    facts: matchedDynamicEvent?.runtimeFacts || [],
    status: progress.eventStatus,
  });
  state.currentEvent = next;
  return next;
}

// 整体覆盖动态事件列表，同时统一做归一化。
export function setRuntimeDynamicEventList(state: JsonRecord, list: RuntimeDynamicEventState[]): RuntimeDynamicEventState[] {
  const next = normalizeRuntimeDynamicEventList(list);
  state.dynamicEvents = next;
  return next;
}

// 按 eventIndex 插入或更新一条动态事件，
// 并在更新当前事件时同步刷新 `state.currentEvent`。
export function upsertRuntimeDynamicEventState(
  state: JsonRecord,
  patch: Partial<RuntimeDynamicEventState> & { eventIndex: number },
): RuntimeDynamicEventState {
  const progress = readChapterProgressState(state);
  const eventIndex = Number.isFinite(Number(patch.eventIndex)) ? Math.max(1, Number(patch.eventIndex)) : progress.eventIndex;
  const currentEvent = readRuntimeCurrentEventState(state);
  const dynamicEvents = normalizeRuntimeDynamicEventList(state.dynamicEvents);
  const matchedIndex = dynamicEvents.findIndex((item) => item.eventIndex === eventIndex);
  // 新建事件时优先继承当前 chapterProgress 指向的 phase/kind/summary，
  // 这样调用方只传少数字段也能得到完整事件对象。
  const base = matchedIndex >= 0
    ? dynamicEvents[matchedIndex]
    : normalizeRuntimeDynamicEventState({
      eventIndex,
      phaseId: eventIndex === progress.eventIndex ? progress.phaseId : "",
      kind: eventIndex === progress.eventIndex ? progress.eventKind : currentEvent.kind,
      flowType: resolveRuntimeEventFlowType({
        eventKind: eventIndex === progress.eventIndex ? progress.eventKind : currentEvent.kind,
        phaseId: eventIndex === progress.eventIndex ? progress.phaseId : "",
      }),
      summary: eventIndex === progress.eventIndex ? progress.eventSummary : currentEvent.summary,
      runtimeFacts: eventIndex === progress.eventIndex ? currentEvent.facts : [],
      status: eventIndex === progress.eventIndex ? progress.eventStatus : "idle",
      allowedRoles: [],
      userNodeId: eventIndex === progress.eventIndex ? progress.userNodeId : "",
      summarySource: "system",
      memorySummary: "",
      memoryFacts: [],
      updateTime: 0,
    });
  const next = normalizeRuntimeDynamicEventState({
    ...base,
    ...patch,
    eventIndex,
  });
  if (matchedIndex >= 0) {
    dynamicEvents[matchedIndex] = next;
  } else {
    dynamicEvents.push(next);
    dynamicEvents.sort((a, b) => a.eventIndex - b.eventIndex);
  }
  setRuntimeDynamicEventList(state, dynamicEvents);
  if (eventIndex === progress.eventIndex) {
    syncRuntimeCurrentEventFromChapterProgress(state);
  }
  return next;
}

// 用 digest 级字段统一回写动态事件，避免各处重复手拼 summary/runtimeFacts/memoryFacts。
export function upsertRuntimeEventDigestState(
  state: JsonRecord,
  patch: Partial<RuntimeEventDigestState> & { eventIndex?: number | null },
): RuntimeEventDigestState {
  const currentDigest = readRuntimeCurrentEventDigestState(state);
  const targetEventIndex = Number.isFinite(Number(patch.eventIndex))
    ? Math.max(1, Number(patch.eventIndex))
    : currentDigest.eventIndex;
  const baseDigest = readRuntimeEventDigestByIndexState(state, targetEventIndex) || currentDigest;
  upsertRuntimeDynamicEventState(state, {
    eventIndex: targetEventIndex,
    kind: patch.eventKind || baseDigest.eventKind,
    flowType: patch.eventFlowType || baseDigest.eventFlowType,
    summary: patch.eventSummary == null
      ? baseDigest.eventSummary
      : String(patch.eventSummary || "").trim(),
    runtimeFacts: Array.isArray(patch.eventFacts)
      ? patch.eventFacts.map((item) => String(item || "").trim()).filter(Boolean)
      : baseDigest.eventFacts,
    summarySource: patch.summarySource || baseDigest.summarySource,
    memorySummary: patch.memorySummary == null
      ? baseDigest.memorySummary
      : String(patch.memorySummary || "").trim(),
    memoryFacts: Array.isArray(patch.memoryFacts)
      ? patch.memoryFacts.map((item) => String(item || "").trim()).filter(Boolean)
      : baseDigest.memoryFacts,
    updateTime: Number.isFinite(Number(patch.updateTime))
      ? Math.max(0, Number(patch.updateTime))
      : baseDigest.updateTime,
    status: patch.eventStatus || baseDigest.eventStatus,
    allowedRoles: Array.isArray(patch.allowedRoles)
      ? patch.allowedRoles.map((item) => String(item || "").trim()).filter(Boolean)
      : baseDigest.allowedRoles,
    userNodeId: patch.userNodeId == null
      ? baseDigest.userNodeId
      : String(patch.userNodeId || "").trim(),
  });
  return readRuntimeEventDigestByIndexState(state, targetEventIndex) || baseDigest;
}

// 更新 chapterProgress，并同步刷新 `currentEvent` 的基础索引/摘要/状态。
export function setChapterProgressState(state: JsonRecord, patch: Partial<ChapterProgressState>): ChapterProgressState {
  const current = readChapterProgressState(state);
  const next = normalizeChapterProgressState({
    ...current,
    ...patch,
  });
  state.chapterProgress = next;
  state.currentEvent = normalizeRuntimeCurrentEventState(state.currentEvent, {
    index: next.eventIndex,
    kind: next.eventKind,
    summary: next.eventSummary,
    status: next.eventStatus,
  });
  return next;
}

// 生成正式会话 id。
export function createGameSessionId(): string {
  return `gs_${Date.now()}_${u.uuid().replace(/-/g, "").slice(0, 10)}`;
}

// 统一当前时间戳入口，便于后续替换或 mock。
export function nowTs(): number {
  return Date.now();
}

// 归一化整份 session state。
// 这里会把 world/chapter/player/narrator/npcs/chapterProgress/currentEvent 全部补齐成运行态标准格式。
export function normalizeSessionState(
  raw: unknown,
  worldId: number,
  chapterId: number | null,
  rolePair: RolePair,
  worldRaw?: unknown,
): JsonRecord {
  const base = parseJsonSafe<JsonRecord>(raw, {});
  const player = isRecord(base.player) ? base.player : {};
  const narrator = isRecord(base.narrator) ? base.narrator : {};
  const rawTurnState = isRecord(base.turnState) ? base.turnState : {};
  const chapterProgress = normalizeChapterProgressState({
    ...base.chapterProgress,
    chapterId: Number(base.chapterProgress?.chapterId || chapterId || 0),
  });
  const currentEvent = normalizeRuntimeCurrentEventState(base.currentEvent, {
    index: chapterProgress.eventIndex,
    kind: chapterProgress.eventKind,
    summary: chapterProgress.eventSummary,
    status: chapterProgress.eventStatus,
  });
  const dynamicEvents = normalizeRuntimeDynamicEventList(base.dynamicEvents);
  const world = parseJsonSafe<JsonRecord>(worldRaw, {});
  const settings = normalizeWorldSettings(world.settings, {
    coverPath: world.coverPath,
    publishStatus: world.publishStatus,
  });
  const mergedPlayer = mergeRuntimeRoleWithStoryRole(rolePair.playerRole, player, "用户");
  const mergedNarrator = mergeRuntimeRoleWithStoryRole(rolePair.narratorRole, narrator, "旁白");
  const normalizedPlayerName = String(mergedPlayer.name || rolePair.playerRole.name || "用户").trim() || "用户";
  const expectedRoleType = String(rawTurnState.expectedRoleType || "player").trim() || "player";
  const normalizedChapterId = Number.isFinite(Number(chapterId)) ? Math.max(0, Number(chapterId || 0)) : 0;
  const normalizedBaseChapterId = Number.isFinite(Number(base.chapterId || base.chapterProgress?.chapterId || 0))
    ? Math.max(0, Number(base.chapterId || base.chapterProgress?.chapterId || 0))
    : 0;
  const normalizedChapterTitle = normalizedChapterId > 0 && normalizedBaseChapterId !== normalizedChapterId
    ? ""
    : String(base.chapterTitle || "").trim();

  return {
    ...base,
    // 运行态归一化要以本次调用显式传入的世界/章节为准。
    // 旧快照里的 version/worldId/round/chapterId 只能当补充，不能反向覆盖这次请求的权威值。
    version: 1,
    worldId,
    round: Number.isFinite(Number(base.round)) ? Number(base.round) : 0,
    // 外部已经明确传入当前章节时，运行态必须强制对齐这次请求的章节，
    // 不能再让旧快照里的 chapterId 反向覆盖回来，否则会把别的章节状态串进当前链路。
    chapterId: normalizedChapterId,
    // 章节标题只在章节 ID 未发生冲突时才允许沿用旧值；
    // 一旦旧快照里的章节 ID 和当前章节不一致，这里先清空，后续由章节行数据回填权威标题。
    chapterTitle: normalizedChapterTitle,
    player: {
      ...mergedPlayer,
      roleType: "player",
      name: normalizedPlayerName,
    },
    narrator: {
      ...mergedNarrator,
      roleType: "narrator",
      name: String(mergedNarrator.name || rolePair.narratorRole.name || "旁白").trim() || "旁白",
    },
    flags: isRecord(base.flags) ? base.flags : {},
    vars: isRecord(base.vars) ? base.vars : {},
    npcs: normalizeRuntimeNpcMap(base.npcs, settings.roles),
    inventory: Array.isArray(base.inventory) ? base.inventory : [],
    unlockedRoles: Array.isArray(base.unlockedRoles) ? base.unlockedRoles : [],
    recentEvents: Array.isArray(base.recentEvents) ? base.recentEvents : [],
    chapterProgress,
    currentEvent,
    dynamicEvents,
    // turnState 默认交给用户发言；如果已有明确 expectedRoleType，则保留原状态。
    turnState: {
      canPlayerSpeak: typeof rawTurnState.canPlayerSpeak === "boolean" ? rawTurnState.canPlayerSpeak : true,
      expectedRoleType,
      expectedRole: expectedRoleType === "player"
        ? normalizedPlayerName
        : String(rawTurnState.expectedRole || normalizedPlayerName).trim() || normalizedPlayerName,
      lastSpeakerRoleType: String(rawTurnState.lastSpeakerRoleType || "").trim(),
      lastSpeaker: String(rawTurnState.lastSpeaker || "").trim(),
    },
  };
}

// 将 `a.b.c` 这类路径切成键数组，
// 供通用状态访问/写入函数复用。
function splitPath(path: string): string[] {
  return String(path || "")
    .trim()
    .split(".")
    .map((item) => item.trim())
    .filter(Boolean);
}

// 通过点路径读取嵌套值。
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

// 通过点路径写入嵌套值；中间节点不存在时自动补对象。
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

// 条件表达式允许直接传 JSON 文本，因此这里先做一次轻量解析。
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

// 比较两个值，支持 equals/contains/in/gt/gte/lt/lte 等基础操作。
function compareValue(left: unknown, right: unknown, op: string): boolean {
  if (op === "equals") return left === right;
  if (op === "filled" || op === "present") {
    if (left === null || left === undefined) return false;
    if (typeof left === "string") return left.trim().length > 0;
    if (Array.isArray(left)) return left.length > 0;
    return true;
  }
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

// 将自然语言条件文本清洗成便于模糊匹配的规范文本。
function normalizeConditionText(input: unknown): string {
  return String(input || "")
    .replace(/[\s，。、“”"'‘’：:；;（）()【】\[\]\-—_·•・⋯…,.!?！？]/g, "")
    .trim()
    .toLowerCase();
}

// 收集 state 中会影响自然语言条件判定的文本池，
// 包括 memory/currentEvent/chapterProgress/dynamicEvents 等摘要与事实。
function collectStateConditionTexts(state: JsonRecord): string[] {
  const currentEvent = isRecord(state.currentEvent) ? state.currentEvent : {};
  const currentEventDigest = isRecord(state.currentEventDigest) ? state.currentEventDigest : {};
  const chapterProgress = isRecord(state.chapterProgress) ? state.chapterProgress : {};
  const dynamicEvents = Array.isArray(state.dynamicEvents) ? state.dynamicEvents : [];
  const values: string[] = [
    String(state.memorySummary || ""),
    ...(Array.isArray(state.memoryFacts) ? state.memoryFacts.map((item) => String(item || "")) : []),
    ...(Array.isArray(state.memoryTags) ? state.memoryTags.map((item) => String(item || "")) : []),
    String(currentEvent.summary || ""),
    ...(Array.isArray(currentEvent.facts) ? currentEvent.facts.map((item) => String(item || "")) : []),
    String(currentEventDigest.eventSummary || ""),
    ...(Array.isArray(currentEventDigest.eventFacts) ? currentEventDigest.eventFacts.map((item) => String(item || "")) : []),
    String(chapterProgress.eventSummary || ""),
    String(chapterProgress.pendingGoal || ""),
    ...dynamicEvents.flatMap((item) => {
      if (!isRecord(item)) return [];
      return [
        String(item.summary || ""),
        ...(Array.isArray(item.runtimeFacts) ? item.runtimeFacts.map((entry) => String(entry || "")) : []),
        String(item.memorySummary || ""),
        ...(Array.isArray(item.memoryFacts) ? item.memoryFacts.map((entry) => String(entry || "")) : []),
      ];
    }),
  ];
  return values
    .map((item) => normalizeConditionText(item))
    .filter(Boolean);
}

// 用自然语言做一次“软判定”。
// 命中时直接返回 true；无法确定时返回 null，交由结构化条件或 message includes 继续处理。
function evaluateNaturalLanguageCondition(text: string, ctx: ConditionContext): boolean | null {
  const normalized = normalizeConditionText(text);
  if (!normalized) return true;
  const normalizedMessage = normalizeConditionText(ctx.messageContent);
  if (normalizedMessage && (normalizedMessage.includes(normalized) || normalized.includes(normalizedMessage))) {
    return true;
  }
  return null;
}

// 从 ConditionContext 里读取 left operand，
// 支持 `state.xxx`、`meta.xxx`、`message.content`、`eventType` 等路径。
function readContextValue(ctx: ConditionContext, fieldRaw: unknown): unknown {
  const field = String(fieldRaw || "").trim();
  if (!field) return undefined;

  if (field === "message" || field === "message.content") return ctx.messageContent;
  if (field === "event" || field === "eventType") return ctx.eventType;
  if (field.startsWith("state.")) return getValueByPath(ctx.state, field.replace(/^state\./, ""));
  if (field.startsWith("meta.")) return getValueByPath(ctx.meta, field.replace(/^meta\./, ""));

  return getValueByPath(ctx.state, field);
}

// 通用条件引擎。
// 支持：
// - 字符串自然语言条件
// - 结构化条件对象
// - and/or/not 组合条件
// - state_text_contains_all 等运行时扩展操作符
export function evaluateCondition(input: unknown, ctx: ConditionContext): boolean {
  const condition = tryParseCondition(input);

  if (condition === null || condition === undefined) return true;
  if (typeof condition === "boolean") return condition;
  if (typeof condition === "string") {
    const text = condition.trim();
    if (!text) return true;
    // 先尝试自然语言软判定，
    // 失败后再退回最原始的 messageContent includes。
    const semanticMatched = evaluateNaturalLanguageCondition(text, ctx);
    if (semanticMatched !== null) {
      return semanticMatched;
    }
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
  // 这个操作符会在整个运行态文本池里查找多个关键 token，
  // 适合“已累计 3 次失败”“已绑定姓名+性别+年龄”这类隐式状态判断。
  if (op === "state_text_contains_all") {
    const values = Array.isArray(condition.value)
      ? condition.value
      : Array.isArray(condition.values)
        ? condition.values
        : [condition.value ?? condition.right];
    const tokens = values.map((item) => normalizeConditionText(item)).filter(Boolean);
    if (!tokens.length) return false;
    const textPool = collectStateConditionTexts(ctx.state).join("\n");
    return tokens.every((token) => textPool.includes(token));
  }

  const left = readContextValue(ctx, condition.field ?? condition.left);
  const right = condition.value ?? condition.right;
  if (["equals", "contains", "in", "gt", "gte", "lt", "lte"].includes(op)) {
    return compareValue(left, right, op);
  }

  return false;
}

// 将 action 列表统一归一化成对象数组。
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

// 归一化世界 settings，顺手把顶层封面/发布状态并回 settings，便于前端直接消费。
export function normalizeWorldSettings(settingsRaw: unknown, topLevel: { coverPath?: unknown; publishStatus?: unknown }): JsonRecord {
  const settings = parseJsonSafe<JsonRecord>(settingsRaw, {});
  const coverPath = String(topLevel.coverPath || "").trim();
  const publishStatus = String(topLevel.publishStatus || "").trim();
  settings.roles = normalizeSettingsRoles(settings.roles);
  if (coverPath) {
    settings.coverPath = coverPath;
  }
  if (publishStatus) {
    settings.publishStatus = publishStatus;
  }
  return settings;
}

// 归一化世界输出，补齐 settings / 用户角色 / 旁白角色。
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

// 归一化章节输出，并同步构建 runtimeOutline。
export function normalizeChapterOutput(row: any): JsonRecord | null {
  if (!row) return null;
  const normalized = normalizeChapterFields({
    content: row.content,
    openingRole: row.openingRole,
    openingText: row.openingText,
    entryCondition: row.entryCondition,
    completionCondition: row.completionCondition,
  });
  const runtimeOutline = buildChapterRuntimeOutline({
    openingRole: normalized.openingRole,
    openingText: normalized.openingText,
    content: normalized.content,
    completionCondition: normalized.completionCondition,
    runtimeOutline: row.runtimeOutline,
  });
  return {
    ...row,
    title: normalizeChapterTitle(row.title, row.sort),
    content: normalized.content,
    openingRole: normalized.openingRole,
    openingText: normalized.openingText,
    // 老章节没有显式配置该字段时仍然默认播放背景音乐。
    bgmAutoPlay: row.bgmAutoPlay === undefined || row.bgmAutoPlay === null
      ? true
      : Number(row.bgmAutoPlay) !== 0,
    showCompletionCondition: Boolean(Number(row.showCompletionCondition || 0)),
    entryCondition: normalized.entryCondition,
    completionCondition: normalized.completionCondition,
    runtimeOutline,
  };
}

// 归一化任务输出，把条件和奖励动作转成对象。
export function normalizeTaskOutput(row: any): JsonRecord | null {
  if (!row) return null;
  return {
    ...row,
    successCondition: parseJsonSafe(row.successCondition, null),
    failCondition: parseJsonSafe(row.failCondition, null),
    rewardAction: parseJsonSafe(row.rewardAction, null),
  };
}

// 归一化触发器输出，把条件和动作表达式转成对象。
export function normalizeTriggerOutput(row: any): JsonRecord | null {
  if (!row) return null;
  return {
    ...row,
    conditionExpr: parseJsonSafe(row.conditionExpr, null),
    actionExpr: parseJsonSafe(row.actionExpr, null),
  };
}

// 归一化消息输出，把 meta / revisitData 从 JSON 文本转成对象。
export function normalizeMessageOutput(row: any): JsonRecord | null {
  if (!row) return null;
  return {
    ...row,
    meta: parseJsonSafe(row.meta, {}),
    revisitData: parseJsonSafe(row.revisitData, null),
  };
}
