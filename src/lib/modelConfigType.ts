import { normalizePersistedVoiceConfig } from "@/lib/voiceGateway";

export type ExternalModelConfigType = "text" | "image" | "voice" | "voice_design" | "video";
export type PersistedModelConfigType = "text" | "image" | "voice" | "video";

function trimText(input: unknown): string {
  return String(input || "").trim();
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
} {
  if (isVoiceDesignModelConfig(row)) {
    return {
      ...row,
      type: "voice_design",
      modelType: "voice_design",
    };
  }
  const resolvedType = trimText(row.type).toLowerCase();
  return {
    ...row,
    type: (resolvedType || "text") as ExternalModelConfigType,
    modelType: trimText(row.modelType),
  };
}

export function normalizeExternalModelConfig(input: {
  type?: unknown;
  model?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  manufacturer?: unknown;
  modelType?: unknown;
}): {
  persistedType: PersistedModelConfigType;
  externalType: ExternalModelConfigType;
  model: string;
  baseUrl: string;
  apiKey: string;
  manufacturer: string;
  modelType: string;
} {
  const requestedType = trimText(input.type).toLowerCase();
  const manufacturer = trimText(input.manufacturer);
  const apiKey = trimText(input.apiKey);
  const model = trimText(input.model);
  const baseUrl = trimText(input.baseUrl);
  const modelType = trimText(input.modelType);

  if (requestedType === "voice_design") {
    return {
      persistedType: "text",
      externalType: "voice_design",
      model,
      baseUrl,
      apiKey,
      manufacturer,
      modelType: "voice_design",
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
  };
}
