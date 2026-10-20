import "../type";
import axios from "axios";

const SILICONFLOW_BASE_URL = "https://api.siliconflow.cn";

/**
 * 硅基流动生图
 * API: POST /v1/images/generations
 * 响应格式与 OpenAI 不同：URL 在 images[0].url，不是 data[0].url
 */
export default async (input: ImageConfig, config: AIConfig): Promise<string> => {
  if (!config.model) throw new Error("缺少Model名称");
  if (!config.apiKey) throw new Error("缺少API Key");

  const apiKey = config.apiKey.replace("Bearer ", "").trim();

  // size 映射
  const sizeMap: Record<string, string> = {
    "1K": "1024x1024",
    "2K": "2048x2048",
    "4K": "4096x4096",
  };

  const size = sizeMap[input.size ?? "1K"] ?? "1024x1024";

  const requestBody: Record<string, any> = {
    model: config.model,
    prompt: input.systemPrompt ? `${input.systemPrompt}\n\n${input.prompt}` : input.prompt,
    image_size: size,
  };

  // 图生图：传入参考图
  if (input.imageBase64 && input.imageBase64.length > 0) {
    requestBody.image = input.imageBase64[0]!.startsWith("data:")
      ? input.imageBase64[0]
      : `data:image/png;base64,${input.imageBase64[0]}`;
  }

  const response = await axios.post(
    `${SILICONFLOW_BASE_URL}/v1/images/generations`,
    requestBody,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Enable-Watermark": "0",
      },
      timeout: 120000,
    },
  );

  // 硅基流动响应：{ images: [{ url }], data: [{ url }], seed, ... }
  const images = response.data?.images;
  if (Array.isArray(images) && images.length > 0 && images[0]?.url) {
    return images[0].url;
  }

  // 兜底 data 字段（某些模型可能走这里）
  const data = response.data?.data;
  if (Array.isArray(data) && data.length > 0 && data[0]?.url) {
    return data[0].url;
  }

  throw new Error(`硅基流动生图返回格式异常：${JSON.stringify(response.data).slice(0, 200)}`);
};
