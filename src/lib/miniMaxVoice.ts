import axios from "axios";

const MINIMAX_TTS_BASE_URL = "https://api.minimaxi.com";
const MINIMAX_VOICE_DESIGN_URL = `${MINIMAX_TTS_BASE_URL}/v1/voice_design`;
const MINIMAX_VOICE_CLONE_URL = `${MINIMAX_TTS_BASE_URL}/v1/voice_clone`;
const MINIMAX_TTS_URL = `${MINIMAX_TTS_BASE_URL}/v1/t2a_v2`;

export interface MiniMaxTtsOptions {
  apiKey: string;
  model?: string;
  text: string;
  voiceId?: string;
  speed?: number;
  vol?: number;
  pitch?: number;
  emotion?: string;
  outputFormat?: "hex" | "url";
  stream?: boolean;
  sampleRate?: number;
  bitrate?: number;
  format?: string;
  channel?: number;
}

export interface MiniMaxTtsResult {
  buffer: Buffer;
  extraInfo?: {
    audioLength: number;
    audioSampleRate: number;
    audioSize: number;
    bitrate: number;
    wordCount: number;
    usageCharacters: number;
    audioFormat: string;
    audioChannel: number;
  };
  traceId?: string;
}

export interface MiniMaxVoiceDesignOptions {
  apiKey: string;
  prompt: string;
  previewText: string;
  voiceId?: string;
  aigcWatermark?: boolean;
}

export interface MiniMaxVoiceDesignResult {
  voiceId: string;
  buffer: Buffer;
  responseData: Record<string, any>;
}

export interface MiniMaxVoiceCloneOptions {
  apiKey: string;
  fileId: number;
  voiceId: string;
  clonePrompt?: {
    promptAudio: number;
    promptText: string;
  };
  text?: string;
  model?: string;
  needNoiseReduction?: boolean;
  needVolumeNormalization?: boolean;
  aigcWatermark?: boolean;
}

export interface MiniMaxVoiceCloneResult {
  voiceId: string;
  demoAudio?: string;
  extraInfo?: {
    audioLength: number;
    audioSampleRate: number;
    audioSize: number;
    bitrate: number;
    wordCount: number;
    usageCharacters: number;
  };
}

function getHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

/**
 * MiniMax TTS 语音合成
 */
export async function synthesizeMiniMaxTtsBuffer(options: MiniMaxTtsOptions): Promise<MiniMaxTtsResult> {
  const {
    apiKey,
    model = "speech-02-hd",
    text,
    voiceId,
    speed = 1.0,
    vol = 1.0,
    pitch = 0,
    emotion,
    outputFormat = "hex",
    stream = false,
    sampleRate = 32000,
    bitrate = 128000,
    format = "mp3",
    channel = 1,
  } = options;

  const payload: Record<string, any> = {
    model,
    text,
    stream,
    voice_setting: {
      voice_id: voiceId || "male-qn-qingse-test",
      speed,
      vol,
      pitch,
    },
    audio_setting: {
      sample_rate: sampleRate,
      bitrate,
      format,
      channel,
    },
  };

  if (emotion) {
    payload.voice_setting.emotion = emotion;
  }

  if (!stream) {
    payload.output_format = outputFormat;
  }

  const response = await axios.post(MINIMAX_TTS_URL, payload, {
    headers: getHeaders(apiKey),
    timeout: 120000,
    responseType: stream ? "stream" : "json",
  });

  if (stream) {
    // 流式返回需要特殊处理
    const chunks: Buffer[] = [];
    const streamResponse = response as unknown as AsyncIterable<Buffer>;
    for await (const chunk of streamResponse) {
      chunks.push(Buffer.from(chunk));
    }
    return { buffer: Buffer.concat(chunks) };
  }

  const data = response.data;

  // 检查错误
  const statusCode = data?.base_resp?.status_code;
  if (statusCode !== 0) {
    throw new Error(`MiniMax TTS 错误: ${data?.base_resp?.status_msg || statusCode}`);
  }

  let buffer: Buffer;
  let extraInfo: MiniMaxTtsResult["extraInfo"];

  if (data?.data?.audio) {
    // hex 编码的音频
    buffer = Buffer.from(data.data.audio, "hex");
  } else if (data?.data?.audio_url) {
    // URL 格式，需要下载
    const audioResponse = await axios.get(data.data.audio_url, {
      responseType: "arraybuffer",
      timeout: 60000,
    });
    buffer = Buffer.from(audioResponse.data);
  } else {
    throw new Error("MiniMax TTS 未返回有效音频");
  }

  if (data?.extra_info) {
    extraInfo = {
      audioLength: data.extra_info.audio_length,
      audioSampleRate: data.extra_info.audio_sample_rate,
      audioSize: data.extra_info.audio_size,
      bitrate: data.extra_info.bitrate,
      wordCount: data.extra_info.word_count,
      usageCharacters: data.extra_info.usage_characters,
      audioFormat: data.extra_info.audio_format,
      audioChannel: data.extra_info.audio_channel,
    };
  }

  return {
    buffer,
    extraInfo,
    traceId: data?.trace_id,
  };
}

/**
 * MiniMax 语音设计 - 通过文本描述生成音色
 */
