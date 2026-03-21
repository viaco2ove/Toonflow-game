import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

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
      if (!result[row.manufacturer]) {
        result[row.manufacturer] = [];
      }
      result[row.manufacturer].push({ label: row.model, value: row.model });
    }

    // 兼容旧库：确保文本模型列表始终包含 t8star 选项
    if (type === "text") {
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

    res.status(200).send(success(result));
  },
);
