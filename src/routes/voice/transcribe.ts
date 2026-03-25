import express from "express";
import axios from "axios";
import FormData from "form-data";
import path from "node:path";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import { voiceSupplierFromManufacturer } from "@/lib/voiceGateway";

const router = express.Router();

function normalizeBaseUrl(input: string | null | undefined): string {
  const base = String(input || "").trim();
  return (base || "http://127.0.0.1:8000").replace(/\/+$/, "");
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
  const preferred = preferredModelType
    ? await u.db("t_config").where({ type: "voice", userId, modelType: preferredModelType }).orderBy("id", "desc").first()
    : null;
  if (preferred) return preferred;
  return u.db("t_config").where({ type: "voice", userId }).orderBy("id", "desc").first();
}

function parseTranscribeResult(data: any): { text: string; segments: any[]; confidence: number | null } {
  let text =
    (typeof data?.text === "string" ? data.text : "") ||
    (typeof data?.transcript === "string" ? data.transcript : "") ||
    (typeof data?.result?.text === "string" ? data.result.text : "") ||
    (typeof data?.data?.text === "string" ? data.data.text : "") ||
    (typeof data?.output?.text === "string" ? data.output.text : "") ||
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
      const modelName = String(model || config.model || "").trim();
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

      const endpointCandidates =
        manufacturer === "aliyun" || manufacturer === "ai_voice_tts"
          ? [`${baseUrl}/v1/asr`, `${baseUrl}/v1/audio/transcriptions`, `${baseUrl}/v1/asr/transcribe`, `${baseUrl}/v1/transcribe`]
          : [`${baseUrl}/v1/asr/transcribe`, `${baseUrl}/v1/asr`, `${baseUrl}/v1/transcribe`, `${baseUrl}/v1/audio/transcriptions`];

      const errors: string[] = [];
      let usedEndpoint = "";
      let rawData: any = null;

      for (const endpoint of endpointCandidates) {
        try {
          if (endpoint.endsWith("/audio/transcriptions")) {
            const form = new FormData();
            const effectiveModel = modelName || "whisper-1";

            form.append("file", audio.buffer, {
              filename: `audio.${audio.ext}`,
              contentType: audio.mime,
            });
            form.append("model", effectiveModel);
            form.append("suppliers", suppliers);
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
            form.append("suppliers", suppliers);
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
                suppliers,
                lang: lang || undefined,
                sessionId: sessionId || undefined,
                prompt: prompt || undefined,
                temperature: typeof temperature === "number" ? temperature : undefined,
                model: modelName || undefined,
                withSegments: Boolean(withSegments),
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
