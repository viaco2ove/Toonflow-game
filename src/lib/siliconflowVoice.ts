import axios from "axios";

// ============================================================================
// SiliconFlow 语音 API
// https://api-docs.siliconflow.cn/docs/api/audio-speech-post
// ============================================================================

const SILICONFLOW_BASE_URL = "https://api.siliconflow.cn";
const SILICONFLOW_TTS_URL = `${SILICONFLOW_BASE_URL}/v1/audio/speech`;
const SILICONFLOW_UPLOAD_VOICE_URL = `${SILICONFLOW_BASE_URL}/v1/uploads/audio/voice`;
const SILICONFLOW_VOICE_LIST_URL = `${SILICONFLOW_BASE_URL}/v1/audio/voice/list`;

// ============================================================================
// 内置音色
// ============================================================================

export interface SiliconFlowVoicePreset {
  voiceId: string;
  name: string;
  language: string;
  gender: string;
  model: string;
}

export const SILICONFLOW_BUILTIN_VOICES: SiliconFlowVoicePreset[] = [
  // CosyVoice2 内置音色
  { voiceId: "FunAudioLLM/CosyVoice2-0.5B:alex", name: "Alex（男声）", language: "en", gender: "male", model: "FunAudioLLM/CosyVoice2-0.5B" },
  { voiceId: "FunAudioLLM/CosyVoice2-0.5B:anna", name: "Anna（女声）", language: "en", gender: "female", model: "FunAudioLLM/CosyVoice2-0.5B" },
  { voiceId: "FunAudioLLM/CosyVoice2-0.5B:bella", name: "Bella（女声）", language: "en", gender: "female", model: "FunAudioLLM/CosyVoice2-0.5B" },
  { voiceId: "FunAudioLLM/CosyVoice2-0.5B:benjamin", name: "Benjamin（男声）", language: "en", gender: "male", model: "FunAudioLLM/CosyVoice2-0.5B" },
  { voiceId: "FunAudioLLM/CosyVoice2-0.5B:charles", name: "Charles（男声）", language: "en", gender: "male", model: "FunAudioLLM/CosyVoice2-0.5B" },
  { voiceId: "FunAudioLLM/CosyVoice2-0.5B:claire", name: "Claire（女声）", language: "en", gender: "female", model: "FunAudioLLM/CosyVoice2-0.5B" },
  { voiceId: "FunAudioLLM/CosyVoice2-0.5B:david", name: "David（男声）", language: "en", gender: "male", model: "FunAudioLLM/CosyVoice2-0.5B" },
  { voiceId: "FunAudioLLM/CosyVoice2-0.5B:diana", name: "Diana（女声）", language: "en", gender: "female", model: "FunAudioLLM/CosyVoice2-0.5B" },
];

export const SILICONFLOW_DEFAULT_VOICE = "FunAudioLLM/CosyVoice2-0.5B:alex";

// ============================================================================
// 类型定义
// ============================================================================

export interface SiliconFlowTtsOptions {
  apiKey: string;
  model?: string;
  text: string;
  voice?: string;
  responseFormat?: string;
}

export interface SiliconFlowTtsResult {
  buffer: Buffer;
  format: string;
}

export interface SiliconFlowUploadVoiceOptions {
  apiKey: string;
  model?: string;
  audioBuffer: Buffer;
  filename?: string;
  customName: string;
  text?: string;
}

export interface SiliconFlowVoiceListItem {
  model: string;
  customName: string;
  text: string;
  uri: string;
}

// ============================================================================
// 核心 API
// ============================================================================

/**
 * SiliconFlow TTS 合成
 * POST /v1/audio/speech → 返回二进制音频流
 */
