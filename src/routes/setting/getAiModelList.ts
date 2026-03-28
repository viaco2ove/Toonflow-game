import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getModelList as getTextModelList } from "@/utils/ai/text/modelList";
const router = express.Router();

function normalizeManufacturerKey(input: unknown): string {
  const value = String(input || "").trim();
  if (!value) return "";
  if (value === "doubao") return "volcengine";
  if (value === "deepSeek") return "deepseek";
  if (value === "openAi") return "openai";
  return value;
}

function appendModelOption(result: Record<string, any[]>, manufacturer: unknown, model: unknown) {
  const manufacturerKey = normalizeManufacturerKey(manufacturer);
  const modelName = String(model || "").trim();
  if (!manufacturerKey || !modelName || manufacturerKey === "other") return;
  if (!result[manufacturerKey]) {
    result[manufacturerKey] = [];
  }
  const exists = result[manufacturerKey].some((item) => String(item?.value || "") === modelName);
  if (!exists) {
    result[manufacturerKey].push({ label: modelName, value: modelName });
  }
}

export default router.post(
  "/",
  validateFields({
    type: z.enum(["text", "image", "video", "voice"]),
  }),
  async (req, res) => {
    const { type } = req.body;
    const sqlTableMap = {
      text: "t_textModel",
      image: "t_imageModel",
      video: "t_videoModel",
      voice: "t_voiceModel",
    };
    const modelLists = await u
      .db(sqlTableMap[type as "image" | "text" | "video" | "voice"])
      .whereNot("manufacturer", "other")
      .select("id", "manufacturer", "model");
    const result: Record<string, any[]> = {};
    for (const row of modelLists) {
      appendModelOption(result, row.manufacturer, row.model);
    }

    if (type === "text") {
      const defaultTextModels = await getTextModelList();
      for (const item of defaultTextModels) {
        appendModelOption(result, item.manufacturer, item.model);
      }

      // 兼容旧库：确保文本模型列表始终包含 t8star 选项
      const t8starDefaults = [
        { label: "gpt-5.4-pro", value: "gpt-5.4-pro" },
        { label: "gemini-2.5-pro", value: "gemini-2.5-pro" },
      ];
      if (!result.t8star) result.t8star = [];
      for (const item of t8starDefaults) {
        const exists = result.t8star.some((model) => String(model?.value || "") === item.value);
        if (!exists) result.t8star.push(item);
      }
    }

    if (type === "image") {
      const briaDefaults = [
        { label: "RMBG-2.0", value: "RMBG-2.0" },
      ];
      if (!result.bria) result.bria = [];
      for (const item of briaDefaults) {
        const exists = result.bria.some((model) => String(model?.value || "") === item.value);
        if (!exists) result.bria.push(item);
      }

      const tencentDefaults = [
        { label: "AIPortraitMatting", value: "AIPortraitMatting" },
      ];
      if (!result.tencent_ci) result.tencent_ci = [];
      for (const item of tencentDefaults) {
        const exists = result.tencent_ci.some((model) => String(model?.value || "") === item.value);
        if (!exists) result.tencent_ci.push(item);
      }

      const localBiRefNetDefaults = [
        { label: "birefnet-portrait", value: "birefnet-portrait" },
        { label: "birefnet-general", value: "birefnet-general" },
        { label: "birefnet-general-lite", value: "birefnet-general-lite" },
      ];
      if (!result.local_birefnet) result.local_birefnet = [];
      for (const item of localBiRefNetDefaults) {
        const exists = result.local_birefnet.some((model) => String(model?.value || "") === item.value);
        if (!exists) result.local_birefnet.push(item);
      }
    }

    res.status(200).send(success(result));
  },
);
