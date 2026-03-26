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
    type: z.enum(["text", "video", "image", "voice", "voice_design"]),
    model: z.string(),
    baseUrl: z.string(),
    apiKey: z.string(),
    modelType: z.string(),
    manufacturer: z.string(),
  }),
  async (req, res) => {
    const { type, model, baseUrl, apiKey, manufacturer, modelType } = req.body;
    const userId = Number((req as any)?.user?.id || 0);
    const normalized = normalizeExternalModelConfig({ type, model, baseUrl, apiKey, manufacturer, modelType });

    await u.db("t_config").insert({
      type: normalized.persistedType,
      model: normalized.model,
      baseUrl: normalized.baseUrl,
      apiKey: normalized.apiKey,
      manufacturer: normalized.manufacturer,
      modelType: normalized.modelType,
      createTime: Date.now(),
      userId,
    });
    res.status(200).send(success("新增成功"));
  },
);
