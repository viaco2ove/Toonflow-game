import express from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { success, error } from "@/lib/responseFormat";
import { synthesizeVoiceDesignBuffer } from "@/lib/voiceDesign";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    modelName: z.string(),
    apiKey: z.string(),
    baseURL: z.string().optional(),
    manufacturer: z.string(),
  }),
  async (req, res) => {
    const { modelName, apiKey, baseURL, manufacturer } = req.body;
    const userId = Number((req as any)?.user?.id || 0);

    try {
      const designed = await synthesizeVoiceDesignBuffer({
        userId,
        promptText: "青年男性，明亮，自信，力量感，清晰，故事感",
        previewText: "这是 AI 故事设置页的语音设计模型测试。",
        preferredName: "settings_test",
        config: {
          model: String(modelName || "").trim(),
          apiKey: String(apiKey || "").trim(),
          baseURL: String(baseURL || "").trim(),
          manufacturer: String(manufacturer || "").trim(),
        },
      });
      const savePath = `/temp/voice-design-test/${userId || "guest"}/${Date.now()}_${uuidv4()}.wav`;
      await u.oss.writeFile(savePath, designed.buffer);
      const audioUrl = await u.oss.getFileUrl(savePath);
      res.status(200).send(success(audioUrl));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
