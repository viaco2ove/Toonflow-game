import express from "express";
import axios from "axios";
import { createHash } from "node:crypto";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import {
  defaultAliyunDirectVoiceId,
  directAliyunVoicePresets,
  fetchVoicePresets,
  filterVoicePresetsByManufacturer,
  getRuntimeStoryVoiceConfig,
  isAliyunVoiceManufacturer,
  isAliyunDirectCosyVoiceModel,
  isAliyunDirectQwenVoiceCloneModel,
  isAliyunDirectQwenVoiceDesignModel,
  isDirectAliyunManufacturer,
  normalizeAliyunDirectTtsModel,
  normalizePersistedVoiceConfig,
  normalizeVoiceBaseUrl,
  resolveAliyunDirectTtsEndpoint,
  resolveUnsupportedVoiceModeReason,
  voiceSupplierFromManufacturer,
} from "@/lib/voiceGateway";
import {
  buildGeneratedReferencePath,
  BUSINESS_VOICE_PRESET_SEED_TEXT,
  ensureBusinessVoicePresets,
  fallbackBusinessVoiceId,
  findBusinessVoicePreset,
  inferVoiceGenderHint,
} from "@/lib/businessVoicePresets";
import { ensureBundledVoicePresetSeed } from "@/lib/voicePresetSeeds";
import { getStoryVoiceDesignConfig, synthesizeVoiceDesignBuffer, type VoiceDesignConfig } from "@/lib/voiceDesign";
import FormData from "form-data";
import { synthesizeAliyunDirectCosyVoiceBuffer } from "@/lib/aliyunCosyVoice";
import { mixPcmWavBuffers } from "@/lib/wavMix";
import { v4 as uuidv4 } from "uuid";

const router = express.Router();

type VoiceMode = "text" | "clone" | "mix" | "prompt_voice";
type DirectAliyunCustomVoiceMode = Extract<VoiceMode, "clone" | "mix" | "prompt_voice">;

const DIRECT_ALIYUN_CUSTOM_VOICE_CACHE = new Map<string, { voiceId: string; createdAt: number }>();
const DIRECT_ALIYUN_CUSTOM_VOICE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DIRECT_ALIYUN_CUSTOM_VOICE_READY_RETRY_DELAYS_MS = [1500, 2500, 4000];
const DIRECT_ALIYUN_SUPPORTED_SAMPLE_RATES = new Set([8000, 16000, 22050, 24000, 44100, 48000]);
const DIRECT_AUDIO_CONTENT_TYPE_MAP: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  webm: "audio/webm",
  mp4: "audio/mp4",
  aac: "audio/aac",
};

function trimText(input?: unknown): string {
  return String(input || "").trim();
}

function normalizePreviewFormat(input?: unknown): string {
  const raw = String(input || "").trim().toLowerCase();
  if (["wav", "mp3", "pcm"].includes(raw)) return raw;
  return "wav";
}

function normalizePreviewSampleRate(input?: unknown): number | null {
  const value = Number(input || 0);
  if (!Number.isFinite(value)) return null;
  return DIRECT_ALIYUN_SUPPORTED_SAMPLE_RATES.has(value) ? value : null;
}

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAliyunCustomizationEndpoint(baseURL?: string | null): string {
  const base = trimText(baseURL);
  if (!base) return "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization";
  if (/\/api\/v1\/services\/audio\/tts\/customization$/i.test(base)) {
    return base;
  }
  if (/\/api\/v1\/services\/aigc\/multimodal-generation\/generation$/i.test(base)) {
    return base.replace(/\/api\/v1\/services\/aigc\/multimodal-generation\/generation$/i, "/api/v1/services/audio/tts/customization");
  }
  const normalized = base
    .replace(/\/compatible-mode\/v1$/i, "")
    .replace(/\/compatible-mode$/i, "")
    .replace(/\/api\/v1$/i, "")
    .replace(/\/v1$/i, "")
    .replace(/\/+$/, "");
  return `${normalized}/api/v1/services/audio/tts/customization`;
}

function isLocalOrPrivateHostname(hostname?: string | null): boolean {
  const normalized = trimText(hostname).toLowerCase().replace(/^\[|\]$/g, "");
  if (!normalized) return true;
  if (normalized === "localhost" || normalized === "::1" || normalized.endsWith(".local")) return true;
  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function isPublicHttpUrl(url?: string | null): boolean {
  const raw = trimText(url);
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/i.test(parsed.protocol)) return false;
    return !isLocalOrPrivateHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function buildDirectAliyunVoiceName(seed: string, maxLength: number): string {
  const normalized = trimText(seed).toLowerCase().replace(/[^a-z0-9]+/g, "");
  const fallback = "voice";
  const raw = normalized || fallback;
  if (raw.length <= maxLength) return raw;
  const hash = sha1(raw).slice(0, 6);
  const headLength = Math.max(1, maxLength - hash.length);
  return `${raw.slice(0, headLength)}${hash}`.slice(0, maxLength);
}

function getDirectAliyunCustomVoiceCache(cacheKey: string): string {
  const cached = DIRECT_ALIYUN_CUSTOM_VOICE_CACHE.get(cacheKey);
  if (!cached) return "";
  if (Date.now() - cached.createdAt > DIRECT_ALIYUN_CUSTOM_VOICE_CACHE_TTL_MS) {
    DIRECT_ALIYUN_CUSTOM_VOICE_CACHE.delete(cacheKey);
    return "";
  }
  return trimText(cached.voiceId);
}

function setDirectAliyunCustomVoiceCache(cacheKey: string, voiceId: string) {
  DIRECT_ALIYUN_CUSTOM_VOICE_CACHE.set(cacheKey, {
    voiceId,
    createdAt: Date.now(),
  });
}

function buildProxyAudioUrl(req: express.Request, configId: number | null | undefined, source: string): string {
  const rawSource = String(source || "").trim();
  if (!rawSource) return "";
  const protocol = String(req.headers["x-forwarded-proto"] || req.protocol || "http")
    .split(",")[0]
    .trim();
  const host = String(req.headers["x-forwarded-host"] || req.get("host") || "127.0.0.1:60000")
    .split(",")[0]
    .trim();
  const rawToken = String(req.headers.authorization || req.query.token || "").replace(/^Bearer\s+/i, "").trim();
  const params = new URLSearchParams();
  if (configId) params.set("configId", String(configId));
  params.set("source", rawSource);
  if (rawToken) params.set("token", rawToken);
  return `${protocol}://${host}/voice/audioProxy?${params.toString()}`;
}

function normalizeBase64(input?: string | null): string {
  if (!input) return "";
  const match = input.match(/^data:([^;]+);base64,(.+)$/);
  return match ? match[2] || "" : input;
}

function inferAudioExt(source?: string | null): string {
  const raw = String(source || "").trim();
  if (!raw) return "wav";
  const dataUriMatch = raw.match(/^data:([^;]+);base64,/i);
  if (dataUriMatch) {
    const mime = String(dataUriMatch[1] || "").trim().toLowerCase();
    if (mime.includes("mpeg") || mime.endsWith("/mp3")) return "mp3";
    if (mime.endsWith("/ogg")) return "ogg";
    if (mime.endsWith("/webm")) return "webm";
    if (mime.endsWith("/mp4")) return "mp4";
    if (mime.endsWith("/aac")) return "aac";
    return "wav";
  }
  try {
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw);
      const ext = String(url.pathname.split(".").pop() || "").replace(/[^a-zA-Z0-9]/g, "");
      return ext || "wav";
    }
  } catch {}
  const ext = String(raw.split(".").pop() || "").replace(/[^a-zA-Z0-9]/g, "");
  return ext || "wav";
}

