import express from "express";
import axios from "axios";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import {
  fetchVoicePresets,
  filterVoicePresetsByManufacturer,
  getUserVoiceConfig,
  normalizeVoiceBaseUrl,
  voiceSupplierFromManufacturer,
} from "@/lib/voiceGateway";
import FormData from "form-data";

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

  return u.oss.getFile(raw);
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

      const userId = Number((req as any)?.user?.id || 0);
      const config = await getUserVoiceConfig(userId, configId);
      if (!config) {
        return res.status(400).send(error("语音模型配置不存在"));
      }

      const baseUrl = normalizeVoiceBaseUrl(config.baseUrl);
      const manufacturer = String(config.manufacturer || "").trim();
      const suppliers = voiceSupplierFromManufacturer(manufacturer);
      const headers: Record<string, string> = {};
      if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
      }

      const payload: Record<string, any> = {
        text,
        mode,
        format: format || "wav",
        use_cache: true,
        suppliers,
      };
      if (typeof speed === "number") {
        payload.speed = speed;
      }
      if (manufacturer === "aliyun" && String(config.model || "").trim()) {
        payload.model = String(config.model || "").trim();
      }

      let resolvedProvider = "";
      const resolvedVoiceId = String(voiceId || "").trim();
      let presetProvider = "";

      if (resolvedVoiceId) {
        const preset = filterVoicePresetsByManufacturer(await fetchVoicePresets(baseUrl, headers), manufacturer).find(
          (item: { voiceId: string }) => item.voiceId === resolvedVoiceId,
        );
        presetProvider = String(preset?.provider || "").trim();
      }

      if (presetProvider) resolvedProvider = presetProvider;

      if (mode === "text") {
        if (resolvedVoiceId) payload.voice_id = resolvedVoiceId;
        if (resolvedProvider) payload.provider = resolvedProvider;
      } else if (mode === "clone") {
        if (suppliers === "aliyun") {
          return res.status(400).send(error("阿里云当前不支持克隆音色"));
        }
        if (referenceAudioPath) {
          const cloneForm = new FormData();
          cloneForm.append("text", text);
          cloneForm.append("format", payload.format);
          cloneForm.append("use_cache", String(payload.use_cache));
          cloneForm.append("suppliers", suppliers);
          if (typeof speed === "number") {
            cloneForm.append("speed", String(speed));
          }
          if (resolvedProvider) {
            cloneForm.append("provider", resolvedProvider);
          }
          if (referenceText) {
            cloneForm.append("reference_text", referenceText);
          }
          const fileBuffer = await loadReferenceAudioBuffer(referenceAudioPath);
          const fileExt = inferAudioExt(referenceAudioPath);
          cloneForm.append("reference_audio", fileBuffer, {
            filename: `reference.${fileExt}`,
            contentType: `audio/${fileExt === "mp3" ? "mpeg" : fileExt}`,
          });
          const cloneResponse = await axios.post(`${baseUrl}/v1/tts/clone_upload`, cloneForm, {
            headers: {
              ...headers,
              ...cloneForm.getHeaders(),
            },
          });
          const cloneData = cloneResponse.data || {};
          const cloneSourceUrl =
            cloneData.audio_url_full ||
            (cloneData.audio_url ? `${baseUrl}${String(cloneData.audio_url).startsWith("/") ? "" : "/"}${cloneData.audio_url}` : "");
          const cloneAudioUrl = buildProxyAudioUrl(req, config?.id, cloneSourceUrl);
          return res.status(200).send(success({ audioUrl: cloneAudioUrl, data: cloneData }));
        }
        if (resolvedProvider) payload.provider = resolvedProvider;
        let base64 = normalizeBase64(referenceAudioBase64);
        if (!base64) {
          return res.status(400).send(error("克隆模式需要参考音频"));
        }
        payload.reference_audio_base64 = base64;
        if (referenceText) payload.reference_text = referenceText;
      } else if (mode === "mix") {
        if (suppliers === "aliyun") {
          return res.status(400).send(error("阿里云当前不支持混合音色"));
        }
        const mixList = (mixVoices || []).map((item: any) => ({
          voice_id: item.voiceId,
          weight: typeof item.weight === "number" ? item.weight : 1,
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
            payload.provider = mixProviders[0];
          }
        }
        payload.mix_voices = mixList;
      } else if (mode === "prompt_voice") {
        if (!promptText) {
          return res.status(400).send(error("提示词模式需要填写提示词"));
        }
        if (resolvedVoiceId) payload.voice_id = resolvedVoiceId;
        if (resolvedProvider) payload.provider = resolvedProvider;
        payload.prompt_text = promptText;
      }

      const response = await axios.post(`${baseUrl}/v1/tts`, payload, { headers });
      const data = response.data || {};
      const sourceUrl =
        data.audio_url_full ||
        (data.audio_url ? `${baseUrl}${String(data.audio_url).startsWith("/") ? "" : "/"}${data.audio_url}` : "");
      const audioUrl = buildProxyAudioUrl(req, config?.id, sourceUrl);

      res.status(200).send(success({ audioUrl, data }));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
