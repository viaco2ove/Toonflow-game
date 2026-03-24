import express from "express";
import axios from "axios";
import u from "@/utils";
import { error } from "@/lib/responseFormat";

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

function resolveSourceUrl(source: string, baseUrl: string): string {
  const raw = String(source || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/")) return `${baseUrl}${raw}`;
  return `${baseUrl}/${raw}`;
}

router.get("/", async (req, res) => {
  try {
    const userId = Number((req as any)?.user?.id || 0);
    const configId = Number(req.query.configId || 0) || null;
    const source = String(req.query.source || "").trim();
    if (!source) {
      return res.status(400).send(error("缺少音频地址"));
    }

    const config = await getVoiceConfig(userId, configId);
    if (!config) {
      return res.status(400).send(error("语音模型配置不存在"));
    }

    const targetUrl = resolveSourceUrl(source, normalizeBaseUrl(config.baseUrl));
    if (!targetUrl) {
      return res.status(400).send(error("音频地址无效"));
    }

    const response = await axios.get<ArrayBuffer>(targetUrl, {
      responseType: "arraybuffer",
      headers: config.apiKey
        ? {
            Authorization: `Bearer ${config.apiKey}`,
          }
        : undefined,
    });

    const contentType = String(response.headers["content-type"] || "audio/wav");
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(Buffer.from(response.data));
  } catch (err) {
    return res.status(500).send(error(u.error(err).message));
  }
});

export default router;
