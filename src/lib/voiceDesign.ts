import axios from "axios";
import { createHash } from "node:crypto";
import u from "@/utils";

export interface VoiceDesignConfig {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  manufacturer?: string;
}

export interface VoiceDesignAudioResult {
  buffer: Buffer;
  sourceUrl: string;
  requestModel: string;
  targetModel: string;
  responseData: Record<string, any> | null;
}

const DEFAULT_DASHSCOPE_AIGC_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization";
const DEFAULT_QWEN_VOICE_DESIGN_TARGET_MODEL = "qwen3-tts-vd-2026-01-26";
const DEFAULT_VOICE_ENROLLMENT_TARGET_MODEL = "cosyvoice-v3-plus";
const MAX_VOICE_DESIGN_NAME_LENGTH = 16;

function trimText(input?: string | null): string {
  return String(input || "").trim();
}

export function hasUsableVoiceDesignConfig(config: unknown): config is VoiceDesignConfig {
  if (!config || typeof config !== "object") return false;
  const candidate = config as VoiceDesignConfig;
  return Boolean(trimText(candidate.apiKey) && trimText(candidate.model));
}

export async function getStoryVoiceDesignConfig(userId: number): Promise<VoiceDesignConfig | null> {
  const config = await u.getPromptAi("storyVoiceDesignModel", userId);
  if (!hasUsableVoiceDesignConfig(config)) {
    return null;
  }
  return {
    model: trimText(config.model),
    apiKey: trimText(config.apiKey),
    baseURL: trimText(config.baseURL),
    manufacturer: trimText(config.manufacturer),
  };
}

function normalizeVoiceDesignEndpoint(baseURL?: string | null): string {
  const base = trimText(baseURL);
  if (!base) return DEFAULT_DASHSCOPE_AIGC_ENDPOINT;
  if (/\/api\/v1\/services\/aigc\/multimodal-generation\/generation$/i.test(base)) {
    return base.replace(/\/api\/v1\/services\/aigc\/multimodal-generation\/generation$/i, "/api/v1/services/audio/tts/customization");
  }
  if (/\/api\/v1\/services\/audio\/tts\/customization$/i.test(base)) {
    return base;
  }
  const normalized = base
    .replace(/\/compatible-mode\/v1$/i, "")
    .replace(/\/compatible-mode$/i, "")
    .replace(/\/api\/v1$/i, "")
    .replace(/\/v1$/i, "")
    .replace(/\/+$/, "");
  return `${normalized}/api/v1/services/audio/tts/customization`;
}

function slugifyPreferredName(input?: string | null, fallback = "story_voice"): string {
  const normalized = trimText(input)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const resolved = normalized || fallback;
  if (resolved.length <= MAX_VOICE_DESIGN_NAME_LENGTH) {
    return resolved;
  }
  const hash = createHash("md5").update(resolved).digest("hex").slice(0, 6);
  const headLength = Math.max(1, MAX_VOICE_DESIGN_NAME_LENGTH - hash.length - 1);
  const head = resolved.slice(0, headLength).replace(/^_+|_+$/g, "") || fallback.slice(0, headLength);
  return `${head}_${hash}`.slice(0, MAX_VOICE_DESIGN_NAME_LENGTH);
}

type VoiceDesignStrategy =
  | {
      kind: "qwen_voice_design";
      requestModel: "qwen-voice-design";
      targetModel: string;
      action: "create";
    }
  | {
      kind: "voice_enrollment";
      requestModel: "voice-enrollment";
      targetModel: string;
      action: "create_voice";
    };

function resolveVoiceDesignStrategy(config: VoiceDesignConfig): VoiceDesignStrategy {
  const rawModel = trimText(config.model);
  const normalizedModel = rawModel.toLowerCase();
  if (
    normalizedModel === "qwen-voice-design"
    || normalizedModel.includes("tts-vd")
    || normalizedModel.startsWith("qwen3-tts-vd")
  ) {
    return {
      kind: "qwen_voice_design",
      requestModel: "qwen-voice-design",
      targetModel: rawModel === "qwen-voice-design" ? DEFAULT_QWEN_VOICE_DESIGN_TARGET_MODEL : rawModel,
      action: "create",
    };
  }

  if (
    normalizedModel === "voice-enrollment"
    || normalizedModel.startsWith("cosyvoice-v3")
    || normalizedModel.startsWith("cosyvoice-v3.5")
  ) {
    return {
      kind: "voice_enrollment",
      requestModel: "voice-enrollment",
      targetModel: rawModel === "voice-enrollment" ? DEFAULT_VOICE_ENROLLMENT_TARGET_MODEL : rawModel,
      action: "create_voice",
    };
  }

  throw new Error(`当前语音设计模型不受支持: ${rawModel || "未配置模型名"}`);
}

