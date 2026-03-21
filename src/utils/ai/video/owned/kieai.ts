import "../type";
import axios from "axios";
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
    console.log(`[video:kieai] ${message}`);
    return;
  }
  try {
    const text = JSON.stringify(payload);
    console.log(`[video:kieai] ${message}: ${text.length > 1200 ? `${text.slice(0, 1200)}...` : text}`);
  } catch {
    console.log(`[video:kieai] ${message}:`, payload);
  }
}

function trimSlash(input: string): string {
  return input.replace(/\/+$/, "");
}

function resolveUrls(baseURL?: string): { submitUrl: string; queryUrl: string } {
  const fallbackRoot = "https://api.kie.ai";
  const raw = (baseURL || fallbackRoot).trim();

  if (raw.includes("|")) {
    const [submit, query] = raw.split("|");
    return {
      submitUrl: trimSlash((submit || "").trim()),
      queryUrl: (query || "").trim(),
    };
  }

  const normalized = trimSlash(raw);
  if (/\/api\/v1\/veo\/generate$/i.test(normalized)) {
    return {
      submitUrl: normalized,
      queryUrl: `${trimSlash(normalized.replace(/\/api\/v1\/veo\/generate$/i, ""))}/api/v1/veo/record-info?taskId={taskId}`,
    };
  }

  return {
    submitUrl: `${normalized}/api/v1/veo/generate`,
    queryUrl: `${normalized}/api/v1/veo/record-info?taskId={taskId}`,
  };
}

function pickTaskId(payload: any): string {
  const candidate =
    payload?.data?.taskId ??
    payload?.taskId ??
    payload?.data?.task_id ??
    payload?.task_id ??
    payload?.result?.taskId ??
    payload?.result?.task_id;
  return candidate ? String(candidate) : "";
}

function pickVideoUrl(payload: any): string {
  const responseUrls =
    payload?.data?.response?.resultUrls ??
    payload?.data?.resultUrls ??
    payload?.response?.resultUrls ??
    payload?.resultUrls;

  if (Array.isArray(responseUrls)) {
    const first = responseUrls.find((item) => typeof item === "string" && item.trim());
    if (first) return String(first).trim();
  }

  const candidate =
    payload?.data?.result_url ??
    payload?.data?.resultUrl ??
    payload?.result_url ??
    payload?.resultUrl ??
    payload?.data?.response?.result_url ??
    payload?.data?.response?.resultUrl ??
    payload?.data?.video_url ??
    payload?.video_url ??
    payload?.url;
  return candidate ? String(candidate) : "";
}

function pickError(payload: any): string {
  const candidate =
    payload?.data?.errorMessage ??
    payload?.errorMessage ??
    payload?.msg ??
    payload?.message ??
    payload?.data?.message ??
    payload?.data?.error ??
    payload?.error;
  return candidate ? String(candidate) : "";
}

export interface KieAiTaskQueryResult {
  status: string;
  completed: boolean;
  url?: string;
  error?: string;
}

