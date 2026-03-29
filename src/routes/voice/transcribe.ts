import express from "express";
import axios from "axios";
import FormData from "form-data";
import path from "node:path";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import { isDirectAliyunManufacturer, normalizeAliyunDirectAsrModel, voiceSupplierFromManufacturer } from "@/lib/voiceGateway";

const router = express.Router();

function normalizeBaseUrl(input: string | null | undefined): string {
  const base = String(input || "").trim();
  return (base || "http://127.0.0.1:8000").replace(/\/+$/, "");
}

function normalizeAliyunCompatibleBaseUrl(input: string | null | undefined): string {
  const base = normalizeBaseUrl(input);
  if (/\/compatible-mode$/i.test(base)) {
    return base;
  }
  return `${base}/compatible-mode`;
}

function isAliyunCompatibleChatAsrModel(input: string | null | undefined): boolean {
  const model = String(input || "").trim().toLowerCase();
  return model.startsWith("qwen3-asr");
}

function parseBase64Audio(input: string): { buffer: Buffer; mime: string; ext: string } {
  const match = input.match(/^data:([^;]+);base64,(.+)$/);
  let base64 = input;
  let mime = "audio/wav";
  if (match) {
    mime = String(match[1] || "audio/wav").trim();
    base64 = String(match[2] || "");
  }

  const extMap: Record<string, string> = {
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/ogg": "ogg",
    "audio/webm": "webm",
    "audio/mp4": "mp4",
    "audio/aac": "aac",
  };

  return {
    buffer: Buffer.from(base64, "base64"),
    mime,
    ext: extMap[mime] || "wav",
  };
}

function parseAudioFromPath(filePath: string, buffer: Buffer): { buffer: Buffer; mime: string; ext: string } {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase() || "wav";
  const mimeMap: Record<string, string> = {
    wav: "audio/wav",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    webm: "audio/webm",
    mp4: "audio/mp4",
    aac: "audio/aac",
  };

  return {
    buffer,
    mime: mimeMap[ext] || "audio/wav",
    ext,
  };
}

async function getVoiceConfig(userId: number, configId?: number | null, preferredModelType?: "tts" | "asr") {
  if (configId) {
    return u.db("t_config").where({ id: configId, type: "voice", userId }).first();
  }
  if (preferredModelType === "asr") {
    const setting = await u.db("t_setting").where({ userId }).select("languageModel").first();
    let storyAsrConfigId = 0;
    try {
      const parsed = JSON.parse(String(setting?.languageModel || "{}"));
      storyAsrConfigId = Number((parsed as Record<string, any>)?.storyAsrModel || 0);
    } catch {
      storyAsrConfigId = 0;
    }
    if (storyAsrConfigId > 0) {
      const selected = await u.db("t_config").where({ id: storyAsrConfigId, type: "voice", userId }).first();
      return selected || null;
    }
  }
  const preferred = preferredModelType
    ? await u.db("t_config").where({ type: "voice", userId, modelType: preferredModelType }).orderBy("id", "desc").first()
    : null;
  if (preferred) return preferred;
  return u.db("t_config").where({ type: "voice", userId }).orderBy("id", "desc").first();
}

function extractChoiceContentText(input: any): string {
  if (typeof input === "string") {
    return input.trim();
  }
  if (Array.isArray(input)) {
    return input
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item?.text === "string") return item.text;
        if (typeof item?.content === "string") return item.content;
        if (typeof item?.output_text === "string") return item.output_text;
        return "";
      })
      .join("")
      .trim();
  }
  if (typeof input === "object" && input) {
    if (typeof input.text === "string") return input.text.trim();
    if (typeof input.content === "string") return input.content.trim();
  }
  return "";
}

