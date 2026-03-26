import axios from "axios";
import u from "@/utils";

export interface GatewayVoicePreset {
  voiceId: string;
  name: string;
  provider: string;
  modes: string[];
  description: string;
}

export type GatewayVoiceMode = "text" | "clone" | "mix" | "prompt_voice";
export type VoiceSupplier = "local" | "aliyun";
const DEFAULT_TTS_VOICE_MODES: GatewayVoiceMode[] = ["text", "clone", "mix", "prompt_voice"];
const DIRECT_ALIYUN_COSYVOICE_TTS_VOICE_MODES: GatewayVoiceMode[] = ["text", "clone", "mix"];
const TEXT_ONLY_VOICE_MODES: GatewayVoiceMode[] = ["text"];

const ALIYUN_DIRECT_QWEN_TTS_PRESETS: GatewayVoicePreset[] = [
  {
    voiceId: "Cherry",
    name: "Cherry",
    provider: "aliyun_direct_qwen_tts",
    modes: ["text", "prompt_voice"],
    description: "千问 3-TTS 官方系统音色，阳光积极、亲切自然小姐姐",
  },
  {
    voiceId: "Serena",
    name: "Serena",
    provider: "aliyun_direct_qwen_tts",
    modes: ["text", "prompt_voice"],
    description: "千问-TTS 官方系统音色，甜润活泼女声",
  },
  {
    voiceId: "Ethan",
    name: "Ethan",
    provider: "aliyun_direct_qwen_tts",
    modes: ["text", "prompt_voice"],
    description: "千问 3-TTS 官方系统音色，阳光温暖男声",
  },
  {
    voiceId: "Chelsie",
    name: "Chelsie",
    provider: "aliyun_direct_qwen_tts",
    modes: ["text", "prompt_voice"],
    description: "千问-TTS 官方系统音色，软糯娇俏女声",
  },
  {
    voiceId: "Nofish",
    name: "Nofish",
    provider: "aliyun_direct_qwen_tts",
    modes: ["text", "prompt_voice"],
    description: "千问 3-TTS 官方系统音色，不会翘舌音的设计师",
  },
  {
    voiceId: "Jennifer",
    name: "Jennifer",
    provider: "aliyun_direct_qwen_tts",
    modes: ["text", "prompt_voice"],
    description: "千问 3-TTS 官方系统音色，电影质感美语女声",
  },
  {
    voiceId: "Ryan",
    name: "Ryan",
    provider: "aliyun_direct_qwen_tts",
    modes: ["text", "prompt_voice"],
    description: "千问 3-TTS 官方系统音色，高张力男声",
  },
  {
    voiceId: "Katerina",
    name: "Katerina",
    provider: "aliyun_direct_qwen_tts",
    modes: ["text", "prompt_voice"],
    description: "千问 3-TTS 官方系统音色，御姐女声",
  },
  {
    voiceId: "Elias",
    name: "Elias",
    provider: "aliyun_direct_qwen_tts",
    modes: ["text", "prompt_voice"],
    description: "千问 3-TTS 官方系统音色，讲师风格女声",
  },
  {
    voiceId: "Jada",
    name: "Jada",
    provider: "aliyun_direct_qwen_tts",
    modes: ["text", "prompt_voice"],
    description: "千问 3-TTS 官方系统音色，沪上阿姐",
  },
  {
    voiceId: "Dylan",
    name: "Dylan",
    provider: "aliyun_direct_qwen_tts",
    modes: ["text", "prompt_voice"],
    description: "千问 3-TTS 官方系统音色，北京少年音",
  },
  {
    voiceId: "Sunny",
    name: "Sunny",
    provider: "aliyun_direct_qwen_tts",
    modes: ["text", "prompt_voice"],
    description: "千问 3-TTS 官方系统音色，四川甜妹",
  },
  {
    voiceId: "li",
    name: "li",
    provider: "aliyun_direct_qwen_tts",
    modes: ["text", "prompt_voice"],
    description: "千问 3-TTS 官方系统音色，南京-老李",
  },
  {
    voiceId: "Marcus",
    name: "Marcus",
    provider: "aliyun_direct_qwen_tts",
    modes: ["text", "prompt_voice"],
    description: "千问 3-TTS 官方系统音色，陕西-秦川",
  },
  {
    voiceId: "Roy",
    name: "Roy",
    provider: "aliyun_direct_qwen_tts",
    modes: ["text", "prompt_voice"],
    description: "千问 3-TTS 官方系统音色，闽南-阿杰",
  },
  {
    voiceId: "Peter",
    name: "Peter",
    provider: "aliyun_direct_qwen_tts",
    modes: ["text", "prompt_voice"],
    description: "千问 3-TTS 官方系统音色，天津-李彼得",
  },
  {
    voiceId: "Rocky",
    name: "Rocky",
    provider: "aliyun_direct_qwen_tts",
    modes: ["text", "prompt_voice"],
    description: "千问 3-TTS 官方系统音色，粤语-阿强",
  },
  {
    voiceId: "Kiki",
    name: "Kiki",
    provider: "aliyun_direct_qwen_tts",
    modes: ["text", "prompt_voice"],
    description: "千问 3-TTS 官方系统音色，粤语-阿清",
  },
  {
    voiceId: "Eric",
    name: "Eric",
    provider: "aliyun_direct_qwen_tts",
    modes: ["text", "prompt_voice"],
    description: "千问 3-TTS 官方系统音色，四川-程川",
  },
];

