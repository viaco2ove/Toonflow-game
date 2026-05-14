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
    inputPricePer1M: z.union([z.number(), z.string()]).optional(),
    outputPricePer1M: z.union([z.number(), z.string()]).optional(),
    cacheReadPricePer1M: z.union([z.number(), z.string()]).optional(),
    currency: z.string().optional(),
    reasoningEffort: z.enum(["minimal", "low", "medium", "high"]).optional(),
  }),
  async (req, res) => {
    const { id, type, model, baseUrl, apiKey, manufacturer, modelType, inputPricePer1M, outputPricePer1M, cacheReadPricePer1M, currency, reasoningEffort } = req.body;
    const userId = Number((req as any)?.user?.id || 0);
    const normalized = normalizeExternalModelConfig({
      type,
      model,
      baseUrl,
      apiKey,
      manufacturer,
      modelType,
      inputPricePer1M,
      outputPricePer1M,
      cacheReadPricePer1M,
      currency,
      reasoningEffort,
    });

    await u.db("t_config").where({ id, userId }).update({
      type: normalized.persistedType,
      model: normalized.model,
      baseUrl: normalized.baseUrl,
      apiKey: normalized.apiKey,
      manufacturer: normalized.manufacturer,
      modelType: normalized.modelType,
      inputPricePer1M: normalized.inputPricePer1M,
      outputPricePer1M: normalized.outputPricePer1M,
      cacheReadPricePer1M: normalized.cacheReadPricePer1M,
      currency: normalized.currency,
      reasoningEffort: normalized.persistedType === "text" ? normalized.reasoningEffort : null,
    });
    res.status(200).send(success("编辑成功"));
  },
);
