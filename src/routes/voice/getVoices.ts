import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import { fetchVoicePresets, filterVoicePresetsByManufacturer, getUserVoiceConfig, normalizeVoiceBaseUrl } from "@/lib/voiceGateway";

const router = express.Router();

// 获取音色预设
export default router.post(
  "/",
  validateFields({
    configId: z.number().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const { configId } = req.body;
      const userId = Number((req as any)?.user?.id || 0);
      const config = await getUserVoiceConfig(userId, configId);
      if (!config) {
        return res.status(400).send(error("语音模型配置不存在"));
      }

      const baseUrl = normalizeVoiceBaseUrl(config.baseUrl);
      const headers: Record<string, string> = {};
      if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
      }

      const presets = filterVoicePresetsByManufacturer(await fetchVoicePresets(baseUrl, headers), config.manufacturer);
      res.status(200).send(success(presets));
    } catch (err) {
      res.status(500).send(error((err as Error)?.message || "获取音色预设失败"));
    }
  },
);
