import u from "@/utils";
import { generateText, streamText, Output, stepCountIs, ModelMessage, LanguageModel, Tool, GenerateTextResult } from "ai";
import { wrapLanguageModel } from "ai";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import { parse } from "best-effort-json-parser";
import { getModelList, normalizeTextModelName } from "./modelList";
import { z } from "zod";
import { OpenAIProvider } from "@ai-sdk/openai";
interface AIInput<T extends Record<string, z.ZodTypeAny> | undefined = undefined> {
  system?: string;
  tools?: Record<string, Tool>;
  maxStep?: number;
  maxRetries?: number;
  output?: T;
  plainTextOutput?: boolean;
  prompt?: string;
  messages?: Array<ModelMessage>;
}

interface AIConfig {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  manufacturer?: string;
}

const LOG_LEVEL = (process.env.LOG_LEVEL || "").trim().toUpperCase();
const TEXT_DEBUG = LOG_LEVEL === "DEBUG" || (process.env.DEBUG_AI_TEXT || "").trim() === "1";
const TEXT_DEBUG_VERBOSE = (process.env.DEBUG_AI_TEXT_VERBOSE || "").trim() === "1";
const TEXT_DEBUG_HTTP =
  (process.env.AI_TEXT_DEBUG_HTTP || "").trim() === "1" || (TEXT_DEBUG && (process.env.AI_TEXT_DEBUG_HTTP_AUTO || "1").trim() === "1");
const TEXT_DEBUG_HTTP_VERBOSE = (process.env.AI_TEXT_DEBUG_HTTP_VERBOSE || "").trim() === "1";

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
  if (!TEXT_DEBUG) return;
  if (payload) {
    console.log("[ai:text]", step, payload);
  } else {
    console.log("[ai:text]", step);
  }
}

function headersToObject(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  try {
    const result: Record<string, string> = {};
    const source = new Headers(headers as any);
    source.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  } catch {
    return {};
  }
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = { ...headers };
  const authKey = Object.keys(sanitized).find((key) => key.toLowerCase() === "authorization");
  if (authKey) {
    const raw = sanitized[authKey] || "";
    sanitized[authKey] = raw.replace(/Bearer\s+(.+)/i, (_, token) => `Bearer ${maskKey(token)}`);
  }
  return sanitized;
}

function getBodyPreview(body: BodyInit | null | undefined): string {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(body)) return body.toString("utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer).toString("utf8");
  return `[${Object.prototype.toString.call(body)}]`;
}

function createDebugFetch(label: string): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const requestMethod =
      init?.method || (typeof input !== "string" && !(input instanceof URL) ? (input as Request).method : undefined) || "GET";
    const requestHeaders = sanitizeHeaders(
      headersToObject(init?.headers || (typeof input !== "string" && !(input instanceof URL) ? (input as Request).headers : undefined)),
    );
    const requestBody = getBodyPreview(init?.body);

    if (TEXT_DEBUG_HTTP) {
      console.log("[ai:text:http] request", {
        label,
        method: requestMethod,
        url: requestUrl,
        headers: requestHeaders,
        body: TEXT_DEBUG_HTTP_VERBOSE ? requestBody : trimPreview(requestBody, 2000),
      });
    }

    const startedAt = Date.now();
    const response = await fetch(input as any, init);
    const responseHeaders = headersToObject(response.headers as any);
    let responseBody = "";
    try {
      responseBody = await response.clone().text();
    } catch (err) {
      responseBody = `[读取响应体失败: ${(err as any)?.message || "unknown"}]`;
    }

    if (TEXT_DEBUG_HTTP) {
      console.log("[ai:text:http] response", {
        label,
        method: requestMethod,
        url: requestUrl,
        status: response.status,
        costMs: Date.now() - startedAt,
        headers: responseHeaders,
        body: TEXT_DEBUG_HTTP_VERBOSE ? responseBody : trimPreview(responseBody, 4000),
      });
    }

    return response;
  };
}

