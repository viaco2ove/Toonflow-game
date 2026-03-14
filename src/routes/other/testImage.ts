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

function trimPreview(input: unknown, size = 160): string {
  const text = String(input ?? "");
  return text.length > size ? `${text.slice(0, size)}...` : text;
}

function debugLog(step: string, payload?: Record<string, unknown>) {
  if (!DEBUG_MODE) return;
  if (payload) {
    console.log("[testImage]", step, payload);
  } else {
    console.log("[testImage]", step);
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
      const image = await withTimeout(
        u.ai.image(
          {
            prompt:
              "一张16:9比例的图片，完美等分为2x2四宫格布局，各区域无缝衔接：\n左上宫格：一只可爱的猫，毛发蓬松，眼睛明亮，姿态俏皮\n右上宫格：一只友善的狗，金毛犬，表情愉悦，摇着尾巴\n左下宫格：一头健壮的牛，田园背景，目光温和，皮毛光泽\n右下宫格：一匹骏马，姿态优雅，鬃毛飘逸，肌肉健美\n风格要求：四个宫格风格统一，色彩鲜艳饱和，高清画质，细节清晰锐利，专业插画风格，线条干净，统一的左上方光源，柔和阴影，和谐配色，卡通/半写实风格，宫格间用白色或浅灰细线分隔",
            imageBase64: [],
            aspectRatio: "16:9",
            size: "1K",
          },
          {
            model: modelName,
            apiKey,
            baseURL,
            manufacturer,
          },
        ),
        TEST_TIMEOUT_MS,
        `图像模型测试超时（>${TEST_TIMEOUT_MS}ms）`,
      );
      debugLog("success", {
        manufacturer,
        modelName: modelName || "",
        costMs: Date.now() - startedAt,
        imagePreview: trimPreview(image),
      });
      res.status(200).send(success(image));
    } catch (err) {
      const msg = u.error(err).message;
      debugLog("failed", {
        manufacturer,
        modelName: modelName || "",
        costMs: Date.now() - startedAt,
        errorName: (err as any)?.name || "",
        errorCode: (err as any)?.code || "",
        message: msg,
      });
      if (DEBUG_MODE && (err as any)?.stack) {
        console.error("[testImage] stack", (err as any).stack);
      }
      res.status(500).send(error(msg));
    }
  },
);
