import { z } from "zod";
import { parse } from "best-effort-json-parser";
import u from "@/utils";
import { miniGamePromptCodeByType } from "@/agents/story/mini_game/index";
import { DebugLogUtil } from "@/utils/debugLogUtil";

export interface MiniGameIntentOptionInput {
  actionId: string;
  label: string;
  desc: string;
  aliases?: string[];
}

export interface ResolveMiniGameIntentInput {
  userId: number;
  gameType: string;
  phase: string;
  status: string;
  publicStateSummary: string;
  latestNarration: string;
  userInput: string;
  options: MiniGameIntentOptionInput[];
}

export interface MiniGameIntentResult {
  actionId: string;
  targetName: string;
  reason: string;
  logMeta?: MiniGameIntentLogMeta | null;
}

export interface MiniGameIntentLogMeta {
  systemPrompt: string;
  userPrompt: string;
  rawResponse: string;
  tokenUsage: MiniGameIntentTokenUsage | null;
  timing: {
    buildMs: number;
    invokeMs: number;
    totalMs: number;
  };
}

export interface MiniGameIntentTokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

const miniGameIntentSchema = {
  action_id: z.string().describe("最终识别出的程序动作 id，必须来自 legal_actions"),
  target_name: z.string().describe("若输入里包含明确目标对象，则返回目标名称；否则为空串"),
  reason: z.string().describe("简短说明为什么这样识别"),
};

/**
 * 构造小游戏动作解析的 JSON Schema 提示尾巴。
 *
 * 用途：
 * - 当这里改成 plain text 输出后，AI 工具层不会再自动把 schema 注入 system prompt；
 * - 为了同时拿到原始 text 和 usage，这里手动补回相同的 schema 约束。
 */
function buildMiniGameIntentSchemaPrompt(): string {
  return `\n请按照以下 JSON Schema 格式返回结果:\n${JSON.stringify(
    z.toJSONSchema(z.object(miniGameIntentSchema)),
    null,
    2,
  )}\n只返回结果，不要将Schema返回。`;
}

/**
 * 读取小游戏动作解析提示词。
 *
 * 用途：
 * - 先读小游戏类型对应的专属提示词；
 * - 如果没有配置专属提示词，再回退到通用小游戏路由提示词。
 */
async function loadMiniGamePrompt(gameType: string): Promise<string> {
  const promptCode = miniGamePromptCodeByType(gameType);
  const dedicatedRow = await u.db("t_prompts")
    .where("code", promptCode)
    .first("defaultValue", "customValue");
  const dedicatedPrompt = String(dedicatedRow?.customValue || dedicatedRow?.defaultValue || "").trim();
  if (dedicatedPrompt) return dedicatedPrompt;
  const fallbackRow = await u.db("t_prompts")
    .where("code", "story-mini-game")
    .first("defaultValue", "customValue");
  return String(fallbackRow?.customValue || fallbackRow?.defaultValue || "").trim();
}

/**
 * 解析小游戏动作识别模型配置。
 *
 * 回退顺序：
 * 1. storyMiniGameModel
 * 2. storyEventProgressModel
 * 3. storyOrchestratorModel
 *
 * 这样即使还没专门配置小游戏模型，也能先跑起来。
 */
export async function resolveMiniGameModel(userId: number) {
  const primary = await u.getPromptAi("storyMiniGameModel", userId);
  if (String((primary as Record<string, unknown> | null)?.manufacturer || "").trim()) {
    return primary;
  }
  const eventProgressFallback = await u.getPromptAi("storyEventProgressModel", userId);
  if (String((eventProgressFallback as Record<string, unknown> | null)?.manufacturer || "").trim()) {
    return eventProgressFallback;
  }
  const orchestratorFallback = await u.getPromptAi("storyOrchestratorModel", userId);
  if (String((orchestratorFallback as Record<string, unknown> | null)?.manufacturer || "").trim()) {
    return orchestratorFallback;
  }
  throw new Error("小游戏动作解析对接的模型未配置");
}

/**
 * 组装给小游戏动作解析 agent 的输入快照。
 *
 * 用途：
 * - 只把 agent 真正需要的小游戏上下文发过去；
 * - 保持输入稳定，避免让模型去猜“当前有哪些合法动作”。
 */
function buildMiniGameIntentPrompt(input: ResolveMiniGameIntentInput): string {
  return JSON.stringify({
    game_type: input.gameType,
    phase: input.phase,
    status: input.status,
    public_state_summary: input.publicStateSummary,
    latest_narration: input.latestNarration,
    legal_actions: input.options.map((item) => ({
      action_id: item.actionId,
      label: item.label,
      desc: item.desc,
      aliases: Array.isArray(item.aliases) ? item.aliases : [],
    })),
    user_input: input.userInput,
  }, null, 2);
}

/**
 * 规范化小游戏动作识别结果。
 *
 * 用途：
 * - 保证最终 actionId 一定来自合法动作列表；
 * - 避免大模型返回一个程序根本不认识的动作，导致后续状态机再次混乱。
 */
