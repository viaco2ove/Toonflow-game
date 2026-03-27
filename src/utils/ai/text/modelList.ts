import { createOpenAI, OpenAIProviderSettings } from "@ai-sdk/openai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createZhipu } from "zhipu-ai-provider";
import { createQwen } from "qwen-ai-provider-v5";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import db from "@/utils/db";

interface Owned {
  manufacturer: string;
  model: string;
  responseFormat: "schema" | "object";
  image: boolean;
  think: boolean;
  tool: boolean;
  instance: (options?: any) => any;
}

const instanceMap = {
  deepSeek: createDeepSeek,
  deepseek: createDeepSeek,
  volcengine: createOpenAI,
  doubao: createOpenAI,
  openai: createOpenAI,
  zhipu: createZhipu,
  qwen: createQwen,
  gemini: createGoogleGenerativeAI,
  anthropic: createAnthropic,
  modelScope: (options: OpenAIProviderSettings) =>
    createOpenAI({ ...options, headers: { ...options?.headers, "X-ModelScope-Async-Mode": "true" } }),
  xai: createXai,
  other: createOpenAI,
  grsai: createOpenAI,
  t8star: createOpenAI,
};

type DefaultOwned = Omit<Owned, "manufacturer" | "instance">;

const DOUBAO_TEXT_MODELS: DefaultOwned[] = [
  {
    model: "doubao-seed-2-0-pro-260215",
    responseFormat: "schema",
    image: true,
    think: true,
    tool: true,
  },
  {
    model: "doubao-seed-2-0-lite-260215",
    responseFormat: "schema",
    image: true,
    think: true,
    tool: true,
  },
  {
    model: "doubao-seed-2-0-mini-260215",
    responseFormat: "schema",
    image: true,
    think: true,
    tool: true,
  },
  {
    model: "doubao-seed-1-8-251228",
    responseFormat: "schema",
    image: true,
    think: true,
    tool: true,
  },
  {
    model: "doubao-seed-1-6-251015",
    responseFormat: "schema",
    image: true,
    think: true,
    tool: true,
  },
  {
    model: "doubao-seed-1-6-lite-251015",
    responseFormat: "schema",
    image: true,
    think: true,
    tool: true,
  },
  {
    model: "doubao-seed-1-6-flash-250828",
    responseFormat: "schema",
    image: true,
    think: true,
    tool: true,
  },
  {
    model: "glm-4-7-251222",
    responseFormat: "schema",
    image: true,
    think: true,
    tool: true,
  },
  {
    model: "deepseek-v3-2-251201",
    responseFormat: "schema",
    image: true,
    think: true,
    tool: true,
  },

];

function createAliasedModels(manufacturers: string[], items: DefaultOwned[]): Owned[] {
  return manufacturers.flatMap((manufacturer) => {
    const instance = instanceMap[manufacturer as keyof typeof instanceMap];
    if (!instance) return [];
    return items.map((item) => ({
      manufacturer,
      ...item,
      instance,
    }));
  });
}

function toOwnedModel(model: any): Owned | null {
  const manufacturer = String(model?.manufacturer || "").trim();
  const instance = instanceMap[manufacturer as keyof typeof instanceMap];
  const modelName = String(model?.model || "").trim();
  if (!manufacturer || !instance || !modelName) return null;
  return {
    manufacturer,
    model: modelName,
    responseFormat: manufacturer === "t8star" ? "object" : model?.responseFormat === "object" ? "object" : "schema",
    image: model?.image == 1 || model?.image === true,
    think: model?.think == 1 || model?.think === true,
    tool: model?.tool == 1 || model?.tool === true,
    instance,
  };
}

function mergeOwnedModels(...lists: Owned[][]): Owned[] {
  const merged = new Map<string, Owned>();
  for (const list of lists) {
    for (const item of list) {
      const key = `${String(item.manufacturer || "").trim().toLowerCase()}:${String(item.model || "").trim()}`;
      if (!key) continue;
      merged.set(key, item);
    }
  }
  return Array.from(merged.values());
}