const ALIYUN_DIRECT_COSYVOICE_V3_PRESETS: GatewayVoicePreset[] = [
  {
    voiceId: "longanhuan",
    name: "龙安欢",
    provider: "aliyun_direct_cosyvoice_v3",
    modes: TEXT_ONLY_VOICE_MODES,
    description: "CosyVoice-v3 系统音色，欢脱元气女",
  },
  {
    voiceId: "longanyang",
    name: "龙安洋",
    provider: "aliyun_direct_cosyvoice_v3",
    modes: TEXT_ONLY_VOICE_MODES,
    description: "CosyVoice-v3 系统音色，阳光大男孩",
  },
  {
    voiceId: "longhuhu_v3",
    name: "龙呼呼",
    provider: "aliyun_direct_cosyvoice_v3",
    modes: TEXT_ONLY_VOICE_MODES,
    description: "CosyVoice-v3 系统音色，天真烂漫女童",
  },
  {
    voiceId: "longwangwang_v3",
    name: "龙汪汪",
    provider: "aliyun_direct_cosyvoice_v3",
    modes: TEXT_ONLY_VOICE_MODES,
    description: "CosyVoice-v3 系统音色，台湾少年音",
  },
  {
    voiceId: "longanshuo_v3",
    name: "龙安朔",
    provider: "aliyun_direct_cosyvoice_v3",
    modes: TEXT_ONLY_VOICE_MODES,
    description: "CosyVoice-v3 系统音色，干净清爽男",
  },
  {
    voiceId: "longfeifei_v3",
    name: "龙菲菲",
    provider: "aliyun_direct_cosyvoice_v3",
    modes: TEXT_ONLY_VOICE_MODES,
    description: "CosyVoice-v3 系统音色，甜美娇气女",
  },
  {
    voiceId: "longanzhi_v3",
    name: "龙安智",
    provider: "aliyun_direct_cosyvoice_v3",
    modes: TEXT_ONLY_VOICE_MODES,
    description: "CosyVoice-v3 系统音色，睿智轻熟男",
  },
  {
    voiceId: "longanqin_v3",
    name: "龙安琴",
    provider: "aliyun_direct_cosyvoice_v3",
    modes: TEXT_ONLY_VOICE_MODES,
    description: "CosyVoice-v3 系统音色，知性沉稳女",
  },
  {
    voiceId: "longanling_v3",
    name: "龙安玲",
    provider: "aliyun_direct_cosyvoice_v3",
    modes: TEXT_ONLY_VOICE_MODES,
    description: "CosyVoice-v3 系统音色，灵动少女音",
  },
  {
    voiceId: "longanya_v3",
    name: "龙安雅",
    provider: "aliyun_direct_cosyvoice_v3",
    modes: TEXT_ONLY_VOICE_MODES,
    description: "CosyVoice-v3 系统音色，温婉女声",
  },
  {
    voiceId: "longanwen_v3",
    name: "龙安文",
    provider: "aliyun_direct_cosyvoice_v3",
    modes: TEXT_ONLY_VOICE_MODES,
    description: "CosyVoice-v3 系统音色，沉静书卷男声",
  },
  {
    voiceId: "longanyun_v3",
    name: "龙安云",
    provider: "aliyun_direct_cosyvoice_v3",
    modes: TEXT_ONLY_VOICE_MODES,
    description: "CosyVoice-v3 系统音色，清亮中性声",
  },
  {
    voiceId: "longjiqi_v3",
    name: "龙极琪",
    provider: "aliyun_direct_cosyvoice_v3",
    modes: TEXT_ONLY_VOICE_MODES,
    description: "CosyVoice-v3 系统音色，科技感青年声",
  },
];

function normalizedManufacturer(input?: string | null): string {
  return String(input || "").trim();
}

export function normalizeVoiceBaseUrl(input: string | null | undefined): string {
  const base = String(input || "").trim();
  return (base || "http://127.0.0.1:8000").replace(/\/+$/, "");
}

export async function getUserVoiceConfig(userId: number, configId?: number | null) {
  if (configId) {
    return u.db("t_config").where({ id: configId, type: "voice", userId }).first();
  }
  return u.db("t_config").where({ type: "voice", userId }).first();
}

