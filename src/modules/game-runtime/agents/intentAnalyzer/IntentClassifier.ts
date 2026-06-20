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

/** 6 类意图（复用意图分析师_prompt.md） */
export type IntentType = "create_task" | "exit_task" | "query_progress" | "game_action" | "memory_update" | "normal_dialog";

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

5. memory_update：用户想更新自己的角色参数卡（物品、装备、技能、状态、身份、等级、经验等长期数据）
   - 触发词：放入物品栏、记录在、加入背包、装备上、学会了、升级到、把xx记录、把xx放入、获得物品、丢掉、消耗、记忆管理
   - 例："把宿舍牌放入物品栏" / "我学会了xxx技能" / "在其他里记录我是xx" / "我装备上xx"

6. normal_dialog：普通对话（兜底，不涉及任务）
   - 例："老板你好" / "你认识他吗"

# 优先级（同时匹配时取高）
exit_task > memory_update > create_task > query_progress > game_action > normal_dialog

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
输出：{"intent":"game_action","confidence":0.90,"reasoning":"游戏战斗动作","params":{"task_description":""}}

输入：把302宿舍牌放入物品栏，记录我是诡异学校302宿舍的舍友
输出：{"intent":"memory_update","confidence":0.95,"reasoning":"明确要求更新参数卡的物品和身份信息","params":{"task_description":""}}

输入：我学会了发蛇缠绕技能
输出：{"intent":"memory_update","confidence":0.92,"reasoning":"明确要求记录新学会的技能","params":{"task_description":""}}`;
}

// ============================================================================
// User Prompt
// ============================================================================

function buildUserPrompt(ctx: IntentContext): string {
  const hasActiveTask = !!ctx.activeTaskId;
  return `输入：${ctx.playerMessage}\n（${hasActiveTask ? "当前有进行中任务" : "当前无进行中任务"}）\n输出 JSON：`;
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
    const userPrompt = buildUserPrompt(ctx);

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
        maxTokens: 512,
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
