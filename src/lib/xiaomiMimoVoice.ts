import axios from "axios";

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
  const voiceData = `data:${normalizeMime(options.referenceAudioMime)};base64,${options.referenceAudioBuffer.toString("base64")}`;
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
        format: trimText(options.format) || "wav",
        voice: voiceData,
      },
    },
  });
  const { buffer } = extractAudioBuffer(data);
  return { buffer, model };
}

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
