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

// ============================================================================
// 类型定义
// ============================================================================

/** 5 类意图（复用意图分析师_prompt.md） */
export type IntentType = "create_task" | "exit_task" | "query_progress" | "game_action" | "normal_dialog";

/** IntentContext：意图分析输入 */
export interface IntentContext {
  userId: number;
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
  path: "ai" | "fallback"; // 调用路径
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
  return `你是意图分类器。读用户输入后只输出一个严格 JSON 对象，禁止任何其他文本。

# 5 类意图

1. create_task：用户想接受/创建/开启一个任务（含明确描述任务内容）
   - 触发词：好、接受、我来做、我去、没问题、我试试、开任务、任务为/任务是、找/做/打/探索/收集/调查/找到 + 具体目标
   - 例："任务为：找到舍友" / "我想去探索古墓" / "好我接受这个挑战" / "去打哥布林"

2. exit_task：用户想退出/放弃当前任务
   - 触发词：退出、放弃、不做了、算了、取消任务
   - 例："算了不做了" / "退出任务"

3. query_progress：用户查询当前任务进度
   - 触发词：任务进度、完成了多少、还差什么、进展如何
   - 例："我的任务怎么样了"

4. game_action：用户执行具体游戏操作（与任务系统无关）
   - 触发词：攻击、使用、打开、查看背包、对话
   - 例："我攻击那只怪物"

5. normal_dialog：普通对话（兜底，不涉及任务）
   - 例："老板你好" / "你认识他吗"

# 优先级（同时匹配时取高）
exit_task > create_task > query_progress > game_action > normal_dialog

# 输出格式（严格 JSON，不要 markdown 代码块，不要 \\\`\\\`\\\`，不要思考过程）

{"intent":"标签","confidence":0.0~1.0,"reasoning":"一句话理由","params":{"task_description":"如果是create_task必填用户想做的事，否则空字符串"}}

# 置信度
- 0.95-1.0：明确关键词
- 0.85-0.94：多个匹配点
- 0.70-0.84：单弱匹配
- <0.70：不确定 → 用 normal_dialog

# 重要规则
1. 直接输出 JSON，第一个字符必须是 { 最后一个字符必须是 }
2. 不要输出 \\\`\\\`\\\`json 标记
3. 不要思考过程、不要解释
4. 中文输入"任务为：xxx" / "任务是xxx" 必判 create_task，task_description = xxx
5. 用户主动表达去做某事（找/打/探索）也判 create_task

# 示例

输入：任务为：找到舍友
输出：{"intent":"create_task","confidence":0.95,"reasoning":"明确以\\"任务为\\"开头表达接受任务","params":{"task_description":"找到舍友"}}

输入：我想去探索古墓
输出：{"intent":"create_task","confidence":0.90,"reasoning":"明确表达去探索的意愿","params":{"task_description":"探索古墓"}}

输入：算了不做了
输出：{"intent":"exit_task","confidence":0.92,"reasoning":"放弃意图明确","params":{"task_description":""}}

输入：老板你好
输出：{"intent":"normal_dialog","confidence":0.90,"reasoning":"普通问候","params":{"task_description":""}}

输入：我的任务进度怎么样了
输出：{"intent":"query_progress","confidence":0.95,"reasoning":"明确询问任务进度","params":{"task_description":""}}

输入：攻击那只怪物
输出：{"intent":"game_action","confidence":0.90,"reasoning":"游戏战斗动作","params":{"task_description":""}}`;
}

// ============================================================================
// User Prompt
// ============================================================================

function buildUserPrompt(ctx: IntentContext): string {
  // 简化：只给意图分类需要的最小上下文，避免 Qwen3 被长 prompt 干扰
  const hasActiveTask = !!ctx.activeTaskId;
  return `输入：${ctx.playerMessage}\n（${hasActiveTask ? "当前有进行中任务" : "当前无进行中任务"}）\n输出 JSON：`;
}

// ============================================================================
// AI 分类
// ============================================================================

/** 模型 key（参照 src/utils/getPromptAi.ts 的 STRICT_MODEL_KEYS） */
const INTENT_MODEL_KEY = "intentClassifierModel";

/**
 * 调用用户配置的模型进行意图分类
 *
 * @param ctx 意图分析上下文
 * @returns 分类结果，失败返回 null
 */
/**
 * 从文本中提取第一个完整的 JSON 对象。
 * 使用括号配平算法，跳过字符串内的括号。
 *
 * 兼容场景：
 * - ```json { ... } ```
 * - 纯 JSON: { ... }
 * - 多余前缀/后缀文本
 */
