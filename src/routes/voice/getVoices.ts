import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import {
  directAliyunVoicePresets,
  fetchVoicePresets,
  filterVoicePresetsByManufacturer,
  getUserVoiceConfig,
  isDirectAliyunManufacturer,
  normalizeVoiceBaseUrl,
} from "@/lib/voiceGateway";
import { ensureBusinessVoicePresets } from "@/lib/businessVoicePresets";

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

      const businessPresets = await ensureBusinessVoicePresets(userId);
      let presets;
      if (isDirectAliyunManufacturer(config.manufacturer)) {
        presets = directAliyunVoicePresets();
      } else {
        try {
          presets = filterVoicePresetsByManufacturer(await fetchVoicePresets(baseUrl, headers), config.manufacturer);
        } catch (err) {
          throw err;
        }
      }
      const merged = [...businessPresets, ...presets].filter((item, index, list) => list.findIndex((row) => row.voiceId === item.voiceId) === index);
      res.status(200).send(success(merged));
    } catch (err) {
      res.status(500).send(error((err as Error)?.message || "获取音色预设失败"));
    }
  },
);
