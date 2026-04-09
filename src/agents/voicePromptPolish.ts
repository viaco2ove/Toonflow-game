import * as zod from "zod";
import u from "@/utils";

export type VoiceSignalGroup = "male" | "female" | "gentle" | "story" | "steady" | "bright" | "broadcast";

export interface PolishVoicePromptInput {
  text: string;
  style?: string | null;
  userId?: number;
  mode?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  provider?: string | null;
}

export interface PolishVoicePromptResult {
  prompt: string;
  keywords: string[];
  signalGroups: VoiceSignalGroup[];
  source: "ai" | "fallback";
}

const SIGNAL_KEYWORDS: Record<VoiceSignalGroup, string[]> = {
  male: ["青年男性", "青年男", "男性", "男声", "男生", "少年感", "磁性男"],
  female: ["女声", "女性", "女生", "少女", "御姐", "甜妹"],
  gentle: ["温柔", "治愈", "柔和", "轻柔", "温暖", "暖心", "细腻", "抒情"],
  story: ["故事", "讲述", "叙述", "娓娓道来", "旁白"],
  steady: ["沉稳", "稳重", "成熟", "纪录片", "说明", "口播", "专业", "坚定", "果决", "磁性", "低沉", "干练"],
  bright: ["活泼", "明快", "明亮", "清亮", "轻快", "朝气", "元气", "年轻", "青年", "张扬", "自信", "热情", "有力", "爽朗"],
  broadcast: ["播报", "直播", "主持", "主播", "口播"],
};

const GROUP_PRIORITY: VoiceSignalGroup[] = ["male", "female", "gentle", "story", "steady", "bright", "broadcast"];

const DEFAULT_COMPLETION_KEYWORDS = ["清晰", "自然", "稳定"];

type VoicePromptPolishStrategy =
  | "route_keywords"
  | "aliyun_direct_cosyvoice_prompt"
  | "aliyun_direct_qwen_prompt"
  | "general_semantic_prompt";

