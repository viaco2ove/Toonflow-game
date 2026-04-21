import express from "express";
import { RuntimeMessageInput } from "@/modules/game-runtime/engines/NarrativeOrchestrator";
import { success } from "@/lib/responseFormat";
import { cacheAndBuildDebugStateSnapshot } from "./debugRuntimeShared";
import { DebugLogUtil } from "@/utils/debugLogUtil";

export type PlanSourceType = "ai" | "fallback" | "rule";
export type PlanEventAdjustMode = "keep" | "update" | "waiting_input" | "completed";
export type PlanEventKind = "opening" | "scene" | "user" | "fixed" | "ending";
export type PlanEventStatus = "idle" | "active" | "waiting_input" | "completed";
export type PlanSpeakerMode = "template" | "fast" | "premium";
export type OrchestrationCommandType = "init_chapter";

export type OrchestrationCommand = {
  type: OrchestrationCommandType;
  chapterId: number;
  chapterTitle: string;
  trigger: "chapter_completed";
};

export type PlanLike = {
  role: string;
  roleType: string;
  motive: string;
  awaitUser: boolean;
  nextRole: string;
  nextRoleType: string;
  source: PlanSourceType;
  memoryHints?: string[];
  triggerMemoryAgent?: boolean;
  stateDelta?: Record<string, unknown>;
  eventType?: string;
  presetContent?: string;
  eventAdjustMode?: PlanEventAdjustMode;
  eventIndex?: number;
  eventKind?: PlanEventKind;
  eventSummary?: string;
  eventFacts?: string[];
  eventStatus?: PlanEventStatus;
  speakerMode?: PlanSpeakerMode;
  speakerRouteReason?: string;
  planSource?: string;
  orchestratorRuntime?: {
    modelKey?: unknown;
    manufacturer?: unknown;
    model?: unknown;
    reasoningEffort?: unknown;
    payloadMode?: unknown;
    payloadModeSource?: unknown;
  };
};

/**
 * 统一把 unknown 转成安全短文本，避免日志和响应里出现 [object Object]。
 */
export function asTrimmedText(value: unknown, fallback = "") {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  return fallback;
}

/**
 * 统一 source 字段，避免前端再自己猜是 AI、规则还是兜底结果。
 */
function normalizePlanSource(source: PlanSourceType) {
  if (source === "fallback") return "fallback";
  if (source === "rule") return "rule";
  return "ai";
}

/**
 * 只保留前端认得的事件调整模式，脏值直接丢弃。
 */
function normalizePlanEventAdjustMode(mode?: PlanEventAdjustMode) {
  if (!mode) return undefined;
  if (mode === "keep" || mode === "update" || mode === "waiting_input" || mode === "completed") return mode;
  return undefined;
}

/**
 * 统一规范事件类型，避免调试态和正式态出现不同枚举值。
 */
function normalizePlanEventKind(kind?: PlanEventKind) {
  if (!kind) return undefined;
  if (kind === "opening" || kind === "scene" || kind === "user" || kind === "fixed" || kind === "ending") return kind;
  return undefined;
}

/**
 * 统一规范事件状态，防止前端收到未知状态后展示异常。
 */
function normalizePlanEventStatus(status?: PlanEventStatus) {
  if (!status) return undefined;
  if (status === "idle" || status === "active" || status === "waiting_input" || status === "completed") return status;
  return undefined;
}

/**
 * 统一规范发言模式，保证前端只处理有限展示分支。
 */
function normalizePlanSpeakerMode(mode?: PlanSpeakerMode) {
  if (!mode) return undefined;
  if (mode === "template" || mode === "fast" || mode === "premium") return mode;
  return undefined;
}

/**
 * 推理强度是可选配置，只有受支持的值才继续透传给前端。
 */
function normalizeReasoningEffort(value: unknown) {
  const normalized = asTrimmedText(value).toLowerCase();
  if (normalized === "minimal" || normalized === "low" || normalized === "medium" || normalized === "high") return normalized;
  return "";
}

/**
 * payload 模式只允许 compact/advanced 两种，其他值统一回退到 compact。
 */
function normalizePayloadMode(value: unknown) {
  return asTrimmedText(value).toLowerCase() === "advanced" ? "advanced" : "compact";
}

/**
 * 区分 payload 模式来源，方便判断是显式配置还是推断得到。
 */
function normalizePayloadModeSource(value: unknown) {
  return asTrimmedText(value).toLowerCase() === "explicit" ? "explicit" : "inferred";
}

