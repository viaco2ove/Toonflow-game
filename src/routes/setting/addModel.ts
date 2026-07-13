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
    type: z.enum(["text", "video", "image", "voice", "voice_design", "voice_clone"]),
    model: z.string(),
    baseUrl: z.string(),
    apiKey: z.string(),
    modelType: z.string(),
    manufacturer: z.string(),
    inputPricePer1M: z.union([z.number(), z.string()]).optional(),
    outputPricePer1M: z.union([z.number(), z.string()]).optional(),
    cacheReadPricePer1M: z.union([z.number(), z.string()]).optional(),
    currency: z.string().optional(),
    reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high"]).optional(),
    temperature: z.union([z.number(), z.string()]).optional(),
    topP: z.union([z.number(), z.string()]).optional(),
    remark: z.string().optional(),
  }),
  async (req, res) => {
    const { type, model, baseUrl, apiKey, manufacturer, modelType, inputPricePer1M, outputPricePer1M, cacheReadPricePer1M, currency, reasoningEffort, temperature, topP, remark } = req.body;
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
      temperature,
      topP,
    });

    await u.db("t_config").insert({
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
      temperature: normalized.persistedType === "text" ? normalized.temperature : null,
      topP: normalized.persistedType === "text" ? normalized.topP : null,
      remark: remark || null,
      createTime: Date.now(),
      userId,
    });
    console.log("[addModel] 新增配置", {
      inputType: type,
      inputModelType: modelType,
      inputManufacturer: manufacturer,
      persistedType: normalized.persistedType,
      modelType_result: normalized.modelType,
    });
    res.status(200).send(success("新增成功"));
  },
);
