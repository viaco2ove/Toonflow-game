import express from "express";
import axios from "axios";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";

const router = express.Router();

type VoiceMode = "text" | "clone" | "mix" | "prompt_voice";

function normalizeBaseUrl(input: string | null | undefined): string {
  const base = String(input || "").trim();
  return (base || "http://127.0.0.1:8000").replace(/\/+$/, "");
}

function normalizeBase64(input?: string | null): string {
  if (!input) return "";
  const match = input.match(/^data:([^;]+);base64,(.+)$/);
  return match ? match[2] || "" : input;
}

async function getVoiceConfig(configId?: number | null) {
  const userId = 1;
  if (configId) {
    return u.db("t_config").where({ id: configId, type: "voice", userId }).first();
  }
  return u.db("t_config").where({ type: "voice", userId }).first();
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

      const config = await getVoiceConfig(configId);
      if (!config) {
        return res.status(400).send(error("语音模型配置不存在"));
      }

      const baseUrl = normalizeBaseUrl(config.baseUrl);
      const url = `${baseUrl}/v1/tts`;
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
      if (typeof speed === "number") {
        payload.speed = speed;
      }

      const provider = String(config.model || "").trim();
      if (provider && provider !== "ai_voice_tts") {
        payload.provider = provider;
      }

      if (mode === "text") {
        if (voiceId) payload.voice_id = voiceId;
      } else if (mode === "clone") {
        let base64 = normalizeBase64(referenceAudioBase64);
        if (!base64 && referenceAudioPath) {
          const buffer = await u.oss.getFile(referenceAudioPath);
          base64 = buffer.toString("base64");
        }
        if (!base64) {
          return res.status(400).send(error("克隆模式需要参考音频"));
        }
        payload.reference_audio_base64 = base64;
        if (referenceText) payload.reference_text = referenceText;
      } else if (mode === "mix") {
        const mixList = (mixVoices || []).map((item: any) => ({
          voice_id: item.voiceId,
          weight: typeof item.weight === "number" ? item.weight : 1,
        }));
        if (!mixList.length) {
          return res.status(400).send(error("混合模式需要选择音色"));
        }
        payload.mix_voices = mixList;
      } else if (mode === "prompt_voice") {
        if (!promptText) {
          return res.status(400).send(error("提示词模式需要填写提示词"));
        }
        payload.prompt_text = promptText;
      }

      const response = await axios.post(url, payload, { headers });
      const data = response.data || {};
      const audioUrl =
        data.audio_url_full ||
        (data.audio_url ? `${baseUrl}${String(data.audio_url).startsWith("/") ? "" : "/"}${data.audio_url}` : "");

      res.status(200).send(success({ audioUrl, data }));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