/**
 * 统一推导 planSource，避免每个调用方都重复拼来源标签。
 */
function resolvePlanSource(plan: PlanLike) {
  const explicit = asTrimmedText(plan.planSource);
  if (explicit) return explicit;
  const eventType = asTrimmedText(plan.eventType);
  const presetContent = asTrimmedText(plan.presetContent);
  if (eventType === "on_opening" && presetContent) return "opening_preset";
  if (plan.source === "rule") return "rule_orchestrator";
  if (plan.source === "fallback") return "fallback_orchestrator";
  return "ai_orchestrator";
}

/**
 * 编排运行信息只做轻量裁剪，避免把后端内部对象原样暴露给前端。
 */
function normalizeOrchestratorRuntime(plan: PlanLike) {
  if (!plan.orchestratorRuntime) return undefined;
  return {
    modelKey: asTrimmedText(plan.orchestratorRuntime.modelKey),
    manufacturer: asTrimmedText(plan.orchestratorRuntime.manufacturer),
    model: asTrimmedText(plan.orchestratorRuntime.model),
    reasoningEffort: normalizeReasoningEffort(plan.orchestratorRuntime.reasoningEffort),
    payloadMode: normalizePayloadMode(plan.orchestratorRuntime.payloadMode),
    payloadModeSource: normalizePayloadModeSource(plan.orchestratorRuntime.payloadModeSource),
  };
}

/**
 * 把编排器/兜底结果收口成稳定结构，供路由内部复用。
 */
export function buildPlanResult(plan: PlanLike | null) {
  if (!plan) return null;
  return {
    role: asTrimmedText(plan.role),
    roleType: asTrimmedText(plan.roleType),
    motive: asTrimmedText(plan.motive),
    awaitUser: Boolean(plan.awaitUser),
    nextRole: asTrimmedText(plan.nextRole),
    nextRoleType: asTrimmedText(plan.nextRoleType),
    source: normalizePlanSource(plan.source),
    triggerMemoryAgent: Boolean(plan.triggerMemoryAgent),
    eventType: asTrimmedText(plan.eventType, "on_orchestrated_reply") || "on_orchestrated_reply",
    presetContent: asTrimmedText(plan.presetContent) || null,
    eventAdjustMode: normalizePlanEventAdjustMode(plan.eventAdjustMode),
    eventIndex: Number.isFinite(Number(plan.eventIndex)) ? Math.max(1, Number(plan.eventIndex)) : undefined,
    eventKind: normalizePlanEventKind(plan.eventKind),
    eventSummary: asTrimmedText(plan.eventSummary),
    eventFacts: Array.isArray(plan.eventFacts)
      ? plan.eventFacts.map((item) => asTrimmedText(item)).filter(Boolean)
      : [],
    eventStatus: normalizePlanEventStatus(plan.eventStatus),
    speakerMode: normalizePlanSpeakerMode(plan.speakerMode),
    speakerRouteReason: asTrimmedText(plan.speakerRouteReason),
    planSource: resolvePlanSource(plan),
    orchestratorRuntime: normalizeOrchestratorRuntime(plan),
  };
}

/**
 * 解析调试编排接口当前真正生效的章节元信息。
 *
 * 用途：
 * - 调试态会在 state 内部先登记或切换章节，`params.chapter` 可能仍是旧章节；
 * - 如果接口继续把旧章节 id/title 回给前端，标题、事件面板和编排 trace 会串章；
 * - 这里统一优先信运行态，再回退到 effectiveChapter 和请求章节，保证返回口径一致。
 */
export function resolveDebugResponseChapterMeta(params: {
  chapter?: any;
  effectiveChapter?: any;
  state?: Record<string, any> | null;
}) {
  const stateChapterId = Number(params.state?.chapterId || 0);
  const effectiveChapterId = Number(params.effectiveChapter?.id || 0);
  const requestChapterId = Number(params.chapter?.id || 0);
  return {
    chapterId: stateChapterId || effectiveChapterId || requestChapterId || 0,
    chapterTitle: asTrimmedText(
      params.state?.chapterTitle,
      asTrimmedText(params.effectiveChapter?.title, asTrimmedText(params.chapter?.title)),
    ),
  };
}

/**
 * 对固定消息套一层与 AI 编排相同的计划外形，减少调用方分支判断。
 */
