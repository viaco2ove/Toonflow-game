import axios from "axios";
import {DebugLogUtil} from "@/utils/debugLogUtil";

// ============================================================================
// SiliconFlow（硅基流动） 语音 API
// https://api-docs.siliconflow.cn/docs/api/audio-speech-post
// ============================================================================

const SILICONFLOW_BASE_URL = "https://api.siliconflow.cn";
const SILICONFLOW_TTS_URL = `${SILICONFLOW_BASE_URL}/v1/audio/speech`;
const SILICONFLOW_UPLOAD_VOICE_URL = `${SILICONFLOW_BASE_URL}/v1/uploads/audio/voice`;
const SILICONFLOW_VOICE_LIST_URL = `${SILICONFLOW_BASE_URL}/v1/audio/voice/list`;
const SILICONFLOW_ASR_URL = `${SILICONFLOW_BASE_URL}/v1/audio/transcriptions`;
const SILICONFLOW_ASR_MODEL = "FunAudioLLM/SenseVoiceSmall";

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
    model = "",
    text,
    voice = SILICONFLOW_DEFAULT_VOICE,
    responseFormat = "mp3",
  } = options;

  if (!apiKey) throw new Error("SiliconFlow API Key 不能为空");
  if (!text?.trim()) throw new Error("合成文本不能为空");
  if (!model?.trim()) throw new Error("SiliconFlow 模型未配置，请在语音模型设置中填写模型名称");

  const requestBody = {
    model,
    input: text.trim(),
    voice,
    response_format: responseFormat,
    stream: false,
  };
  console.log("[SiliconFlowTTS] curl -X POST '" + SILICONFLOW_TTS_URL + "' -H 'Authorization: Bearer " + apiKey.slice(0,4) + "***' -H 'Content-Type: application/json' -d '" + JSON.stringify(requestBody) + "'");

  let response;
  try {
    response = await axios.post(
      SILICONFLOW_TTS_URL,
      requestBody,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        responseType: "arraybuffer",
        timeout: 60000,
      },
    );
  } catch (err: any) {
    const errBody = err?.response?.data ? Buffer.from(err.response.data).toString("utf8") : "";
    console.error("[SiliconFlowTTS] 失败:", err?.response?.status, errBody.slice(0, 300));
    throw new Error(`SiliconFlow TTS 失败 (${err?.response?.status}): ${errBody.slice(0, 200)}`);
  }
  if (DebugLogUtil.isDebugLogEnabled()) {
    console.log("[Voice][synthesizeSiliconFlowTtsBuffer]", JSON.stringify({
      model,
      input: text.trim(),
      voice,
      response_format: responseFormat,
      stream: false,
    }));
  }
  const buffer = Buffer.from(response.data);
  if (!buffer.length) {
    throw new Error("SiliconFlow TTS 未返回音频数据");
  }

  return { buffer, format: responseFormat };
}

/**
 * 上传参考音频到 SiliconFlow（用于声音克隆）
 * POST /v1/uploads/audio/voice → 返回 uri
 * text 必须而且要准确！因此不能写死。需要先进行语音转文字！
 * 否则到了语音生成阶段，SiliconFlow 的效果是非常混乱的
 * text 为空直接不需要下一步了。直接报错吧。不然合成语音阶段也是报500 未知错误！
 */
/**
 * ASR 语音转文字（SiliconFlow SenseVoiceSmall）
 * POST /v1/audio/transcriptions → 返回转写文本
 */
export async function transcribeSiliconFlowAudio(
  apiKey: string,
  audioBuffer: Buffer,
  filename = "audio.wav",
): Promise<string> {
  if (!apiKey) throw new Error("SiliconFlow API Key 不能为空");
  if (!audioBuffer?.length) throw new Error("音频数据不能为空");

  const FormData = (await import("form-data")).default;
  const form = new FormData();
  form.append("file", audioBuffer, { filename, contentType: "audio/wav" });
  form.append("model", SILICONFLOW_ASR_MODEL);

  let response;
  try {
    response = await axios.post(SILICONFLOW_ASR_URL, form, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...form.getHeaders(),
      },
      timeout: 30000,
    });
  } catch (err: any) {
    const status = err?.response?.status ?? err?.status ?? "unknown";
    const errBody = err?.response?.data
      ? (typeof err.response.data === "string" ? err.response.data : JSON.stringify(err.response.data))
      : String(err?.message || err);
    console.error("[SiliconFlowASR] 失败:", status, errBody.slice(0, 300));
    throw new Error(`SiliconFlow ASR 失败 (${status}): ${errBody.slice(0, 200)}`);
  }

  const text = String(response.data?.text || "").trim();
  if (!text) {
    throw new Error("SiliconFlow ASR 未返回有效文本，参考音频可能无法识别");
  }
  return text;
}

