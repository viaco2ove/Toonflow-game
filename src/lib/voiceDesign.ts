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

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

function buildCosyVoicePrefix(seed: string, maxLength: number): string {
  const normalized = trimText(seed).toLowerCase().replace(/[^a-z0-9]+/g, "");
  const fallback = "voice";
  const raw = normalized || fallback;
  if (raw.length <= maxLength) return raw;
  const hash = sha1(raw).slice(0, 6);
  const headLength = Math.max(1, maxLength - hash.length);
  return `${raw.slice(0, headLength)}${hash}`.slice(0, maxLength);
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

export async function getStoryVoiceCloneConfig(userId: number): Promise<VoiceDesignConfig | null> {
  const config = await u.getPromptAi("storyVoiceCloneModel", userId);
  if (!config || typeof config !== "object") return null;
  const c = config as VoiceDesignConfig;
  if (!trimText(c.apiKey) || !trimText(c.model)) return null;
  return {
    model: trimText(c.model),
    apiKey: trimText(c.apiKey),
    baseURL: trimText(c.baseURL),
    manufacturer: trimText(c.manufacturer),
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
  const raw = trimText(input);
  // voiceId 格式如 qwen-tts-vd-story_pro_ffbcf6-voice-20260528150309825-a836
  // 阿里 preferred_name 只支持最多 16 字符，直接截取时间戳部分
  const tsMatch = raw.match(/(\d{14})$/);
  if (tsMatch) {
    return `qwen${tsMatch[1]}`.slice(0, MAX_VOICE_DESIGN_NAME_LENGTH);
  }
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const resolved = normalized || fallback;
  // MiniMax voice_id 要求：长度 8-256，首字符为字母，末字符不能是 - 或 _
  if (resolved.length < 8) {
    // 补足最小长度并加时间戳后缀确保唯一性
    const suffix = Date.now().toString(36).slice(-4);
    const padded = `${resolved}_${suffix}`;
    return padded.slice(0, 20);
  }
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
    }
  | {
      kind: "minimax_voice_design";
      requestModel: "voice_design";
      targetModel: string;
      action: "create";
    }
  | {
      kind: "xiaomimimo_voice_design";
      requestModel: string;
      targetModel: string;
      action: "create";
    };

function resolveVoiceDesignStrategy(config: VoiceDesignConfig): VoiceDesignStrategy {
  const rawModel = trimText(config.model);
  const normalizedModel = rawModel.toLowerCase();
  console.log("[voiceDesign] resolveVoiceDesignStrategy", {
    rawModel,
    normalizedModel,
    manufacturer: trimText(config.manufacturer),
  });
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

  if (
    normalizedModel === "voice-design"
    || normalizedModel === "minimax-voice-design"
    || config.manufacturer === "minimax"
  ) {
    return {
      kind: "minimax_voice_design",
      requestModel: "voice_design",
      targetModel: "minimax-tts",
      action: "create",
    };
  }

  if (
    normalizedModel === "mimo-v2.5-tts-voicedesign"
    || config.manufacturer === "xiaomimimo"
  ) {
    return {
      kind: "xiaomimimo_voice_design",
      requestModel: rawModel || "mimo-v2.5-tts-voicedesign",
      targetModel: rawModel || "mimo-v2.5-tts-voicedesign",
      action: "create",
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
    data?.choices?.[0]?.message?.audio?.data,
    data?.choices?.[0]?.message?.audio?.base64,
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

  console.log("[voiceDesign] synthesizeVoiceDesignBuffer", {
    userId: options.userId,
    configFromOption: Boolean(options.config),
    config: {
      model: trimText(config.model),
      manufacturer: trimText(config.manufacturer),
      baseURL: trimText(config.baseURL),
      hasApiKey: Boolean(config.apiKey),
    },
    promptText: options.promptText?.slice(0, 50),
    previewText: options.previewText?.slice(0, 50),
  });

  const strategy = resolveVoiceDesignStrategy(config);
  const endpoint = normalizeVoiceDesignEndpoint(config.baseURL);
  console.log("[voiceDesign] strategy resolved", {
    kind: strategy.kind,
    requestModel: strategy.requestModel,
    targetModel: strategy.targetModel,
    endpoint,
  });
  const promptText = trimText(options.promptText);
  const previewText = trimText(options.previewText);
  if (!promptText) {
    throw new Error("语音设计提示词不能为空");
  }
  if (!previewText) {
    throw new Error("语音设计试听文本不能为空");
  }

  const preferredName = slugifyPreferredName(options.preferredName, "story_voice");

  const doRequest = async (name: string) => {
    if (strategy.kind === "minimax_voice_design") {
      // MiniMax 语音设计 API
      const minimaxEndpoint = `${trimText(config.baseURL) || "https://api.minimaxi.com"}/v1/voice_design`;
      const p = {
        prompt: promptText,
        preview_text: previewText,
        voice_id: name,
        aigc_watermark: false,
      };
      return axios.post(minimaxEndpoint, p, {
        headers: {
          Authorization: `Bearer ${trimText(config.apiKey)}`,
          "Content-Type": "application/json",
        },
        timeout: 120000,
        responseType: "arraybuffer",
      });
    }
    if (strategy.kind === "xiaomimimo_voice_design") {
      const endpoint = `${trimText(config.baseURL).replace(/\/+$/, "") || "https://api.xiaomimimo.com"}/v1/chat/completions`;
      const p = {
        model: strategy.requestModel,
        messages: [
          { role: "user", content: promptText },
          { role: "assistant", content: previewText },
        ],
        audio: {
          format: trimText(options.format) || "wav",
          optimize_text_preview: true,
        },
      };
      return axios.post(endpoint, p, {
        headers: {
          "api-key": trimText(config.apiKey),
          "Content-Type": "application/json",
        },
        timeout: 120000,
        responseType: "arraybuffer",
      });
    }
    const p = strategy.kind === "qwen_voice_design"
      ? {
          model: strategy.requestModel,
          input: {
            action: strategy.action,
            target_model: strategy.targetModel,
            voice_prompt: promptText,
            preview_text: previewText,
            preferred_name: name,
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
            prefix: buildCosyVoicePrefix(preferredName, 10), // CosyVoice prefix 限制 10 字符
          },
          parameters: {
            sample_rate: 24000,
            response_format: trimText(options.format) || "wav",
          },
        };
    return axios.post(endpoint, p, {
      headers: {
        Authorization: `Bearer ${trimText(config.apiKey)}`,
        "Content-Type": "application/json",
      },
      timeout: 120000,
      responseType: "arraybuffer",
    });
  };

  const invalidName = (err: unknown) => {
    const a = err as any;
    const rawBody = a?.response?.data;
    // response.data 可能是 Buffer，需要先转成字符串
    let bodyStr = "";
    if (Buffer.isBuffer(rawBody)) {
      bodyStr = rawBody.toString("utf8");
    } else if (typeof rawBody === "string") {
      bodyStr = rawBody;
    } else if (typeof rawBody === "object") {
      bodyStr = JSON.stringify(rawBody);
    }
    if (!bodyStr) return false;
    // 检查是否包含 preferred_name 相关错误（阿里云）
    if (bodyStr.includes("preferred_name")) return true;
    // 检查是否包含 voice_id duplicate 错误（MiniMax）
    if (rawBody && typeof rawBody === "object" && rawBody?.base_resp?.status_msg?.includes("duplicate")) return true;
    // 解析 JSON 检查 message
    try {
      const parsed = JSON.parse(bodyStr);
      const msg = parsed?.message || parsed?.error?.message || parsed?.base_resp?.status_msg || "";
      return msg.includes("InvalidParameter") || msg.includes("invalid") || msg.includes("duplicate");
    } catch {
      return false;
    }
  };

  let response: any;
  try {
    response = await doRequest(preferredName);
  } catch (err) {
    if (invalidName(err)) {
      // name 已被占用或无效，追加时间戳重新生成
      // MiniMax voice_id 要求：长度 8-256，首字符为字母，末字符不能是 - 或 _
      const fallbackName = `sv_${Date.now().toString(36)}`.slice(0, 20);
      response = await doRequest(fallbackName);
    } else {
      throw err;
    }
  }

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

  // MiniMax 返回 JSON 格式，需要特殊处理
  if (strategy.kind === "minimax_voice_design") {
    const responseData = parseJsonResponse(responseBuffer);
    const statusCode = responseData?.base_resp?.status_code;
    if (statusCode !== 0) {
      // MiniMax 返回错误（如 voice_id duplicate），尝试用新 name 重试
      const errMsg = String(responseData?.base_resp?.status_msg || "");
      if (errMsg.includes("duplicate")) {
        console.log("[voiceDesign] MiniMax voice_id duplicate，尝试重试", {
          preferredName,
          statusMsg: errMsg,
        });
        const fallbackName = `sv_${Date.now().toString(36)}`.slice(0, 20);
        const retryResponse = await doRequest(fallbackName);
        const retryBuffer = Buffer.isBuffer(retryResponse.data) ? retryResponse.data : Buffer.from(retryResponse.data);
        const retryData = parseJsonResponse(retryBuffer);
        const retryStatus = retryData?.base_resp?.status_code;
        if (retryStatus !== 0) {
          throw new Error(`MiniMax 语音设计重试失败: ${retryData?.base_resp?.status_msg || retryStatus}`);
        }
        if (!retryData?.trial_audio) {
          throw new Error("MiniMax 语音设计未返回有效音频");
        }
        // 重试成功，继续用这个 voice_id 做 TTS 合成
        const { synthesizeMiniMaxTtsBuffer } = await import("@/lib/miniMaxVoice");
        const minimaxVoiceId = String(retryData?.voice_id || fallbackName).trim();
        const ttsResult = await synthesizeMiniMaxTtsBuffer({
          apiKey: trimText(config.apiKey),
          model: "speech-02-hd",
          text: options.previewText,
          voiceId: minimaxVoiceId,
          speed: 1.0,
          outputFormat: "hex",
          sampleRate: 24000,
        });
        return {
          buffer: ttsResult.buffer,
          sourceUrl: "",
          requestModel: strategy.requestModel,
          targetModel: strategy.targetModel,
          responseData: retryData,
        };
      }
      throw new Error(`MiniMax 语音设计错误: ${errMsg || statusCode}`);
    }
    if (!responseData?.trial_audio) {
      throw new Error("MiniMax 语音设计未返回有效音频");
    }

    // MiniMax voice_design 完成创建 voice_id 后，需要用这个 voice_id 做 TTS 合成
    // 生成一个固定文本的音频才是真正可用于克隆的参考音频
    const { synthesizeMiniMaxTtsBuffer } = await import("@/lib/miniMaxVoice");
    const minimaxVoiceId = String(responseData?.voice_id || preferredName).trim();
    const ttsResult = await synthesizeMiniMaxTtsBuffer({
      apiKey: trimText(config.apiKey),
      model: "speech-02-hd",
      text: options.previewText,
      voiceId: minimaxVoiceId,
      speed: 1.0,
      outputFormat: "hex",
      sampleRate: 24000,
    });
    return {
      buffer: ttsResult.buffer,
      sourceUrl: "",
      requestModel: strategy.requestModel,
      targetModel: strategy.targetModel,
      responseData,
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