export async function getRuntimeStoryVoiceConfig(userId: number, requestedConfigId?: number | null) {
  let requestedConfig = null as any;
  if (requestedConfigId) {
    requestedConfig = await getUserVoiceConfig(userId, requestedConfigId);
  }

  const setting = await u.db("t_setting").where({ userId }).select("languageModel").first();
  let storyVoiceConfigId = 0;
  try {
    const parsed = JSON.parse(String(setting?.languageModel || "{}"));
    storyVoiceConfigId = Number((parsed as Record<string, any>)?.storyVoiceModel || 0);
  } catch {
    storyVoiceConfigId = 0;
  }

  if (storyVoiceConfigId > 0) {
    const runtimeConfig = await u.db("t_config")
      .where({ id: storyVoiceConfigId, type: "voice", userId })
      .first();
    if (runtimeConfig) {
      return runtimeConfig;
    }
  }

  return requestedConfig || getUserVoiceConfig(userId, requestedConfigId);
}

export function isLocalVoiceManufacturer(input?: string | null): boolean {
  const normalized = normalizedManufacturer(input);
  return normalized === "ai_voice_tts" || normalized === "aliyun";
}

export function isLocalAliyunManufacturer(input?: string | null): boolean {
  return normalizedManufacturer(input) === "aliyun";
}

export function isDirectAliyunManufacturer(input?: string | null): boolean {
  return normalizedManufacturer(input) === "aliyun_direct";
}

export function isAliyunVoiceManufacturer(input?: string | null): boolean {
  return isLocalAliyunManufacturer(input) || isDirectAliyunManufacturer(input);
}

export function voiceSupplierFromManufacturer(input?: string | null): VoiceSupplier | null {
  const normalized = normalizedManufacturer(input);
  if (normalized === "ai_voice_tts") return "local";
  if (normalized === "aliyun") return "aliyun";
  return null;
}

export function filterVoicePresetsByManufacturer(presets: GatewayVoicePreset[], manufacturer?: string | null) {
  const normalized = normalizedManufacturer(manufacturer);
  if (normalized === "aliyun") {
    return presets.filter((item) => String(item.provider || "").trim() === "aliyun_tts");
  }
  if (normalized === "ai_voice_tts") {
    return presets.filter((item) => String(item.provider || "").trim() !== "aliyun_tts");
  }
  return presets;
}

function normalizeText(input?: string | null): string {
  return String(input || "").trim().toLowerCase();
}

export function normalizeAliyunDirectTtsModel(input?: string | null): string {
  const raw = String(input || "").trim();
  if (!raw) return "cosyvoice-v3-flash";
  return raw;
}

export function directAliyunVoicePresets(model?: string | null): GatewayVoicePreset[] {
  const normalizedModel = normalizeText(normalizeAliyunDirectTtsModel(model));
  if (normalizedModel.includes("qwen3-tts")) {
    return ALIYUN_DIRECT_QWEN_TTS_PRESETS.map((item) => ({ ...item }));
  }
  if (normalizedModel === "qwen-tts" || normalizedModel === "qwen-tts-latest") {
    return ALIYUN_DIRECT_QWEN_TTS_PRESETS.filter((item) => ["Chelsie", "Cherry", "Ethan", "Serena"].includes(item.voiceId)).map((item) => ({ ...item }));
  }
  if (normalizedModel === "cosyvoice-v3-flash" || normalizedModel === "cosyvoice-v3-plus") {
    return ALIYUN_DIRECT_COSYVOICE_V3_PRESETS.map((item) => ({ ...item }));
  }
  if (normalizedModel === "cosyvoice-v3.5-flash" || normalizedModel === "cosyvoice-v3.5-plus") {
    return [];
  }
  return [];
}

export function defaultAliyunDirectVoiceId(model?: string | null): string {
  const normalizedModel = normalizeText(normalizeAliyunDirectTtsModel(model));
  if (normalizedModel.includes("qwen3-tts")) return "Cherry";
  if (normalizedModel === "qwen-tts" || normalizedModel === "qwen-tts-latest") return "Chelsie";
  if (normalizedModel === "cosyvoice-v3-flash" || normalizedModel === "cosyvoice-v3-plus") return "longanyang";
  return "";
}

export function normalizeAliyunDirectAsrModel(input?: string | null): string {
  const raw = String(input || "").trim();
  if (!raw || raw === "fun-asr-realtime") return "qwen3-asr-flash";
  return raw;
}

