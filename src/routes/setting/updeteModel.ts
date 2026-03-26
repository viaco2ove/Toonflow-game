import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { normalizeExternalModelConfig } from "@/lib/modelConfigType";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    type: z.enum(["text", "video", "image", "voice", "voice_design"]),
    model: z.string(),
    baseUrl: z.string(),
    modelType: z.string(),
    apiKey: z.string(),
    manufacturer: z.string(),
  }),
  async (req, res) => {
    const { id, type, model, baseUrl, apiKey, manufacturer, modelType } = req.body;
    const userId = Number((req as any)?.user?.id || 0);
    const normalized = normalizeExternalModelConfig({ type, model, baseUrl, apiKey, manufacturer, modelType });

    await u.db("t_config").where({ id, userId }).update({
      type: normalized.persistedType,
      model: normalized.model,
      baseUrl: normalized.baseUrl,
      apiKey: normalized.apiKey,
      manufacturer: normalized.manufacturer,
      modelType: normalized.modelType,
    });
    res.status(200).send(success("编辑成功"));
  },
);
