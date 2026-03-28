import "../type";
import { generateImage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const normalizeBaseURL = (baseURL: string): string => {
  let normalized = baseURL.trim().replace(/\|+$/g, "");
  if (!normalized) throw new Error("缺少baseUrl");

  // OpenAI 兼容 SDK 会自动拼接 /images/generations，避免重复拼接。
  normalized = normalized.replace(/\/images\/generations\/?$/i, "");

  if (normalized.includes("|")) {
    throw new Error("t8star 的 baseURL 不能包含 |，请填写 OpenAI 兼容根路径（例如 https://ai.t8star.cn/v1）");
  }

  return normalized;
};

export default async (input: ImageConfig, config: AIConfig): Promise<string> => {
  if (!config.model) throw new Error("缺少Model名称");
  if (!config.apiKey) throw new Error("缺少API Key");
  if (!config.baseURL) throw new Error("缺少baseUrl");

  const provider = createOpenAICompatible({
    name: "t8star",
    baseURL: normalizeBaseURL(config.baseURL),
    headers: {
      Authorization: `Bearer ${config.apiKey.replace("Bearer ", "")}`,
    },
  });

  const sizeMap: Record<string, `${number}x${number}`> = {
    "1K": "1024x1024",
    "2K": "2048x2048",
    "4K": "4096x4096",
  };
  const fullPrompt = input.systemPrompt ? `${input.systemPrompt}\n\n${input.prompt}` : input.prompt;

  const { image } = await generateImage({
    model: provider.imageModel(config.model),
    prompt:
      input.imageBase64 && input.imageBase64.length
        ? { text: fullPrompt + `请直接输出图片`, images: input.imageBase64 }
        : fullPrompt + `请直接输出图片`,
    aspectRatio: input.aspectRatio as "1:1" | "3:4" | "4:3" | "9:16" | "16:9",
    size: sizeMap[input.size] ?? "1024x1024",
  });

  return image.base64;
};