function inferAudioMimeType(source?: string | null): string {
  const ext = inferAudioExt(source).toLowerCase();
  return DIRECT_AUDIO_CONTENT_TYPE_MAP[ext] || "audio/wav";
}

async function loadReferenceAudioBuffer(referenceAudioPath: string): Promise<Buffer> {
  const raw = String(referenceAudioPath || "").trim();
  if (!raw) {
    throw new Error("克隆模式需要参考音频");
  }

  if (/^data:/i.test(raw)) {
    return Buffer.from(normalizeBase64(raw), "base64");
  }

  if (/^https?:\/\//i.test(raw)) {
    const response = await axios.get(raw, {
      responseType: "arraybuffer",
      timeout: 30000,
    });
    return Buffer.from(response.data);
  }

  const maybeSeedName = raw.split("/").pop() || "";
  if (/^\/system\/voice-presets\/[^/]+\.wav$/i.test(raw) && maybeSeedName) {
    await ensureBundledVoicePresetSeed(maybeSeedName);
  }

  return u.oss.getFile(raw);
}

function toReferenceAudioSource(referenceAudioPath?: string | null, referenceAudioBase64?: string | null): string {
  const rawPath = String(referenceAudioPath || "").trim();
  if (rawPath) return rawPath;
  const base64 = normalizeBase64(referenceAudioBase64);
  if (!base64) return "";
  return `data:audio/wav;base64,${base64}`;
}

function resolveSourceUrl(data: Record<string, any>, baseUrl: string): string {
  const fullUrl = String(data.audio_url_full || "").trim();
  if (fullUrl) return fullUrl;
  const relativeUrl = String(data.audio_url || "").trim();
  if (!relativeUrl) return "";
  return `${baseUrl}${relativeUrl.startsWith("/") ? "" : "/"}${relativeUrl}`;
}

function normalizeMixVoiceItems(
  mixVoices: Array<{ voiceId: string; weight?: number | null }> | null | undefined,
): Array<{ voiceId: string; weight: number }> {
  const normalized: Array<{ voiceId: string; weight: number }> = [];
  const seen = new Set<string>();
  for (const item of mixVoices || []) {
    const rawVoiceId = String(item?.voiceId || "").trim();
    if (!rawVoiceId) continue;
    const businessPreset = findBusinessVoicePreset(rawVoiceId);
    const resolvedVoiceId = String(businessPreset?.baseVoiceId || rawVoiceId).trim();
    if (!resolvedVoiceId || seen.has(resolvedVoiceId)) continue;
    seen.add(resolvedVoiceId);
    normalized.push({
      voiceId: resolvedVoiceId,
      weight: typeof item?.weight === "number" ? item.weight : 1,
    });
  }
  return normalized;
}

function resolveDirectAliyunBusinessPresetVoiceId(config: { model?: string | null }, preset: ReturnType<typeof findBusinessVoicePreset>): string {
  if (!preset) return "";
  const model = normalizeAliyunDirectTtsModel(String(config.model || "").trim());
  const availablePresetIds = new Set(directAliyunVoicePresets(model).map((item) => String(item.voiceId || "").trim()).filter(Boolean));
  const defaultVoiceId = defaultAliyunDirectVoiceId(model);
  const normalizedModel = String(model || "").trim().toLowerCase();

  let candidates: string[] = [];
  if (normalizedModel.includes("qwen3-tts") || normalizedModel === "qwen-tts" || normalizedModel === "qwen-tts-latest") {
    switch (preset.voiceId) {
      case "story_std_male":
        candidates = ["Ethan", "Ryan", "Marcus", "Peter"];
        break;
      case "story_steady_male":
        candidates = ["Marcus", "Ethan", "Ryan", "Peter"];
        break;
      case "story_std_female":
        candidates = ["Cherry", "Chelsie", "Serena", "Jada"];
        break;
      case "story_gentle_female":
        candidates = ["Chelsie", "Cherry", "Serena", "Katerina"];
        break;
      case "story_lively_female":
        candidates = ["Serena", "Sunny", "Cherry", "Chelsie"];
        break;
      case "story_narrator":
        candidates = ["Elias", "Cherry", "Katerina", "Jada"];
        break;
      default:
        candidates = preset.fallbackGender === "male" ? ["Ethan", "Marcus", "Ryan"] : ["Cherry", "Chelsie", "Serena"];
        break;
    }
  } else if (isAliyunDirectCosyVoiceModel(model)) {
    switch (preset.voiceId) {
      case "story_std_male":
        candidates = ["longanshuo_v3", "longanyang", "longanwen_v3"];
        break;
      case "story_steady_male":
        candidates = ["longanzhi_v3", "longanwen_v3", "longanshuo_v3"];
        break;
      case "story_std_female":
        candidates = ["longanya_v3", "longanling_v3", "longanqin_v3"];
        break;
      case "story_gentle_female":
        candidates = ["longanya_v3", "longanqin_v3", "longanling_v3"];
        break;
      case "story_lively_female":
        candidates = ["longanhuan", "longanling_v3", "longfeifei_v3"];
        break;
      case "story_narrator":
        candidates = ["longanqin_v3", "longanwen_v3", "longanya_v3"];
        break;
      default:
        candidates = preset.fallbackGender === "male"
          ? ["longanyang", "longanshuo_v3", "longanwen_v3"]
          : ["longanya_v3", "longanling_v3", "longanqin_v3"];
        break;
    }
  }

  for (const candidate of candidates) {
    if (availablePresetIds.has(candidate)) {
      return candidate;
    }
  }
  return defaultVoiceId;
}

