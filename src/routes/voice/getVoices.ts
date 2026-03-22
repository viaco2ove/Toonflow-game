import express from "express";
import axios from "axios";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";

const router = express.Router();

function normalizeBaseUrl(input: string | null | undefined): string {
  const base = String(input || "").trim();
  return (base || "http://127.0.0.1:8000").replace(/\/+$/, "");
}

async function getVoiceConfig(userId: number, configId?: number | null) {
  if (configId) {
    return u.db("t_config").where({ id: configId, type: "voice", userId }).first();
  }
  return u.db("t_config").where({ type: "voice", userId }).first();
}

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
      const config = await getVoiceConfig(userId, configId);
      if (!config) {
        return res.status(400).send(error("语音模型配置不存在"));
      }

      const baseUrl = normalizeBaseUrl(config.baseUrl);
      const url = `${baseUrl}/voices`;
      const headers: Record<string, string> = {};
      if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
      }

      const response = await axios.get(url, { headers });
      const data = (response.data as any)?.data ?? response.data;
      res.status(200).send(success(data));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