function normalizeText(input?: string | null): string {
  return String(input || "")
    .trim()
    .replace(/[，、；：。！？,.!?;:/\\|()[\]{}"'“”‘’]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

function detectSignalGroups(source: string): VoiceSignalGroup[] {
  const normalized = normalizeText(source);
  if (!normalized) return [];
  return GROUP_PRIORITY.filter((group) => SIGNAL_KEYWORDS[group].some((keyword) => normalized.includes(normalizeText(keyword))));
}

function extractMatchedKeywords(source: string): string[] {
  const normalized = normalizeText(source);
  if (!normalized) return [];
  const matched: string[] = [];
  GROUP_PRIORITY.forEach((group) => {
    SIGNAL_KEYWORDS[group].forEach((keyword) => {
      if (normalized.includes(normalizeText(keyword))) {
        matched.push(keyword);
      }
    });
  });
  return unique(matched);
}

function splitSourceTokens(source: string): string[] {
  return unique(
    String(source || "")
      .split(/[\r\n,，、；;。.!！？/]+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0 && item.length <= 16),
  );
}

function buildFallbackKeywords(text: string, style?: string | null): { keywords: string[]; signalGroups: VoiceSignalGroup[] } {
  const source = [text, style].filter(Boolean).join("，");
  const signalGroups = detectSignalGroups(source);
  const matched = extractMatchedKeywords(source);
  const rawTokens = splitSourceTokens(source);

  const keywords: string[] = [];
  const hasGender = matched.some((item) => ["青年男性", "青年男", "男性", "男声", "女声", "女性", "女生", "少女", "御姐", "甜妹"].includes(item));

  matched.forEach((item) => {
    if (keywords.length < 8) keywords.push(item);
  });

  rawTokens.forEach((item) => {
    if (keywords.length < 8 && !keywords.includes(item)) {
      keywords.push(item);
    }
  });

  if (!hasGender) {
    if (signalGroups.includes("male") && keywords.length < 8) keywords.unshift("青年男性");
    if (signalGroups.includes("female") && keywords.length < 8) keywords.unshift("女性");
  }

  DEFAULT_COMPLETION_KEYWORDS.forEach((item) => {
    if (keywords.length < 4 && !keywords.includes(item)) {
      keywords.push(item);
    }
  });

  return {
    keywords: keywords.slice(0, 8),
    signalGroups,
  };
}

function sanitizePrompt(prompt: string): string {
  return String(prompt || "")
    .replace(/\r?\n/g, "，")
    .replace(/[。；;]+/g, "，")
    .replace(/\s+/g, " ")
    .replace(/，{2,}/g, "，")
    .replace(/^，|，$/g, "")
    .trim();
}

function hasUsableAiConfig(config: unknown): config is Record<string, any> {
  return !!config && typeof config === "object" && Object.keys(config as Record<string, any>).length > 0;
}

/**
 * 根据当前绑定模式与目标语音厂商，选择更贴近下游语音接口的润色策略。
 * 这里不改变“用哪个文本模型做润色”，只改变润色 prompt 的写法。
 */
function resolvePromptPolishStrategy(input: PolishVoicePromptInput): VoicePromptPolishStrategy {
  const mode = String(input.mode || "").trim().toLowerCase();
  const manufacturer = String(input.manufacturer || "").trim().toLowerCase();
  const model = String(input.model || "").trim().toLowerCase();

  if (mode === "mix") {
    return "route_keywords";
  }
  if (mode === "prompt_voice" && manufacturer === "aliyun_direct") {
    if (model.startsWith("qwen3-tts-vd")) {
      return "aliyun_direct_qwen_prompt";
    }
    if (model.includes("cosyvoice")) {
      return "aliyun_direct_cosyvoice_prompt";
    }
  }
  if (mode === "prompt_voice") {
    return "general_semantic_prompt";
  }
  return "route_keywords";
}

const voicePromptResultSchema = {
  prompt: zod
    .string()
    .describe("适合 ai_voice_tts prompt_voice 模式的一行中文关键词串，使用中文逗号分隔，长度控制在 3 到 8 个高信号短词或短词组"),
  keywords: zod.array(zod.string()).max(8).describe("拆分后的高信号关键词数组"),
  signalGroups: zod
    .array(zod.enum(["male", "female", "gentle", "story", "steady", "bright", "broadcast"]))
    .describe("命中的信号组"),
};

/**
 * 为不同的下游语音接口生成不同的系统提示词，避免“一套关键词策略”强行套所有模式。
 */
function buildSystemPrompt(strategy: VoicePromptPolishStrategy): string {
  const sharedPrompt = `
你是“音色提示词润色 agent”，专门把用户输入整理成适合下游语音接口的 prompt_text。

你必须遵守这些规则：
1. 只输出结构化结果，不要额外解释。
2. 保留明确的性别、年龄段、气质、语速、情绪、口吻信息。
3. 不要编造剧情，不要输出对白，不要写动作和长场景描述。
4. 如果输入只有角色名或极短短语，只能做保守补全。
5. 如果存在冲突词，优先保留更明确、更稳定的标签。

当前高信号词示例：
- male：男声、男性、男生、青年男性、少年感、磁性男
- female：女声、女性、女生、少女、御姐、甜妹
- gentle：温柔、治愈、柔和、轻柔、温暖、暖心、细腻、抒情
- story：故事、讲述、叙述、娓娓道来、旁白
- steady：沉稳、稳重、成熟、纪录片、说明、口播、专业、坚定、果决、磁性、低沉、干练
- bright：活泼、明快、明亮、清亮、轻快、朝气、元气、年轻、青年、张扬、自信、热情、有力、爽朗
- broadcast：播报、直播、主持、主播、口播
  `.trim();

  if (strategy === "aliyun_direct_cosyvoice_prompt") {
    return `
${sharedPrompt}

当前目标是“阿里云直连 CosyVoice 官方语音设计/复刻接口”。
输出策略：
1. prompt_text 会直接作为 voice_prompt 发送到阿里官方接口。
2. 输出可以是短自然语义描述，但要控制在 1 句以内，聚焦音色特征。
3. 优先格式：青年女性，温柔清晰，讲述感，自然亲和。
4. 不要写剧情背景，不要写动作，只描述声音应该是什么样。
5. 尽量保留中文逗号分隔的短描述，不要散文化。
    `.trim();
  }

  if (strategy === "aliyun_direct_qwen_prompt") {
    return `
${sharedPrompt}

当前目标是“阿里云直连 Qwen Voice Design 官方语音设计接口”。
输出策略：
1. prompt_text 会直接作为 voice_prompt 发送到阿里官方接口。
2. 输出更偏“设计说明式”的短描述，可以比纯关键词稍自然。
3. 控制在 12 到 30 个汉字，不要写多句。
4. 示例：青年男性，沉稳清晰，讲述感，略带磁性。
5. 不要写剧情、世界观、台词内容。
    `.trim();
  }

  if (strategy === "general_semantic_prompt") {
    return `
${sharedPrompt}

当前目标是“提示词音色”。
输出策略：
1. 可以保留短自然语义，但仍以高信号词为主。
2. 推荐一行中文逗号串，长度控制在 3 到 8 个短词或短词组。
3. 不要散文化，不要写成长段说明。
    `.trim();
  }

  return `
${sharedPrompt}

当前目标是“规则打分式风格路由”。
输出策略：
1. 输出目标不是写人设小作文，而是提炼 3 到 8 个高信号短词或短词组。
2. 尽量使用中文逗号连接，例如：青年男性，干练，自信，明亮，有力，朝气。
3. 输出必须偏“短关键词路由词”，不要散文化。
  `.trim();
}

/**
 * 把当前模式、厂商、模型等上下文显式送给润色 agent，让它按目标接口生成更合适的 prompt。
 */
function buildUserPrompt(
  input: PolishVoicePromptInput,
  signalGroups: VoiceSignalGroup[],
  detectedKeywords: string[],
  strategy: VoicePromptPolishStrategy,
): string {
  return `
请根据以下输入润色音色提示词。

原始输入：
${String(input.text || "").trim() || "无"}

偏好风格：
${String(input.style || "").trim() || "无"}

已识别信号组：
${signalGroups.length ? signalGroups.join(", ") : "无"}

已识别关键词：
${detectedKeywords.length ? detectedKeywords.join("，") : "无"}

目标模式：
${String(input.mode || "").trim() || "未知"}

目标厂商：
${String(input.manufacturer || "").trim() || "未知"}

目标模型：
${String(input.model || "").trim() || "未知"}

当前策略：
${strategy}

输出要求：
1. prompt 字段是一行中文关键词串
2. 不要写剧情、对白、动作、长句解释
3. 输出必须可直接用于目标语音接口的 prompt_text
  `.trim();
}

export default async function polishVoicePromptAgent(input: PolishVoicePromptInput): Promise<PolishVoicePromptResult> {
  const rawText = String(input.text || "").trim();
  const rawStyle = String(input.style || "").trim();
  const sourceText = [rawText, rawStyle].filter(Boolean).join("，");
  const signalGroups = detectSignalGroups(sourceText);
  const detectedKeywords = extractMatchedKeywords(sourceText);
  const strategy = resolvePromptPolishStrategy(input);

  const fallback = buildFallbackKeywords(rawText, rawStyle);
  const fallbackPrompt = sanitizePrompt(fallback.keywords.join("，")) || sanitizePrompt(rawText) || "自然，清晰，稳定";

  let promptAiConfig = await u.getPromptAi("assetsPrompt", input.userId);
  if (!hasUsableAiConfig(promptAiConfig)) {
    promptAiConfig = await u.getPromptAi("storyOrchestratorModel", input.userId);
  }
  if (!hasUsableAiConfig(promptAiConfig)) {
    return {
      prompt: fallbackPrompt,
      keywords: fallback.keywords,
      signalGroups: fallback.signalGroups,
      source: "fallback",
    };
  }

  try {
    const result = await u.ai.text.invoke(
      {
        usageType: "语音提示词优化",
        usageRemark: rawText || rawStyle || "语音提示词优化",
        usageMeta: {
          stage: "voicePromptPolish",
          mode: String(input.mode || "").trim() || undefined,
          manufacturer: String(input.manufacturer || "").trim() || undefined,
          model: String(input.model || "").trim() || undefined,
          provider: String(input.provider || "").trim() || undefined,
          strategy,
        },
        messages: [
          { role: "system", content: buildSystemPrompt(strategy) },
          { role: "user", content: buildUserPrompt(input, signalGroups, detectedKeywords, strategy) },
        ],
        output: voicePromptResultSchema,
      },
      promptAiConfig,
    );

    const prompt = sanitizePrompt(String(result?.prompt || ""));
    const keywords = unique(
      Array.isArray(result?.keywords)
        ? result.keywords.map((item: any) => String(item || "").trim()).filter(Boolean)
        : prompt.split("，").map((item) => item.trim()).filter(Boolean),
    ).slice(0, 8);

    const normalizedGroups = unique(
      Array.isArray(result?.signalGroups)
        ? result.signalGroups.map((item: any) => String(item || "").trim()).filter(Boolean)
        : signalGroups,
    ).filter((item): item is VoiceSignalGroup => GROUP_PRIORITY.includes(item as VoiceSignalGroup));

    if (!prompt) {
      throw new Error("音色提示词生成为空");
    }

    return {
      prompt,
      keywords: keywords.length ? keywords : fallback.keywords,
      signalGroups: normalizedGroups.length ? normalizedGroups : fallback.signalGroups,
      source: "ai",
    };
  } catch {
    return {
      prompt: fallbackPrompt,
      keywords: fallback.keywords,
      signalGroups: fallback.signalGroups,
      source: "fallback",
    };
  }
}