async function resolveLocalCloneGateway(userId: number): Promise<{ baseUrl: string; headers: Record<string, string> }> {
  const row = await u.db("t_config")
    .where({ type: "voice", userId, manufacturer: "ai_voice_tts" })
    .orderBy("id", "desc")
    .first();
  const baseUrl = normalizeVoiceBaseUrl(String(row?.baseUrl || "http://127.0.0.1:8000"));
  const headers: Record<string, string> = {};
  if (String(row?.apiKey || "").trim()) {
    headers.Authorization = `Bearer ${String(row?.apiKey || "").trim()}`;
  }
  return { baseUrl, headers };
}

async function synthesizeWithLocalClone(
  req: express.Request,
  userId: number,
  text: string,
  referenceAudioPath: string,
  referenceText: string,
  format: string,
  speed?: number | null,
) {
  const { baseUrl, headers } = await resolveLocalCloneGateway(userId);
  const cloneForm = new FormData();
  cloneForm.append("text", text);
  cloneForm.append("format", format || "wav");
  cloneForm.append("use_cache", "true");
  cloneForm.append("suppliers", "local");
  if (typeof speed === "number") {
    cloneForm.append("speed", String(speed));
  }
  if (String(referenceText || "").trim()) {
    cloneForm.append("reference_text", String(referenceText || "").trim());
  }
  const fileBuffer = await loadReferenceAudioBuffer(referenceAudioPath);
  const fileExt = inferAudioExt(referenceAudioPath);
  const fileContentTypeMap: Record<string, string> = {
    wav: "audio/wav",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    webm: "audio/webm",
    mp4: "audio/mp4",
    aac: "audio/aac",
  };
  cloneForm.append("reference_audio", fileBuffer, {
    filename: `reference.${fileExt}`,
    contentType: fileContentTypeMap[fileExt] || "audio/wav",
  });
  const cloneResponse = await axios.post(`${baseUrl}/v1/tts/clone_upload`, cloneForm, {
    headers: {
      ...headers,
      ...cloneForm.getHeaders(),
    },
    timeout: 120000,
  });
  const cloneData = cloneResponse.data || {};
  const cloneSourceUrl = resolveSourceUrl(cloneData, baseUrl);
  const cloneAudioUrl = buildProxyAudioUrl(req, null, cloneSourceUrl);
  return {
    audioUrl: cloneAudioUrl,
    data: cloneData,
    sourceUrl: cloneSourceUrl,
  };
}

async function persistDerivedReferenceAudio(
  savePath: string,
  sourceUrl: string,
): Promise<string> {
  if (await u.oss.fileExists(savePath)) return savePath;
  const response = await axios.get(sourceUrl, {
    responseType: "arraybuffer",
    timeout: 120000,
  });
  await u.oss.writeFile(savePath, Buffer.from(response.data));
  return savePath;
}

async function persistPreviewAudioBuffer(userId: number, input: Buffer, format = "wav"): Promise<string> {
  const ext = inferAudioExt(`.${String(format || "wav").trim().toLowerCase()}`) || "wav";
  const savePath = `/user/${userId}/game/voice-preview/${uuidv4()}.${ext}`;
  await u.oss.writeFile(savePath, input);
  return savePath;
}

async function resolveDirectAliyunReferenceAudioUrl(referenceAudioSource: string): Promise<string> {
  const source = trimText(referenceAudioSource);
  if (!source) {
    throw new Error("克隆模式需要参考音频");
  }
  if (/^https?:\/\//i.test(source) && isPublicHttpUrl(source)) {
    return source;
  }
  if (!/^https?:\/\//i.test(source) && !/^data:/i.test(source)) {
    const externalUrl = await u.oss.getExternalUrl(source);
    if (isPublicHttpUrl(externalUrl)) {
      return externalUrl;
    }
  }

  const buffer = await loadReferenceAudioBuffer(source);
  const ext = inferAudioExt(source);
  const uploadedUrl = await u.oss.uploadTemp(buffer, `aliyun-direct-ref-${sha1(source).slice(0, 12)}.${ext}`);
  if (isPublicHttpUrl(uploadedUrl)) {
    return trimText(uploadedUrl);
  }

  throw new Error("阿里云官方声音复刻需要公网可访问的参考音频，请配置 TEMP_OSS 或使用公网音频地址");
}

async function resolveDirectAliyunReferenceAudioDataUri(referenceAudioSource: string): Promise<string> {
  const source = trimText(referenceAudioSource);
  if (!source) {
    throw new Error("克隆模式需要参考音频");
  }
  if (/^data:/i.test(source)) {
    return source;
  }
  const buffer = await loadReferenceAudioBuffer(source);
  return `data:${inferAudioMimeType(source)};base64,${buffer.toString("base64")}`;
}

function extractDirectAliyunCustomVoiceId(data: Record<string, any> | null | undefined): string {
  return trimText(
    data?.output?.voice_id
    || data?.output?.voiceID
    || data?.output?.voiceId
    || data?.voice_id
    || data?.voiceID
    || data?.voiceId,
  );
}

function isDirectAliyunPromptVoiceConfigCompatible(targetModel: string, voiceDesignConfig?: VoiceDesignConfig | null): boolean {
  const designModel = trimText(voiceDesignConfig?.model).toLowerCase();
  if (!designModel) return false;
  if (isAliyunDirectCosyVoiceModel(targetModel)) {
    return designModel === "voice-enrollment" || designModel.startsWith("cosyvoice-v3");
  }
  if (isAliyunDirectQwenVoiceDesignModel(targetModel)) {
    return designModel === "qwen-voice-design" || designModel.startsWith("qwen3-tts-vd");
  }
  return false;
}

