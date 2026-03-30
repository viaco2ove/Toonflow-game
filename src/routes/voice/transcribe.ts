import express from "express";
import axios from "axios";
import FormData from "form-data";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import { isDirectAliyunManufacturer, normalizeAliyunDirectAsrModel, voiceSupplierFromManufacturer } from "@/lib/voiceGateway";

const router = express.Router();
const COMMON_WIN_FFMPEG_PATHS = [
  "D:\\Program Files\\ffmpeg-master-latest-win64-gpl-shared\\bin\\ffmpeg.exe",
  "C:\\Program Files\\ffmpeg-master-latest-win64-gpl-shared\\bin\\ffmpeg.exe",
  "D:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
  "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
];
const TRANSCODE_AUDIO_EXTS = new Set(["webm", "mp4", "m4a", "aac", "ogg", "oga"]);
let cachedFfmpegPath = "";

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

function convertWindowsPathToWsl(input: string): string {
  const raw = String(input || "").trim();
  const match = raw.match(/^([A-Za-z]):\\(.*)$/);
  if (!match) return raw;
  const drive = match[1]!.toLowerCase();
  const tail = match[2]!.replace(/\\/g, "/");
  return `/mnt/${drive}/${tail}`;
}

function discoverFfmpegPath(): string {
  if (cachedFfmpegPath) return cachedFfmpegPath;
  const envPath = String(process.env.FFMPEG_PATH || "").trim();
  if (envPath && existsSync(envPath)) {
    cachedFfmpegPath = envPath;
    return cachedFfmpegPath;
  }
  for (const candidate of COMMON_WIN_FFMPEG_PATHS) {
    if (existsSync(candidate)) {
      cachedFfmpegPath = candidate;
      return cachedFfmpegPath;
    }
    const wslCandidate = convertWindowsPathToWsl(candidate);
    if (wslCandidate !== candidate && existsSync(wslCandidate)) {
      cachedFfmpegPath = wslCandidate;
      return cachedFfmpegPath;
    }
  }
  const syncLookup = process.platform === "win32"
    ? spawnSync("where", ["ffmpeg"], { encoding: "utf8", windowsHide: true })
    : spawnSync("cmd.exe", ["/c", "where", "ffmpeg"], { encoding: "utf8", windowsHide: true });
  const stdout = String(syncLookup.stdout || "").trim();
  const firstLine = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  if (firstLine) {
    const normalized = existsSync(firstLine) ? firstLine : convertWindowsPathToWsl(firstLine);
    if (existsSync(normalized)) {
      cachedFfmpegPath = normalized;
      return cachedFfmpegPath;
    }
  }
  throw new Error("未找到 ffmpeg，无法处理当前录音格式");
}

async function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const trimmed = stderr.trim().split(/\r?\n/).slice(-6).join("\n").trim();
      reject(new Error(trimmed || `ffmpeg 执行失败（退出码 ${code ?? -1}）`));
    });
  });
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
    "audio/m4a": "m4a",
    "audio/x-m4a": "m4a",
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
    m4a: "audio/mp4",
    aac: "audio/aac",
  };

  return {
    buffer,
    mime: mimeMap[ext] || "audio/wav",
    ext,
  };
}

async function normalizeAsrAudio(input: { buffer: Buffer; mime: string; ext: string }) {
  if (!TRANSCODE_AUDIO_EXTS.has(String(input.ext || "").trim().toLowerCase())) {
    return input;
  }
  const ffmpegPath = discoverFfmpegPath();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "toonflow-asr-audio-"));
  try {
    const inputExt = String(input.ext || "bin").trim().toLowerCase() || "bin";
    const inputPath = path.join(tempDir, `input.${inputExt}`);
    const outputPath = path.join(tempDir, "normalized.wav");
    await fs.writeFile(inputPath, input.buffer);
    await runFfmpeg(ffmpegPath, [
      "-y",
      "-i",
      inputPath,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "wav",
      outputPath,
    ]);
    const buffer = await fs.readFile(outputPath);
    return {
      buffer,
      mime: "audio/wav",
      ext: "wav",
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function getVoiceConfig(userId: number, configId?: number | null, preferredModelType?: "tts" | "asr") {
  if (configId) {
    const selected = await u.db("t_config").where({ id: configId, type: "voice", userId }).first();
    if (!selected) return null;
    if (preferredModelType !== "asr") return selected;
    const modelType = String(selected.modelType || "").trim().toLowerCase();
    if (modelType === "asr") return selected;
    if (isDirectAliyunManufacturer(selected.manufacturer)) {
      return {
        ...selected,
        modelType: "asr",
        model: normalizeAliyunDirectAsrModel(null),
      };
    }
    return null;
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
      if (!selected) return null;
      const modelType = String(selected.modelType || "").trim().toLowerCase();
      if (modelType === "asr") return selected;
      if (isDirectAliyunManufacturer(selected.manufacturer)) {
        return {
          ...selected,
          modelType: "asr",
          model: normalizeAliyunDirectAsrModel(null),
        };
      }
      return null;
    }
    const latestDirectAliyun = await u.db("t_config")
      .where({ type: "voice", userId, manufacturer: "aliyun_direct" })
      .orderBy("id", "desc")
      .first();
    if (latestDirectAliyun) {
      return {
        ...latestDirectAliyun,
        modelType: "asr",
        model: normalizeAliyunDirectAsrModel(null),
      };
    }
    return null;
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
      const configModelType = String(config.modelType || "").trim().toLowerCase();
      if (!directAliyun && configModelType && configModelType !== "asr" && !String(model || "").trim()) {
        return res.status(400).send(error("当前未配置语音识别模型"));
      }
      const modelName = directAliyun
        ? normalizeAliyunDirectAsrModel(
            String(
              model
              || (configModelType === "asr" ? config.model : "")
              || "",
            ).trim(),
          )
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
      audio = await normalizeAsrAudio(audio);

      const compatibleBaseUrl = normalizeAliyunCompatibleBaseUrl(config.baseUrl);
      const endpointCandidates = directAliyun
        ? [`${compatibleBaseUrl}/v1/chat/completions`]
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
