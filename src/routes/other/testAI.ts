import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
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

function trimPreview(input: unknown, size = 240): string {
  const text = String(input ?? "");
  return text.length > size ? `${text.slice(0, size)}...` : text;
}

function debugLog(step: string, payload?: Record<string, unknown>) {
  if (!DEBUG_MODE) return;
  if (payload) {
    console.log("[testAI]", step, payload);
  } else {
    console.log("[testAI]", step);
  }
}

function normalizeTestAiErrorMessage(input: string): string {
  const message = String(input || "").trim();
  const lower = message.toLowerCase();
  if (lower.includes("insufficient account balance") || lower.includes("insufficient_balance")) {
    return "账户余额不足";
  }
  return message;
}

function resolveTestAiStatusCode(input: string): number {
  const lower = String(input || "").trim().toLowerCase();
  if (lower.includes("insufficient account balance") || lower.includes("insufficient_balance")) {
    return 402;
  }
  return 500;
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
    modelName: z.string(),
    apiKey: z.string(),
    baseURL: z.string().optional(),
    manufacturer: z.string(),
    reasoningEffort: z.enum(["minimal", "low", "medium", "high"]).optional(),
  }),
  async (req, res) => {
    const { modelName, apiKey, baseURL, manufacturer, reasoningEffort } = req.body;
    const startedAt = Date.now();
    debugLog("request", {
      manufacturer,
      reasoningEffort: String(reasoningEffort || "minimal"),
      modelName,
      baseURL: baseURL || "",
      apiKey: maskKey(apiKey),
      timeoutMs: TEST_TIMEOUT_MS,
    });

    try {
      const manufacturerKey = String(manufacturer || "").trim().toLowerCase();
      const testPrompt = manufacturerKey === "t8star"
        ? "请直接回复：T8Star 文本模型连通成功"
        : `请直接回复：${manufacturer || "文本模型"}连通成功`;

      const result = await withTimeout(
        u.ai.text.invoke(
          manufacturerKey === "t8star"
            ? {
                prompt: testPrompt,
                usageType: "模型测试",
                usageRemark: `${manufacturer || ""}/${modelName || ""}`,
                usageMeta: {
                  stage: "testAI",
                  manufacturer,
                  modelName,
                },
              }
            : {
                prompt: testPrompt,
                usageType: "模型测试",
                usageRemark: `${manufacturer || ""}/${modelName || ""}`,
                usageMeta: {
                  stage: "testAI",
                  manufacturer,
                  modelName,
                },
                output: {
                  reply: z.string().describe("回复内容"),
                },
              },
          {
            model: modelName,
            apiKey,
            baseURL,
            manufacturer,
            reasoningEffort,
          },
        ),
        TEST_TIMEOUT_MS,
        `文本模型测试超时（>${TEST_TIMEOUT_MS}ms）`,
      );

      const reply =
        typeof (result as any)?.reply === "string"
          ? (result as any).reply
          : typeof (result as any)?.text === "string"
          ? (result as any).text
          : typeof result === "string"
          ? result
          : "";
      if (!reply) {
        throw new Error("模型测试未返回可读文本");
      }
      debugLog("success", {
        manufacturer,
        modelName,
        manufacturerKey,
        reasoningEffort: String(reasoningEffort || "minimal"),
        costMs: Date.now() - startedAt,
        replyPreview: trimPreview(reply),
      });
      res.status(200).send(success(reply));
    } catch (err) {
      const rawMessage = u.error(err).message;
      const msg = normalizeTestAiErrorMessage(rawMessage);
      debugLog("failed", {
        manufacturer,
        modelName,
        costMs: Date.now() - startedAt,
        errorName: (err as any)?.name || "",
        errorCode: (err as any)?.code || "",
        message: msg,
        rawMessage,
      });
      if (DEBUG_MODE && (err as any)?.stack) {
        console.error("[testAI] stack", (err as any).stack);
      }
      res.status(resolveTestAiStatusCode(rawMessage)).send(error(msg));
    }
  },
);
