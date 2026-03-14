import express from "express";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
const router = express.Router();

const DEBUG_MODE = (process.env.LOG_LEVEL || "").trim().toUpperCase() === "DEBUG";
const TEST_TIMEOUT_MS = Number.parseInt((process.env.TEST_MODEL_TIMEOUT_MS || "").trim(), 10) || 180000;

function maskKey(input?: string): string {
  const value = String(input || "").trim();
  if (!value) return "";
  if (value.length <= 8) return `${value.slice(0, 2)}***${value.slice(-2)}`;
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function trimPreview(input: unknown, size = 200): string {
  const text = String(input ?? "");
  return text.length > size ? `${text.slice(0, size)}...` : text;
}

function debugLog(step: string, payload?: Record<string, unknown>) {
  if (!DEBUG_MODE) return;
  if (payload) {
    console.log("[testVideo]", step, payload);
  } else {
    console.log("[testVideo]", step);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 检查语言模型
export default router.post(
  "/",
  validateFields({
    modelName: z.string().optional(),
    apiKey: z.string(),
    baseURL: z.string().optional(),
    manufacturer: z.string(),
  }),
  async (req, res) => {
    const { modelName, apiKey, baseURL, manufacturer } = req.body;
    const startedAt = Date.now();
    debugLog("request", {
      manufacturer,
      modelName: modelName || "",
      baseURL: baseURL || "",
      apiKey: maskKey(apiKey),
      timeoutMs: TEST_TIMEOUT_MS,
    });
    try {
      const duration = manufacturer == "gemini" ? 4 : 5;
      const videoPath = await withTimeout(
        u.ai.video(
          {
            imageBase64: [],
            savePath: "test.mp4",
            prompt: "stickman Dances",
            duration: duration,
            resolution: "720p",
            aspectRatio: "16:9",
            audio: false,
            mode: "single",
          },
          {
            model: modelName,
            apiKey,
            baseURL,
            manufacturer,
          },
        ),
        TEST_TIMEOUT_MS,
        `视频模型测试超时（>${TEST_TIMEOUT_MS}ms）`,
      );
      if (!videoPath) {
        throw new Error("视频模型测试未返回视频文件");
      }
      const url = await u.oss.getFileUrl(videoPath);
      debugLog("success", {
        manufacturer,
        modelName: modelName || "",
        costMs: Date.now() - startedAt,
        videoPath: trimPreview(videoPath),
        urlPreview: trimPreview(url),
      });
      res.status(200).send(success(url));
    } catch (err: any) {
      const msg = u.error(err).message;
      debugLog("failed", {
        manufacturer,
        modelName: modelName || "",
        costMs: Date.now() - startedAt,
        errorName: err?.name || "",
        errorCode: err?.code || "",
        message: msg,
      });
      if (DEBUG_MODE && err?.stack) {
        console.error("[testVideo] stack", err.stack);
      }
      res.status(500).send(error(msg));
    }
  },
);
