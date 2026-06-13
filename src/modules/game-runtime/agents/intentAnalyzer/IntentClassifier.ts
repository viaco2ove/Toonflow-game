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
  return `# 角色：意图分析师

你是一个意图分析专家，专门分析用户在角色扮演游戏中的输入，识别用户意图。

## 上下文

- 当前环境：Toonflow Game 角色扮演游戏引擎
- 用户正在进行沉浸式剧情对话，偶尔会触发任务系统
- 任务系统（Task）复用 MiniGame 框架，非阻塞模式

## 意图类别

你必须将用户输入分类到以下 5 个意图之一：

### 1. create_task（创建/接受任务）
**触发条件**：用户表达了接受、承诺、执行某个任务/挑战的意愿
**关键词**：好、我接受、好的、我来做、我去、没问题、我试试、开始行动、执行任务、接取任务
**示例**：
- 用户输入："好，我接受这个挑战"
- 用户输入："没问题，包在我身上"
- 用户输入："让我去调查一下"

### 2. exit_task（退出/放弃任务）
**触发条件**：用户明确表示要放弃、退出、终止当前任务
**关键词**：退出、放弃、不做了、算了、取消任务、终止任务、结束任务、离开任务
**示例**：
- 用户输入："算了，我不想做了"
- 用户输入："退出任务"
- 用户输入："放弃这个任务"

### 3. query_progress（查询任务进度）
**触发条件**：用户想查看当前任务的完成情况、进度、状态
**关键词**：任务进度、完成了多少、有几个、完成了吗、任务状态、进展如何、还差什么
**示例**：
- 用户输入："我的任务进度怎么样了"
- 用户输入："完成了多少了"
- 用户输入："任务还差什么"

### 4. game_action（游戏行为）
**触发条件**：用户在执行具体的游戏操作（攻击、探索、交易、互动等）
**关键词**：攻击、探索、交易、使用、打开、关闭、查看背包、对话NPC、战斗、移动
**示例**：
- 用户输入："我攻击那只怪物"
- 用户输入："向老板询问线索"
- 用户输入："打开背包看看"

### 5. normal_dialog（正常对话）
**触发条件**：用户在正常推进剧情对话，不涉及任务系统
**关键词**：无特定关键词，只要不属于以上 4 类即为 normal_dialog
**示例**：
- 用户输入："老板，今天生意怎么样"
- 用户输入："你好，很高兴认识你"
- 用户输入："这座城市有什么历史"

## 优先级

exit_task > create_task > query_progress > game_action > normal_dialog
同时匹配多个意图时，按优先级取最高。

## 输出格式

你必须输出一个 JSON 对象，不要输出任何其他内容：

\`\`\`json
{
  "intent": "意图标签",
  "confidence": 0.0-1.0,
  "reasoning": "简要推理过程（1-2句话）",
  "params": {}
}
\`\`\`

## 置信度标准

| 置信度 | 含义 | 示例 |
|--------|------|------|
| 0.95-1.0 | 非常明确，关键词高度匹配 | "退出任务" → exit_task |
| 0.85-0.94 | 明确，有多个匹配点 | "好，我接受这个挑战，去调查那个山洞" → create_task |
| 0.70-0.84 | 中等，单个弱匹配 | "让我试试" → create_task |
| < 0.70 | 不确定，偏向默认 | 无法判断 → normal_dialog |

## 推理规则

1. **优先级顺序**：exit_task > create_task > query_progress > game_action > normal_dialog
2. **模糊处理**：如果用户输入模糊且置信度低于 0.7，返回 normal_dialog
3. **上下文感知**：如果当前没有进行中的任务，create_task 意图应该降权
4. **中文语境**："包在我身上" = create_task，"试试看" = create_task`;
}

// ============================================================================
// User Prompt
// ============================================================================

function buildUserPrompt(ctx: IntentContext): string {
  const recentContext = ctx.recentMessages
    ? ctx.recentMessages.slice(-5).map((m) => `${m.role || "user"}: ${m.content || ""}`).join("\n")
    : "（无最近对话历史）";

  return `用户输入：${ctx.playerMessage}

最近对话：
${recentContext}

${ctx.activeTaskId ? `当前任务ID: ${ctx.activeTaskId}` : "（当前无进行中任务）"}
${ctx.chapterTitle ? `当前章节: ${ctx.chapterTitle}` : ""}

请分析用户意图。`;
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
export async function classifyIntentWithAi(ctx: IntentContext): Promise<IntentResult | null> {
  try {
    // 1. 获取模型配置
    const modelConfig = await u.getPromptAi(INTENT_MODEL_KEY, ctx.userId) as any;

    if (!modelConfig || !modelConfig.model || !modelConfig.apiKey) {
      console.debug("[intent-classifier] 未配置模型，跳过 AI 分类");
      return null;
    }

    // 2. 构建 prompt
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(ctx);

    // 3. 调用 AI
    const startedAt = Date.now();
    const result = await u.ai.text.invoke(
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

    const latencyMs = Date.now() - startedAt;

    // 4. 解析结果
    if (result && typeof result === "object") {
      const validated = AI_RESPONSE_SCHEMA.safeParse(result);
      if (validated.success) {
        const { intent, confidence, reasoning, params } = validated.data;

        // 校验 intent 是否为有效值
        const validIntents: IntentType[] = ["create_task", "exit_task", "query_progress", "game_action", "normal_dialog"];
        const normalizedIntent = validIntents.includes(intent as IntentType) ? (intent as IntentType) : "normal_dialog";

        return {
          intent: normalizedIntent,
          confidence: Math.max(0, Math.min(1, confidence)),
          reasoning: reasoning || "无推理",
          params: (params as Record<string, unknown>) || {},
          path: "ai",
        };
      }
    }

    console.debug("[intent-classifier] AI 返回格式解析失败:", result);
    return null;
  } catch (err) {
    console.warn("[intent-classifier] AI 分类失败:", (err as Error)?.message);
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