function normalizeMiniGameIntentResult(
  rawObject: Record<string, unknown> | null | undefined,
  options: MiniGameIntentOptionInput[],
  logMeta?: MiniGameIntentLogMeta | null,
): MiniGameIntentResult | null {
  const actionId = String(rawObject?.action_id || "").trim();
  if (!actionId) return null;
  const matched = options.find((item) => item.actionId === actionId);
  if (!matched) return null;
  return {
    actionId,
    targetName: String(rawObject?.target_name || "").trim(),
    reason: String(rawObject?.reason || "").trim(),
    logMeta: logMeta || null,
  };
}

/**
 * 从文本模型返回结果里提取真实 usage token。
 *
 * 用途：
 * - 小游戏动作解析日志需要打印模型真实 input/output/reasoning token；
 * - 不同厂商 usage 字段层级略有差异，这里统一归一成稳定结构。
 */
function readMiniGameIntentTokenUsage(result: unknown): MiniGameIntentTokenUsage | null {
  const usage = (result as any)?.usage;
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = Number(usage.inputTokens || 0) || 0;
  const outputTokens = Number(usage.outputTokens || 0) || 0;
  const reasoningTokens = Number(usage.outputTokenDetails?.reasoningTokens || usage.reasoningTokens || 0) || 0;
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
  };
}

/**
 * 使用大模型把小游戏自然语言输入归一成程序动作。
 *
 * 用途：
 * - 让小游戏支持更自然、更花哨的说法；
 * - 同时保留原有规则引擎，避免把状态推进本身交给模型。
 */
export async function resolveMiniGameIntentByAi(input: ResolveMiniGameIntentInput): Promise<MiniGameIntentResult | null> {
  if (!String(input.userInput || "").trim()) return null;
  if (!Array.isArray(input.options) || !input.options.length) return null;
  const startedAt = Date.now();
  let systemPrompt = "";
  let prompt = "";
  let buildFinishedAt = startedAt;
  try {
    systemPrompt = `${await loadMiniGamePrompt(input.gameType)}${buildMiniGameIntentSchemaPrompt()}`.trim();
    if (!systemPrompt) return null;
    const modelConfig = await resolveMiniGameModel(input.userId);
    prompt = buildMiniGameIntentPrompt(input);
    buildFinishedAt = Date.now();
    const invokeStartedAt = buildFinishedAt;
    const result = await u.ai.text.invoke(
      {
        usageType: "小游戏动作解析",
        usageRemark: input.gameType || "未知小游戏",
        usageMeta: {
          stage: "storyMiniGameModel",
          gameType: input.gameType,
          phase: input.phase,
          status: input.status,
        },
        plainTextOutput: true,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        maxRetries: 0,
      },
      modelConfig as any,
    );
    const invokeFinishedAt = Date.now();
    const rawResponse = String((result as any)?.text || "").trim();
    const parsedObject = rawResponse ? parse(rawResponse) : null;
    const rawObject = parsedObject && typeof parsedObject === "object"
      ? (parsedObject as Record<string, unknown>)
      : null;
    const tokenUsage = readMiniGameIntentTokenUsage(result);
    const logMeta: MiniGameIntentLogMeta = {
      systemPrompt,
      userPrompt: prompt,
      rawResponse,
      tokenUsage,
      timing: {
        buildMs: Math.max(0, buildFinishedAt - startedAt),
        invokeMs: Math.max(0, invokeFinishedAt - invokeStartedAt),
        totalMs: Math.max(0, invokeFinishedAt - startedAt),
      },
    };
    const normalized = normalizeMiniGameIntentResult(rawObject as Record<string, unknown> | null, input.options, logMeta);
    DebugLogUtil.logMiniGamePromptStats("story:mini_game:stats", {
      gameType: input.gameType,
      phase: input.phase,
      status: input.status,
      systemPrompt,
      userPrompt: prompt,
      rawResponse,
      tokenUsage,
      timing: logMeta.timing,
      runtimeError: null,
    });
    DebugLogUtil.log("story:mini_game:agent", JSON.stringify({
      gameType: input.gameType,
      phase: input.phase,
      status: input.status,
      input: input.userInput,
      actionId: normalized?.actionId || "",
      targetName: normalized?.targetName || "",
      reason: normalized?.reason || "",
    }));
    return normalized;
  } catch (error) {
    DebugLogUtil.logMiniGamePromptStats("story:mini_game:stats", {
      gameType: input.gameType,
      phase: input.phase,
      status: input.status,
      systemPrompt,
      userPrompt: prompt,
      rawResponse: "",
      tokenUsage: null,
      timing: {
        buildMs: Math.max(0, buildFinishedAt - startedAt),
        invokeMs: Math.max(0, Date.now() - buildFinishedAt),
        totalMs: Math.max(0, Date.now() - startedAt),
      },
      runtimeError: error,
    });
    DebugLogUtil.log("story:mini_game:agent:error", String((error as Error)?.message || error || ""));
    return null;
  }
}