function buildDirectAliyunCustomVoiceCacheKey(options: {
  configId: number;
  targetModel: string;
  mode: DirectAliyunCustomVoiceMode;
  referenceAudioSource?: string;
  promptText?: string;
  mixVoices?: Array<{ voiceId: string; weight?: number | null }>;
}): string {
  return sha1(JSON.stringify({
    configId: options.configId,
    targetModel: trimText(options.targetModel),
    mode: options.mode,
    referenceAudioSource: trimText(options.referenceAudioSource),
    promptText: trimText(options.promptText),
    mixVoices: normalizeMixVoiceItems(options.mixVoices),
  }));
}

async function createDirectAliyunCustomVoice(options: {
  config: any;
  mode: DirectAliyunCustomVoiceMode;
  referenceAudioSource?: string;
  promptText?: string;
  sampleRate?: number | null;
  mixVoices?: Array<{ voiceId: string; weight?: number | null }>;
  voiceDesignConfig?: VoiceDesignConfig | null;
}): Promise<{ voiceId: string; fresh: boolean; responseData: Record<string, any> | null }> {
  const targetModel = normalizeAliyunDirectTtsModel(trimText(options.config?.model));
  const requestedSampleRate = normalizePreviewSampleRate(options.sampleRate) || 24000;
  const cacheKey = buildDirectAliyunCustomVoiceCacheKey({
    configId: Number(options.config?.id || 0),
    targetModel,
    mode: options.mode,
    referenceAudioSource: options.referenceAudioSource,
    promptText: options.promptText,
    mixVoices: options.mixVoices,
  });
  const cachedVoiceId = getDirectAliyunCustomVoiceCache(cacheKey);
  if (cachedVoiceId) {
    return { voiceId: cachedVoiceId, fresh: false, responseData: null };
  }

  let endpoint = normalizeAliyunCustomizationEndpoint(options.config?.baseUrl);
  let apiKey = trimText(options.config?.apiKey);
  let payload: Record<string, any> | null = null;
  const preferredName = buildDirectAliyunVoiceName(`${targetModel}_${options.mode}_${cacheKey.slice(0, 8)}`, 16);

  if (options.mode === "prompt_voice") {
    if (!trimText(options.promptText)) {
      throw new Error("提示词模式需要填写提示词");
    }
    if (!isDirectAliyunPromptVoiceConfigCompatible(targetModel, options.voiceDesignConfig)) {
      throw new Error("当前语音设计模型与所选故事语音模型不兼容");
    }
    endpoint = normalizeAliyunCustomizationEndpoint(options.voiceDesignConfig?.baseURL || options.config?.baseUrl);
    apiKey = trimText(options.voiceDesignConfig?.apiKey) || apiKey;
    if (isAliyunDirectCosyVoiceModel(targetModel)) {
      payload = {
        model: "voice-enrollment",
        input: {
          action: "create_voice",
          target_model: targetModel,
          voice_prompt: trimText(options.promptText),
          preview_text: BUSINESS_VOICE_PRESET_SEED_TEXT,
          prefix: buildDirectAliyunVoiceName(preferredName, 10),
        },
        parameters: {
          sample_rate: requestedSampleRate,
          response_format: "wav",
        },
      };
    } else if (isAliyunDirectQwenVoiceDesignModel(targetModel)) {
      payload = {
        model: "qwen-voice-design",
        input: {
          action: "create",
          target_model: targetModel,
          voice_prompt: trimText(options.promptText),
          preview_text: BUSINESS_VOICE_PRESET_SEED_TEXT,
          preferred_name: preferredName,
          language: "zh",
        },
        parameters: {
          sample_rate: requestedSampleRate,
          response_format: "wav",
        },
      };
    }
  } else if (isAliyunDirectCosyVoiceModel(targetModel)) {
    const publicReferenceUrl = await resolveDirectAliyunReferenceAudioUrl(trimText(options.referenceAudioSource));
    payload = {
      model: "voice-enrollment",
      input: {
        action: "create_voice",
        target_model: targetModel,
        url: publicReferenceUrl,
        prefix: buildDirectAliyunVoiceName(preferredName, 10),
      },
      parameters: {
        sample_rate: requestedSampleRate,
        response_format: "wav",
      },
    };
  } else if (isAliyunDirectQwenVoiceCloneModel(targetModel)) {
    const dataUri = await resolveDirectAliyunReferenceAudioDataUri(trimText(options.referenceAudioSource));
    payload = {
      model: "qwen-voice-enrollment",
      input: {
        action: "create",
        target_model: targetModel,
        preferred_name: preferredName,
        audio: {
          data: dataUri,
        },
      },
      parameters: {
        sample_rate: requestedSampleRate,
        response_format: "wav",
      },
    };
  }

  if (!payload) {
    throw new Error("当前阿里云直连模型不支持该绑定模式");
  }
  if (!apiKey) {
    throw new Error("当前阿里云直连模型缺少 API Key");
  }

  const response = await axios.post(endpoint, payload, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeout: 120000,
  });
  const responseData = response.data && typeof response.data === "object" ? response.data : null;
  const voiceId = extractDirectAliyunCustomVoiceId(responseData);
  if (!voiceId) {
    throw new Error("阿里云官方复刻/设计接口未返回 voice_id");
  }
  setDirectAliyunCustomVoiceCache(cacheKey, voiceId);
  return {
    voiceId,
    fresh: true,
    responseData,
  };
}

