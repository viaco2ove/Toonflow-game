import "../type";
import { generateImage, generateText, ModelMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import axios from "axios";

const normalizeBaseURL = (baseURL: string): string => {
  let normalized = baseURL.trim().replace(/\|+$/g, "");
  if (!normalized) throw new Error("缺少baseUrl");

  // OpenAI 兼容 SDK 会自动拼接 /images/generations，避免重复拼接。
  normalized = normalized.replace(/\/images\/generations\/?$/i, "");

  if (normalized.includes("|")) {
    throw new Error("other 厂商的 baseURL 不能包含 |，请只填写 OpenAI 兼容根路径（例如 https://example.com/v1）");
  }

  return normalized;
};

export default async (input: ImageConfig, config: AIConfig): Promise<string> => {
  if (!config.model) throw new Error("缺少Model名称");
  if (!config.apiKey) throw new Error("缺少API Key");
  if (!config.baseURL) throw new Error("缺少baseUrl");
  const baseURL = normalizeBaseURL(config.baseURL);

  const apiKey = config.apiKey.replace("Bearer ", "");

  const otherProvider = createOpenAICompatible({
    name: "xixixi",
    baseURL,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  // 根据 size 配置映射到具体尺寸
  const sizeMap: Record<string, `${number}x${number}`> = {
    "1K": "1024x1024",
    "2K": "2048x2048",
    "4K": "4096x4096",
  };
  // 构建完整的提示词
  const fullPrompt = input.systemPrompt ? `${input.systemPrompt}\n\n${input.prompt}` : input.prompt;
  const model = config.model;
  if (model.includes("gemini") || model.includes("nano")) {
    let promptData;
    if (input.imageBase64 && input.imageBase64.length) {
      promptData = [{ role: "system", content: fullPrompt + `请直接输出图片` }];
      (promptData as ModelMessage[]).push({
        role: "user",
        content: input.imageBase64.map((i) => ({
          type: "image",
          image: i,
        })),
      });
    } else {
      promptData = fullPrompt + `请直接输出图片`;
    }

    const result = await generateText({
      model: otherProvider.languageModel(model),
      prompt: promptData as string | ModelMessage[],
      providerOptions: {
        google: {
          imageConfig: {
            ...(config.model == "gemini-2.5-flash-image"
              ? { aspectRatio: input.aspectRatio }
              : { aspectRatio: input.aspectRatio, imageSize: input.size }),
          },
          responseModalities: ["IMAGE"],
        },
      },
    });

    if (result.files && result.files.length) {
      let imageBase64;
      for (const item of result.files) {
        imageBase64 = `data:${item.mediaType};base64,${item.base64}`;
      }
      // 返回生成的图片 base64
      return imageBase64!;
    } else {
      if (!result.text) {
        console.error(JSON.stringify(result.response, null, 2));
        throw new Error("图片生成失败");
      }
      // 匹配所有 markdown 图片 ![...](url)
      const mdImgPattern = /!\[.*?\]\((.+?)\)/g;
      const matches = [...result.text.matchAll(mdImgPattern)];
      for (const match of matches) {
        const imgInfo = match[1];
        // 检查是否已是 base64
        const base64InMd = imgInfo.match(/data:image\/[a-z]+;base64,.+/);
        if (base64InMd) {
          return imgInfo; // 已经是base64，直接返回
        } else {
          return await urlToBase64(imgInfo); // 否则尝试转base64
        }
      }
      // 检查纯base64字符串
      const base64Match = result.text.match(/base64,([A-Za-z0-9+/=]+)/);
      if (base64Match) {
        return "data:image/jpeg;base64," + base64Match[1];
      }
      // 检查是否为图片直链接
      if (/^https?:\/\/.*\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(result.text)) {
        return await urlToBase64(result.text);
      }
      // 默认情况
      return result.text;
    }
  } else {
    const hasRefs = !!(input.imageBase64 && input.imageBase64.length);
    try {
      const { image } = await generateImage({
        model: otherProvider.imageModel(model),
        prompt: hasRefs
          ? { text: fullPrompt + `请直接输出图片`, images: input.imageBase64 }
          : fullPrompt + `请直接输出图片`,
        aspectRatio: input.aspectRatio as "1:1" | "3:4" | "4:3" | "9:16" | "16:9",
        size: sizeMap[input.size] ?? "1024x1024",
      });
      return image.base64;
    } catch (e) {
      /* ★ 2026-11-14 图生图端点降级：
       *   带参考图时 AI SDK 标准实现走 /images/edits（multipart），但部分平台
       *   （实测 agnes）把 edits 的 i2i 权限与 generations 的 t2i 分开鉴权 → 403
       *   "team not allowed"。而这些平台的 generations 端点自己支持 image 数组
       *   做图生图（openai SDK extra_body.image 用法）。这里 edits 失败改走
       *   generations+image 重试；不带图的原样抛错。 */
      if (!hasRefs) throw e;
      console.warn(
        "[ai.image][other] /images/edits 失败，改走 /images/generations + image 图生图重试:",
        (e instanceof Error ? e.message : String(e)).slice(0, 200),
      );
      const resp = await axios.post(
        `${baseURL}/images/generations`,
        {
          model,
          prompt: fullPrompt + `请直接输出图片`,
          size: sizeMap[input.size] ?? "1024x1024",
          image: input.imageBase64,
          extra_body: { image: input.imageBase64 },
        },
        {
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          timeout: 180000,
        },
      );
      const d: any = resp.data || {};
      const item: any = (d.data && d.data[0]) || (d.images && d.images[0]) || {};
      const url: string = item.url || item.image_url || "";
      if (url) return await urlToBase64(url);
      const b64: string = item.b64_json || item.base64 || (typeof item === "string" ? item : "") || "";
      if (b64) return b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`;
      throw e;
    }
  }
};

async function urlToBase64(url: string): Promise<string> {
  const res = await axios.get(url, { responseType: "arraybuffer" });
  const base64 = Buffer.from(res.data).toString("base64");
  const mimeType = res.headers["content-type"] || "image/png";
  return `data:${mimeType};base64,${base64}`;
}
