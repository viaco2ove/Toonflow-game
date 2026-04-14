import u from "@/utils";
import { JsonRecord } from "@/lib/gameEngine";
import { AiEventProgressResolution } from "@/modules/game-runtime/engines/ChapterProgressEngine";
import { DebugLogUtil } from "@/utils/debugLogUtil";
import { z } from "zod";

/**
 * 事件进度检测输入。
 *
 * 用途：
 * - 给 AI 提供当前事件、当前进度和最近 10 条对话
 * - 只判断“当前事件是否结束、现在进行到哪一步”
 */
export interface EvaluateEventProgressInput {
  userId?: number;
  chapter: any;
  state: JsonRecord;
  messageContent?: string;
  messageRole?: string;
  messageRoleType?: string;
  eventType?: string;
  recentMessages?: any[];
  traceMeta?: JsonRecord;
}

type EventProgressTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
};

const eventProgressOutputSchema = {
  ended: z.boolean(),
  event_status: z.enum(["active", "waiting_input", "completed"]).optional(),
  progress_summary: z.string().nullable().optional(),
  progress_facts: z.array(z.string()).optional(),
  reason: z.string().nullable().optional(),
};

/**
 * 归一化单值文本，过滤 null/undefined/空串。
 */
function normalizeScalarText(input: unknown): string {
  const text = String(input ?? "").trim();
  if (!text || text === "null" || text === "undefined") return "";
  return text;
}

/**
 * 归一化 traceMeta，保证日志输出结构稳定。
 */
function normalizeTraceMeta(input: unknown): JsonRecord {
  if (!input || typeof input !== "object") return {};
  return input as JsonRecord;
}

/**
 * 对较长文本做日志截断，避免一轮事件进度检测把终端刷爆。
 */
