import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { normalizeExternalModelConfig, normalizeVoiceSegmentFields } from "@/lib/modelConfigType";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    type: z.enum(["text", "video", "image", "voice", "voice_design", "voice_clone"]),
    model: z.string(),
    baseUrl: z.string(),
    modelType: z.string(),
    apiKey: z.string(),
    manufacturer: z.string(),
    inputPricePer1M: z.union([z.number(), z.string()]).optional(),
    outputPricePer1M: z.union([z.number(), z.string()]).optional(),
    cacheReadPricePer1M: z.union([z.number(), z.string()]).optional(),
    currency: z.string().optional(),
    reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high"]).optional(),
    temperature: z.union([z.number(), z.string()]).optional(),
    topP: z.union([z.number(), z.string()]).optional(),
    remark: z.string().optional(),
    // 语音合成「分段」配置：punctuation=按标点符号 / chars=按字数；仅 tts 类型有意义
    segmentMode: z.enum(["punctuation", "chars"]).nullable().optional(),
    segmentChars: z.number().int().nullable().optional(),
  }),
  async (req, res) => {
    const { id, type, model, baseUrl, apiKey, manufacturer, modelType, inputPricePer1M, outputPricePer1M, cacheReadPricePer1M, currency, reasoningEffort, temperature, topP, remark, segmentMode, segmentChars } = req.body;
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
    // 分段配置规范化：非法值落 null，前端按默认（按标点符号/100字）兜底
    const segment = normalizeVoiceSegmentFields(segmentMode, segmentChars);

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
      temperature: normalized.persistedType === "text" ? normalized.temperature : null,
      topP: normalized.persistedType === "text" ? normalized.topP : null,
      remark: remark || null,
      segmentMode: segment.segmentMode,
      segmentChars: segment.segmentChars,
    });
    res.status(200).send(success("编辑成功"));
  },
);
