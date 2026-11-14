import "../type";
import axios from "axios";

/**
 * ★ agnes（api.agnes-ai.cn）专属图像厂商（2026-11-14）
 * ------------------------------------------------------------------
 * 平台特性（实测）：
 *   · 文生图：POST /v1/images/generations（JSON：model / prompt / size / response_format）
 *   · 图生图：**不走** OpenAI 标准 /v1/images/edits（平台把 edits 的 i2i 权限与
 *     generations 的 t2i 分开鉴权，常规 key 打 edits 必 403 "team not allowed"）；
 *     正确用法是**参考图随 generations 请求透传**——body.extra_body.image = [dataURL]，
 *     平台在 generations 端点内直接做 i2i（用户已验证 200）。
 *   · baseURL 允许两种填法：根路径（…/v1）或完整端点（…/v1/images/generations），自动归一。
 *
 * 返回 url（index.ts 统一按 resType 转 b64），失败抛带平台原始 message 的错误。
 */

const AGNES_DEFAULT_ENDPOINT = "https://api.agnes-ai.cn/v1/images/generations";

const normalizeEndpoint = (baseURL?: string): string => {
  let u = String(baseURL || AGNES_DEFAULT_ENDPOINT).trim().replace(/\/+$/g, "");
  if (!u) u = AGNES_DEFAULT_ENDPOINT;
  if (!/\/images\/generations$/i.test(u)) u = u + "/images/generations";
  return u;
};

const SIZE_MAP: Record<string, string> = {
  "1K": "1024x1024",
  "2K": "2048x2048",
  "4K": "4096x4096",
};

export default async (input: ImageConfig, config: AIConfig): Promise<string> => {
  if (!config.model) throw new Error("缺少Model名称");
  if (!config.apiKey) throw new Error("缺少API Key");
  const apiKey = config.apiKey.replace("Bearer ", "").trim();
  const endpoint = normalizeEndpoint(config.baseURL);

  const fullPrompt = input.systemPrompt ? `${input.systemPrompt}\n\n${input.prompt}` : input.prompt;
  const body: Record<string, unknown> = {
    model: config.model,
    prompt: fullPrompt,
    size: SIZE_MAP[input.size] ?? "1024x1024",
    response_format: "url",
  };
  const hasRefs = !!(input.imageBase64 && input.imageBase64.length);
  if (hasRefs) {
    // ★ agnes 的图生图姿势：参考图放 extra_body.image（不是 /images/edits）
    body.extra_body = { image: input.imageBase64 };
    console.log(`[ai.image][agnes] t2i+refs via generations extra_body.image（${input.imageBase64.length} 张参考图）`);
  }

  const resp = await axios.post(endpoint, body, {
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    timeout: 180000,
  });

  const d: any = resp.data || {};
  const item: any = (d.data && d.data[0]) || (d.images && d.images[0]) || {};
  const url: string = item.url || item.image_url || "";
  if (url) return url;
  const b64: string = item.b64_json || item.base64 || (typeof item === "string" ? item : "") || "";
  if (b64) return b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`;
  throw new Error("agnes 生图返回不含图片数据：" + JSON.stringify(d).slice(0, 200));
};