async function synthesizeDirectAliyunPreviewAudio(options: {
  config: any;
  headers: Record<string, string>;
  userId: number;
  text: string;
  voiceId: string;
  format: string;
  sampleRate?: number | null;
  speed?: number | null;
}): Promise<{ sourceUrl: string; data: Record<string, any> }> {
  const directModel = normalizeAliyunDirectTtsModel(trimText(options.config?.model));
  if (isAliyunDirectCosyVoiceModel(directModel)) {
    const buffer = await synthesizeAliyunDirectCosyVoiceBuffer({
      apiKey: trimText(options.config?.apiKey),
      baseUrl: options.config?.baseUrl,
      model: directModel,
      voiceId: trimText(options.voiceId),
      text: trimText(options.text),
      format: options.format,
      sampleRate: options.sampleRate,
      speed: options.speed,
    });
    return {
      sourceUrl: await persistPreviewAudioBuffer(options.userId, buffer, options.format),
      data: {
        localGenerated: true,
        mode: "websocket",
        voice: trimText(options.voiceId),
        model: directModel,
        customVoice: true,
      },
    };
  }

  const response = await axios.post(
    resolveAliyunDirectTtsEndpoint(options.config?.baseUrl),
    {
      model: directModel,
      input: {
        text: trimText(options.text),
        language_type: "Chinese",
        voice: trimText(options.voiceId),
      },
    },
    {
      headers: options.headers,
      timeout: 120000,
    },
  );
  const responseData = response.data && typeof response.data === "object" ? response.data : {};
  const sourceUrl = trimText(responseData?.output?.audio?.url);
  if (!sourceUrl) {
    throw new Error("阿里云直连语音合成未返回可用音频地址");
  }
  return {
    sourceUrl,
    data: {
      ...responseData,
      customVoice: true,
    },
  };
}

async function synthesizeDirectAliyunPreviewAudioWithRetry(options: {
  config: any;
  headers: Record<string, string>;
  userId: number;
  text: string;
  voiceId: string;
  format: string;
  sampleRate?: number | null;
  speed?: number | null;
  fresh?: boolean;
}): Promise<{ sourceUrl: string; data: Record<string, any> }> {
  let lastError: unknown = null;
  const maxAttempts = options.fresh ? DIRECT_ALIYUN_CUSTOM_VOICE_READY_RETRY_DELAYS_MS.length + 1 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await synthesizeDirectAliyunPreviewAudio(options);
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts - 1) {
        break;
      }
      await sleep(DIRECT_ALIYUN_CUSTOM_VOICE_READY_RETRY_DELAYS_MS[attempt] || 1000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("阿里云直连语音合成失败");
}

async function synthesizeDirectAliyunReferenceBuffer(options: {
  config: any;
  headers: Record<string, string>;
  model: string;
  voiceId: string;
  text: string;
  sampleRate?: number | null;
}): Promise<Buffer> {
  const { config, headers, model, voiceId, text, sampleRate } = options;
  if (isAliyunDirectCosyVoiceModel(model)) {
    return synthesizeAliyunDirectCosyVoiceBuffer({
      apiKey: String(config.apiKey || "").trim(),
      baseUrl: config.baseUrl,
      model,
      voiceId,
      text,
      format: "wav",
      sampleRate,
    });
  }

  const endpoint = resolveAliyunDirectTtsEndpoint(config.baseUrl);
  const response = await axios.post(
    endpoint,
    {
      model,
      input: {
        text,
        language_type: "Chinese",
        ...(voiceId ? { voice: voiceId } : {}),
      },
    },
    { headers, timeout: 120000 },
  );
  const sourceUrl = String(response.data?.output?.audio?.url || "").trim();
  if (!sourceUrl) {
    throw new Error("未能生成参考音色");
  }
  const audioResponse = await axios.get(sourceUrl, {
    responseType: "arraybuffer",
    timeout: 120000,
  });
  return Buffer.from(audioResponse.data);
}

async function synthesizeReferenceAudioFromMode(options: {
  config: any;
  manufacturer: string;
  baseUrl: string;
  headers: Record<string, string>;
  mode: VoiceMode;
  voiceId: string;
  promptText: string;
  mixVoices: Array<{ voiceId: string; weight?: number | null }>;
  sampleRate?: number | null;
  resolvedProvider: string;
  textSeed?: string;
  userId: number;
  voiceDesignConfig?: VoiceDesignConfig | null;
}): Promise<string> {
  const {
    config,
    manufacturer,
    baseUrl,
    headers,
    mode,
    voiceId,
    promptText,
    mixVoices,
    sampleRate,
    resolvedProvider,
    textSeed = BUSINESS_VOICE_PRESET_SEED_TEXT,
    userId,
    voiceDesignConfig = null,
  } = options;

  const cachePath = buildGeneratedReferencePath({
    manufacturer,
    configId: Number(config?.id || 0),
    mode,
    voiceId,
    promptText,
    mixVoices: normalizeMixVoiceItems(mixVoices),
  });
  if (await u.oss.fileExists(cachePath)) {
    return cachePath;
  }

  if (mode === "prompt_voice") {
    const designed = await synthesizeVoiceDesignBuffer({
      userId,
      config: voiceDesignConfig,
      promptText,
      previewText: textSeed,
      preferredName: voiceId || "story_prompt_voice",
      format: "wav",
    });
    await u.oss.writeFile(cachePath, designed.buffer);
    return cachePath;
  }

  let sourceUrl = "";

  if (isDirectAliyunManufacturer(manufacturer)) {
    const directModel = normalizeAliyunDirectTtsModel(String(config.model || "").trim());
    const directVoiceId = String(voiceId || "").trim() || defaultAliyunDirectVoiceId(directModel);
    if (mode === "mix") {
      const normalizedMixVoices = normalizeMixVoiceItems(mixVoices);
      if (!normalizedMixVoices.length) {
        throw new Error("混合模式需要选择音色");
      }
      const buffers = await Promise.all(
        normalizedMixVoices.map(async (item) => ({
          buffer: await synthesizeDirectAliyunReferenceBuffer({
            config,
            headers,
            model: directModel,
            voiceId: item.voiceId,
            text: textSeed,
            sampleRate,
          }),
          weight: item.weight,
        })),
      );
      const mixedBuffer = mixPcmWavBuffers(buffers);
      await u.oss.writeFile(cachePath, mixedBuffer);
      return cachePath;
    }
    if (mode !== "text") {
      throw new Error("当前语音模型不支持该绑定模式");
    }
    if (isAliyunDirectCosyVoiceModel(directModel)) {
      const buffer = await synthesizeAliyunDirectCosyVoiceBuffer({
        apiKey: String(config.apiKey || "").trim(),
        baseUrl: config.baseUrl,
        model: directModel,
        voiceId: directVoiceId,
        text: textSeed,
        format: "wav",
        sampleRate,
      });
      await u.oss.writeFile(cachePath, buffer);
      return cachePath;
    }
    const buffer = await synthesizeDirectAliyunReferenceBuffer({
      config,
      headers,
      model: directModel,
      voiceId: directVoiceId,
      text: textSeed,
      sampleRate,
    });
    await u.oss.writeFile(cachePath, buffer);
    return cachePath;
  } else {
    const payload: Record<string, any> = {
      text: textSeed,
      mode,
      format: "wav",
      use_cache: true,
    };
    const supplier = voiceSupplierFromManufacturer(manufacturer);
    if (supplier) payload.suppliers = supplier;
    if (isAliyunVoiceManufacturer(manufacturer) && String(config.model || "").trim()) {
      payload.model = String(config.model || "").trim();
    }
    if (voiceId) payload.voice_id = voiceId;
    if (resolvedProvider) payload.provider = resolvedProvider;
    if (mode === "mix") {
      payload.mix_voices = normalizeMixVoiceItems(mixVoices).map((item) => ({
        voice_id: item.voiceId,
        weight: item.weight,
      }));
    }
    const response = await axios.post(`${baseUrl}/v1/tts`, payload, { headers, timeout: 120000 });
    sourceUrl = resolveSourceUrl(response.data || {}, baseUrl);
  }

  if (!String(sourceUrl || "").trim()) {
    throw new Error("未能生成参考音色");
  }
  return persistDerivedReferenceAudio(cachePath, sourceUrl);
}