const modelList: Owned[] = [
  // DeepSeek
  {
    manufacturer: "deepseek",
    model: "deepseek-chat",
    responseFormat: "schema",
    image: false,
    think: false,
    instance: createDeepSeek,
    tool: true,
  },
  {
    manufacturer: "deepseek",
    model: "deepseek-reasoner",
    responseFormat: "schema",
    image: false,
    think: true,
    instance: createDeepSeek,
    tool: true,
  },

  // 豆包
  ...createAliasedModels(["volcengine", "doubao"], DOUBAO_TEXT_MODELS),
  // GLM
  {
    manufacturer: "zhipu",
    model: "glm-4.7",
    responseFormat: "object",
    image: false,
    think: false,
    instance: createZhipu,
    tool: true,
  },
  {
    manufacturer: "zhipu",
    model: "glm-4.7-flashx",
    responseFormat: "object",
    image: false,
    think: false,
    instance: createZhipu,
    tool: true,
  },
  {
    manufacturer: "zhipu",
    model: "glm-4.6",
    responseFormat: "object",
    image: false,
    think: false,
    instance: createZhipu,
    tool: true,
  },
  {
    manufacturer: "zhipu",
    model: "glm-4.5-air",
    responseFormat: "object",
    image: false,
    think: false,
    instance: createZhipu,
    tool: true,
  },
  {
    manufacturer: "zhipu",
    model: "glm-4.5-airx",
    responseFormat: "object",
    image: false,
    think: false,
    instance: createZhipu,
    tool: true,
  },
  {
    manufacturer: "zhipu",
    model: "glm-4-long",
    responseFormat: "object",
    image: false,
    think: false,
    instance: createZhipu,
    tool: true,
  },
  {
    manufacturer: "zhipu",
    model: "glm-4-flashx-250414",
    responseFormat: "object",
    image: false,
    think: false,
    instance: createZhipu,
    tool: true,
  },
  {
    manufacturer: "zhipu",
    model: "glm-4.7-flash",
    responseFormat: "object",
    image: false,
    think: false,
    instance: createZhipu,
    tool: true,
  },
  {
    manufacturer: "zhipu",
    model: "glm-4.5-flash",
    responseFormat: "object",
    image: false,
    think: true,
    instance: createZhipu,
    tool: true,
  },
  {
    manufacturer: "zhipu",
    model: "glm-4-flash-250414",
    responseFormat: "object",
    image: false,
    think: false,
    instance: createZhipu,
    tool: true,
  },
  {
    manufacturer: "zhipu",
    model: "glm-4.6v",
    responseFormat: "object",
    image: true,
    think: true,
    instance: createZhipu,
    tool: true,
  },
  // Qwen
  {
    manufacturer: "qwen",
    model: "qwen-vl-max",
    responseFormat: "schema",
    image: true,
    think: false,
    instance: createQwen,
    tool: true,
  },
  {
    manufacturer: "qwen",
    model: "qwen-plus-latest",
    responseFormat: "schema",
    image: false,
    think: false,
    instance: createQwen,
    tool: true,
  },
  {
    manufacturer: "qwen",
    model: "qwen-max",
    responseFormat: "schema",
    image: false,
    think: false,
    instance: createQwen,
    tool: true,
  },
  {
    manufacturer: "qwen",
    model: "qwen2.5-72b-instruct",
    responseFormat: "schema",
    image: false,
    think: false,
    instance: createQwen,
    tool: true,
  },
  {
    manufacturer: "qwen",
    model: "qwen2.5-14b-instruct-1m",
    responseFormat: "schema",
    image: false,
    think: false,
    instance: createQwen,
    tool: true,
  },
  {
    manufacturer: "qwen",
    model: "qwen2.5-vl-72b-instruct",
    responseFormat: "schema",
    image: true,
    think: false,
    instance: createQwen,
    tool: true,
  },
  // OpenAI
  {
    manufacturer: "openai",
    model: "gpt-4o",
    responseFormat: "schema",
    image: true,
    think: false,
    instance: createOpenAI,
    tool: true,
  },
  {
    manufacturer: "openai",
    model: "gpt-4o-mini",
    responseFormat: "schema",
    image: true,
    think: false,
    instance: createOpenAI,
    tool: true,
  },
  {
    manufacturer: "openai",
    model: "gpt-4.1",
    responseFormat: "schema",
    image: true,
    think: false,
    instance: createOpenAI,
    tool: true,
  },
  {
    manufacturer: "openai",
    model: "gpt-5.1",
    responseFormat: "schema",
    image: true,
    think: false,
    instance: createOpenAI,
    tool: true,
  },
  {
    manufacturer: "openai",
    model: "gpt-5.2",
    responseFormat: "schema",
    image: true,
    think: false,
    instance: createOpenAI,
    tool: true,
  },

  // Gemini
  {
    manufacturer: "gemini",
    model: "gemini-2.5-pro",
    responseFormat: "schema",
    image: true,
    think: true,
    instance: createGoogleGenerativeAI,
    tool: true,
  },
  {
    manufacturer: "gemini",
    model: "gemini-2.5-flash",
    responseFormat: "schema",
    image: true,
    think: true,
    instance: createGoogleGenerativeAI,
    tool: true,
  },
  {
    manufacturer: "gemini",
    model: "gemini-2.0-flash",
    responseFormat: "schema",
    image: true,
    think: false,
    instance: createGoogleGenerativeAI,
    tool: true,
  },
  {
    manufacturer: "gemini",
    model: "gemini-2.0-flash-lite",
    responseFormat: "schema",
    image: true,
    think: false,
    instance: createGoogleGenerativeAI,
    tool: true,
  },
  {
    manufacturer: "gemini",
    model: "gemini-1.5-pro",
    responseFormat: "schema",
    image: true,
    think: false,
    instance: createGoogleGenerativeAI,
    tool: true,
  },
  {
    manufacturer: "gemini",
    model: "gemini-1.5-flash",
    responseFormat: "schema",
    image: true,
    think: false,
    instance: createGoogleGenerativeAI,
    tool: true,
  },
  // Anthropic (Claude)
  {
    manufacturer: "anthropic",
    model: "claude-opus-4-5",
    responseFormat: "schema",
    image: true,
    think: false,
    instance: createAnthropic,
    tool: true,
  },
  {
    manufacturer: "anthropic",
    model: "claude-haiku-4-5",
    responseFormat: "schema",
    image: true,
    think: false,
    instance: createAnthropic,
    tool: true,
  },
  {
    manufacturer: "anthropic",
    model: "claude-sonnet-4-5",
    responseFormat: "schema",
    image: true,
    think: false,
    instance: createAnthropic,
    tool: true,
  },
  {
    manufacturer: "anthropic",
    model: "claude-opus-4-1",
    responseFormat: "schema",
    image: true,
    think: false,
    instance: createAnthropic,
    tool: true,
  },
  {
    manufacturer: "anthropic",
    model: "claude-opus-4-0",
    responseFormat: "schema",
    image: true,
    think: false,
    instance: createAnthropic,
    tool: true,
  },
  {
    manufacturer: "anthropic",
    model: "claude-sonnet-4-0",
    responseFormat: "schema",
    image: true,
    think: false,
    instance: createAnthropic,
    tool: true,
  },
  {
    manufacturer: "anthropic",
    model: "claude-3-7-sonnet-latest",
    responseFormat: "schema",
    image: true,
    think: false,
    instance: createAnthropic,
    tool: true,
  },
  {
    manufacturer: "anthropic",
    model: "claude-3-5-haiku-latest",
    responseFormat: "schema",
    image: true,
    think: false,
    instance: createAnthropic,
    tool: true,
  },
  //xai
   {
    manufacturer: "xai",
    model: "grok-3",
    responseFormat: "schema",
    image: false,
    think: false,
    instance: createXai,
    tool: true,
  },
   {
    manufacturer: "xai",
    model: "grok-4",
    responseFormat: "schema",
    image: false,
    think: false,
    instance: createXai,
    tool: true,
  },
  {
    manufacturer: "xai",
    model: "grok-4.1",
    responseFormat: "schema",
    image: true,
    think: false,
    instance: createXai,
    tool: true,
  },
  // T8Star (OpenAI-Compatible)
  {
    manufacturer: "t8star",
    model: "gpt-5.4-pro",
    responseFormat: "object",
    image: true,
    think: true,
    instance: createOpenAI,
    tool: true,
  },
  {
    manufacturer: "t8star",
    model: "gemini-2.5-pro",
    responseFormat: "object",
    image: true,
    think: true,
    instance: createOpenAI,
    tool: true,
  },
  //其他
  {
    manufacturer: "other",
    model: "gpt-4.1",
    responseFormat: "schema",
    image: true,
    think: false,
    instance: createOpenAI,
    tool: true,
  },
];

export const getModelList = async () => {
  try {
    const modelLists = await db("t_textModel").select("*");
    if (!modelLists.length) return modelList;
    const dbModels = modelLists.map((model) => toOwnedModel(model)).filter(Boolean) as Owned[];
    return mergeOwnedModels(modelList, dbModels);
  } catch {
    return modelList;
  }
};

export default modelList;
