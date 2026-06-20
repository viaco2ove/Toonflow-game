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

      // 本地 Qwen3-0.6B 走 node-llama-cpp，绕过 ai-sdk
      if (manufacturerKey === "qwen060") {
        const { chatWithQwen060, getQwen060InstallStatus } = await import("@/lib/localQwen060");
        const status = await getQwen060InstallStatus();
        if (status.status !== "installed") {
          throw new Error(`Qwen3-0.6B 未安装：${status.message}`);
        }
        const r = await withTimeout(
          chatWithQwen060({
            messages: [{ role: "user", content: testPrompt }],
            maxTokens: 256,
            temperature: 0.3,
            // 测试场景禁用 thinking 模式（Qwen3 默认开启会先输出 <think>，可能耗光 token 还没回答）
            enableThinking: false,
          }),
          TEST_TIMEOUT_MS,
          `Qwen3-0.6B 测试超时（>${TEST_TIMEOUT_MS}ms）`,
        );
        const reply = r.text || "";
        if (!reply) {
          throw new Error("模型测试未返回可读文本");
        }
        debugLog("success", {
          manufacturer,
          modelName,
          manufacturerKey,
          costMs: Date.now() - startedAt,
          replyPreview: trimPreview(reply),
        });
        res.status(200).send(success(reply));
        return;
      }

      // 火山/豆包系列（含 260428 这种默认开启思考的新版本）必须显式传 reasoning_effort，
      // 否则模型可能进入思考模式，导致返回内容混入推理过程而无法解析出可读文本。
      // 测试连通性时统一兜底为 minimal（不思考），让模型直接给出回复。
      const VOLCENGINE_LIKE_MANUFACTURERS = new Set(["volcengine", "doubao"]);
      const effectiveReasoningEffort =
        reasoningEffort
          ?? (VOLCENGINE_LIKE_MANUFACTURERS.has(manufacturerKey) ? "minimal" : undefined);

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
            reasoningEffort: effectiveReasoningEffort,
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
      const errMsg = u.error(err).message;
      if (DEBUG_MODE) {
        console.error("[testAI] 文本模型测试失败", {
          manufacturer,
          modelName,
          apiKey: apiKey ? `${String(apiKey).slice(0, 4)}***${String(apiKey).slice(-4)}` : "",
          baseURL: baseURL || "",
          error: errMsg,
          stack: (err as any)?.stack,
        });
      }
      res.status(resolveTestAiStatusCode(errMsg)).send(error(normalizeTestAiErrorMessage(errMsg)));
    }
  },
);
