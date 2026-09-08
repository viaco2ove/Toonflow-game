/**
 * 意图分析师 Agent — AI 分类器
 *
 * 对接用户配置的模型供应商（复用意图分析师.md L4-28）：
 * - local 文本模型: Qwen3-0.6B（默认，本地 CPU 可跑）
 * - 火山引擎 / DeepSeek / OpenAI / Gemini / t8star: 线上，可切换
 *
 * 方法：生成式分类（直接输出 intent label + confidence + reasoning）
 * 复用意图分析师_prompt.md 的 system prompt
 */

import u from "@/utils";
import { z } from "zod";
import { buildWorldKnowledgeText, normalizeWorldBookOutput } from "@/lib/gameEngine";

// ============================================================================
// 类型定义
// ============================================================================

/** 6 类意图（复用意图分析师_prompt.md） */
export type IntentType = "create_task" | "exit_task" | "query_progress" | "game_action" | "memory_update" | "normal_dialog";

/** IntentContext：意图分析输入 */
export interface IntentContext {
  userId: number;
  worldId?: number;
  playerMessage: string;
  recentMessages?: Array<{ role?: string | null; content?: string | null }>;
  activeTaskId?: string | null;
  chapterTitle?: string | null;
}

/** IntentResult：意图分析输出 */
export interface IntentResult {
  intent: IntentType;
  confidence: number; // 0-1
  reasoning: string; // 1-2 句话推理
  params: Record<string, unknown>;
  path: "embed" | "ai" | "fallback"; // 调用路径
}