export function buildPresetPlan(message: {
  role?: unknown;
  roleType?: unknown;
  eventType?: unknown;
  content?: unknown;
} | null, next: {
  awaitUser?: boolean;
  nextRole?: string;
  nextRoleType?: string;
}) {
  const messageEventType = asTrimmedText(message?.eventType, "on_debug");
  return buildPlanResult({
    role: asTrimmedText(message?.role, "旁白"),
    roleType: asTrimmedText(message?.roleType, "narrator"),
    motive: "",
    awaitUser: Boolean(next.awaitUser),
    nextRole: asTrimmedText(next.nextRole),
    nextRoleType: asTrimmedText(next.nextRoleType),
    source: "fallback",
    planSource: messageEventType === "on_opening" ? "opening_preset" : "preset",
    memoryHints: [],
    triggerMemoryAgent: false,
    stateDelta: {},
    eventType: messageEventType,
    presetContent: asTrimmedText(message?.content),
  });
}

/**
 * 在章节成功后构造“当前章节收口确认”的最小编排结果。
 */
export function buildDebugSuccessFollowUpPlan(params: {
  state: Record<string, any>;
  rolePair: {
    narratorRole: {
      name?: string;
    };
  };
}) {
  const playerName = asTrimmedText(params.state.player?.name, "用户") || "用户";
  return buildPlanResult({
    role: asTrimmedText(params.rolePair.narratorRole.name, "旁白") || "旁白",
    roleType: "narrator",
    motive: `确认${playerName}的角色信息并完成角色绑定`,
    awaitUser: false,
    nextRole: "",
    nextRoleType: "",
    source: "rule",
    triggerMemoryAgent: false,
    eventType: "on_orchestrated_reply",
    presetContent: "",
    eventAdjustMode: "completed",
    eventStatus: "completed",
    planSource: "chapter_success_followup",
  });
}

/**
 * /game/orchestration 只允许返回“当前谁说、为什么说、是否轮到用户”和显式章节命令。
 * 其他运行时状态统一缓存到服务端，后续再通过 storyInfo/streamlines 获取。
 */
export function buildOrchestrationPayload(params: {
  userId: number;
  worldId: number;
  state: Record<string, any>;
  chapterId: number;
  chapterTitle: string;
  endDialog?: string | null;
  endDialogDetail?: string | null;
  plan?: ReturnType<typeof buildPlanResult>;
  command?: OrchestrationCommand | null;
  messages?: RuntimeMessageInput[];
}) {
  cacheAndBuildDebugStateSnapshot({
    userId: params.userId,
    worldId: params.worldId,
    state: params.state,
  });

  if (DebugLogUtil.isDebugLogEnabled()) {
    const planSource = asTrimmedText(params.plan?.planSource);
    const tag = planSource === "opening_preset"
      ? "story:introduction:plan"
      : "story:orchestrator:plan";
    console.log(`[${tag}]`, JSON.stringify({
      planSource,
      awaitUser: Boolean(params.plan?.awaitUser),
      roleType: asTrimmedText(params.plan?.roleType),
      role: asTrimmedText(params.plan?.role),
    }));
  }

  return {
    role: asTrimmedText(params.plan?.role),
    // 前端需要明确知道当前发言角色类型，用于区分旁白、NPC 和用户展示样式。
    roleType: asTrimmedText(params.plan?.roleType),
    motive: asTrimmedText(params.plan?.motive),
    // 正式游玩只认 awaitUser，不再对外暴露“下一位是谁”的预编排字段。
    awaitUser: Boolean(params.plan?.awaitUser),
    command: params.command || null,
  };
}

/**
 * 把正式会话和调试态的计划统一收口成接口约定的最小返回结构。
 */
export function buildMinimalOrchestrationResponse(plan?: {
  role?: unknown;
  roleType?: unknown;
  motive?: unknown;
  awaitUser?: unknown;
  command?: OrchestrationCommand | null;
} | null) {
  return {
    role: asTrimmedText(plan?.role),
    roleType: asTrimmedText(plan?.roleType),
    motive: asTrimmedText(plan?.motive),
    awaitUser: Boolean(plan?.awaitUser),
    command: plan?.command || null,
  };
}

/**
 * 调试态统一成功返回入口，避免每个分支都重复拼最小响应。
 *
 * 响应约束：
 * - 外层维持通用 `code/message` 信封；
 * - data 只能包含 `role/roleType/motive/awaitUser`，禁止夹带 state、chapter、event 等大杂烩字段。
 */
export function sendDebugSuccess(
  res: express.Response,
  params: Parameters<typeof buildOrchestrationPayload>[0],
) {
  return res.status(200).send(success(buildOrchestrationPayload(params)));
}