const buildOptions = async (input: AIInput<any>, config: AIConfig = {}) => {
  if (!config || !config?.model || !config?.apiKey || !config?.manufacturer) throw new Error("请检查模型配置是否正确");
  const { apiKey, baseURL, manufacturer } = { ...config };
  const requestedModel = String(config?.model || "").trim();
  const model = normalizeTextModelName(manufacturer, requestedModel);
  let owned;
  const modelList = await getModelList();
  if (manufacturer == "other") {
    owned = modelList.find((m) => m.manufacturer === manufacturer);
  } else {
    owned = modelList.find((m) => m.model === model && m.manufacturer === manufacturer);
  }
  if (!owned) {
    throw new Error(`模型 ${model} 与厂商 ${manufacturer} 不匹配或未注册`);
  }

  const openAICompatible = ["volcengine", "doubao", "other", "openai", "modelScope", "grsai", "t8star", "lmstudio"].includes(owned.manufacturer);
  const modelInstance = owned.instance({
    apiKey,
    baseURL: baseURL!,
    name: "xixixi",
    ...(TEXT_DEBUG_HTTP && openAICompatible ? { fetch: createDebugFetch(`${owned.manufacturer}:${model}`) } : {}),
  } as any);

  const maxStep = input.maxStep ?? (input.tools ? Object.keys(input.tools).length * 5 : undefined);
  const outputBuilders: Record<string, (schema: any) => any> = {
    schema: (s) => {
      return Output.object({ schema: z.object(s) });
    },
    object: () => {
      const jsonSchemaPrompt = `\n请按照以下 JSON Schema 格式返回结果:\n${JSON.stringify(
        z.toJSONSchema(z.object(input.output)),
        null,
        2,
      )}\n只返回结果，不要将Schema返回。`;
      input.system = (input.system ?? "") + jsonSchemaPrompt;
      // return Output.json();
    },
  };

  const output = input.output && !input.plainTextOutput
    ? (outputBuilders[owned.responseFormat]?.(input.output) ?? null)
    : null;
  const chatModelManufacturer = ["volcengine", "doubao", "other", "openai", "modelScope", "grsai", "t8star", "lmstudio"];
  const modelFn = chatModelManufacturer.includes(owned.manufacturer) ? (modelInstance as OpenAIProvider).chat(model!) : modelInstance(model!);

  const outputKeys = input.output ? Object.keys(input.output) : [];
  const messageCount = Array.isArray(input.messages) ? input.messages.length : 0;
  debugLog("buildOptions", {
    manufacturer,
    model,
    ...(requestedModel && requestedModel !== model ? { requestedModel } : {}),
    baseURL: baseURL || "",
    apiKey: maskKey(apiKey),
    ownedManufacturer: owned.manufacturer,
    responseFormat: owned.responseFormat,
    toolEnabled: Boolean(input.tools && owned.tool),
    toolCount: input.tools ? Object.keys(input.tools).length : 0,
    maxStep: maxStep ?? 0,
    outputKeys,
    plainTextOutput: Boolean(input.plainTextOutput),
    messageCount,
    promptPreview: trimPreview(input.prompt || ""),
  });
  if (TEXT_DEBUG_VERBOSE && messageCount > 0) {
    const messages = (input.messages || []).slice(-3).map((msg) => ({
      role: msg.role,
      contentPreview: trimPreview(JSON.stringify(msg.content || "")),
    }));
    debugLog("messagesPreview", { messages });
  }

  return {
    config: {
      model: modelFn as LanguageModel,
      ...(input.system && { system: input.system }),
      ...(input.prompt ? { prompt: input.prompt } : { messages: input.messages! }),
      ...(input.tools && owned.tool && { tools: input.tools }),
      ...(maxStep && { stopWhen: stepCountIs(maxStep) }),
      ...(input.maxRetries !== undefined && { maxRetries: input.maxRetries }),
      ...(output && { output }),
    },
    responseFormat: owned.responseFormat,
  };
};

type InferOutput<T> = T extends Record<string, z.ZodTypeAny> ? z.infer<z.ZodObject<T>> : GenerateTextResult<Record<string, Tool>, never>;

