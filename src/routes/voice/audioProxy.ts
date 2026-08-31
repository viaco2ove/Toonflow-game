import express from "express";
import axios from "axios";
import u from "@/utils";
import { error } from "@/lib/responseFormat";
import { ensureBundledVoicePresetSeed } from "@/lib/voicePresetSeeds";

const router = express.Router();

function normalizeBaseUrl(input: string | null | undefined): string {
  const base = String(input || "").trim();
  return (base ).replace(/\/+$/, "");
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

function isLocalOssAudioSource(source: string): boolean {
  const raw = String(source || "").trim();
  return /^\/?(system|user|\d+)\//i.test(raw);
}

function inferAudioContentType(source: string): string {
  const raw = String(source || "").trim().toLowerCase();
  if (raw.endsWith(".mp3")) return "audio/mpeg";
  if (raw.endsWith(".ogg")) return "audio/ogg";
  if (raw.endsWith(".webm")) return "audio/webm";
  if (raw.endsWith(".m4a")) return "audio/mp4";
  if (raw.endsWith(".aac")) return "audio/aac";
  if (raw.endsWith(".flac")) return "audio/flac";
  return "audio/wav";
}

router.get("/", async (req, res) => {
  const requestStart = Date.now();
  const debugMeta: Record<string, unknown> = {
    route: "/voice/audioProxy",
    requestId: `aproxy_${requestStart}_${Math.random().toString(36).slice(2, 8)}`,
  };
  try {
    const userId = Number((req as any)?.user?.id || 0);
    const configId = Number(req.query.configId || 0) || null;
    const source = String(req.query.source || "").trim();
    debugMeta.userId = userId;
    debugMeta.configId = configId;
    debugMeta.source = source;
    debugMeta.isLocalOss = isLocalOssAudioSource(source);
    debugMeta.hasToken = Boolean(req.query.token);
    console.log("[audioProxy] request start", debugMeta);
    if (!source) {
      console.log("[audioProxy] missing source, return 400", debugMeta);
      return res.status(400).send(error("缺少音频地址"));
    }

    if (isLocalOssAudioSource(source)) {
      try {
        const buffer = await u.oss.getFile(source);
        console.log("[audioProxy] oss hit", {
          ...debugMeta,
          bytes: buffer.length,
          contentType: inferAudioContentType(source),
          elapsedMs: Date.now() - requestStart,
        });
        res.setHeader("Content-Type", inferAudioContentType(source));
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-AudioProxy-Debug", String(debugMeta.requestId));
        return res.status(200).send(buffer);
      } catch (err) {
        console.error("[audioProxy] oss read failed:", u.error(err).message, debugMeta);
        const maybeSeedName = String(source || "").trim().split("/").pop() || "";
        if (/^\/system\/voice-presets\/[^/]+\.wav$/i.test(source) && maybeSeedName) {
          await ensureBundledVoicePresetSeed(maybeSeedName);
          const buffer = await u.oss.getFile(source);
          console.log("[audioProxy] oss seed hit", {
            ...debugMeta,
            bytes: buffer.length,
            elapsedMs: Date.now() - requestStart,
          });
          res.setHeader("Content-Type", inferAudioContentType(source));
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("X-AudioProxy-Debug", String(debugMeta.requestId));
          return res.status(200).send(buffer);
        }
        throw err;
      }
    }

    const config = await getVoiceConfig(userId, configId);
    if (!config) {
      console.log("[audioProxy] config not found", debugMeta);
      return res.status(400).send(error("语音模型配置不存在"));
    }
    debugMeta.configManufacturer = String(config.manufacturer || "");
    debugMeta.configModel = String(config.model || "");

    const targetUrl = resolveSourceUrl(source, normalizeBaseUrl(config.baseUrl));
    if (!targetUrl) {
      console.log("[audioProxy] invalid target url", debugMeta);
      return res.status(400).send(error("音频地址无效"));
    }
    debugMeta.targetUrl = targetUrl;

    const response = await axios.get<ArrayBuffer>(targetUrl, {
      responseType: "arraybuffer",
      headers: config.apiKey
        ? {
            Authorization: `Bearer ${config.apiKey}`,
          }
        : undefined,
    });

    const contentType = String(response.headers["content-type"] || "audio/wav");
    const outBuf = Buffer.from(response.data);
    console.log("[audioProxy] upstream success", {
      ...debugMeta,
      upstreamContentType: response.headers["content-type"],
      upstreamBytes: outBuf.length,
      elapsedMs: Date.now() - requestStart,
    });
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-AudioProxy-Debug", String(debugMeta.requestId));
    return res.status(200).send(outBuf);
  } catch (err) {
    console.error("[audioProxy] failed", {
      ...debugMeta,
      error: u.error(err).message,
      stack: (err as any)?.stack,
      elapsedMs: Date.now() - requestStart,
    });
    return res.status(500).send(error(u.error(err).message));
  }
});

export default router;
