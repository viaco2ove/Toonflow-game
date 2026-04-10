import * as zod from "zod";
import u from "@/utils";

export type VoiceSignalGroup = "male" | "female" | "gentle" | "story" | "steady" | "bright" | "broadcast";

export interface PolishVoicePromptInput {
  text: string;
  userId?: number;
  mode?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  provider?: string | null;
  voiceDesignModel?: string | null;
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

/**
 * 仅在 debug 日志级别下打印润色链路诊断信息，避免常规日志被刷屏。
 */
function isDebugLogEnabled(): boolean {
  return String(process.env.LOG_LEVEL || "").trim().toLowerCase() === "debug";
}

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

function buildFallbackKeywords(text: string): { keywords: string[]; signalGroups: VoiceSignalGroup[] } {
  const source = [text].filter(Boolean).join("，");
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
 * 这里继续走文本大模型润色，但 system / user prompt 会按目标下游接口切换。
 */
function resolvePromptPolishStrategy(input: PolishVoicePromptInput): VoicePromptPolishStrategy {
  const mode = String(input.mode || "").trim().toLowerCase();
  const manufacturer = String(input.manufacturer || "").trim().toLowerCase();
  const model = String(input.model || "").trim().toLowerCase();
  const voiceDesignModel = String(input.voiceDesignModel || "").trim().toLowerCase();

  if (mode === "mix") {
    return "route_keywords";
  }
  if (mode === "prompt_voice" && manufacturer === "aliyun_direct") {
    // 阿里直连提示词音色真正落地时，会再经过语音设计模型。
    // 这里优先按 storyVoiceDesignModel 判断润色风格，和下游接口保持一致。
    if (
      voiceDesignModel === "qwen-voice-design"
      || voiceDesignModel.startsWith("qwen3-tts-vd")
    ) {
      return "aliyun_direct_qwen_prompt";
    }
    if (
      voiceDesignModel === "voice-enrollment"
      || voiceDesignModel.startsWith("cosyvoice-v3")
      || voiceDesignModel.startsWith("cosyvoice-v3.5")
    ) {
      return "aliyun_direct_cosyvoice_prompt";
    }
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
 * 为不同的下游语音接口生成不同的系统提示词，直接对齐产品文档里的提示词设计。
 */
function buildSystemPrompt(strategy: VoicePromptPolishStrategy): string {
  if (strategy === "aliyun_direct_cosyvoice_prompt") {
    return `
你是“CosyVoice 音色提示词润色助手”。

你的任务是：把用户输入的角色名、风格词、短描述，改写成适合 CosyVoice 使用的简洁音色描述。

必须遵守以下规则：
1. 输出只保留一行中文，不要解释。
2. 输出聚焦声音特征：性别、年龄感、气质、语气、语速、清晰度、情绪。
3. 不要写剧情、对白、动作、世界观设定。
4. 不要写成长句散文，尽量简洁、自然、稳定。
5. 如果输入过于模糊，可以合理补全，但不要过度发挥。
6. 输出要让下游模型一眼就能抓住“这个声音应该怎么说话”。

输出风格要求：
- 1句中文
- 10~30字优先
- 尽量短
- 尽量自然
- 尽量像音色标签的自然表达
    `.trim();
  }

  if (strategy === "aliyun_direct_qwen_prompt") {
    return `
你是“语音设计提示词润色助手”。

你的任务是：把用户输入的角色名、风格词、短描述，改写成适合阿里云 qwen-voice-design 的 voice_prompt。

必须遵守以下规则：
1. 输出只保留一行中文，不要解释，不要加前后缀。
2. 输出内容必须是“声音特征描述”，不是剧情，不是台词，不是人物设定介绍。
3. 优先补全这些维度：性别、年龄感、音色特征、语气、语速、情绪、表达风格、适用场景。
4. 如果用户输入很短、很模糊，例如“孙悟空”“霸总”，允许做合理补全，但不要过度编造。
5. 不要写“模仿某演员/某真人/某具体角色原声”。
6. 不要输出抽象空话，例如“很好听”“有魅力”“高级感拉满”。
7. 最终结果要像一个可以直接传给 voice_prompt 的描述。

输出风格要求：
- 1句中文
- 20~50字优先
- 具体、稳定、可用于声音设计
    `.trim();
  }

  if (strategy === "general_semantic_prompt") {
    return `
你是“音色提示词润色 agent”，专门把用户输入整理成适合下游语音接口的 prompt_text。

你必须遵守这些规则：
1. 只输出结构化结果，不要额外解释。
2. 保留明确的性别、年龄段、气质、语速、情绪、口吻信息。
3. 不要编造剧情，不要输出对白，不要写动作和长场景描述。
4. 如果输入只有角色名或极短短语，只能做保守补全。
5. 如果存在冲突词，优先保留更明确、更稳定的标签。
    `.trim();
  }

  return `
你是“音色提示词润色 agent”，专门把用户输入整理成适合下游语音接口的 prompt_text。

你必须遵守这些规则：
1. 只输出结构化结果，不要额外解释。
2. 保留明确的性别、年龄段、气质、语速、情绪、口吻信息。
3. 不要编造剧情，不要输出对白，不要写动作和长场景描述。
4. 输出目标不是写长说明，而是提炼高信号短词或短词组。
    `.trim();
}

/**
 * 把当前模式、厂商、模型等上下文显式送给润色 agent，让它按目标接口生成更合适的 prompt。
 * 这里不再使用前端传来的 style 串，避免 storyVoiceModel 干扰真实的语音设计模型判断。
 */
function buildUserPrompt(
  input: PolishVoicePromptInput,
  signalGroups: VoiceSignalGroup[],
  detectedKeywords: string[],
  strategy: VoicePromptPolishStrategy,
): string {
  if (strategy === "aliyun_direct_qwen_prompt") {
    return `
请把下面这段输入润色成适合 qwen-voice-design 的 voice_prompt。

用户输入：
${String(input.text || "").trim() || "无"}

输出要求：
- 只输出一行中文
- 不要解释
- 不要台词
- 不要剧情
- 要描述声音本身
    `.trim();
  }

  if (strategy === "aliyun_direct_cosyvoice_prompt") {
    return `
请把下面这段输入润色成适合 CosyVoice 的音色描述。

用户输入：
${String(input.text || "").trim() || "无"}

输出要求：
- 只输出一行中文
- 不要解释
- 不要台词
- 不要剧情
- 简洁自然
- 重点描述声音特征
    `.trim();
  }

  return `
请根据以下输入润色音色提示词。

原始输入：
${String(input.text || "").trim() || "无"}

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

语音设计模型：
${String(input.voiceDesignModel || "").trim() || "未知"}

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
  const sourceText = [rawText].filter(Boolean).join("，");
  const signalGroups = detectSignalGroups(sourceText);
  const detectedKeywords = extractMatchedKeywords(sourceText);
  const strategy = resolvePromptPolishStrategy(input);

  const fallback = buildFallbackKeywords(rawText);
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
        usageRemark: rawText || "语音提示词优化",
        usageMeta: {
          stage: "voicePromptPolish",
          mode: String(input.mode || "").trim() || undefined,
          manufacturer: String(input.manufacturer || "").trim() || undefined,
          model: String(input.model || "").trim() || undefined,
          provider: String(input.provider || "").trim() || undefined,
          voiceDesignModel: String(input.voiceDesignModel || "").trim() || undefined,
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

    if (isDebugLogEnabled()) {
      console.log("[voice:polish:debug] runtime", {
        manufacturer: String(input.manufacturer || "").trim(),
        model: String(input.model || "").trim(),
        voiceDesignModel: String(input.voiceDesignModel || "").trim(),
        mode: String(input.mode || "").trim(),
        provider: String(input.provider || "").trim(),
        strategy,
        polishModelManufacturer: String(promptAiConfig?.manufacturer || "").trim(),
        polishModel: String(promptAiConfig?.model || "").trim(),
      });
    }

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
