import express from "express";
import axios from "axios";
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
  isDirectAliyunManufacturer,
  normalizeAliyunDirectTtsModel,
  normalizeVoiceBaseUrl,
  resolveAliyunDirectTtsEndpoint,
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
import FormData from "form-data";
import { synthesizeAliyunDirectCosyVoiceBuffer } from "@/lib/aliyunCosyVoice";
import { v4 as uuidv4 } from "uuid";

const router = express.Router();

type VoiceMode = "text" | "clone" | "mix" | "prompt_voice";

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

async function synthesizeReferenceAudioFromMode(options: {
  config: any;
  manufacturer: string;
  baseUrl: string;
  headers: Record<string, string>;
  mode: VoiceMode;
  voiceId: string;
  promptText: string;
  mixVoices: Array<{ voiceId: string; weight?: number | null }>;
  resolvedProvider: string;
  textSeed?: string;
  userId: number;
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
    resolvedProvider,
    textSeed = BUSINESS_VOICE_PRESET_SEED_TEXT,
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

  let sourceUrl = "";

  if (isDirectAliyunManufacturer(manufacturer)) {
    const directModel = normalizeAliyunDirectTtsModel(String(config.model || "").trim());
    const directVoiceId = String(voiceId || "").trim() || defaultAliyunDirectVoiceId(directModel);
    if (isAliyunDirectCosyVoiceModel(directModel)) {
      if (mode !== "text") {
        throw new Error("当前阿里云直连 CosyVoice 模型仅支持预设音色，请切换到 qwen3-tts-instruct-flash 或本地克隆模型");
      }
      const buffer = await synthesizeAliyunDirectCosyVoiceBuffer({
        apiKey: String(config.apiKey || "").trim(),
        baseUrl: config.baseUrl,
        model: directModel,
        voiceId: directVoiceId,
        text: textSeed,
        format: "wav",
      });
      await u.oss.writeFile(cachePath, buffer);
      return cachePath;
    }
    const endpoint = resolveAliyunDirectTtsEndpoint(config.baseUrl);
    const directInput: Record<string, any> = {
      text: textSeed,
      language_type: "Chinese",
      instructions: promptText,
      optimize_instructions: true,
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
    sourceUrl = String(response.data?.output?.audio?.url || "").trim();
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
    if (mode === "prompt_voice") {
      payload.prompt_text = promptText;
    } else if (mode === "mix") {
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
      const config = await getRuntimeStoryVoiceConfig(userId, configId);
      if (!config) {
        return res.status(400).send(error("语音模型配置不存在"));
      }
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
      const suppliers = voiceSupplierFromManufacturer(manufacturer);
      const directAliyun = isDirectAliyunManufacturer(manufacturer);
      const headers: Record<string, string> = {};
      if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
      }

      const payload: Record<string, any> = {
        text,
        mode,
        format: format || "wav",
        use_cache: true,
      };
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

      if (businessPreset) {
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
          resolvedProvider: String(payload.provider || ""),
          userId,
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
      } else if (mode === "prompt_voice") {
        if (!promptText) {
          return res.status(400).send(error("提示词模式需要填写提示词"));
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
          resolvedProvider,
          userId,
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
      debugContext.result = {
        sourceUrl,
        proxied: audioUrl,
      };

      res.status(200).send(success({ audioUrl, data }));
    } catch (err) {
      const axiosErr = axios.isAxiosError(err) ? err : null;
      console.error("[voice] preview failed", {
        ...debugContext,
        message: u.error(err).message,
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
      res.status(500).send(error(u.error(err).message));
    }
  },
);