function extractJsonObject(text: string): string | null {
  if (!text) return null;
  let i = text.indexOf("{");
  if (i < 0) return null;

  // 从第一个 { 开始，找配平的 }
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
  const TAG = "[story:intent:analysis]";
  try {
    // 1. 获取模型配置
    const modelConfig = await u.getPromptAi(INTENT_MODEL_KEY, ctx.userId) as any;

    if (!modelConfig || !modelConfig.model) {
      console.log(`${TAG} 未配置意图分析师模型，跳过 AI 分类`, { userId: ctx.userId });
      return null;
    }

    // 本地模型（qwen060）不需要 apiKey
    const isLocalModel = modelConfig.manufacturer === "qwen060";
    if (!isLocalModel && !modelConfig.apiKey) {
      console.log(`${TAG} 未配置 apiKey，跳过 AI 分类`, { manufacturer: modelConfig.manufacturer });
      return null;
    }

    console.log(`${TAG} 开始意图分析`, {
      userId: ctx.userId,
      manufacturer: modelConfig.manufacturer,
      model: modelConfig.model,
      messagePreview: String(ctx.playerMessage || "").slice(0, 80),
      activeTaskId: ctx.activeTaskId || null,
    });

    // 2. 构建 prompt
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(ctx);

    // 3. 调用 AI
    const startedAt = Date.now();
    let rawText: string;

    if (isLocalModel) {
      // qwen060：直接走 node-llama-cpp 本地推理
      const { chatWithQwen060 } = await import("@/lib/localQwen060");
      const result = await chatWithQwen060({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        maxTokens: 512,
        temperature: 0.3,
        // 意图分类不需要思考模式，直接出 JSON
        enableThinking: false,
      });
      rawText = result.text;
    } else {
      // 其他厂商：走 ai-sdk
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
      // ai-sdk 已经解析为对象
      const validated = AI_RESPONSE_SCHEMA.safeParse(aiResult);
      if (validated.success) {
        const { intent, confidence, reasoning, params } = validated.data;
        const validIntents: IntentType[] = ["create_task", "exit_task", "query_progress", "game_action", "normal_dialog"];
        const normalizedIntent = validIntents.includes(intent as IntentType) ? (intent as IntentType) : "normal_dialog";
        const latencyMs = Date.now() - startedAt;
        console.log(`${TAG} AI 分类完成`, {
          path: "ai-sdk",
          intent: normalizedIntent,
          confidence: Math.max(0, Math.min(1, confidence)),
          reasoning: reasoning?.slice(0, 80) || "无推理",
          latencyMs,
        });
        return {
          intent: normalizedIntent,
          confidence: Math.max(0, Math.min(1, confidence)),
          reasoning: reasoning || "无推理",
          params: (params as Record<string, unknown>) || {},
          path: "ai",
        };
      }
      console.log(`${TAG} AI 返回格式解析失败`, { rawResult: aiResult });
      return null;
    }

    const latencyMs = Date.now() - startedAt;
    console.log(`${TAG} qwen060 推理完成`, {
      latencyMs,
      rawTextLength: rawText.length,
      rawTextPreview: rawText.slice(0, 200),
    });

    // 4. 解析 qwen060 的纯文本输出（应该是 JSON）
    // 使用括号配平算法提取完整 JSON
    const jsonStr = extractJsonObject(rawText);
    if (!jsonStr) {
      console.log(`${TAG} 未找到 JSON 输出`, { rawText: rawText.slice(0, 300) });
      return null;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (err) {
      console.log(`${TAG} JSON 解析失败`, {
        error: (err as Error).message,
        jsonStr: jsonStr.slice(0, 300),
      });
      return null;
    }

    const validated = AI_RESPONSE_SCHEMA.safeParse(parsed);
    if (validated.success) {
      const { intent, confidence, reasoning, params } = validated.data;
      const validIntents: IntentType[] = ["create_task", "exit_task", "query_progress", "game_action", "normal_dialog"];
      const normalizedIntent = validIntents.includes(intent as IntentType) ? (intent as IntentType) : "normal_dialog";

      console.log(`${TAG} qwen060 分类完成`, {
        path: "qwen060",
        intent: normalizedIntent,
        confidence: Math.max(0, Math.min(1, confidence)),
        reasoning: reasoning?.slice(0, 80) || "无推理",
        latencyMs,
      });

      return {
        intent: normalizedIntent,
        confidence: Math.max(0, Math.min(1, confidence)),
        reasoning: reasoning || "无推理",
        params: (params as Record<string, unknown>) || {},
        path: "ai",
      };
    }

    console.log(`${TAG} qwen060 输出格式校验失败`, { parsed });
    return null;
  } catch (err) {
    console.warn(`${TAG} AI 分类失败`, { error: (err as Error)?.message });
    return null;
  }
}

/**
 * 意图分析兜底链
 *
 * @param ctx 意图分析上下文
 * @returns 分类结果（永不为 null）
 */
export async function analyzeIntentWithAi(ctx: IntentContext): Promise<IntentResult> {
  const result = await classifyIntentWithAi(ctx);

  if (result && result.confidence >= 0.7) {
    return result;
  }

  // 降级到 normal_dialog
  return {
    intent: "normal_dialog",
    confidence: 0,
    reasoning: result ? "AI 分类置信度不足，默认为普通对话" : "AI 分类不可用，默认为普通对话",
    params: {},
    path: "fallback",
  };
}
