import axios from "axios";
import u from "@/utils";

export interface GatewayVoicePreset {
  voiceId: string;
  name: string;
  provider: string;
  modes: string[];
  description: string;
}

export type VoiceSupplier = "local" | "aliyun";

const ALIYUN_DIRECT_PRESETS: GatewayVoicePreset[] = [
  {
    voiceId: "Cherry",
    name: "Cherry",
    provider: "aliyun_direct",
    modes: ["text", "prompt_voice"],
    description: "阿里云官方系统音色，通用中文女声",
  },
  {
    voiceId: "Serena",
    name: "Serena",
    provider: "aliyun_direct",
    modes: ["text", "prompt_voice"],
    description: "阿里云官方系统音色，柔和女声",
  },
  {
    voiceId: "Ethan",
    name: "Ethan",
    provider: "aliyun_direct",
    modes: ["text", "prompt_voice"],
    description: "阿里云官方系统音色，稳重男声",
  },
  {
    voiceId: "Chelsie",
    name: "Chelsie",
    provider: "aliyun_direct",
    modes: ["text", "prompt_voice"],
    description: "阿里云官方系统音色，明亮女声",
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
  if (normalized === "aliyun_direct") {
    return ALIYUN_DIRECT_PRESETS;
  }
  if (normalized === "ai_voice_tts") {
    return presets.filter((item) => String(item.provider || "").trim() !== "aliyun_tts");
  }
  return presets;
}

export function directAliyunVoicePresets(): GatewayVoicePreset[] {
  return ALIYUN_DIRECT_PRESETS.map((item) => ({ ...item }));
}

export function normalizeAliyunDirectTtsModel(input?: string | null): string {
  const raw = String(input || "").trim();
  if (!raw || raw === "cosyvoice-v3-flash") return "qwen3-tts-instruct-flash";
  return raw;
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
