import { normalizePersistedVoiceConfig } from "@/lib/voiceGateway";
import {DebugLogUtil} from "@/utils/debugLogUtil";

export type ExternalModelConfigType = "text" | "image" | "voice" | "voice_design" | "voice_clone" | "video";
export type PersistedModelConfigType = "text" | "image" | "voice" | "video";
export type ModelReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

function trimText(input: unknown): string {
  return String(input || "").trim();
}

function normalizeNonNegativeNumber(input: unknown): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}

function normalizeTemperature(input: unknown): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0) return 0.3;
  if (value > 2) return 2;
  return Math.round(value * 100) / 100;
}

function normalizeTopP(input: unknown): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0) return 0.5;
  if (value > 1) return 1;
  return Math.round(value * 100) / 100;
}

function normalizeReasoningEffort(input: unknown): ModelReasoningEffort {
  const value = trimText(input).toLowerCase();
  if (value === "none" || value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return "minimal";
}

/** 语音合成「分段」模式允许的取值 */
export type VoiceSegmentMode = "punctuation" | "chars";

/**
 * 规范化语音合成「分段」配置字段（t_config.segmentMode / segmentChars）
 *
 * 用途：addModel / updateModel 落库前统一校验：
 * - segmentMode 仅接受 "punctuation"（按标点符号）/ "chars"（按字数），其他值存 null（走默认行为）
 * - segmentChars 仅接受正整数，并 clamp 到 10~500，非法值存 null（前端兜底默认 100）
 */
export function normalizeVoiceSegmentFields(
  segmentMode: unknown,
  segmentChars: unknown,
): { segmentMode: VoiceSegmentMode | null; segmentChars: number | null } {
  const mode = trimText(segmentMode).toLowerCase();
  const normalizedMode: VoiceSegmentMode | null = mode === "punctuation" || mode === "chars" ? mode : null;
  const rawChars = Number(segmentChars);
  let normalizedChars: number | null = null;
  if (Number.isFinite(rawChars) && rawChars > 0) {
    // clamp 到合理区间，避免填 1 字或超大值导致合成请求异常
    normalizedChars = Math.min(500, Math.max(10, Math.round(rawChars)));
  }
  return { segmentMode: normalizedMode, segmentChars: normalizedChars };
}

export function isVoiceDesignModelConfig(input: {
  type?: unknown;
  modelType?: unknown;
}): boolean {
  return trimText(input.modelType).toLowerCase() === "voice_design";
}

export function isVoiceCloneModelConfig(input: {
  type?: unknown;
  modelType?: unknown;
}): boolean {
  return trimText(input.modelType).toLowerCase() === "voice_clone";
}

export function toExternalModelConfigRow<T extends Record<string, any>>(row: T): T & {
  type: ExternalModelConfigType;
  modelType: string;
  currency: string;
  inputPricePer1M: number;
  outputPricePer1M: number;
  cacheReadPricePer1M: number;
  reasoningEffort: ModelReasoningEffort | "";
  temperature: number;
  topP: number;
} {
  const resolvedType = trimText(row.type).toLowerCase();
  const modelType = trimText(row.modelType).toLowerCase();

  if (modelType === "voice_design") {
    return {
      ...row,
      type: "voice_design",
      modelType: "voice_design",
      currency: trimText(row.currency).toUpperCase() || "CNY",
      inputPricePer1M: normalizeNonNegativeNumber(row.inputPricePer1M),
      outputPricePer1M: normalizeNonNegativeNumber(row.outputPricePer1M),
      cacheReadPricePer1M: normalizeNonNegativeNumber(row.cacheReadPricePer1M),
      reasoningEffort: "",
      temperature: 0.3,
      topP: 0.5,
    };
  }
  if (modelType === "voice_clone") {
    return {
      ...row,
      type: "voice_clone",
      modelType: "voice_clone",
      currency: trimText(row.currency).toUpperCase() || "CNY",
      inputPricePer1M: normalizeNonNegativeNumber(row.inputPricePer1M),
      outputPricePer1M: normalizeNonNegativeNumber(row.outputPricePer1M),
      cacheReadPricePer1M: normalizeNonNegativeNumber(row.cacheReadPricePer1M),
      reasoningEffort: "",
      temperature: 0.3,
      topP: 0.5,
    };
  }
  const externalType = (resolvedType || "text") as ExternalModelConfigType;
  return {
    ...row,
    type: externalType,
    modelType: trimText(row.modelType),
    currency: trimText(row.currency).toUpperCase() || "CNY",
    inputPricePer1M: normalizeNonNegativeNumber(row.inputPricePer1M),
    outputPricePer1M: normalizeNonNegativeNumber(row.outputPricePer1M),
    cacheReadPricePer1M: normalizeNonNegativeNumber(row.cacheReadPricePer1M),
    reasoningEffort: externalType === "text" ? normalizeReasoningEffort(row.reasoningEffort) : "",
    temperature: externalType === "text" ? normalizeTemperature(row.temperature) : 0.3,
    topP: externalType === "text" ? normalizeTopP(row.topP) : 0.5,
  };
}

export function normalizeExternalModelConfig(input: {
  type?: unknown;
  model?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  manufacturer?: unknown;
  modelType?: unknown;
  inputPricePer1M?: unknown;
  outputPricePer1M?: unknown;
  cacheReadPricePer1M?: unknown;
  currency?: unknown;
  reasoningEffort?: unknown;
  temperature?: unknown;
  topP?: unknown;
}): {
  persistedType: PersistedModelConfigType;
  externalType: ExternalModelConfigType;
  model: string;
  baseUrl: string;
  apiKey: string;
  manufacturer: string;
  modelType: string;
  inputPricePer1M: number;
  outputPricePer1M: number;
  cacheReadPricePer1M: number;
  currency: string;
  reasoningEffort: ModelReasoningEffort;
  temperature: number;
  topP: number;
} {
  const requestedType = trimText(input.type).toLowerCase();
  const manufacturer = trimText(input.manufacturer);
  const apiKey = trimText(input.apiKey);
  const model = trimText(input.model);
  const baseUrl = trimText(input.baseUrl);
  const modelType = trimText(input.modelType);
  const inputPricePer1M = normalizeNonNegativeNumber(input.inputPricePer1M);
  const outputPricePer1M = normalizeNonNegativeNumber(input.outputPricePer1M);
  const cacheReadPricePer1M = normalizeNonNegativeNumber(input.cacheReadPricePer1M);
  const currency = trimText(input.currency).toUpperCase() || "CNY";
  const reasoningEffort = normalizeReasoningEffort(input.reasoningEffort);
  const temperature = normalizeTemperature(input.temperature);
  const topP = normalizeTopP(input.topP);

  if (requestedType === "voice_design") {
    return {
      persistedType: "voice_design",
      externalType: "voice_design",
      model,
      baseUrl,
      apiKey,
      manufacturer,
      modelType: "voice_design",
      inputPricePer1M,
      outputPricePer1M,
      cacheReadPricePer1M,
      currency,
      reasoningEffort,
      temperature,
      topP,
    };
  }

  if (requestedType === "voice_clone") {
    return {
      persistedType: "voice_clone",
      externalType: "voice_clone",
      model,
      baseUrl,
      apiKey,
      manufacturer,
      modelType: "voice_clone",
      inputPricePer1M,
      outputPricePer1M,
      cacheReadPricePer1M,
      currency,
      reasoningEffort,
      temperature,
      topP,
    };
  }

  if (requestedType === "voice") {
    const normalizedVoiceConfig = normalizePersistedVoiceConfig({
      manufacturer,
      modelType,
      model,
      baseUrl,
    });
    return {
      persistedType: "voice",
      externalType: "voice",
      model: normalizedVoiceConfig.model,
      baseUrl: normalizedVoiceConfig.baseUrl,
      apiKey,
      manufacturer,
      modelType,
      inputPricePer1M,
      outputPricePer1M,
      cacheReadPricePer1M,
      currency,
      reasoningEffort,
      temperature,
      topP,
    };
  }

  const persistedType = (requestedType === "image" || requestedType === "video") ? requestedType : "text";
  return {
    persistedType,
    externalType: persistedType,
    model,
    baseUrl,
    apiKey,
    manufacturer,
    modelType,
    inputPricePer1M,
    outputPricePer1M,
    cacheReadPricePer1M,
    currency,
    reasoningEffort,
    temperature,
    topP,
  };
}