export async function synthesizeSiliconFlowTtsBuffer(
  options: SiliconFlowTtsOptions,
): Promise<SiliconFlowTtsResult> {
  const {
    apiKey,
    model = "FunAudioLLM/CosyVoice2-0.5B",
    text,
    voice = SILICONFLOW_DEFAULT_VOICE,
    responseFormat = "mp3",
  } = options;

  if (!apiKey) throw new Error("SiliconFlow API Key 不能为空");
  if (!text?.trim()) throw new Error("合成文本不能为空");

  const response = await axios.post(
    SILICONFLOW_TTS_URL,
    {
      model,
      input: text.trim(),
      voice,
      response_format: responseFormat,
      stream: false,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      responseType: "arraybuffer",
      timeout: 60000,
    },
  );

  const buffer = Buffer.from(response.data);
  if (!buffer.length) {
    throw new Error("SiliconFlow TTS 未返回音频数据");
  }

  return { buffer, format: responseFormat };
}

/**
 * 上传参考音频到 SiliconFlow（用于声音克隆）
 * POST /v1/uploads/audio/voice → 返回 uri
 */
export async function uploadSiliconFlowVoice(
  options: SiliconFlowUploadVoiceOptions,
): Promise<string> {
  const {
    apiKey,
    model = "IndexTeam/IndexTTS-2",
    audioBuffer,
    filename = "reference.wav",
    customName,
    text = "",
  } = options;

  if (!apiKey) throw new Error("SiliconFlow API Key 不能为空");
  if (!audioBuffer?.length) throw new Error("参考音频不能为空");
  if (!customName) throw new Error("音色名称不能为空");

  const FormData = (await import("form-data")).default;
  const form = new FormData();
  form.append("file", audioBuffer, { filename, contentType: "audio/wav" });
  form.append("model", model);
  form.append("customName", customName);
  if (text) form.append("text", text);

  const response = await axios.post(SILICONFLOW_UPLOAD_VOICE_URL, form, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...form.getHeaders(),
    },
    timeout: 60000,
  });

  const uri = response.data?.uri;
  if (!uri) {
    throw new Error("SiliconFlow 上传参考音频未返回 uri");
  }

  return uri;
}

/**
 * 获取用户已创建的克隆音色列表
 * GET /v1/audio/voice/list
 */
export async function fetchSiliconFlowVoiceList(
  apiKey: string,
): Promise<SiliconFlowVoiceListItem[]> {
  if (!apiKey) throw new Error("SiliconFlow API Key 不能为空");

  const response = await axios.get(SILICONFLOW_VOICE_LIST_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 15000,
  });

  return Array.isArray(response.data?.results) ? response.data.results : [];
}

/**
 * SiliconFlow 声音克隆合成（上传参考音频 + 用 uri 合成）
 */
export async function synthesizeSiliconFlowCloneBuffer(options: {
  apiKey: string;
  model?: string;
  text: string;
  referenceAudioBuffer: Buffer;
  referenceAudioFilename?: string;
  referenceText?: string;
  voiceName?: string;
  responseFormat?: string;
}): Promise<SiliconFlowTtsResult> {
  const {
    apiKey,
    model = "FunAudioLLM/CosyVoice2-0.5B",
    text,
    referenceAudioBuffer,
    referenceAudioFilename = "reference.wav",
    referenceText = "",
    voiceName,
    responseFormat = "mp3",
  } = options;

  // 1. 上传参考音频获取 uri
  const customName = voiceName || `clone_${Date.now().toString(36)}`;
  const uri = await uploadSiliconFlowVoice({
    apiKey,
    model: "IndexTeam/IndexTTS-2",
    audioBuffer: referenceAudioBuffer,
    filename: referenceAudioFilename,
    customName,
    text: referenceText,
  });

  // 2. 用 uri 合成
  return synthesizeSiliconFlowTtsBuffer({
    apiKey,
    model,
    text,
    voice: uri,
    responseFormat,
  });
}

/**
 * 检测是否为 SiliconFlow 厂商
 */
export function isSiliconFlowManufacturer(manufacturer?: string | null): boolean {
  return String(manufacturer || "").trim().toLowerCase() === "siliconflow";
}
