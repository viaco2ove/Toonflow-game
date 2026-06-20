import axios from "axios";
import { createHash } from "node:crypto";

function trimText(input: unknown): string {
  return String(input || "").trim();
}

function normalizeBaseUrl(input?: string | null): string {
  const raw = trimText(input) || "https://api.xiaomimimo.com";
  return raw.replace(/\/+$/, "");
}

function normalizeMime(filenameOrMime?: string | null): string {
  const raw = trimText(filenameOrMime).toLowerCase();
  if (raw.includes("wav") || raw.endsWith(".wav")) return "audio/wav";
  return "audio/mpeg";
}

function parseAudioData(data: unknown): Buffer {
  const raw = trimText(data);
  if (!raw) throw new Error("xiaomimimo 未返回音频数据");
  const base64 = raw.includes(",") ? raw.split(",").pop() || "" : raw;
  return Buffer.from(base64, "base64");
}

async function postChatCompletions(options: {
  apiKey: string;
  baseUrl?: string | null;
  payload: Record<string, unknown>;
}) {
  const apiKey = trimText(options.apiKey);
  if (!apiKey) throw new Error("xiaomimimo 缺少 API Key");
  const response = await axios.post(`${normalizeBaseUrl(options.baseUrl)}/v1/chat/completions`, options.payload, {
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
    },
    timeout: 120000,
  });
  return response.data || {};
}

function extractAudioBuffer(data: any): { buffer: Buffer; transcript?: string } {
  const message = data?.choices?.[0]?.message || {};
  const audio = message.audio || {};
  return {
    buffer: parseAudioData(audio.data),
    transcript: trimText(audio.transcript || message.final_text_preview || "") || undefined,
  };
}

export async function synthesizeXiaomiMimoTtsBuffer(options: {
  apiKey: string;
  baseUrl?: string | null;
  model?: string | null;
  text: string;
  voice?: string | null;
  prompt?: string | null;
  format?: "wav" | "mp3" | string;
}): Promise<{ buffer: Buffer; model: string; voice?: string }> {
  const model = trimText(options.model) || "mimo-v2.5-tts";
  const text = trimText(options.text);
  if (!text) throw new Error("xiaomimimo TTS 文本不能为空");
  const format = trimText(options.format) || "wav";
  const messages: any[] = [];
  if (trimText(options.prompt)) messages.push({ role: "user", content: trimText(options.prompt) });
  messages.push({ role: "assistant", content: text });
  const payload: Record<string, unknown> = {
    model,
    messages,
    audio: {
      format,
      voice: trimText(options.voice) || "mimo_default",
    },
  };
  const data = await postChatCompletions({ apiKey: options.apiKey, baseUrl: options.baseUrl, payload });
  const { buffer } = extractAudioBuffer(data);
  return { buffer, model, voice: trimText(options.voice) || "mimo_default" };
}

export async function synthesizeXiaomiMimoVoiceDesignBuffer(options: {
  apiKey: string;
  baseUrl?: string | null;
  model?: string | null;
  promptText: string;
  text: string;
  format?: "wav" | "mp3" | string;
}): Promise<{ buffer: Buffer; requestModel: string; targetModel: string }> {
  const model = trimText(options.model) || "mimo-v2.5-tts-voicedesign";
  const promptText = trimText(options.promptText);
  const text = trimText(options.text);
  if (!promptText) throw new Error("xiaomimimo 音色设计提示词不能为空");
  if (!text) throw new Error("xiaomimimo TTS 文本不能为空");
  const data = await postChatCompletions({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    payload: {
      model,
      messages: [
        { role: "user", content: promptText },
        { role: "assistant", content: text },
      ],
      audio: {
        format: trimText(options.format) || "wav",
        optimize_text_preview: true,
      },
    },
  });
  const { buffer } = extractAudioBuffer(data);
  return { buffer, requestModel: model, targetModel: model };
}

export async function synthesizeXiaomiMimoVoiceCloneBuffer(options: {
  apiKey: string;
  baseUrl?: string | null;
  model?: string | null;
  text: string;
  referenceAudioBuffer: Buffer;
  referenceAudioMime?: string | null;
  format?: "wav" | "mp3" | string;
}): Promise<{ buffer: Buffer; model: string }> {
  const model = trimText(options.model) || "mimo-v2.5-tts-voiceclone";
  const text = trimText(options.text);
  if (!text) throw new Error("xiaomimimo TTS 文本不能为空");
  if (!options.referenceAudioBuffer?.length) throw new Error("xiaomimimo 克隆需要参考音频");
  const format = trimText(options.format) || "wav";

  // 缓存键：以参考音频 hash + 模型 + 文本 + 格式 唯一标识一次合成
  // xiaomimimo voiceclone API 是无状态的，每次合成都要带完整参考音频，单次 17+ 秒且容易触发 429。
  // 同一段台词 + 同一参考音频在 5 分钟内复用上次合成结果，避免重复 API 调用。
  const refHash = createHash("sha1").update(options.referenceAudioBuffer).digest("hex").slice(0, 16);
  const cacheKey = `${model}|${refHash}|${format}|${text}`;
  const cached = XIAOMI_CLONE_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    console.log("[xiaomimimo clone] cache hit", { model, refHash, textLength: text.length, bufferBytes: cached.buffer.length });
    return { buffer: cached.buffer, model };
  }

  // inflight 去重：同一缓存键的并发请求复用同一个 Promise，避免前端 retry 时多次打 API
  const inflight = XIAOMI_CLONE_INFLIGHT.get(cacheKey);
  if (inflight) {
    console.log("[xiaomimimo clone] inflight hit, await existing request", { model, refHash, textLength: text.length });
    return inflight;
  }

  const voiceData = `data:${normalizeMime(options.referenceAudioMime)};base64,${options.referenceAudioBuffer.toString("base64")}`;
  const task = (async () => {
    const data = await postChatCompletions({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      payload: {
        model,
        messages: [
          { role: "user", content: "" },
          { role: "assistant", content: text },
        ],
        audio: {
          format,
          voice: voiceData,
        },
      },
    });
    const { buffer } = extractAudioBuffer(data);
    XIAOMI_CLONE_CACHE.set(cacheKey, { buffer, expiresAt: Date.now() + XIAOMI_CLONE_CACHE_TTL_MS });
    return { buffer, model };
  })();
  XIAOMI_CLONE_INFLIGHT.set(cacheKey, task);
  try {
    return await task;
  } finally {
    XIAOMI_CLONE_INFLIGHT.delete(cacheKey);
  }
}

// xiaomimimo voiceclone 合成结果缓存（5 分钟）+ 并发去重
const XIAOMI_CLONE_CACHE_TTL_MS = 5 * 60 * 1000;
const XIAOMI_CLONE_CACHE = new Map<string, { buffer: Buffer; expiresAt: number }>();
const XIAOMI_CLONE_INFLIGHT = new Map<string, Promise<{ buffer: Buffer; model: string }>>();

export async function transcribeXiaomiMimoAudio(options: {
  apiKey: string;
  baseUrl?: string | null;
  model?: string | null;
  audioBuffer: Buffer;
  mime?: string | null;
  language?: string | null;
}): Promise<string> {
  const model = trimText(options.model) || "mimo-v2.5-asr";
  const dataUrl = `data:${normalizeMime(options.mime)};base64,${options.audioBuffer.toString("base64")}`;
  const data = await postChatCompletions({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    payload: {
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "input_audio", input_audio: { data: dataUrl } },
          ],
        },
      ],
      asr_options: { language: trimText(options.language) || "zh" },
    },
  });
  return trimText(data?.choices?.[0]?.message?.content);
}
