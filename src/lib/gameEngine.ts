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
  phaseId: string;
  phaseIndex: number;
  userNodeId: string;
  userNodeIndex: number;
  userNodeStatus: "idle" | "waiting_input" | "completed" | "skipped";
  completedEvents: string[];
  pendingGoal: string;
  fixedOutcomeLocked: boolean;
  lastEvaluatedMessageId: number;
}

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

function splitParagraphs(input: string): string[] {
  return String(input || "")
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function slugifyRuntimeKey(input: unknown, fallback: string): string {
  const text = normalizeEditorText(input)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return text || fallback;
}

function normalizeSuggestionList(input: string): string[] {
  return String(input || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => /^[-*]\s+/.test(item))
    .map((item) => item.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}

function normalizeRuntimeSummary(input: string, fallback: string): string {
  const text = String(input || "")
    .replace(/\r\n/g, "\n")
    .replace(/^@([^:\n：]+)\s*[:：]\s*/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 80) || fallback;
}

function normalizePhaseSignalList(input: unknown[]): string[] {
  return Array.from(new Set(
    (Array.isArray(input) ? input : [])
      .map((item) => normalizeEditorText(item))
      .filter(Boolean)
      .map((item) => item.slice(0, 80)),
  ));
}

function splitRuntimeDirectiveItems(input: string): string[] {
  return String(input || "")
    .replace(/\r\n/g, "\n")
    .split(/[\n,，;；|]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getUserNodeRuntimeMarker(userNodeId: string): string {
  return `user_node:${String(userNodeId || "").trim()}`;
}

function getPhaseRuntimeMarker(phaseId: string): string {
  return `phase:${String(phaseId || "").trim()}`;
}

function isUserNodeHeading(input: string): boolean {
  return /用户行动|用户交互|用户节点|唯一干预机会/u.test(String(input || ""));
}

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

function extractRuntimeUserNodesFromContent(input: unknown): ChapterRuntimeUserNode[] {
  return extractRuntimeSections(input)
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
    const role = String(matched[1] || "").trim();
    const content = String(matched[2] || "").trim();
    if (role) signals.push(role);
    if (content) signals.push(content.slice(0, 80));
  }
  return normalizePhaseSignalList(signals);
}

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

function extractRuntimePhasesFromContent(
  input: unknown,
  userNodes: ChapterRuntimeUserNode[],
  fixedEvents: ChapterRuntimeOutline["fixedEvents"],
): ChapterRuntimePhase[] {
  const sections = extractRuntimeSections(input);
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
      requiredEventIds: phaseDirectives.requiredEventIds.length
        ? phaseDirectives.requiredEventIds
        : (previousPhaseId ? [getPhaseRuntimeMarker(previousPhaseId)] : []),
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

function buildFixedEventsFromCompletionCondition(input: unknown): ChapterRuntimeOutline["fixedEvents"] {
  const condition = tryParseCondition(input);
  if (typeof condition === "string" && condition.trim()) {
    return [{
      id: `fixed_event_${slugifyRuntimeKey(condition, "success")}`,
      label: condition.trim(),
      requiredBeforeFinish: true,
    }];
  }
  if (isRecord(condition)) {
    const successCondition = condition.success ?? condition.pass ?? condition.result ?? condition.outcome;
    if (typeof successCondition === "string" && successCondition.trim()) {
      return [{
        id: `fixed_event_${slugifyRuntimeKey(successCondition, "success")}`,
        label: successCondition.trim(),
        requiredBeforeFinish: true,
      }];
    }
  }
  return [];
}

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

export function buildChapterRuntimeOutline(input: {
  openingRole?: unknown;
  openingText?: unknown;
  content?: unknown;
  completionCondition?: unknown;
  runtimeOutline?: unknown;
}): ChapterRuntimeOutline {
  const normalizedExisting = normalizeChapterRuntimeOutline(input.runtimeOutline);
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
  const fixedEvents = normalizedExisting.fixedEvents.length
    ? normalizedExisting.fixedEvents
    : buildFixedEventsFromCompletionCondition(input.completionCondition);
  const phases = normalizedExisting.phases.length
    ? normalizedExisting.phases
    : extractRuntimePhasesFromContent(input.content, userNodes, fixedEvents);
  return {
    openingMessages,
    phases,
    userNodes,
    fixedEvents,
    endingRules: {
      success: normalizedExisting.endingRules.success.length
        ? normalizedExisting.endingRules.success
        : fixedEvents.filter((item) => item.requiredBeforeFinish).map((item) => item.id),
      failure: normalizedExisting.endingRules.failure,
      nextChapterId: normalizedExisting.endingRules.nextChapterId,
    },
  };
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

function normalizeOptionalNumber(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  const text = normalizeEditorText(input);
  if (!text) return null;
  const matched = text.match(/^\d{1,6}$/);
  if (!matched) return null;
  const value = Number(matched[0]);
  return Number.isFinite(value) ? value : null;
}

function normalizeStringList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => normalizeEditorText(item))
    .filter(Boolean)
    .slice(0, 64);
}

function extractParameterCardText(source: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const matched = source.match(pattern);
    const value = normalizeEditorText(matched?.[1]);
    if (value) return value;
  }
  return "";
}

function inferGenderFromText(source: string): string {
  const explicit = extractParameterCardText(source, [
    /性别\s*[:：]\s*(男|女)/i,
  ]);
  if (explicit === "男" || explicit === "女") return explicit;
  if (/(少女|女子|女性|女人|女孩|女生|御姐|她\b|女主)/.test(source)) return "女";
  if (/(少年|男子|男性|男人|男孩|男生|他\b|男主)/.test(source)) return "男";
  return "";
}

function inferAgeFromText(source: string): number | null {
  const matched = source.match(/(\d{1,3})\s*岁/);
  if (!matched) return null;
  const value = Number(matched[1]);
  return Number.isFinite(value) ? value : null;
}

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

function hasUsableParameterCard(input: unknown): boolean {
  if (!isRecord(input)) return false;
  return Object.values(input).some((value) => {
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "number") return Number.isFinite(value);
    return !isNullLikeText(normalizeEditorText(value));
  });
}

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

export function normalizeRolePair(playerRoleRaw: unknown, narratorRoleRaw: unknown): RolePair {
  return {
    playerRole: normalizeStoryRole(playerRoleRaw, DEFAULT_PLAYER_ROLE),
    narratorRole: normalizeStoryRole(narratorRoleRaw, DEFAULT_NARRATOR_ROLE),
  };
}

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
  phaseId: "",
  phaseIndex: 0,
  userNodeId: "",
  userNodeIndex: -1,
  userNodeStatus: "idle",
  completedEvents: [],
  pendingGoal: "",
  fixedOutcomeLocked: false,
  lastEvaluatedMessageId: 0,
};