// 语音预览
export default router.post(
  "/",
  validateFields({
    configId: z.number().optional().nullable(),
    text: z.string(),
    mode: z.enum(["text", "clone", "mix", "prompt_voice"]).optional(),
    voiceId: z.string().optional().nullable(),
    speed: z.number().optional().nullable(),
    format: z.string().optional().nullable(),
    sampleRate: z.number().optional().nullable(),
    referenceText: z.string().optional().nullable(),
    referenceAudioBase64: z.string().optional().nullable(),
    referenceAudioPath: z.string().optional().nullable(),
    promptText: z.string().optional().nullable(),
    mixVoices: z
      .array(
        z.object({
          voiceId: z.string(),
          weight: z.number().optional().nullable(),
        }),
      )
      .optional()
      .nullable(),
  }),
  async (req, res) => {
    const debugContext: Record<string, unknown> = {
      route: "/voice/preview",
    };
    try {
      const {
        configId,
        text,
        mode = "text",
        voiceId,
        speed,
        format,
        sampleRate,
        referenceText,
        referenceAudioBase64,
        referenceAudioPath,
        promptText,
        mixVoices,
      } = req.body;
      debugContext.request = {
        configId: configId ?? null,
        mode,
        voiceId: String(voiceId || "").trim() || null,
        textLength: String(text || "").length,
        hasReferenceText: !!String(referenceText || "").trim(),
        hasReferenceAudioBase64: !!String(referenceAudioBase64 || "").trim(),
        hasReferenceAudioPath: !!String(referenceAudioPath || "").trim(),
        promptTextLength: String(promptText || "").trim().length,
        mixVoiceCount: Array.isArray(mixVoices) ? mixVoices.length : 0,
      };

      const userId = Number((req as any)?.user?.id || 0);
      const persistedConfig = await getRuntimeStoryVoiceConfig(userId, configId);
      if (!persistedConfig) {
        return res.status(400).send(error("语音模型配置不存在"));
      }
      const normalizedConfig = normalizePersistedVoiceConfig({
        manufacturer: persistedConfig.manufacturer,
        modelType: persistedConfig.modelType,
        model: persistedConfig.model,
        baseUrl: persistedConfig.baseUrl,
      });
      const config = {
        ...persistedConfig,
        ...normalizedConfig,
      };
      debugContext.userId = userId;
      debugContext.config = {
        id: Number(config.id || 0),
        manufacturer: String(config.manufacturer || "").trim(),
        model: String(config.model || "").trim(),
        modelType: String(config.modelType || "").trim(),
        baseUrl: String(config.baseUrl || "").trim(),
      };
      debugContext.requestedConfigId = configId ?? null;
      debugContext.resolvedConfigId = Number(config.id || 0);

      const baseUrl = normalizeVoiceBaseUrl(config.baseUrl);
      const manufacturer = String(config.manufacturer || "").trim();
      const voiceDesignConfig = mode === "prompt_voice" ? await getStoryVoiceDesignConfig(userId) : null;
      const unsupportedModeReason = resolveUnsupportedVoiceModeReason({
        manufacturer,
        modelType: config.modelType,
        model: config.model,
        mode,
      });
      if (unsupportedModeReason) {
        return res.status(400).send(error(unsupportedModeReason));
      }
      if (mode === "prompt_voice" && !voiceDesignConfig) {
        return res.status(400).send(error("请先在设置里配置语音设计模型"));
      }
      const suppliers = voiceSupplierFromManufacturer(manufacturer);
      const directAliyun = isDirectAliyunManufacturer(manufacturer);
      const headers: Record<string, string> = {};
      if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
      }

      const payload: Record<string, any> = {
        text,
        mode,
        format: normalizePreviewFormat(format),
        use_cache: true,
      };
      const normalizedSampleRate = normalizePreviewSampleRate(sampleRate);
      if (suppliers) {
        payload.suppliers = suppliers;
      }
      if (typeof speed === "number") {
        payload.speed = speed;
      }
      if (isAliyunVoiceManufacturer(manufacturer) && String(config.model || "").trim()) {
        payload.model = String(config.model || "").trim();
      }

      let resolvedProvider = "";
      const businessPresets = await ensureBusinessVoicePresets(userId);
      const providerPresetPool = directAliyun
        ? directAliyunVoicePresets(String(config.model || "").trim())
        : filterVoicePresetsByManufacturer(await fetchVoicePresets(baseUrl, headers), manufacturer);
      const mergedPresetPool = [...businessPresets, ...providerPresetPool].filter(
        (item, index, list) => list.findIndex((row) => row.voiceId === item.voiceId) === index,
      );
      const rawVoiceId = String(voiceId || "").trim();
      let effectiveVoiceId = rawVoiceId;
      let presetProvider = "";
      let businessPreset = findBusinessVoicePreset(effectiveVoiceId);
      let preset = effectiveVoiceId ? mergedPresetPool.find((item: { voiceId: string }) => item.voiceId === effectiveVoiceId) : null;
      const resolvedReferenceAudioSource = toReferenceAudioSource(referenceAudioPath, referenceAudioBase64);

      if (!preset && effectiveVoiceId) {
        const fallbackId = fallbackBusinessVoiceId(inferVoiceGenderHint(effectiveVoiceId));
        if (fallbackId) {
          effectiveVoiceId = fallbackId;
          businessPreset = findBusinessVoicePreset(fallbackId);
          preset = mergedPresetPool.find((item: { voiceId: string }) => item.voiceId === fallbackId) || businessPreset;
        }
      }
      presetProvider = String(preset?.provider || "").trim();

      if (presetProvider && !directAliyun) resolvedProvider = presetProvider;

      let compatibilityPresetId = "";
      if (businessPreset) {
        compatibilityPresetId = businessPreset.voiceId;
        if (
          String(text || "").trim() === String(businessPreset.referenceText || "").trim()
          && (!speed || Number(speed) === 1)
        ) {
          const seedAudioUrl = buildProxyAudioUrl(req, null, businessPreset.referencePath);
          return res.status(200).send(success({
            audioUrl: seedAudioUrl,
            data: {
              compatibilityPreset: businessPreset.voiceId,
              compatibilitySeed: true,
            },
          }));
        }
        if (directAliyun) {
          const directFallbackVoiceId = resolveDirectAliyunBusinessPresetVoiceId(config, businessPreset);
          if (directFallbackVoiceId) {
            effectiveVoiceId = directFallbackVoiceId;
            preset = providerPresetPool.find((item: { voiceId: string }) => item.voiceId === directFallbackVoiceId) || null;
            businessPreset = null;
            presetProvider = String(preset?.provider || "").trim();
          }
        }
      }

      if (businessPreset) {
        const cloned = await synthesizeWithLocalClone(
          req,
          userId,
          text,
          businessPreset.referencePath,
          businessPreset.referenceText,
          payload.format,
          speed,
        );
        return res.status(200).send(success({ audioUrl: cloned.audioUrl, data: { ...cloned.data, compatibilityPreset: businessPreset.voiceId } }));
      }

      if (mode === "text") {
        if (effectiveVoiceId) payload.voice_id = effectiveVoiceId;
        if (resolvedProvider) payload.provider = resolvedProvider;
      } else if (mode === "clone") {
        if (resolvedReferenceAudioSource) {
          if (directAliyun) {
            const customVoice = await createDirectAliyunCustomVoice({
              config,
              mode,
              referenceAudioSource: resolvedReferenceAudioSource,
              sampleRate: normalizedSampleRate,
            });
            const synthesized = await synthesizeDirectAliyunPreviewAudioWithRetry({
              config,
              headers,
              userId,
              text,
              voiceId: customVoice.voiceId,
              format: payload.format,
              sampleRate: normalizedSampleRate,
              speed,
              fresh: customVoice.fresh,
            });
            const audioUrl = buildProxyAudioUrl(req, config?.id, synthesized.sourceUrl);
            return res.status(200).send(success({
              audioUrl,
              data: {
                ...synthesized.data,
                customVoiceId: customVoice.voiceId,
                customVoiceMode: mode,
              },
            }));
          }
          const cloned = await synthesizeWithLocalClone(
            req,
            userId,
            text,
            resolvedReferenceAudioSource,
            String(referenceText || "").trim(),
            payload.format,
            speed,
          );
          return res.status(200).send(success({ audioUrl: cloned.audioUrl, data: cloned.data }));
        }
        return res.status(400).send(error("克隆模式需要参考音频"));
      } else if (mode === "mix") {
        const normalizedMixVoices = normalizeMixVoiceItems((mixVoices || []) as Array<{ voiceId: string; weight?: number | null }>);
        const mixList = normalizedMixVoices.map((item) => ({
          voice_id: item.voiceId,
          weight: item.weight,
        }));
        if (!mixList.length) {
          return res.status(400).send(error("混合模式需要选择音色"));
        }
        const mixIds = mixList.map((item: { voice_id: string }) => String(item.voice_id || "").trim()).filter(Boolean);
        if (mixIds.length) {
          const mixProviders = Array.from(
            new Set(
              filterVoicePresetsByManufacturer(await fetchVoicePresets(baseUrl, headers), manufacturer)
                .filter((item: { voiceId: string; provider: string }) => mixIds.includes(item.voiceId) && item.provider)
                .map((item: { provider: string }) => item.provider),
            ),
          );
          if (mixProviders.length === 1) {
            if (!directAliyun) {
              payload.provider = mixProviders[0];
            }
          }
        }
        const generatedReferencePath = await synthesizeReferenceAudioFromMode({
          config,
          manufacturer,
          baseUrl,
          headers,
          mode,
          voiceId: effectiveVoiceId,
          promptText: String(promptText || "").trim(),
          mixVoices: normalizedMixVoices,
          sampleRate: normalizedSampleRate,
          resolvedProvider: String(payload.provider || ""),
          userId,
        });
        if (directAliyun) {
          const customVoice = await createDirectAliyunCustomVoice({
            config,
            mode,
            referenceAudioSource: generatedReferencePath,
            sampleRate: normalizedSampleRate,
            mixVoices: normalizedMixVoices,
          });
          const synthesized = await synthesizeDirectAliyunPreviewAudioWithRetry({
            config,
            headers,
            userId,
            text,
            voiceId: customVoice.voiceId,
            format: payload.format,
            sampleRate: normalizedSampleRate,
            speed,
            fresh: customVoice.fresh,
          });
          const audioUrl = buildProxyAudioUrl(req, config?.id, synthesized.sourceUrl);
          return res.status(200).send(success({
            audioUrl,
            data: {
              ...synthesized.data,
              customVoiceId: customVoice.voiceId,
              customVoiceMode: mode,
              compatibilityReferencePath: generatedReferencePath,
            },
          }));
        }
        const cloned = await synthesizeWithLocalClone(
          req,
          userId,
          text,
          generatedReferencePath,
          BUSINESS_VOICE_PRESET_SEED_TEXT,
          payload.format,
          speed,
        );
        return res.status(200).send(success({ audioUrl: cloned.audioUrl, data: { ...cloned.data, compatibilityReferencePath: generatedReferencePath } }));
      } else if (mode === "prompt_voice") {
        if (!promptText) {
          return res.status(400).send(error("提示词模式需要填写提示词"));
        }
        if (directAliyun) {
          const customVoice = await createDirectAliyunCustomVoice({
            config,
            mode,
            promptText: String(promptText || "").trim(),
            sampleRate: normalizedSampleRate,
            voiceDesignConfig,
          });
          const synthesized = await synthesizeDirectAliyunPreviewAudioWithRetry({
            config,
            headers,
            userId,
            text,
            voiceId: customVoice.voiceId,
            format: payload.format,
            sampleRate: normalizedSampleRate,
            speed,
            fresh: customVoice.fresh,
          });
          const audioUrl = buildProxyAudioUrl(req, config?.id, synthesized.sourceUrl);
          return res.status(200).send(success({
            audioUrl,
            data: {
              ...synthesized.data,
              customVoiceId: customVoice.voiceId,
              customVoiceMode: mode,
            },
          }));
        }
        const generatedReferencePath = await synthesizeReferenceAudioFromMode({
          config,
          manufacturer,
          baseUrl,
          headers,
          mode,
          voiceId: effectiveVoiceId,
          promptText: String(promptText || "").trim(),
          mixVoices: [],
          sampleRate: normalizedSampleRate,
          resolvedProvider,
          userId,
          voiceDesignConfig,
        });
        const cloned = await synthesizeWithLocalClone(
          req,
          userId,
          text,
          generatedReferencePath,
          BUSINESS_VOICE_PRESET_SEED_TEXT,
          payload.format,
          speed,
        );
        return res.status(200).send(success({ audioUrl: cloned.audioUrl, data: { ...cloned.data, compatibilityReferencePath: generatedReferencePath } }));
      }

      let data: Record<string, any> = {};
      let sourceUrl = "";

      if (directAliyun) {
        const directModel = normalizeAliyunDirectTtsModel(String(config.model || "").trim());
        const directVoiceId = effectiveVoiceId || defaultAliyunDirectVoiceId(directModel);
        if (isAliyunDirectCosyVoiceModel(directModel)) {
          const buffer = await synthesizeAliyunDirectCosyVoiceBuffer({
            apiKey: String(config.apiKey || "").trim(),
            baseUrl: config.baseUrl,
            model: directModel,
            voiceId: directVoiceId,
            text: String(text || ""),
            format: payload.format,
            sampleRate: normalizedSampleRate,
            speed,
          });
          sourceUrl = await persistPreviewAudioBuffer(userId, buffer, payload.format);
          data = {
            localGenerated: true,
            mode: "websocket",
            voice: directVoiceId,
            model: directModel,
          };
        } else {
          const endpoint = resolveAliyunDirectTtsEndpoint(config.baseUrl);
          const directInput: Record<string, any> = {
            text,
            language_type: "Chinese",
          };
          if (directVoiceId) {
            directInput.voice = directVoiceId;
          }
          const response = await axios.post(
            endpoint,
            {
              model: directModel,
              input: directInput,
            },
            { headers, timeout: 120000 },
          );
          data = response.data || {};
          sourceUrl = String(data?.output?.audio?.url || "").trim();
        }
      } else {
        const response = await axios.post(`${baseUrl}/v1/tts`, payload, { headers });
        data = response.data || {};
        sourceUrl =
          data.audio_url_full ||
          (data.audio_url ? `${baseUrl}${String(data.audio_url).startsWith("/") ? "" : "/"}${data.audio_url}` : "");
      }

      if (!String(sourceUrl || "").trim()) {
        return res.status(500).send(error("未返回可用音频地址"));
      }
      const audioUrl = buildProxyAudioUrl(req, config?.id, sourceUrl);
      if (compatibilityPresetId) {
        data = {
          ...data,
          compatibilityPreset: compatibilityPresetId,
          compatibilityVoiceId: effectiveVoiceId || null,
        };
      }
      debugContext.result = {
        sourceUrl,
        proxied: audioUrl,
      };

      res.status(200).send(success({ audioUrl, data }));
    } catch (err) {
      const axiosErr = axios.isAxiosError(err) ? err : null;
      const upstreamCode = trimText(axiosErr?.response?.data?.code);
      const upstreamMessage = trimText(axiosErr?.response?.data?.message);
      let responseStatus = 500;
      let responseMessage = u.error(err).message;
      if (
        upstreamCode === "Audio.DecoderError"
        || /detect audio failed/i.test(responseMessage)
        || /detect audio failed/i.test(upstreamMessage)
      ) {
        responseStatus = 400;
        responseMessage = "参考音频无法被阿里云解码，请使用采样率大于 16kHz 的 16bit WAV/MP3/M4A/AAC 音频，并确保音频中有清晰有效的人声";
      } else if (
        /当前语音设计模型与所选故事语音模型不兼容|请先在设置里配置语音设计模型|当前语音模型不支持该绑定模式|克隆模式需要参考音频|提示词模式需要填写提示词|混合模式需要选择音色|语音模型配置不存在|当前阿里云直连模型不支持该绑定模式|当前阿里云直连模型缺少 API Key|参考音频需要提供公网可访问的 http/i.test(responseMessage)
      ) {
        responseStatus = 400;
      } else if (axiosErr?.response?.status && axiosErr.response.status >= 400 && axiosErr.response.status < 500) {
        responseStatus = 400;
        responseMessage = responseMessage || upstreamMessage || "语音预览请求无效";
      }
      console.error("[voice] preview failed", {
        ...debugContext,
        message: responseMessage,
        stack: err instanceof Error ? err.stack : undefined,
        upstream: axiosErr
          ? {
              code: axiosErr.code,
              status: axiosErr.response?.status,
              method: axiosErr.config?.method,
              url: axiosErr.config?.url,
              responseData: axiosErr.response?.data,
            }
          : null,
      });
      res.status(responseStatus).send(error(responseMessage));
    }
  },
);
