import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { normalizePersistedVoiceConfig } from "@/lib/voiceGateway";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    type: z.enum(["text", "video", "image", "voice"]),
    model: z.string(),
    baseUrl: z.string(),
    modelType: z.string(),
    apiKey: z.string(),
    manufacturer: z.string(),
  }),
  async (req, res) => {
    const { id, type, model, baseUrl, apiKey, manufacturer, modelType } = req.body;
    const userId = Number((req as any)?.user?.id || 0);
    const normalizedVoiceConfig = type === "voice"
      ? normalizePersistedVoiceConfig({ manufacturer, modelType, model, baseUrl })
      : { model, baseUrl };

    await u.db("t_config").where({ id, userId }).update({
      type,
      model: normalizedVoiceConfig.model,
      baseUrl: normalizedVoiceConfig.baseUrl,
      apiKey,
      manufacturer,
      modelType,
    });
    res.status(200).send(success("编辑成功"));
  },
);