function parseTranscribeResult(data: any): { text: string; segments: any[]; confidence: number | null } {
  let text =
    (typeof data?.text === "string" ? data.text : "") ||
    (typeof data?.transcript === "string" ? data.transcript : "") ||
    (typeof data?.result?.text === "string" ? data.result.text : "") ||
    (typeof data?.data?.text === "string" ? data.data.text : "") ||
    (typeof data?.output?.text === "string" ? data.output.text : "") ||
    extractChoiceContentText(data?.choices?.[0]?.message?.content) ||
    "";

  const segmentsRaw = data?.segments ?? data?.result?.segments ?? data?.data?.segments ?? data?.output?.segments ?? [];
  const segments = Array.isArray(segmentsRaw) ? segmentsRaw : [];

  if (!text && segments.length) {
    text = segments
      .map((item: any) => String(item?.text || item?.content || ""))
      .join("")
      .trim();
  }

  const confidenceCandidates = [
    data?.confidence,
    data?.result?.confidence,
    data?.data?.confidence,
    data?.output?.confidence,
  ];

  let confidence: number | null = null;
  for (const value of confidenceCandidates) {
    const num = Number(value);
    if (Number.isFinite(num)) {
      confidence = num;
      break;
    }
  }

  return {
    text: text.trim(),
    segments,
    confidence,
  };
}

