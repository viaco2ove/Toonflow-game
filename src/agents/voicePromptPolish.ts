import * as zod from "zod";
import u from "@/utils";

export type VoiceSignalGroup = "male" | "female" | "gentle" | "story" | "steady" | "bright" | "broadcast";

export interface PolishVoicePromptInput {
  text: string;
  style?: string | null;
  userId?: number;
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

const voicePromptResultSchema = {
  prompt: zod
    .string()
    .describe("适合 ai_voice_tts prompt_voice 模式的一行中文关键词串，使用中文逗号分隔，长度控制在 3 到 8 个高信号短词或短词组"),
  keywords: zod.array(zod.string()).max(8).describe("拆分后的高信号关键词数组"),
  signalGroups: zod
    .array(zod.enum(["male", "female", "gentle", "story", "steady", "bright", "broadcast"]))
    .describe("命中的信号组"),
};

const SYSTEM_PROMPT = `
你是“音色提示词润色 agent”，专门把用户输入整理成适合 ai_voice_tts 网关 mode=prompt_voice 的提示词。

你必须遵守这些规则：
1. prompt_voice 是“规则打分式风格路由”，不是自由散文理解。
2. 输出目标不是写人设小作文，而是提炼 3 到 8 个高信号短词或短词组。
3. 优先使用这些信号组：male、female、gentle、story、steady、bright、broadcast。
4. 保留明确的性别、年龄段、气质、语速、情绪、口吻信息。
5. 不要编造剧情，不要输出对白，不要写动作和场景，不要长句解释。
6. 尽量使用中文逗号连接，例如：青年男性，干练，自信，明亮，有力，朝气。
7. 如果输入只有角色名或极短短语，可做保守补全，但只能补充稳定的音色特征，不能扩写剧情。
8. 如果存在冲突词，优先保留更明确、更稳定、更适合音色路由的标签。
9. provider 分策略：
   - cosyvoice_local：prompt_text 会继续透传给 CosyVoice instruct，可以保留短自然语义，但仍以高信号词为主。
   - edge_online：prompt_text 不会传给底层引擎，只在网关层辅助选音色，因此输出必须更偏“短关键词路由词”，不要散文化。

当前高信号词示例：
- male：男声、男性、男生、青年男性、少年感、磁性男
- female：女声、女性、女生、少女、御姐、甜妹
- gentle：温柔、治愈、柔和、轻柔、温暖、暖心、细腻、抒情
- story：故事、讲述、叙述、娓娓道来、旁白
- steady：沉稳、稳重、成熟、纪录片、说明、口播、专业、坚定、果决、磁性、低沉、干练
- bright：活泼、明快、明亮、清亮、轻快、朝气、元气、年轻、青年、张扬、自信、热情、有力、爽朗
- broadcast：播报、直播、主持、主播、口播

只输出结构化结果，不要额外解释。
`.trim();

function buildUserPrompt(input: PolishVoicePromptInput, signalGroups: VoiceSignalGroup[], detectedKeywords: string[]): string {
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

输出要求：
1. prompt 字段是一行中文关键词串
2. 尽量保持 3 到 8 个高信号短词或短词组
3. 不要写剧情、对白、动作、长句解释
4. 输出可直接用于 ai_voice_tts 的 prompt_text
5. 如果 style/上下文里出现 edge_online，进一步压缩成更路由化的关键词串
  `.trim();
}

export default async function polishVoicePromptAgent(input: PolishVoicePromptInput): Promise<PolishVoicePromptResult> {
  const rawText = String(input.text || "").trim();
  const rawStyle = String(input.style || "").trim();
  const sourceText = [rawText, rawStyle].filter(Boolean).join("，");
  const signalGroups = detectSignalGroups(sourceText);
  const detectedKeywords = extractMatchedKeywords(sourceText);

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
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(input, signalGroups, detectedKeywords) },
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
