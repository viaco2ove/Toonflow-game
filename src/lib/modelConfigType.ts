import { normalizePersistedVoiceConfig } from "@/lib/voiceGateway";

export type ExternalModelConfigType = "text" | "image" | "voice" | "voice_design" | "video";
export type PersistedModelConfigType = "text" | "image" | "voice" | "video";

function trimText(input: unknown): string {
  return String(input || "").trim();
}

function normalizeNonNegativeNumber(input: unknown): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function isVoiceDesignModelConfig(input: {
  type?: unknown;
  modelType?: unknown;
  manufacturer?: unknown;
  model?: unknown;
}): boolean {
  const externalType = trimText(input.type).toLowerCase();
  if (externalType === "voice_design") return true;

  const modelType = trimText(input.modelType).toLowerCase();
  if (modelType === "voice_design") return true;

  const manufacturer = trimText(input.manufacturer).toLowerCase();
  const model = trimText(input.model).toLowerCase();
  return manufacturer === "qwen" && (
    model === "qwen-voice-design"
    || model.startsWith("qwen3-tts-vd")
    || model === "voice-enrollment"
    || model.startsWith("cosyvoice-v3")
    || model.startsWith("cosyvoice-v3.5")
  );
}

export function toExternalModelConfigRow<T extends Record<string, any>>(row: T): T & {
  type: ExternalModelConfigType;
  modelType: string;
  currency: string;
  inputPricePer1M: number;
  outputPricePer1M: number;
  cacheReadPricePer1M: number;
} {
  if (isVoiceDesignModelConfig(row)) {
    return {
      ...row,
      type: "voice_design",
      modelType: "voice_design",
      currency: trimText(row.currency).toUpperCase() || "CNY",
      inputPricePer1M: normalizeNonNegativeNumber(row.inputPricePer1M),
      outputPricePer1M: normalizeNonNegativeNumber(row.outputPricePer1M),
      cacheReadPricePer1M: normalizeNonNegativeNumber(row.cacheReadPricePer1M),
    };
  }
  const resolvedType = trimText(row.type).toLowerCase();
  return {
    ...row,
    type: (resolvedType || "text") as ExternalModelConfigType,
    modelType: trimText(row.modelType),
    currency: trimText(row.currency).toUpperCase() || "CNY",
    inputPricePer1M: normalizeNonNegativeNumber(row.inputPricePer1M),
    outputPricePer1M: normalizeNonNegativeNumber(row.outputPricePer1M),
    cacheReadPricePer1M: normalizeNonNegativeNumber(row.cacheReadPricePer1M),
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

  if (requestedType === "voice_design") {
    return {
      persistedType: "text",
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
  };
}