function shortText(input: unknown, limit = 160): string {
  const text = normalizeScalarText(input);
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

/**
 * 优先读取自定义值，没有再回退到默认 prompt。
 */
function getPromptValue(row: any): string {
  const customValue = normalizeScalarText(row?.customValue);
  if (customValue) return customValue;
  return normalizeScalarText(row?.defaultValue);
}

/**
 * 去掉 markdown 代码块包裹，兼容模型偶尔返回 ```json 的情况。
 */
function unwrapModelText(input: unknown): string {
  return normalizeScalarText(input).replace(/^```[a-zA-Z]*\s*|\s*```$/g, "").trim();
}

/**
 * 尽量把 SDK 返回结果归一化为普通对象，避免 Proxy / getter 干扰后续解析。
 */
function normalizeResultObject(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object") return null;
  try {
    return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  } catch {
    return input as Record<string, unknown>;
  }
}

/**
 * 同一 orchestration 请求下，记录事件进度检测关键节点，方便核对是否重复调用。
 */
function logEventProgressKeyNode(node: string, traceMeta: unknown, extra?: Record<string, unknown>) {
  if (!DebugLogUtil.isDebugLogEnabled()) return;
  console.log("[game:orchestrator:key_nodes]", JSON.stringify({
    node,
    ...normalizeTraceMeta(traceMeta),
    ...(extra || {}),
  }));
}

/**
 * 回退解析纯文本 key-value 输出，兼容模型偶发未按 schema 返回对象的情况。
 */
function parseFieldMap(rawText: string): Record<string, string> {
  const lines = unwrapModelText(rawText)
    .split(/\r?\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const result: Record<string, string> = {};
  for (const line of lines) {
    const matched = line.match(/^[-*]?\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*[:：=]\s*(.*)$/);
    if (!matched) continue;
    result[matched[1].toLowerCase()] = matched[2].trim();
  }
  return result;
}

/**
 * 从 field map 中读取第一个非空字段。
 */
function getPlainField(fields: Record<string, string>, ...keys: string[]): string {
  for (const key of keys) {
    const value = normalizeScalarText(fields[key.toLowerCase()]);
    if (value) return value;
  }
  return "";
}

/**
 * 归一化布尔值，兼容模型输出 true/false/yes/no/1/0。
 */
function normalizeBoolean(input: unknown): boolean | null {
  const text = normalizeScalarText(input).toLowerCase();
  if (!text) return null;
  if (["true", "yes", "1", "completed", "ended"].includes(text)) return true;
  if (["false", "no", "0", "active", "waiting_input", "ongoing"].includes(text)) return false;
  return null;
}

/**
 * 归一化事件状态，确保只落库允许的状态值。
 */
function normalizeEventStatus(input: unknown): "active" | "waiting_input" | "completed" {
  const text = normalizeScalarText(input).toLowerCase();
  if (text === "completed") return "completed";
  if (text === "waiting_input") return "waiting_input";
  return "active";
}

/**
 * 读取事件进度检测 prompt。
 */
async function loadEventProgressPrompt(): Promise<string> {
  const row = await u.db("t_prompts")
    .where("code", "story-event-progress")
    .first("defaultValue", "customValue");
  return getPromptValue(row);
}

/**
 * 解析事件进度检测模型配置。
 *
 * 回退顺序：
 * 1. storyEventProgressModel
 * 2. storyChapterJudgeModel
 * 3. storyOrchestratorModel
 */
async function resolveEventProgressModel(userId?: number) {
  const primary = await u.getPromptAi("storyEventProgressModel", userId);
  if (normalizeScalarText((primary as Record<string, unknown> | null)?.manufacturer)) {
    return primary;
  }
  const chapterJudgeFallback = await u.getPromptAi("storyChapterJudgeModel", userId);
  if (normalizeScalarText((chapterJudgeFallback as Record<string, unknown> | null)?.manufacturer)) {
    return chapterJudgeFallback;
  }
  const orchestratorFallback = await u.getPromptAi("storyOrchestratorModel", userId);
  if (normalizeScalarText((orchestratorFallback as Record<string, unknown> | null)?.manufacturer)) {
    return orchestratorFallback;
  }
  throw new Error("事件进度检测对接的模型未配置");
}

/**
 * 组装给事件进度检测 agent 的最小输入快照。
 */
function buildEventProgressInputSnapshot(input: EvaluateEventProgressInput): JsonRecord {
  const chapterProgress =
    typeof input.state.chapterProgress === "object" && input.state.chapterProgress !== null
      ? (input.state.chapterProgress as Record<string, unknown>)
      : {};
  const currentEvent =
    typeof input.state.currentEventDigest === "object" && input.state.currentEventDigest !== null
      ? (input.state.currentEventDigest as Record<string, unknown>)
      : {};
  const recentDialogue = Array.isArray(input.recentMessages)
    ? input.recentMessages
        .slice(-10)
        .map((item) => ({
          role: normalizeScalarText(item?.role) || "未知角色",
          role_type: normalizeScalarText(item?.roleType) || "",
          event_type: normalizeScalarText(item?.eventType) || "",
          content: shortText(item?.content, 160),
        }))
        .filter((item) => item.content)
    : [];
  return {
    chapter: {
      id: Number(input.chapter?.id || 0),
      title: normalizeScalarText(input.chapter?.title) || "未命名章节",
    },
    current_event: {
      index: Number(chapterProgress.eventIndex || currentEvent.eventIndex || 0),
      kind: normalizeScalarText(chapterProgress.eventKind || currentEvent.eventKind) || "scene",
      flow: normalizeScalarText(currentEvent.eventFlowType) || "chapter_content",
      status: normalizeEventStatus(chapterProgress.eventStatus || currentEvent.eventStatus),
      summary: normalizeScalarText(chapterProgress.eventSummary || currentEvent.eventSummary),
      facts: Array.isArray(currentEvent.eventFacts)
        ? currentEvent.eventFacts.map((item) => normalizeScalarText(item)).filter(Boolean)
        : [],
    },
    current_progress: {
      phase_id: normalizeScalarText(chapterProgress.phaseId),
      phase_index: Number(chapterProgress.phaseIndex || 0),
      user_node_status: normalizeScalarText(chapterProgress.userNodeStatus) || "idle",
      pending_goal: normalizeScalarText(chapterProgress.pendingGoal),
      completed_events: Array.isArray(chapterProgress.completedEvents)
        ? chapterProgress.completedEvents.map((item) => normalizeScalarText(item)).filter(Boolean)
        : [],
    },
    latest_message: {
      role: normalizeScalarText(input.messageRole) || "",
      role_type: normalizeScalarText(input.messageRoleType) || "",
      event_type: normalizeScalarText(input.eventType) || "",
      content: normalizeScalarText(input.messageContent) || "",
    },
    recent_dialogue: recentDialogue,
  };
}

/**
 * 把事件进度检测输入快照压成更适合 debug 日志阅读的结构。
 *
 * 用途：
 * - 快速确认发给 agent 的到底是不是当前事件
 * - 直接看到 latest_message / recent_dialogue 是否把无关内容混进去了
 */
function buildEventProgressDebugSnapshot(snapshot: JsonRecord): JsonRecord {
  const currentEvent =
    typeof snapshot.current_event === "object" && snapshot.current_event !== null
      ? snapshot.current_event as Record<string, unknown>
      : {};
  const currentProgress =
    typeof snapshot.current_progress === "object" && snapshot.current_progress !== null
      ? snapshot.current_progress as Record<string, unknown>
      : {};
  const latestMessage =
    typeof snapshot.latest_message === "object" && snapshot.latest_message !== null
      ? snapshot.latest_message as Record<string, unknown>
      : {};
  const recentDialogue = Array.isArray(snapshot.recent_dialogue)
    ? snapshot.recent_dialogue as Array<Record<string, unknown>>
    : [];
  return {
    currentEvent: {
      index: Number(currentEvent.index || 0),
      kind: normalizeScalarText(currentEvent.kind),
      flow: normalizeScalarText(currentEvent.flow),
      status: normalizeScalarText(currentEvent.status),
      summary: normalizeScalarText(currentEvent.summary),
      facts: Array.isArray(currentEvent.facts)
        ? currentEvent.facts.map((item) => normalizeScalarText(item)).filter(Boolean)
        : [],
    },
    currentProgress: {
      phaseId: normalizeScalarText(currentProgress.phase_id),
      phaseIndex: Number(currentProgress.phase_index || 0),
      userNodeStatus: normalizeScalarText(currentProgress.user_node_status),
      pendingGoal: normalizeScalarText(currentProgress.pending_goal),
      completedEvents: Array.isArray(currentProgress.completed_events)
        ? currentProgress.completed_events.map((item) => normalizeScalarText(item)).filter(Boolean)
        : [],
    },
    latestMessage: {
      role: normalizeScalarText(latestMessage.role),
      roleType: normalizeScalarText(latestMessage.role_type),
      eventType: normalizeScalarText(latestMessage.event_type),
      content: normalizeScalarText(latestMessage.content),
      contentLength: normalizeScalarText(latestMessage.content).length,
    },
    recentDialogueCount: recentDialogue.length,
    recentDialogue: recentDialogue.map((item) => ({
      role: normalizeScalarText(item.role),
      roleType: normalizeScalarText(item.role_type),
      eventType: normalizeScalarText(item.event_type),
      content: normalizeScalarText(item.content),
    })),
  };
}

/**
 * 构造最终发送给模型的用户 prompt。
 */
function buildEventProgressPrompt(input: EvaluateEventProgressInput): string {
  return JSON.stringify(buildEventProgressInputSnapshot(input), null, 2);
}

/**
 * 打印事件进度检测的 runtime/stats 日志。
 */
function buildEventProgressStats(input: {
  systemPrompt: string;
  prompt: string;
  inputSnapshot: JsonRecord;
  responseText: string;
  parsedResolution?: AiEventProgressResolution | null;
  tokenUsage?: EventProgressTokenUsage | null;
  requestStatus: "success" | "fallback" | "skip_no_prompt";
  manufacturer: string;
  model: string;
  reasoningEffort: string;
  buildMs?: number;
  invokeMs?: number;
  totalMs?: number;
  traceMeta?: JsonRecord;
  start: number;
}) {
  const inputDebugSnapshot = buildEventProgressDebugSnapshot(input.inputSnapshot);
  const runtimeLog = {
    manufacturer: input.manufacturer,
    model: input.model,
    reasoningEffort: input.reasoningEffort || "",
    traceMeta: normalizeTraceMeta(input.traceMeta),
    inputSnapshot: inputDebugSnapshot,
    requestChars: input.systemPrompt.length + input.prompt.length,
    systemChars: input.systemPrompt.length,
    userChars: input.prompt.length,
    requestStatus: input.requestStatus,
    responseText: input.responseText,
    responseTextLength: input.responseText.length,
    parsedResolution: input.parsedResolution || null,
    tokenUsage: input.tokenUsage || null,
    buildMs: Number(input.buildMs || 0),
    invokeMs: Number(input.invokeMs || 0),
    totalMs: Number(input.totalMs || 0),
  };
  console.log("[story:event_progress:runtime]", JSON.stringify(runtimeLog));
  if (!DebugLogUtil.isDebugLogEnabled()) return;
  console.log(`[story:event_progress:stats] request_chars=${runtimeLog.requestChars} system_chars=${runtimeLog.systemChars} user_chars=${runtimeLog.userChars} request_status=${input.requestStatus} build_ms=${runtimeLog.buildMs} invoke_ms=${runtimeLog.invokeMs} total_ms=${runtimeLog.totalMs}`);
  console.log(`[story:event_progress:stats] | 输入摘要 | current_event=${inputDebugSnapshot.currentEvent?.index || 0}/${inputDebugSnapshot.currentEvent?.status || ""} ↩ phase=${inputDebugSnapshot.currentProgress?.phaseId || ""} ↩ latest_role=${inputDebugSnapshot.latestMessage?.role || ""}/${inputDebugSnapshot.latestMessage?.eventType || ""} ↩ recent_dialogue_count=${inputDebugSnapshot.recentDialogueCount || 0} | - | - |`);
  console.log(`[story:event_progress:stats] | 解析结果 | ended=${String(input.parsedResolution?.ended ?? "")} ↩ event_status=${normalizeScalarText(input.parsedResolution?.eventStatus)} ↩ progress_summary=${shortText(input.parsedResolution?.progressSummary, 240000)} ↩ reason=${shortText(input.parsedResolution?.reason, 240000)} | - | - |`);
  console.log(`[story:event_progress:stats] | 区块 | 实际内容 | 字符数 | 估算 Tokens |`);
  console.log(`[story:event_progress:stats] | System Prompt | ${shortText(input.systemPrompt, 240000) || "无"} | ${input.systemPrompt.length} | ${Math.max(input.systemPrompt ? 1 : 0, Math.ceil(input.systemPrompt.length / 4))} |`);
  console.log(`[story:event_progress:stats] | 用户提示词 | ${shortText(input.prompt, 240000) || "无"} | ${input.prompt.length} | ${Math.max(input.prompt ? 1 : 0, Math.ceil(input.prompt.length / 4))} |`);
  console.log(`[story:event_progress:stats] | 返回内容 | ${shortText(input.responseText, 240000) || "无"} | ${input.responseText.length} | ${Math.max(input.responseText ? 1 : 0, Math.ceil(input.responseText.length / 4))} |`);
  if (input.tokenUsage) {
    console.log(`[story:event_progress:stats] | 实际推理消耗 | input=${input.tokenUsage.inputTokens || 0}, output=${input.tokenUsage.outputTokens || 0}, reasoning=${input.tokenUsage.reasoningTokens || 0} | - | - |`);
  }
  console.log(`[story:event_progress:stats] 耗时: ${Date.now() - input.start}ms`);
}

/**
 * 调用 AI 判断当前事件进度。
 *
 * 返回 null 代表：
 * - prompt 未配置
 * - 模型未配置
 * - 模型调用失败
 *
 * 此时调用方必须回退到旧规则逻辑。
 */
export async function evaluateEventProgressByAi(
  input: EvaluateEventProgressInput,
): Promise<AiEventProgressResolution | null> {
  const totalStartedAt = Date.now();
  const start = Date.now();
  const systemPrompt = await loadEventProgressPrompt();
  const inputSnapshot = buildEventProgressInputSnapshot(input);
  const userPrompt = JSON.stringify(inputSnapshot, null, 2);
  if (!systemPrompt) {
    buildEventProgressStats({
      systemPrompt: "",
      prompt: userPrompt,
      inputSnapshot,
      responseText: "未加载到 AI故事-事件进度检测 Prompt，已回退到规则推进。",
      parsedResolution: null,
      tokenUsage: null,
      requestStatus: "skip_no_prompt",
      manufacturer: "",
      model: "",
      reasoningEffort: "",
      buildMs: 0,
      invokeMs: 0,
      totalMs: Date.now() - totalStartedAt,
      traceMeta: input.traceMeta,
      start,
    });
    return null;
  }
  const buildStartedAt = Date.now();
  const prompt = JSON.stringify(inputSnapshot, null, 2);
  const buildMs = Date.now() - buildStartedAt;
  let rawText = "";
  let tokenUsage: EventProgressTokenUsage | null = null;
  let requestStage = "resolve_model";
  let invokeMs = 0;
  try {
    const modelConfig = await resolveEventProgressModel(input.userId);
    requestStage = "invoke_model";
    logEventProgressKeyNode("storyEventProgressModel:invoke:start", input.traceMeta, {
      chapterId: Number(input.chapter?.id || 0),
      eventType: normalizeScalarText(input.eventType),
      messageLength: normalizeScalarText(input.messageContent).length,
    });
    const invokeStartedAt = Date.now();
    const result = await u.ai.text.invoke(
      {
        usageType: "事件进度检测",
        usageRemark: normalizeScalarText(input.chapter?.title) || "未知章节",
        usageMeta: {
          stage: "storyEventProgressModel",
          chapterId: Number(input.chapter?.id || 0),
          chapterTitle: normalizeScalarText(input.chapter?.title),
        },
        output: eventProgressOutputSchema,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        maxRetries: 0,
      },
      modelConfig as any,
    );
    invokeMs = Date.now() - invokeStartedAt;
    logEventProgressKeyNode("storyEventProgressModel:invoke:done", input.traceMeta, { invokeMs });
    const rawObject = (result as any)?.object ?? (typeof result === "object" ? result : null);
    const responseObject = normalizeResultObject(rawObject);
    const responseObjectText = responseObject ? JSON.stringify(responseObject, null, 2) : "";
    const fallbackText = unwrapModelText((result as any)?.text || "");
    rawText = responseObjectText || fallbackText;
    tokenUsage = {
      inputTokens: Number((result as any)?.usage?.inputTokens || 0),
      outputTokens: Number((result as any)?.usage?.outputTokens || 0),
      reasoningTokens: Number((result as any)?.usage?.outputTokenDetails?.reasoningTokens || (result as any)?.usage?.reasoningTokens || 0),
    };
    const fieldMap = parseFieldMap(rawText);
    const ended = normalizeBoolean(
      responseObject?.ended
      ?? getPlainField(fieldMap, "ended"),
    );
    const resolution: AiEventProgressResolution = {
      ended: ended ?? false,
      eventStatus: normalizeEventStatus(
        responseObject?.event_status
        ?? responseObject?.eventStatus
        ?? getPlainField(fieldMap, "event_status", "eventstatus"),
      ),
      progressSummary: normalizeScalarText(
        responseObject?.progress_summary
        ?? responseObject?.progressSummary
        ?? getPlainField(fieldMap, "progress_summary", "progresssummary"),
      ) || null,
      progressFacts: Array.isArray(responseObject?.progress_facts)
        ? responseObject.progress_facts.map((item) => normalizeScalarText(item)).filter(Boolean)
        : [],
      reason: normalizeScalarText(
        responseObject?.reason
        ?? getPlainField(fieldMap, "reason"),
      ) || null,
    };
    buildEventProgressStats({
      systemPrompt,
      prompt,
      inputSnapshot,
      responseText: rawText,
      parsedResolution: resolution,
      tokenUsage,
      requestStatus: "success",
      manufacturer: normalizeScalarText((modelConfig as any)?.manufacturer),
      model: normalizeScalarText((modelConfig as any)?.model),
      reasoningEffort: normalizeScalarText((modelConfig as any)?.reasoningEffort),
      buildMs,
      invokeMs,
      totalMs: Date.now() - totalStartedAt,
      traceMeta: input.traceMeta,
      start,
    });
    return resolution;
  } catch (err) {
    buildEventProgressStats({
      systemPrompt,
      prompt,
      inputSnapshot,
      responseText: rawText || `事件进度检测未拿到模型返回内容（阶段: ${requestStage}）`,
      parsedResolution: null,
      tokenUsage,
      requestStatus: "fallback",
      manufacturer: "",
      model: "",
      reasoningEffort: "",
      buildMs,
      invokeMs,
      totalMs: Date.now() - totalStartedAt,
      traceMeta: input.traceMeta,
      start,
    });
    console.warn("[story:event_progress:runtime]error", {
      chapterId: Number(input.chapter?.id || 0),
      chapterTitle: normalizeScalarText(input.chapter?.title),
      traceMeta: normalizeTraceMeta(input.traceMeta),
      stage: requestStage,
      message: (err as any)?.message || String(err),
    });
    return null;
  }
}