export default router.post(
  "/",
  validateFields({
    configId: z.number().optional().nullable(),
    audioBase64: z.string().optional().nullable(),
    audioPath: z.string().optional().nullable(),
    lang: z.string().optional().nullable(),
    sessionId: z.string().optional().nullable(),
    prompt: z.string().optional().nullable(),
    temperature: z.number().optional().nullable(),
    model: z.string().optional().nullable(),
    withSegments: z.boolean().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const { configId, audioBase64, audioPath, lang, sessionId, prompt, temperature, model, withSegments } = req.body;

      if (!audioBase64 && !audioPath) {
        return res.status(400).send(error("audioBase64 或 audioPath 至少提供一个"));
      }

      const userId = Number((req as any)?.user?.id || 0);
      const config = await getVoiceConfig(userId, configId, "asr");
      if (!config) {
        return res.status(400).send(error("语音模型配置不存在"));
      }

      const baseUrl = normalizeBaseUrl(config.baseUrl);
      const manufacturer = String(config.manufacturer || "").trim();
      const suppliers = voiceSupplierFromManufacturer(manufacturer);
      const directAliyun = isDirectAliyunManufacturer(manufacturer);
      const modelName = directAliyun
        ? normalizeAliyunDirectAsrModel(String(model || config.model || "").trim())
        : String(model || config.model || "").trim();
      const headers: Record<string, string> = {};
      if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
      }

      let audio: { buffer: Buffer; mime: string; ext: string };
      if (audioBase64) {
        audio = parseBase64Audio(String(audioBase64));
      } else {
        const filePath = String(audioPath || "");
        const fileBuffer = await u.oss.getFile(filePath);
        audio = parseAudioFromPath(filePath, fileBuffer);
      }

      const compatibleBaseUrl = normalizeAliyunCompatibleBaseUrl(config.baseUrl);
      const endpointCandidates = directAliyun
        ? isAliyunCompatibleChatAsrModel(modelName)
          ? [`${compatibleBaseUrl}/v1/chat/completions`, `${compatibleBaseUrl}/v1/audio/transcriptions`]
          : [`${compatibleBaseUrl}/v1/audio/transcriptions`, `${compatibleBaseUrl}/v1/asr`, `${compatibleBaseUrl}/v1/asr/transcribe`, `${compatibleBaseUrl}/v1/transcribe`]
        : [`${baseUrl}/v1/asr`, `${baseUrl}/v1/audio/transcriptions`, `${baseUrl}/v1/asr/transcribe`, `${baseUrl}/v1/transcribe`];

      const errors: string[] = [];
      let usedEndpoint = "";
      let rawData: any = null;

      for (const endpoint of endpointCandidates) {
        try {
          if (endpoint.endsWith("/chat/completions")) {
            const audioDataUrl = `data:${audio.mime};base64,${audio.buffer.toString("base64")}`;
            const instruction = [
              "请将这段语音转写成简体中文文本。",
              lang ? `目标语言：${String(lang)}` : "",
              prompt ? `补充提示：${String(prompt)}` : "",
              "只返回转写结果正文，不要补充解释。",
            ]
              .filter(Boolean)
              .join("\n");

            const response = await axios.post(
              endpoint,
              {
                model: modelName || "qwen3-asr-flash",
                messages: [
                  {
                    role: "user",
                    content: [
                      {
                        type: "input_audio",
                        input_audio: {
                          data: audioDataUrl,
                          format: audio.ext,
                        },
                      },
                      {
                        type: "text",
                        text: instruction,
                      },
                    ],
                  },
                ],
              },
              {
                headers: {
                  ...headers,
                  "Content-Type": "application/json",
                },
                timeout: 120000,
              },
            );
            rawData = response.data || {};
          } else if (endpoint.endsWith("/audio/transcriptions")) {
            const form = new FormData();
            const effectiveModel = modelName || "whisper-1";

            form.append("file", audio.buffer, {
              filename: `audio.${audio.ext}`,
              contentType: audio.mime,
            });
            form.append("model", effectiveModel);
            if (suppliers) {
              form.append("suppliers", suppliers);
            }
            if (lang) form.append("language", String(lang));
            if (prompt) form.append("prompt", String(prompt));
            if (typeof temperature === "number") form.append("temperature", String(temperature));
            if (withSegments) {
              form.append("response_format", "verbose_json");
            }

            const response = await axios.post(endpoint, form, {
              headers: {
                ...headers,
                ...form.getHeaders(),
              },
              maxBodyLength: Infinity,
              timeout: 120000,
            });
            rawData = response.data || {};
          } else if (endpoint.endsWith("/v1/asr")) {
            const form = new FormData();
            form.append("audio", audio.buffer, {
              filename: `audio.${audio.ext}`,
              contentType: audio.mime,
            });
            if (suppliers) {
              form.append("suppliers", suppliers);
            }
            if (modelName) form.append("model", modelName);
            if (lang) form.append("language", String(lang));
            if (prompt) form.append("prompt", String(prompt));
            if (typeof temperature === "number") form.append("temperature", String(temperature));
            if (audio.ext) form.append("format", String(audio.ext));

            const response = await axios.post(endpoint, form, {
              headers: {
                ...headers,
                ...form.getHeaders(),
              },
              maxBodyLength: Infinity,
              timeout: 120000,
            });
            rawData = response.data || {};
          } else {
            const response = await axios.post(
              endpoint,
              {
                audioBase64: audio.buffer.toString("base64"),
                audioMime: audio.mime,
                lang: lang || undefined,
                sessionId: sessionId || undefined,
                prompt: prompt || undefined,
                temperature: typeof temperature === "number" ? temperature : undefined,
                model: modelName || undefined,
                withSegments: Boolean(withSegments),
                ...(suppliers ? { suppliers } : {}),
              },
              {
                headers,
                timeout: 120000,
              },
            );
            rawData = response.data || {};
          }

          usedEndpoint = endpoint;
          break;
        } catch (err: any) {
          const message = err?.response?.data?.message || err?.message || String(err);
          errors.push(`[${endpoint}] ${message}`);
        }
      }

      if (!usedEndpoint) {
        return res.status(500).send(error(`语音转写失败：${errors.join(" | ")}`));
      }

      const parsed = parseTranscribeResult(rawData);
      if (!parsed.text && parsed.segments.length === 0) {
        return res.status(500).send(error("转写成功但未返回文本结果"));
      }

      res.status(200).send(
        success({
          text: parsed.text,
          segments: parsed.segments,
          confidence: parsed.confidence,
          endpoint: usedEndpoint,
          raw: rawData,
        }),
      );
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
