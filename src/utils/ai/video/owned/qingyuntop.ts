import "../type";
import axios from "axios";
import FormData from "form-data";
import path from "node:path";
import { pollTask } from "@/utils/ai/utils";
import u from "@/utils";
import db from "@/utils/db";

const VIDEO_DEBUG = (process.env.AI_VIDEO_DEBUG || "").trim() === "1";
const VIDEO_DEBUG_VERBOSE = (process.env.AI_VIDEO_DEBUG_VERBOSE || "").trim() === "1";

function maskKey(input?: string): string {
  const value = String(input || "").trim();
  if (!value) return "";
  if (value.length <= 8) return `${value.slice(0, 2)}***${value.slice(-2)}`;
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function logDebug(message: string, payload?: unknown): void {
  if (!VIDEO_DEBUG) return;
  if (payload === undefined) {
    console.log(`[video:qingyuntop] ${message}`);
    return;
  }
  try {
    const text = JSON.stringify(payload);
    console.log(`[video:qingyuntop] ${message}: ${text.length > 1200 ? `${text.slice(0, 1200)}...` : text}`);
  } catch {
    console.log(`[video:qingyuntop] ${message}:`, payload);
  }
}

function trimSlash(input: string): string {
  return input.replace(/\/+$/, "");
}

function resolveUrls(baseURL?: string): { submitUrl: string; queryUrl: string } {
  const fallbackRoot = "https://api.qingyuntop.top";
  const raw = (baseURL || fallbackRoot).trim();

  if (raw.includes("|")) {
    const [submit, query] = raw.split("|");
    return {
      submitUrl: trimSlash((submit || "").trim()),
      queryUrl: (query || "").trim(),
    };
  }

  const normalized = trimSlash(raw);
  if (/\/v1\/video\/create$/i.test(normalized)) {
    return {
      submitUrl: normalized,
      queryUrl: `${trimSlash(normalized.replace(/\/v1\/video\/create$/i, ""))}/v1/video/query?id={taskId}`,
    };
  }

  return {
    submitUrl: `${normalized}/v1/video/create`,
    queryUrl: `${normalized}/v1/video/query?id={taskId}`,
  };
}

function resolveOpenAiUrls(baseURL?: string): { submitUrl: string; queryUrl: string; contentUrl: string } {
  const fallbackRoot = "https://api.qingyuntop.top/v1/videos";
  const raw = (baseURL || fallbackRoot).trim();

  if (raw.includes("|")) {
    const [submit, query, content] = raw.split("|");
    const submitUrl = trimSlash((submit || "").trim());
    const queryUrl = (query || "").trim() || `${submitUrl}/{taskId}`;
    const contentUrl = (content || "").trim() || `${submitUrl}/{videoId}/content`;
    return { submitUrl, queryUrl, contentUrl };
  }

  const normalized = trimSlash(raw);
  return {
    submitUrl: normalized,
    queryUrl: `${normalized}/{taskId}`,
    contentUrl: `${normalized}/{videoId}/content`,
  };
}

function isOpenAiFormat(baseURL?: string): boolean {
  const raw = String(baseURL || "").trim().toLowerCase();
  return raw.includes("/v1/videos");
}

function pickTaskId(payload: any): string {
  const candidate =
    payload?.id ??
    payload?.task_id ??
    payload?.data?.id ??
    payload?.data?.task_id ??
    payload?.result?.id ??
    payload?.result?.task_id;
  return candidate ? String(candidate) : "";
}

function pickContentId(payload: any): string {
  const candidate = payload?.data?.id ?? payload?.id ?? payload?.result?.id ?? payload?.data?.result?.id;
  return candidate ? String(candidate) : "";
}

function pickStatus(payload: any): string {
  const candidate = payload?.status ?? payload?.data?.status ?? payload?.result?.status ?? payload?.data?.result?.status;
  return candidate ? String(candidate) : "";
}

function pickSize(aspectRatio: string): string {
  const map: Record<string, string> = {
    "16:9": "16x9",
    "9:16": "9x16",
    "1:1": "1x1",
    "4:3": "4x3",
    "3:4": "3x4",
    "21:9": "21x9",
  };
  return map[aspectRatio] || "16x9";
}

function pickVideoUrl(payload: any): string {
  const outputValue =
    payload?.data?.output ??
    payload?.output ??
    payload?.result?.output ??
    payload?.data?.result?.output ??
    payload?.result?.data?.output ??
    payload?.data?.result?.data?.output;

  if (typeof outputValue === "string" && outputValue.trim()) {
    return outputValue.trim();
  }
  if (Array.isArray(outputValue)) {
    const first = outputValue.find((item) => typeof item === "string" && item.trim());
    if (typeof first === "string" && first.trim()) return first.trim();
    const firstObjUrl = outputValue.find((item) => item && typeof item === "object" && (item.url || item.video_url));
    if (firstObjUrl) {
      const objUrl = String(firstObjUrl.url || firstObjUrl.video_url || "").trim();
      if (objUrl) return objUrl;
    }
  }
  if (outputValue && typeof outputValue === "object") {
    const objUrl = String(outputValue.url || outputValue.video_url || "").trim();
    if (objUrl) return objUrl;
  }

  const candidate =
    payload?.video_url ??
    payload?.url ??
    payload?.data?.video_url ??
    payload?.data?.url ??
    payload?.data?.video?.url ??
    payload?.result?.video_url ??
    payload?.result?.url ??
    payload?.data?.result?.video_url ??
    payload?.data?.result?.url ??
    payload?.data?.videos?.[0]?.url ??
    payload?.data?.videos?.[0]?.video_url;
  return candidate ? String(candidate) : "";
}

function pickError(payload: any): string {
  const candidate =
    payload?.fail_reason ??
    payload?.error?.message ??
    payload?.error_message ??
    payload?.message ??
    payload?.data?.fail_reason ??
    payload?.data?.error?.message ??
    payload?.data?.error_message ??
    payload?.data?.message ??
    payload?.result?.fail_reason ??
    payload?.result?.error?.message ??
    payload?.result?.message;
  return candidate ? String(candidate) : "";
}

export interface QingyunTaskQueryResult {
  status: string;
  completed: boolean;
  url?: string;
  error?: string;
}

export async function queryQingyunTaskOnce(
  taskId: string,
  options: {
    apiKey?: string;
    baseURL?: string;
    queryUrl?: string;
  },
): Promise<QingyunTaskQueryResult> {
  if (!taskId) {
    return { status: "UNKNOWN", completed: false, error: "缺少任务ID" };
  }
  if (!options.apiKey) {
    return { status: "UNKNOWN", completed: false, error: "缺少API Key" };
  }

  const openAiFormat = isOpenAiFormat(options.baseURL);
  const authorization = `Bearer ${options.apiKey.replace(/^Bearer\\s*/i, "").trim()}`;

  let queryTemplate = "";
  let contentUrl = "";

  if (openAiFormat) {
    const resolved = resolveOpenAiUrls(options.baseURL);
    queryTemplate = resolved.queryUrl;
    contentUrl = resolved.contentUrl;
  } else {
    const resolved = resolveUrls(options.baseURL);
    queryTemplate = resolved.queryUrl;
  }

  if (options.queryUrl && options.queryUrl.includes("{taskId}")) {
    queryTemplate = options.queryUrl;
  }

  const queryUrlFinal = queryTemplate.includes("{taskId}")
    ? queryTemplate.replace("{taskId}", taskId)
    : `${queryTemplate}${queryTemplate.includes("?") ? "&" : "?"}id=${taskId}`;

  const queryRes = await axios.get(queryUrlFinal, {
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
  });

  const payload = queryRes.data;
  const statusRaw = pickStatus(payload);
  const status = String(statusRaw || "").toUpperCase();
  let url = pickVideoUrl(payload);
  const errorText = pickError(payload);

  if (["SUCCESS", "SUCCEEDED", "COMPLETED"].includes(status)) {
    if (!url && contentUrl) {
      const contentId = pickContentId(payload);
      if (contentId) {
        const contentRes = await axios.get(contentUrl.replace("{videoId}", contentId), {
          headers: {
            Authorization: authorization,
            "Content-Type": "application/json",
          },
        });
        url = pickVideoUrl(contentRes.data);
      }
    }
    if (!url) return { status, completed: false };
    return { status, completed: true, url };
  }

  if (["FAILURE", "FAILED", "ERROR", "CANCELLED", "CANCELED"].includes(status)) {
    return { status, completed: false, error: errorText || `任务失败: ${status}` };
  }

  if (url) {
    return { status: status || "SUCCESS", completed: true, url };
  }

  if (errorText) {
    return { status: status || "FAILED", completed: false, error: errorText };
  }

  return { status: status || "PENDING", completed: false };
}

async function normalizeImageUrls(images?: string[]): Promise<string[]> {
  if (!images || images.length === 0) return [];
  const output: string[] = [];
  let idx = 0;
  for (const image of images) {
    idx += 1;
    if (!image) continue;
    if (image.startsWith("http")) {
      output.push(image);
      continue;
    }
    const dataUrlMatch = /^data:image\/([^;]+);base64,(.*)$/i.exec(image);
    let base64Data = image;
    let ext = "png";
    if (dataUrlMatch) {
      ext = (dataUrlMatch[1] || "png").toLowerCase();
      base64Data = dataUrlMatch[2] || "";
    }
    try {
      const buffer = Buffer.from(base64Data, "base64");
      const filename = `${Date.now()}_${idx}.${ext}`;
      const tempUrl = await u.oss.uploadTemp(buffer, filename);
      if (tempUrl) {
        output.push(tempUrl);
        continue;
      }
      const relPath = path.posix.join("tmp", "qingyuntop", filename);
      await u.oss.writeFile(relPath, buffer);
      const url = await u.oss.getFileUrl(relPath);
      output.push(url);
    } catch (err) {
      logDebug("image convert failed", { index: idx, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return output;
}

async function loadImageBuffer(image: string): Promise<{ buffer: Buffer; filename: string }> {
  if (!image) {
    throw new Error("缺少图片数据");
  }
  if (image.startsWith("http")) {
    const res = await axios.get(image, { responseType: "arraybuffer" });
    const contentType = String(res.headers?.["content-type"] || "image/png").toLowerCase();
    const ext = contentType.includes("jpeg") ? "jpg" : contentType.includes("webp") ? "webp" : contentType.includes("gif") ? "gif" : "png";
    return { buffer: Buffer.from(res.data), filename: `upload.${ext}` };
  }
  const dataUrlMatch = /^data:image\/([^;]+);base64,(.*)$/i.exec(image);
  if (dataUrlMatch) {
    const ext = (dataUrlMatch[1] || "png").toLowerCase();
    const base64Data = dataUrlMatch[2] || "";
    return { buffer: Buffer.from(base64Data, "base64"), filename: `upload.${ext}` };
  }
  return { buffer: Buffer.from(image, "base64"), filename: "upload.png" };
}

export default async (input: VideoConfig, config: AIConfig) => {
  if (!config.model) throw new Error("缺少Model名称");
  if (!config.apiKey) throw new Error("缺少API Key");

  const authorization = `Bearer ${config.apiKey.replace(/^Bearer\\s*/i, "").trim()}`;
  const openAiFormat = isOpenAiFormat(config.baseURL);

  let taskId = "";
  let submitUrl = "";
  let queryUrl = "";
  let contentUrl = "";

  if (openAiFormat) {
    const resolved = resolveOpenAiUrls(config.baseURL);
    submitUrl = resolved.submitUrl;
    queryUrl = resolved.queryUrl;
    contentUrl = resolved.contentUrl;

    const form = new FormData();
    form.append("model", config.model);
    form.append("prompt", input.prompt || "");
    form.append("seconds", String(input.duration || 5));
    form.append("size", pickSize(input.aspectRatio));
    form.append("watermark", "false");

    const images = input.imageBase64 || [];
    if (images.length > 0) {
      const { buffer, filename } = await loadImageBuffer(images[0]!);
      form.append("input_reference", buffer, { filename });
    }

    logDebug("submit request", {
      submitUrl,
      queryUrl,
      model: config.model,
      apiKey: maskKey(config.apiKey),
      promptLength: String(input.prompt || "").length,
      imageCount: images.length,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      duration: input.duration,
      ...(VIDEO_DEBUG_VERBOSE ? { requestBody: { size: pickSize(input.aspectRatio), seconds: input.duration } } : {}),
    });

    const createRes = await axios.post(submitUrl, form, {
      headers: {
        Authorization: authorization,
        ...form.getHeaders(),
      },
    });
    taskId = pickTaskId(createRes.data);
    logDebug("submit response", {
      httpStatus: createRes.status,
      requestId: createRes.headers?.["x-request-id"] || createRes.headers?.["request-id"] || "",
      taskId,
      ...(VIDEO_DEBUG_VERBOSE ? { data: createRes.data } : { status: pickStatus(createRes.data), error: pickError(createRes.data) || "" }),
    });
    if (!taskId) {
      throw new Error(`任务提交成功但未返回id: ${JSON.stringify(createRes.data)}`);
    }
  } else {
    const resolved = resolveUrls(config.baseURL);
    submitUrl = resolved.submitUrl;
    queryUrl = resolved.queryUrl;

    const imageUrls = await normalizeImageUrls(input.imageBase64);
    const body: Record<string, any> = {
      prompt: input.prompt,
      model: config.model,
      aspect_ratio: input.aspectRatio,
      enhance_prompt: true,
    };

    if (["1080p", "2K", "4K"].includes(input.resolution)) {
      body.enable_upsample = true;
    }
    if (imageUrls.length > 0) {
      body.images = imageUrls;
    }

    logDebug("submit request", {
      submitUrl,
      queryUrl,
      model: config.model,
      apiKey: maskKey(config.apiKey),
      promptLength: String(input.prompt || "").length,
      imageCount: imageUrls.length,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      duration: input.duration,
      ...(VIDEO_DEBUG_VERBOSE ? { requestBody: body } : {}),
    });

    const createRes = await axios.post(submitUrl, body, {
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
    });
    taskId = pickTaskId(createRes.data);
    logDebug("submit response", {
      httpStatus: createRes.status,
      requestId: createRes.headers?.["x-request-id"] || createRes.headers?.["request-id"] || "",
      taskId,
      ...(VIDEO_DEBUG_VERBOSE ? { data: createRes.data } : { status: pickStatus(createRes.data), error: pickError(createRes.data) || "" }),
    });
    if (!taskId) {
      throw new Error(`任务提交成功但未返回id: ${JSON.stringify(createRes.data)}`);
    }
  }

  try {
    await db("t_video")
      .where({ filePath: input.savePath, state: 0 })
      .update({
        providerTaskId: taskId,
        providerQueryUrl: queryUrl,
        providerManufacturer: "qingyuntop",
      } as any);
  } catch (err) {
    logDebug("persist task meta failed", {
      savePath: input.savePath,
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let pollCount = 0;
  return pollTask(
    async () => {
      pollCount++;
      const queryUrlFinal = queryUrl.includes("{taskId}") ? queryUrl.replace("{taskId}", taskId) : `${queryUrl}${queryUrl.includes("?") ? "&" : "?"}id=${taskId}`;
      const queryRes = await axios.get(queryUrlFinal, {
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
      });
      const payload = queryRes.data;
      const status = pickStatus(payload).toUpperCase();
      let url = pickVideoUrl(payload);
      const errorText = pickError(payload);

      if (VIDEO_DEBUG && (pollCount <= 5 || pollCount % 10 === 0 || Boolean(url) || Boolean(errorText))) {
        logDebug(`poll response #${pollCount}`, {
          httpStatus: queryRes.status,
          requestId: queryRes.headers?.["x-request-id"] || queryRes.headers?.["request-id"] || "",
          status,
          hasUrl: Boolean(url),
          error: errorText || "",
          ...(VIDEO_DEBUG_VERBOSE ? { data: payload } : {}),
        });
      }

      if (["SUCCESS", "SUCCEEDED", "COMPLETED"].includes(status)) {
        if (!url && contentUrl) {
          const contentId = pickContentId(payload);
          if (contentId) {
            const contentRes = await axios.get(contentUrl.replace("{videoId}", contentId), {
              headers: {
                Authorization: authorization,
                "Content-Type": "application/json",
              },
            });
            url = pickVideoUrl(contentRes.data);
          }
        }
        if (!url) {
          return { completed: false, status };
        }
        return { completed: true, url, status };
      }

      if (["FAILURE", "FAILED", "ERROR", "CANCELLED", "CANCELED"].includes(status)) {
        return { completed: false, error: errorText || `任务失败: ${status}`, status };
      }

      if (["NOT_START", "SUBMITTED", "QUEUED", "IN_PROGRESS", "RUNNING", "PENDING", "PROCESSING"].includes(status)) {
        return { completed: false, status };
      }

      if (url) {
        return { completed: true, url, status };
      }

      return { completed: false, status };
    },
    500,
    2000,
    {
      label: `video:qingyuntop:${config.model}`,
      debug: VIDEO_DEBUG,
      logEvery: 10,
    },
  );
};