function parseJsonResponse(buffer: Buffer): Record<string, any> | null {
  const rawText = buffer.toString("utf8").trim();
  if (!rawText) return null;
  if (!rawText.startsWith("{") && !rawText.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(rawText);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function extractAudioSource(data: Record<string, any> | null): { url?: string; base64?: string } | null {
  if (!data) return null;
  const urlCandidates = [
    data?.output?.preview_audio?.url,
    data?.output?.audio?.url,
    data?.output?.audio_url,
    data?.output?.audioUrl,
    data?.output?.url,
    data?.audio?.url,
    data?.audio_url,
    data?.url,
  ];
  const url = urlCandidates.map((item) => trimText(item)).find(Boolean);
  if (url) return { url };

  const base64Candidates = [
    data?.output?.preview_audio?.data,
    data?.output?.preview_audio?.base64,
    data?.output?.audio?.data,
    data?.output?.audio?.base64,
    data?.output?.audio_data,
    data?.audio?.data,
    data?.audio?.base64,
    data?.audio_data,
  ];
  const base64 = base64Candidates.map((item) => trimText(item)).find(Boolean);
  if (base64) return { base64 };
  return null;
}

async function resolveAudioBuffer(source: { url?: string; base64?: string }): Promise<{ buffer: Buffer; sourceUrl: string }> {
  const base64 = trimText(source.base64);
  if (base64) {
    return {
      buffer: Buffer.from(base64.replace(/^data:[^;]+;base64,/i, ""), "base64"),
      sourceUrl: "",
    };
  }

  const url = trimText(source.url);
  if (!url) {
    throw new Error("语音设计模型未返回可用音频");
  }
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 120000,
  });
  return {
    buffer: Buffer.from(response.data),
    sourceUrl: url,
  };
}

export async function synthesizeVoiceDesignBuffer(options: {
  userId: number;
  promptText: string;
  previewText: string;
  preferredName?: string;
  format?: string;
  config?: VoiceDesignConfig | null;
}): Promise<VoiceDesignAudioResult> {
  const config = options.config ?? (await getStoryVoiceDesignConfig(options.userId));
  if (!config || !hasUsableVoiceDesignConfig(config)) {
    throw new Error("请先在设置里配置语音设计模型");
  }

  const strategy = resolveVoiceDesignStrategy(config);
  const endpoint = normalizeVoiceDesignEndpoint(config.baseURL);
  const promptText = trimText(options.promptText);
  const previewText = trimText(options.previewText);
  if (!promptText) {
    throw new Error("语音设计提示词不能为空");
  }
  if (!previewText) {
    throw new Error("语音设计试听文本不能为空");
  }

  const preferredName = slugifyPreferredName(options.preferredName, "story_voice");
  const payload =
    strategy.kind === "qwen_voice_design"
      ? {
          model: strategy.requestModel,
          input: {
            action: strategy.action,
            target_model: strategy.targetModel,
            voice_prompt: promptText,
            preview_text: previewText,
            preferred_name: preferredName,
            language: "zh",
          },
          parameters: {
            sample_rate: 24000,
            response_format: trimText(options.format) || "wav",
          },
        }
      : {
          model: strategy.requestModel,
          input: {
            action: strategy.action,
            target_model: strategy.targetModel,
            voice_prompt: promptText,
            preview_text: previewText,
            prefix: preferredName,
          },
          parameters: {
            sample_rate: 24000,
            response_format: trimText(options.format) || "wav",
          },
        };

  const response = await axios.post(endpoint, payload, {
    headers: {
      Authorization: `Bearer ${trimText(config.apiKey)}`,
      "Content-Type": "application/json",
    },
    timeout: 120000,
    responseType: "arraybuffer",
  });

  const responseBuffer = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);
  const contentType = trimText(String(response.headers["content-type"] || "")).toLowerCase();
  if (contentType.startsWith("audio/") || contentType === "application/octet-stream") {
    return {
      buffer: responseBuffer,
      sourceUrl: "",
      requestModel: strategy.requestModel,
      targetModel: strategy.targetModel,
      responseData: null,
    };
  }

  const responseData = parseJsonResponse(responseBuffer);
  const source = extractAudioSource(responseData);
  if (!source) {
    throw new Error("语音设计模型未返回可用音频");
  }
  const resolved = await resolveAudioBuffer(source);
  return {
    buffer: resolved.buffer,
    sourceUrl: resolved.sourceUrl,
    requestModel: strategy.requestModel,
    targetModel: strategy.targetModel,
    responseData,
  };
}