function normalizeChapterProgressStatus(input: unknown): ChapterProgressState["userNodeStatus"] {
  const status = String(input || "").trim().toLowerCase();
  if (status === "waiting_input") return "waiting_input";
  if (status === "completed") return "completed";
  if (status === "skipped") return "skipped";
  return "idle";
}

export function normalizeChapterProgressState(raw: unknown): ChapterProgressState {
  const base = parseJsonSafe<JsonRecord>(raw, {});
  const completedEvents = Array.isArray(base.completedEvents)
    ? base.completedEvents.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  return {
    phaseId: String(base.phaseId || "").trim(),
    phaseIndex: Number.isFinite(Number(base.phaseIndex)) ? Math.max(0, Number(base.phaseIndex)) : DEFAULT_CHAPTER_PROGRESS_STATE.phaseIndex,
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

export function readChapterProgressState(state: unknown): ChapterProgressState {
  if (!isRecord(state)) return normalizeChapterProgressState(undefined);
  return normalizeChapterProgressState(state.chapterProgress);
}

export function setChapterProgressState(state: JsonRecord, patch: Partial<ChapterProgressState>): ChapterProgressState {
  const current = readChapterProgressState(state);
  const next = normalizeChapterProgressState({
    ...current,
    ...patch,
  });
  state.chapterProgress = next;
  return next;
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
  worldRaw?: unknown,
): JsonRecord {
  const base = parseJsonSafe<JsonRecord>(raw, {});
  const player = isRecord(base.player) ? base.player : {};
  const narrator = isRecord(base.narrator) ? base.narrator : {};
  const rawTurnState = isRecord(base.turnState) ? base.turnState : {};
  const chapterProgress = normalizeChapterProgressState(base.chapterProgress);
  const world = parseJsonSafe<JsonRecord>(worldRaw, {});
  const settings = normalizeWorldSettings(world.settings, {
    coverPath: world.coverPath,
    publishStatus: world.publishStatus,
  });
  const mergedPlayer = mergeRuntimeRoleWithStoryRole(rolePair.playerRole, player, "用户");
  const mergedNarrator = mergeRuntimeRoleWithStoryRole(rolePair.narratorRole, narrator, "旁白");
  const normalizedPlayerName = String(mergedPlayer.name || rolePair.playerRole.name || "用户").trim() || "用户";
  const expectedRoleType = String(rawTurnState.expectedRoleType || "player").trim() || "player";

  return {
    version: 1,
    worldId,
    chapterId,
    round: Number.isFinite(Number(base.round)) ? Number(base.round) : 0,
    ...base,
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

function normalizeConditionText(input: unknown): string {
  return String(input || "")
    .replace(/[\s，。、“”"'‘’：:；;（）()【】\[\]\-—_·•・⋯…,.!?！？]/g, "")
    .trim()
    .toLowerCase();
}

function isGenericPlayerName(input: unknown): boolean {
  const text = normalizeEditorText(input);
  if (!text) return true;
  return ["用户", "用户", "主角", "我", "本人"].includes(text);
}

function hasBoundPlayerIdentity(state: JsonRecord): boolean {
  const player = isRecord(state.player) ? state.player : {};
  if (player.identity_bound === true) return true;
  const card = isRecord(player.parameterCardJson) ? player.parameterCardJson : {};
  const name = normalizeEditorText(card.name);
  const gender = normalizeEditorText(card.gender);
  const age = normalizeOptionalNumber(card.age);
  return !!name && !isGenericPlayerName(name) && !!gender && age != null;
}

function evaluateNaturalLanguageCondition(text: string, ctx: ConditionContext): boolean | null {
  const normalized = normalizeConditionText(text);
  if (!normalized) return true;

  const asksIdentity =
    (normalized.includes("输入") || normalized.includes("填写") || normalized.includes("提供") || normalized.includes("告知") || normalized.includes("绑定"))
    && (normalized.includes("姓名") || normalized.includes("名称") || normalized.includes("名字"))
    && normalized.includes("性别")
    && normalized.includes("年龄");
  const mentionsIdentityBound =
    (normalized.includes("身份绑定") || normalized.includes("绑定身份") || normalized.includes("完成绑定"))
    && (normalized.includes("姓名") || normalized.includes("名称") || normalized.includes("性别") || normalized.includes("年龄"));

  if (asksIdentity || mentionsIdentityBound) {
    return hasBoundPlayerIdentity(ctx.state);
  }
  return null;
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
  settings.roles = normalizeSettingsRoles(settings.roles);
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
    showCompletionCondition: Boolean(Number(row.showCompletionCondition || 0)),
    entryCondition: normalized.entryCondition,
    completionCondition: normalized.completionCondition,
    runtimeOutline,
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