// AI 返回的 JSON 结构
const AI_RESPONSE_SCHEMA = z.object({
  intent: z.string(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

// ============================================================================
// System Prompt（复用意图分析师_prompt.md）
// ============================================================================

function buildSystemPrompt(): string {
  // 精简版（参考 litter_llama/intent_prompt.py）：
  // 删去冗余的"重要规则 / 置信度 / 6 个示例"，只保留 6 类意图 + 优先级 + 4 个核心示例，
  // 字符数从 ~3000 降到 ~1100，prefill 时间缩短约 50%。
  return `你是意图分类器。读用户输入后只输出一个严格 JSON 对象，禁止任何其他文本。

# 6 类意图
1. create_task：用户想接受/创建/开启一个任务（含明确描述任务内容）
   - 触发词：好、接受、我来做、我去、没问题、我试试、开任务、任务为/任务是、找/做/打/探索/收集/调查 + 目标
2. exit_task：用户想退出/放弃当前任务
   - 触发词：退出、放弃、不做了、算了、取消任务
3. query_progress：用户查询当前任务进度
   - 触发词：任务进度、完成了多少、还差什么、进展如何
4. game_action：用户执行具体游戏操作（与任务系统无关）
   - 触发词：攻击、使用、打开、查看背包、对话
5. memory_update：用户想更新自己的角色参数卡（物品、装备、技能、状态、身份、等级、经验）
   - 触发词：放入物品栏、记录在、加入背包、装备上、学会了、升级到、获得物品、记忆管理、@记忆管理器
6. normal_dialog：普通对话（兜底）

# 优先级（同时匹配时取高）
exit_task > memory_update > create_task > query_progress > game_action > normal_dialog

# 输出格式（严格 JSON，不要 markdown 代码块，不要思考过程）
{"intent":"标签","confidence":0.0~1.0,"reasoning":"一句话理由","params":{"task_description":"create_task 时填用户想做的事，否则空字符串"}}

# 重要规则
1. 直接输出 JSON，第一字符 { 最后一字符 }
2. 中文"任务为：xxx" / "任务是xxx" 必判 create_task，task_description=xxx
3. 用户主动表达去做某事（找/打/探索）也判 create_task

# 示例
输入：任务为：找到舍友 → {"intent":"create_task","confidence":0.95,"reasoning":"明确以任务为开头","params":{"task_description":"找到舍友"}}
输入：算了不做了 → {"intent":"exit_task","confidence":0.92,"reasoning":"放弃意图明确","params":{"task_description":""}}
输入：把302宿舍牌放入物品栏 → {"intent":"memory_update","confidence":0.95,"reasoning":"明确要求更新物品","params":{"task_description":""}}
输入：老板你好 → {"intent":"normal_dialog","confidence":0.90,"reasoning":"普通问候","params":{"task_description":""}}`;
}

// ============================================================================
// User Prompt
// ============================================================================

function buildUserPrompt(ctx: IntentContext, worldKnowledge?: string): string {
  const hasActiveTask = !!ctx.activeTaskId;
  const base = `输入：${ctx.playerMessage}\n（${hasActiveTask ? "当前有进行中任务" : "当前无进行中任务"}）\n输出 JSON：`;
  return worldKnowledge ? `${base}\n\n【世界知识】\n${worldKnowledge}` : base;
}

// ============================================================================
// AI 分类
// ============================================================================

/** 模型 key（参照 src/utils/getPromptAi.ts 的 STRICT_MODEL_KEYS） */
const INTENT_MODEL_KEY = "intentClassifierModel";

/**
 * 从文本中提取第一个完整的 JSON 对象。
 * 使用括号配平算法，跳过字符串内的括号。
 */
function extractJsonObject(text: string): string | null {
  if (!text) return null;
  let i = text.indexOf("{");
  if (i < 0) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (ch === "\\") { escapeNext = true; continue; }
    if (ch === '"' && !escapeNext) { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(text.indexOf("{"), i + 1);
      }
    }
  }
  return null;
}

export async function classifyIntentWithAi(ctx: IntentContext): Promise<IntentResult | null> {
  try {
    // ★ 快速路径：向量模型（m3e-small）优先，~100ms 出结果
    // 硬超时 2s：超过 2s 说明向量引擎没就绪（未安装/Python 缺失/进程卡死），立即降级到 AI 路径
    const embedModelName = process.env.LOCAL_EMBED_MODEL;
    if (embedModelName) {
      try {
        const { classifyIntentByEmbedding } = await import("@/lib/localEmbed");
        const embedPromise = classifyIntentByEmbedding(ctx.playerMessage);
        const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000));
        const embedResult = await Promise.race([embedPromise, timeoutPromise]);
        if (embedResult && embedResult.confidence >= 0.4) {
          const validIntents: IntentType[] = ["create_task", "exit_task", "query_progress", "game_action", "memory_update", "normal_dialog"];
          const intent = validIntents.includes(embedResult.intent as IntentType)
            ? (embedResult.intent as IntentType)
            : "normal_dialog";
          console.log(`[story:intent:analysis:stats] path=embed intent=${intent} confidence=${embedResult.confidence}`);
          return {
            intent,
            confidence: embedResult.confidence,
            reasoning: embedResult.reasoning,
            params: {},
            path: "embed",
          };
        }
      } catch {
        // 向量模型不可用，继续走 AI 路径
      }
    }

    const modelConfig = await u.getPromptAi(INTENT_MODEL_KEY, ctx.userId) as any;

    if (!modelConfig || !modelConfig.model) {
      console.log("[story:intent:analysis:stats] status=skipped reason=model_not_configured");
      return null;
    }

    const isLocalModel = modelConfig.manufacturer === "qwen060";
    if (!isLocalModel && !modelConfig.apiKey) {
      console.log("[story:intent:analysis:stats] status=skipped reason=api_key_missing");
      return null;
    }

    const { loadTaskPrompt } = await import("../taskMode/loadTaskPrompt");
    const systemPrompt = await loadTaskPrompt("intent-analyzer", buildSystemPrompt());
    // ★ 世界书注入：scanText = playerMessage + recentMessages
    let worldKnowledge = "";
    if (ctx.worldId) {
      try {
        const scanText = [ctx.playerMessage, ...(ctx.recentMessages || []).map((m) => m.content || "")].join("\n");
        const rows = await u.db("t_worldBook").where({ worldId: ctx.worldId }).select("*");
        const entries = normalizeWorldBookOutput(rows);
        worldKnowledge = buildWorldKnowledgeText(entries, scanText, 400, "intent_classifier");
      } catch (e) {
        console.warn("[intent_classifier] 世界书加载失败", e);
      }
    }
    const userPrompt = buildUserPrompt(ctx, worldKnowledge);

    console.log("[story:intent:analysis:runtime] request", JSON.stringify({
      userId: ctx.userId,
      manufacturer: modelConfig.manufacturer,
      model: modelConfig.model,
      messagePreview: String(ctx.playerMessage || "").slice(0, 100),
      activeTaskId: ctx.activeTaskId || null,
      systemPromptChars: systemPrompt.length,
      userPromptChars: userPrompt.length,
    }));
    console.log("[story:intent:analysis:runtime] full_user_prompt:", userPrompt.replace(/\n/g, "↩"));

    const startedAt = Date.now();
    let rawText: string;

    if (isLocalModel) {
      const { chatWithQwen060 } = await import("@/lib/localQwen060");
      const result = await chatWithQwen060({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        // 意图分类输出 ~80 tokens（"{"intent":"...","confidence":0.x,"reasoning":"...","params":{...}}"）。
        // 128 给足缓冲；超过 128 几乎肯定是模型在"思考"或重复输出。
        maxTokens: 128,
        temperature: 0.3,
        enableThinking: false,
      });
      rawText = result.text;
    } else {
      const aiResult = await u.ai.text.invoke(
        {
          system: systemPrompt,
          messages: [{ role: "user" as const, content: userPrompt }],
          output: {
            intent: z.string(),
            confidence: z.number(),
            reasoning: z.string(),
            params: z.record(z.string(), z.unknown()),
          },
        },
        modelConfig,
      ) as any;

      const validated = AI_RESPONSE_SCHEMA.safeParse(aiResult);
      if (validated.success) {
        const { intent, confidence, reasoning, params } = validated.data;
        const validIntents: IntentType[] = ["create_task", "exit_task", "query_progress", "game_action", "memory_update", "normal_dialog"];
        const normalizedIntent = validIntents.includes(intent as IntentType) ? (intent as IntentType) : "normal_dialog";
        const latencyMs = Date.now() - startedAt;

        console.log("[story:intent:analysis:runtime] response", JSON.stringify({
          path: "ai-sdk",
          intent: normalizedIntent,
          confidence: Math.max(0, Math.min(1, confidence)),
          reasoning: reasoning?.slice(0, 80) || "无推理",
          latencyMs,
        }));
        console.log(`[story:intent:analysis:stats] path=ai-sdk intent=${normalizedIntent} confidence=${Math.max(0, Math.min(1, confidence))} latency_ms=${latencyMs}`);

        return {
          intent: normalizedIntent,
          confidence: Math.max(0, Math.min(1, confidence)),
          reasoning: reasoning || "无推理",
          params: (params as Record<string, unknown>) || {},
          path: "ai",
        };
      }
      console.log("[story:intent:analysis:stats] path=ai-sdk status=parse_error");
      return null;
    }

    const latencyMs = Date.now() - startedAt;
    console.log("[story:intent:analysis:runtime] qwen060_response", JSON.stringify({
      latencyMs,
      rawTextLength: rawText.length,
      rawTextPreview: rawText.slice(0, 200),
    }));

    const jsonStr = extractJsonObject(rawText);
    if (!jsonStr) {
      console.log("[story:intent:analysis:stats] path=qwen060 status=json_not_found latency_ms=" + latencyMs);
      return null;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      console.log("[story:intent:analysis:stats] path=qwen060 status=json_parse_error latency_ms=" + latencyMs);
      return null;
    }

    const validated = AI_RESPONSE_SCHEMA.safeParse(parsed);
    if (validated.success) {
      const { intent, confidence, reasoning, params } = validated.data;
      const validIntents: IntentType[] = ["create_task", "exit_task", "query_progress", "game_action", "memory_update", "normal_dialog"];
      const normalizedIntent = validIntents.includes(intent as IntentType) ? (intent as IntentType) : "normal_dialog";

      console.log("[story:intent:analysis:runtime] qwen060_classification_result", JSON.stringify({
        path: "qwen060",
        intent: normalizedIntent,
        confidence: Math.max(0, Math.min(1, confidence)),
        reasoning: reasoning?.slice(0, 80) || "无推理",
        latencyMs,
      }));
      console.log(`[story:intent:analysis:stats] path=qwen060 intent=${normalizedIntent} confidence=${Math.max(0, Math.min(1, confidence))} latency_ms=${latencyMs}`);

      return {
        intent: normalizedIntent,
        confidence: Math.max(0, Math.min(1, confidence)),
        reasoning: reasoning || "无推理",
        params: (params as Record<string, unknown>) || {},
        path: "ai",
      };
    }

    console.log("[story:intent:analysis:stats] path=qwen060 status=schema_error latency_ms=" + latencyMs);
    return null;
  } catch (err) {
    console.warn("[story:intent:analysis:stats] status=exception error=" + (err as any)?.message);
    return null;
  }
}

/**
 * 意图分析入口（永不为 null）
 */
export async function analyzeIntentWithAi(ctx: IntentContext): Promise<IntentResult> {
  const result = await classifyIntentWithAi(ctx);

  if (result && result.confidence >= 0.7) {
    return result;
  }

  return {
    intent: "normal_dialog",
    confidence: 0,
    reasoning: result ? "AI 分类置信度不足" : "AI 分类不可用",
    params: {},
    path: "fallback",
  };
}