/**
 * 上传参考音频到 SiliconFlow（用于声音克隆）
 * POST /v1/uploads/audio/voice → 返回 uri
 * text 由 ASR 自动转写，不需要手动填写
 */
export async function uploadSiliconFlowVoice(
  options: SiliconFlowUploadVoiceOptions,
): Promise<string> {
  const {
    apiKey,
    model = "",
    audioBuffer,
    filename = "reference.wav",
    customName,
    text: providedText = "",
  } = options;

  if (!apiKey) throw new Error("SiliconFlow API Key 不能为空");
  if (!audioBuffer?.length) throw new Error("参考音频不能为空");
  if (!customName) throw new Error("音色名称不能为空");
  if (!model?.trim()) throw new Error("SiliconFlow 克隆模型未配置，请在语音克隆设置中填写模型名称");

  // text 必须准确对应参考音频内容，由 ASR 自动转写
  let text = providedText;
  if (!text?.trim()) {
    text = await transcribeSiliconFlowAudio(apiKey, audioBuffer, filename);
  }
  if (!text?.trim()) {
    throw new Error("SiliconFlow 上传参考音频时无法转写文本，参考音频可能无法识别");
  }

  const FormData = (await import("form-data")).default;
  const form = new FormData();
  form.append("file", audioBuffer, { filename, contentType: "audio/wav" });
  form.append("model", model);
  form.append("customName", customName);
  if (text) form.append("text", text);

  if (DebugLogUtil.isDebugLogEnabled()) {
    console.log("[Voice][uploadSiliconFlowVoice]", JSON.stringify({"model": model,"customName":customName,"text":text}));
    console.log("[Voice][uploadSiliconFlowVoice][CRUL]", "curl -X POST '" + SILICONFLOW_UPLOAD_VOICE_URL + "' -H 'Authorization: Bearer " + apiKey.slice(0,4) + "***' -H 'Content-Type: multipart/form-data' --form 'file=@" + filename + "' --form 'model=" + model + "' --form 'customName=" + customName + "' --form 'text=" + text + "'");
  }

  let response;
  try {
    response = await axios.post(SILICONFLOW_UPLOAD_VOICE_URL, form, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...form.getHeaders(),
      },
      timeout: 60000,
    });
  } catch (err: any) {
    const errBody = err?.response?.data ? (typeof err.response.data === "string" ? err.response.data : JSON.stringify(err.response.data)) : "";
    console.error("[SiliconFlowUpload] 失败:", err?.response?.status, errBody.slice(0, 300));
    throw new Error(`SiliconFlow 上传失败 (${err?.response?.status}): ${errBody.slice(0, 200)}`);
  }

  if (DebugLogUtil.isDebugLogEnabled()) {
    console.log("[Voice][uploadSiliconFlowVoice]", JSON.stringify({ status: response.status, response: response.data }));
  }

  const uri = response.data?.uri;
  if (!uri) {
    throw new Error("SiliconFlow 上传参考音频未返回 uri，响应: " + JSON.stringify(response.data).slice(0, 200));
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
  uploadModel?: string;
  text: string;
  referenceAudioBuffer: Buffer;
  referenceAudioFilename?: string;
  voiceName?: string;
  responseFormat?: string;
}): Promise<SiliconFlowTtsResult> {
  const {
    apiKey,
    model = "",
    uploadModel = "",
    text,
    referenceAudioBuffer,
    referenceAudioFilename = "reference.wav",
    voiceName,
    responseFormat = "mp3",
  } = options;

  if (!model?.trim()) throw new Error("SiliconFlow TTS 模型未配置");
  const finalUploadModel = uploadModel.trim() || model;

  // 1. 上传参考音频获取 uri
  // 注意：上传时不传 text，避免 SiliconFlow 用上传时的文本替代合成文本
  const customName = voiceName || `clone_${Date.now().toString(36)}`;
  const uri = await uploadSiliconFlowVoice({
    apiKey,
    model: finalUploadModel,
    audioBuffer: referenceAudioBuffer,
    filename: referenceAudioFilename,
    customName,
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