export async function synthesizeMiniMaxVoiceDesignBuffer(options: MiniMaxVoiceDesignOptions): Promise<MiniMaxVoiceDesignResult> {
  const {
    apiKey,
    prompt,
    previewText,
    voiceId,
    aigcWatermark = false,
  } = options;

  const payload: Record<string, any> = {
    prompt,
    preview_text: previewText,
    aigc_watermark: aigcWatermark,
  };

  if (voiceId) {
    payload.voice_id = voiceId;
  }

  const response = await axios.post(MINIMAX_VOICE_DESIGN_URL, payload, {
    headers: getHeaders(apiKey),
    timeout: 120000,
  });

  const data = response.data;

  // 检查错误
  const statusCode = data?.base_resp?.status_code;
  if (statusCode !== 0) {
    throw new Error(`MiniMax 语音设计错误: ${data?.base_resp?.status_msg || statusCode}`);
  }

  if (!data?.trial_audio) {
    throw new Error("MiniMax 语音设计未返回有效音频");
  }

  const buffer = Buffer.from(data.trial_audio, "hex");

  return {
    voiceId: data.voice_id,
    buffer,
    responseData: data,
  };
}

/**
 * MiniMax 语音克隆 - 通过参考音频克隆音色
 */
export async function cloneMiniMaxVoice(options: MiniMaxVoiceCloneOptions): Promise<MiniMaxVoiceCloneResult> {
  const {
    apiKey,
    fileId,
    voiceId,
    clonePrompt,
    text,
    model,
    needNoiseReduction = false,
    needVolumeNormalization = false,
    aigcWatermark = false,
  } = options;

  const payload: Record<string, any> = {
    file_id: fileId,
    voice_id: voiceId,
    need_noise_reduction: needNoiseReduction,
    need_volume_normalization: needVolumeNormalization,
    aigc_watermark: aigcWatermark,
  };

  if (clonePrompt) {
    payload.clone_prompt = {
      prompt_audio: clonePrompt.promptAudio,
      prompt_text: clonePrompt.promptText,
    };
  }

  if (text && model) {
    payload.text = text;
    payload.model = model;
  }

  const response = await axios.post(MINIMAX_VOICE_CLONE_URL, payload, {
    headers: getHeaders(apiKey),
    timeout: 120000,
  });

  const data = response.data;

  // 检查错误
  const statusCode = data?.base_resp?.status_code;
  if (statusCode !== 0) {
    throw new Error(`MiniMax 语音克隆错误: ${data?.base_resp?.status_msg || statusCode}`);
  }

  const result: MiniMaxVoiceCloneResult = {
    voiceId: data.voice_id,
  };

  if (data?.demo_audio) {
    result.demoAudio = data.demo_audio;
  }

  if (data?.extra_info) {
    result.extraInfo = {
      audioLength: data.extra_info.audio_length,
      audioSampleRate: data.extra_info.audio_sample_rate,
      audioSize: data.extra_info.audio_size,
      bitrate: data.extra_info.bitrate,
      wordCount: data.extra_info.word_count,
      usageCharacters: data.extra_info.usage_characters,
    };
  }

  return result;
}

/**
 * MiniMax 音色列表
 * 官方内置音色 ID
 */
export const MINIMAX_BUILTIN_VOICES = [
  // 中文音色
  { voiceId: "Chinese_Male_Qn", name: "青年男声", language: "zh", gender: "male" },
  { voiceId: "Chinese_Female_Qn", name: "青年女声", language: "zh", gender: "female" },
  { voiceId: "Chinese_Lyrical_Voice", name: "抒情女声", language: "zh", gender: "female" },
  { voiceId: "Chinese_Storyteller", name: "讲故事", language: "zh", gender: "male" },
  { voiceId: "Chinese_News_Presenter", name: "新闻播报", language: "zh", gender: "male" },
  { voiceId: "Chinese_Beijing_Young", name: "北京少年音", language: "zh", gender: "male" },
  { voiceId: "Chinese_HK_Flight_Attendant", name: "港航空姐", language: "zh-Hant", gender: "female" },
  // 英文音色
  { voiceId: "English_American_Male", name: "美式男声", language: "en", gender: "male" },
  { voiceId: "English_American_Female", name: "美式女声", language: "en", "gender": "female" },
  { voiceId: "English_British_Male", name: "英式男声", language: "en", gender: "male" },
  { voiceId: "English_British_Female", name: "英式女声", language: "en", gender: "female" },
  // 日文音色
  { voiceId: "Japanese_Female_Young", name: "日文女声", language: "ja", gender: "female" },
  { voiceId: "Japanese_Male_Young", name: "日文男声", language: "ja", gender: "male" },
];

/**
 * 判断是否是 MiniMax 模型
 */
export function isMiniMaxModel(model: string): boolean {
  const normalized = model.toLowerCase();
  return (
    normalized.startsWith("speech-") ||
    normalized.includes("minimax") ||
    normalized === "minimax-tts"
  );
}

/**
 * 获取 MiniMax 模型的默认音色
 */
export function getMiniMaxDefaultVoice(model: string, language = "zh"): string {
  // 根据语言返回默认音色
  const langVoices: Record<string, string> = {
    zh: "Chinese_Male_Qn",
    "zh-cn": "Chinese_Male_Qn",
    "zh-hant": "Chinese_HK_Flight_Attendant",
    en: "English_American_Male",
    ja: "Japanese_Female_Young",
  };
  return langVoices[language] || langVoices.zh;
}