export function resolveAliyunDirectTtsEndpoint(input: string | null | undefined): string {
  const base = String(input || "").trim().replace(/\/+$/, "");
  if (!base) {
    return "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
  }
  if (/\/api\/v1\/services\/aigc\/multimodal-generation\/generation$/i.test(base)) {
    return base;
  }
  const normalized = base
    .replace(/\/compatible-mode\/v1$/i, "")
    .replace(/\/compatible-mode$/i, "")
    .replace(/\/api\/v1$/i, "");
  return `${normalized}/api/v1/services/aigc/multimodal-generation/generation`;
}

export function isAliyunDirectCosyVoiceModel(input?: string | null): boolean {
  const normalizedModel = normalizeText(normalizeAliyunDirectTtsModel(input));
  return [
    "cosyvoice-v3-flash",
    "cosyvoice-v3-plus",
    "cosyvoice-v3.5-flash",
    "cosyvoice-v3.5-plus",
  ].includes(normalizedModel);
}

export function resolveVoiceModelModes(input: {
  manufacturer?: string | null;
  modelType?: string | null;
  model?: string | null;
}): GatewayVoiceMode[] {
  const manufacturer = normalizedManufacturer(input.manufacturer);
  const modelType = String(input.modelType || "").trim().toLowerCase();
  if (modelType && modelType !== "tts") {
    return [];
  }
  if (manufacturer === "aliyun_direct" && isAliyunDirectCosyVoiceModel(input.model)) {
    return [...DIRECT_ALIYUN_COSYVOICE_TTS_VOICE_MODES];
  }
  return [...DEFAULT_TTS_VOICE_MODES];
}

export function resolveUnsupportedVoiceModeReason(input: {
  manufacturer?: string | null;
  modelType?: string | null;
  model?: string | null;
  mode?: string | null;
}): string {
  const mode = String(input.mode || "").trim() as GatewayVoiceMode;
  if (!mode) return "";
  if (resolveVoiceModelModes(input).includes(mode)) {
    return "";
  }
  return "当前语音模型不支持该绑定模式";
}

export function resolveAliyunDirectCosyVoiceWsEndpoint(input: string | null | undefined): string {
  const raw = String(input || "").trim().replace(/\/+$/, "");
  if (!raw) {
    return "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
  }
  if (/^wss?:\/\//i.test(raw)) {
    return raw.replace(/^http/i, "ws").replace(/\/+$/, "");
  }
  const normalized = raw
    .replace(/^https?:\/\//i, "")
    .replace(/\/compatible-mode\/v1$/i, "")
    .replace(/\/compatible-mode$/i, "")
    .replace(/\/api\/v1\/services\/aigc\/multimodal-generation\/generation$/i, "")
    .replace(/\/api\/v1$/i, "")
    .replace(/\/+$/, "");
  return `wss://${normalized}/api-ws/v1/inference`;
}

export function normalizePersistedVoiceConfig(input: {
  manufacturer?: string | null;
  modelType?: string | null;
  model?: string | null;
  baseUrl?: string | null;
}) {
  const manufacturer = normalizedManufacturer(input.manufacturer);
  const modelType = String(input.modelType || "").trim().toLowerCase();
  const model = String(input.model || "").trim();
  const baseUrl = String(input.baseUrl || "").trim();
  if (manufacturer !== "aliyun_direct") {
    return {
      model,
      baseUrl,
    };
  }
  if (modelType === "asr") {
    return {
      model: normalizeAliyunDirectAsrModel(model),
      baseUrl: baseUrl || "https://dashscope.aliyuncs.com/compatible-mode",
    };
  }
  return {
    model: normalizeAliyunDirectTtsModel(model),
    baseUrl: baseUrl && !/compatible-mode/i.test(baseUrl) ? baseUrl : "https://dashscope.aliyuncs.com",
  };
}

export function normalizeVoicePreset(item: any): GatewayVoicePreset | null {
  if (!item) return null;
  if (typeof item === "string") {
    const voiceId = item.trim();
    if (!voiceId) return null;
    return {
      voiceId,
      name: voiceId,
      provider: "",
      modes: [],
      description: "",
    };
  }

  const voiceId = String(item.voice_id || item.voiceId || item.id || item.key || "").trim();
  if (!voiceId) return null;

  return {
    voiceId,
    name: String(item.name || item.label || item.voice_name || voiceId).trim() || voiceId,
    provider: String(item.provider || item.provider_id || "").trim(),
    modes: Array.isArray(item.modes) ? item.modes.map((mode: any) => String(mode || "").trim()).filter(Boolean) : [],
    description: String(item.description || item.desc || "").trim(),
  };
}

export async function fetchVoicePresets(baseUrl: string, headers: Record<string, string>) {
  const response = await axios.get(`${baseUrl}/voices`, { headers });
  const data = (response.data as any)?.data ?? response.data;
  const list = Array.isArray(data) ? data : Array.isArray(data?.voices) ? data.voices : [];
  return list.map(normalizeVoicePreset).filter((item: GatewayVoicePreset | null): item is GatewayVoicePreset => !!item);
}