const ai = Object.create({}) as {
  invoke<T extends Record<string, z.ZodTypeAny> | undefined = undefined>(input: AIInput<T>, config?: AIConfig): Promise<InferOutput<T>>;
  stream(input: AIInput, config?: AIConfig): Promise<ReturnType<typeof streamText>>;
};

ai.invoke = async (input: AIInput<any>, config: AIConfig) => {
  const startedAt = Date.now();
  debugLog("invoke:start", {
    manufacturer: config?.manufacturer || "",
    model: config?.model || "",
    promptPreview: trimPreview(input.prompt || ""),
    messageCount: Array.isArray(input.messages) ? input.messages.length : 0,
  });
  const options = await buildOptions(input, config);

  try {
    const result = await generateText(options.config);
    debugLog("invoke:success", {
      manufacturer: config?.manufacturer || "",
      model: config?.model || "",
      costMs: Date.now() - startedAt,
      textLength: (result?.text || "").length,
      textPreview: trimPreview(result?.text || ""),
      hasObject: Boolean((result as any)?.object),
      warningsCount: Array.isArray((result as any)?.warnings) ? (result as any).warnings.length : 0,
    });
    if (!input.plainTextOutput && options.responseFormat === "object" && input.output) {
      const pattern = /{[^{}]*}|{(?:[^{}]*|{[^{}]*})*}/g;
      const jsonLikeTexts = Array.from(result.text.matchAll(pattern), (m) => m[0]);

      const res = jsonLikeTexts.map((jsonText) => parse(jsonText));
      debugLog("invoke:parsedObject", {
        candidateCount: jsonLikeTexts.length,
        hasResult: Boolean(res[0]),
      });
      return res[0];
    }
    if (!input.plainTextOutput && options.responseFormat === "schema" && input.output) {
      const objectResult =
        (result as any)?.object ??
        (result as any)?.output ??
        (result as any)?.experimental_output ??
        (result as any)?.experimental_outputObject ??
        null;
      if (objectResult && typeof objectResult === "object") {
        debugLog("invoke:parsedSchema", {
          source: "object",
          keys: Object.keys(objectResult),
        });
        return objectResult;
      }

      const rawText = String((result as any)?.text || "").trim();
      if (!rawText) {
        throw new Error("模型返回为空，无法解析结构化结果（text/object 均为空）");
      }
      const parsed = JSON.parse(rawText);
      debugLog("invoke:parsedSchema", {
        source: "text",
        keys: parsed && typeof parsed === "object" ? Object.keys(parsed) : [],
      });
      return parsed;
    }
    return result;
  } catch (err) {
    const costMs = Date.now() - startedAt;
    debugLog("invoke:failed", {
      manufacturer: config?.manufacturer || "",
      model: config?.model || "",
      costMs,
      errorName: (err as any)?.name || "",
      errorCode: (err as any)?.code || "",
      message: (err as any)?.message || "",
    });
    if (TEXT_DEBUG && (err as any)?.stack) {
      console.error("[ai:text] invoke stack", (err as any).stack);
    }
    throw err;
  }
};

ai.stream = async (input: AIInput, config: AIConfig) => {
  const startedAt = Date.now();
  debugLog("stream:start", {
    manufacturer: config?.manufacturer || "",
    model: config?.model || "",
    promptPreview: trimPreview(input.prompt || ""),
    messageCount: Array.isArray(input.messages) ? input.messages.length : 0,
  });
  const options = await buildOptions(input, config);

  try {
    const stream = streamText(options.config);
    debugLog("stream:created", {
      manufacturer: config?.manufacturer || "",
      model: config?.model || "",
      costMs: Date.now() - startedAt,
    });
    return stream;
  } catch (err) {
    debugLog("stream:failed", {
      manufacturer: config?.manufacturer || "",
      model: config?.model || "",
      costMs: Date.now() - startedAt,
      errorName: (err as any)?.name || "",
      errorCode: (err as any)?.code || "",
      message: (err as any)?.message || "",
    });
    if (TEXT_DEBUG && (err as any)?.stack) {
      console.error("[ai:text] stream stack", (err as any).stack);
    }
    throw err;
  }
};

export default ai;