export async function queryKieAiTaskOnce(
  taskId: string,
  options: {
    apiKey?: string;
    baseURL?: string;
    queryUrl?: string;
  },
): Promise<KieAiTaskQueryResult> {
  if (!taskId) {
    return { status: "UNKNOWN", completed: false, error: "缺少任务ID" };
  }
  if (!options.apiKey) {
    return { status: "UNKNOWN", completed: false, error: "缺少API Key" };
  }

  const { queryUrl } = resolveUrls(options.baseURL);
  const queryTemplate =
    options.queryUrl && options.queryUrl.includes("{taskId}") ? options.queryUrl : queryUrl;
  const queryUrlFinal = queryTemplate.includes("{taskId}")
    ? queryTemplate.replace("{taskId}", taskId)
    : `${queryTemplate}${queryTemplate.includes("?") ? "&" : "?"}taskId=${taskId}`;
  const authorization = `Bearer ${options.apiKey.replace(/^Bearer\\s*/i, "").trim()}`;

  const queryRes = await axios.get(queryUrlFinal, {
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
  });

  const payload = queryRes.data;
  const successFlag = Number(payload?.data?.successFlag ?? payload?.successFlag ?? 0);
  const url = pickVideoUrl(payload);
  const errorText = pickError(payload);

  if (payload?.code && Number(payload.code) !== 200) {
    return { status: "FAILED", completed: false, error: errorText || String(payload?.msg || "任务失败") };
  }

  if (successFlag === 1) {
    if (!url) {
      return { status: "SUCCESS", completed: false };
    }
    return { status: "SUCCESS", completed: true, url };
  }

  if (errorText) {
    return { status: "FAILED", completed: false, error: errorText };
  }

  if (url) {
    return { status: "SUCCESS", completed: true, url };
  }

  return { status: "PENDING", completed: false };
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
      const relPath = path.posix.join("tmp", "kieai", filename);
      await u.oss.writeFile(relPath, buffer);
      const url = await u.oss.getFileUrl(relPath);
      output.push(url);
    } catch (err) {
      logDebug("image convert failed", { index: idx, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return output;
}

export default async (input: VideoConfig, config: AIConfig) => {
  if (!config.model) throw new Error("缺少Model名称");
  if (!config.apiKey) throw new Error("缺少API Key");

  const { submitUrl, queryUrl } = resolveUrls(config.baseURL);
  const authorization = `Bearer ${config.apiKey.replace(/^Bearer\\s*/i, "").trim()}`;
  const imageUrls = await normalizeImageUrls(input.imageBase64);
  const generationType = imageUrls.length > 0 ? "REFERENCE_2_VIDEO" : "TEXT_2_VIDEO";

  const body: Record<string, any> = {
    prompt: input.prompt,
    model: config.model,
    aspect_ratio: input.aspectRatio || "16:9",
    enableFallback: false,
    enableTranslation: true,
    generationType,
  };
  if (imageUrls.length > 0) {
    body.imageUrls = imageUrls;
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
    generationType,
    ...(VIDEO_DEBUG_VERBOSE ? { requestBody: body } : {}),
  });

  const createRes = await axios.post(submitUrl, body, {
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
  });
  const taskId = pickTaskId(createRes.data);
  logDebug("submit response", {
    httpStatus: createRes.status,
    requestId: createRes.headers?.["x-request-id"] || createRes.headers?.["request-id"] || "",
    taskId,
    ...(VIDEO_DEBUG_VERBOSE ? { data: createRes.data } : { error: pickError(createRes.data) || "" }),
  });
  if (!taskId) {
    throw new Error(`任务提交成功但未返回taskId: ${JSON.stringify(createRes.data)}`);
  }

  try {
    await db("t_video")
      .where({ filePath: input.savePath, state: 0 })
      .update({
        providerTaskId: taskId,
        providerQueryUrl: queryUrl,
        providerManufacturer: "kieai",
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
      const queryUrlFinal = queryUrl.includes("{taskId}")
        ? queryUrl.replace("{taskId}", taskId)
        : `${queryUrl}${queryUrl.includes("?") ? "&" : "?"}taskId=${taskId}`;
      const queryRes = await axios.get(queryUrlFinal, {
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
      });
      const payload = queryRes.data;
      const successFlag = Number(payload?.data?.successFlag ?? payload?.successFlag ?? 0);
      const url = pickVideoUrl(payload);
      const errorText = pickError(payload);
      const status = successFlag === 1 ? "SUCCESS" : "PENDING";

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

      if (payload?.code && Number(payload.code) !== 200) {
        return { completed: false, error: errorText || String(payload?.msg || "任务失败"), status: "FAILED" };
      }

      if (successFlag === 1) {
        if (!url) {
          return { completed: false, status };
        }
        return { completed: true, url, status };
      }

      if (errorText) {
        return { completed: false, error: errorText, status: "FAILED" };
      }

      if (url) {
        return { completed: true, url, status: "SUCCESS" };
      }

      return { completed: false, status };
    },
    500,
    2000,
    {
      label: `video:kieai:${config.model}`,
      debug: VIDEO_DEBUG,
      logEvery: 10,
    },
  );
};
