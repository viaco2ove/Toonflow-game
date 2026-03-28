import express from "express";
import { Readable } from "node:stream";
import sharp from "sharp";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import u from "@/utils";

const router = express.Router();

const MODEL_INPUT_SIZE = 1024;
const AVATAR_STD_SIZE = 512;
const AVATAR_BG_SIZE = 768;
const FOREGROUND_SIDE_PADDING = 10;
const FOREGROUND_TOP_PADDING = 8;
const FOREGROUND_BOTTOM_PADDING = 0;
const ALPHA_CROP_PADDING = 6;
const ALIYUN_IMAGESEG_BASE_URL = "https://imageseg.cn-shanghai.aliyuncs.com";
const ALIYUN_IMAGESEG_DEFAULT_REGION_ID = "cn-shanghai";
const ROLE_AVATAR_TASK_TYPE = "separate_role_avatar";
const ROLE_AVATAR_STATUS_QUEUED = "queued";
const ROLE_AVATAR_STATUS_PROCESSING = "processing";
const ROLE_AVATAR_STATUS_SUCCESS = "success";
const ROLE_AVATAR_STATUS_FAILED = "failed";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0", "::1"]);
const activeRoleAvatarTasks = new Map<number, Promise<void>>();

type SeparateRoleAvatarPayload = {
  projectId?: number | null;
  fileName?: string | null;
  name?: string | null;
  base64Data: string;
};

type RoleAvatarTaskRow = {
  id?: number | null;
  userId?: number | null;
  projectId?: number | null;
  taskType?: string | null;
  status?: string | null;
  progress?: number | null;
  message?: string | null;
  errorMessage?: string | null;
  foregroundPath?: string | null;
  foregroundFilePath?: string | null;
  backgroundPath?: string | null;
  backgroundFilePath?: string | null;
  createTime?: number | null;
  updateTime?: number | null;
};

type RoleAvatarTaskUpdate = {
  status?: string | null;
  progress?: number | null;
  message?: string | null;
  errorMessage?: string | null;
  foregroundPath?: string | null;
  foregroundFilePath?: string | null;
  backgroundPath?: string | null;
  backgroundFilePath?: string | null;
};

type SeparateRoleAvatarResult = {
  foregroundPath: string;
  foregroundFilePath: string;
  backgroundPath: string;
  backgroundFilePath: string;
};

type ImageAiConfig = {
  model?: string;
  apiKey: string;
  baseURL?: string;
  manufacturer: string;
};

type AliyunAccessKeyPair = {
  accessKeyId: string;
  accessKeySecret: string;
};

type TencentAccessKeyPair = {
  secretId: string;
  secretKey: string;
  sessionToken?: string;
};

type TencentCosBucketConfig = {
  bucket: string;
  region: string;
};

type AliyunMattingAction = {
  action: "SegmentCommonImage" | "SegmentHDCommonImage" | "SegmentBody" | "SegmentHDBody";
  requestType: "SegmentCommonImageAdvanceRequest" | "SegmentHDCommonImageAdvanceRequest" | "SegmentBodyAdvanceRequest" | "SegmentHDBodyAdvanceRequest";
  requestField: "imageURLObject" | "imageUrlObject";
  sdkMethod: "segmentCommonImageAdvance" | "segmentHDCommonImageAdvance" | "segmentBodyAdvance" | "segmentHDBodyAdvance";
};

type AliyunErrorDetail = {
  httpStatus: number | null;
  code: string;
  message: string;
  requestId: string;
};

type TencentErrorDetail = {
  httpStatus: number | null;
  code: string;
  message: string;
  requestId: string;
};

function nowTs(): number {
  return Date.now();
}

function normalizeBase64Data(input: string, fileName: string): string {
  const value = String(input || "").trim();
  if (!value) throw new Error("缺少待分离图片");
  if (/^data:image\//i.test(value)) return value;

  const ext = String(fileName || "").trim().split(".").pop()?.toLowerCase() || "";
  if (ext === "jpg" || ext === "jpeg") return `data:image/jpeg;base64,${value}`;
  if (ext === "gif") return `data:image/gif;base64,${value}`;
  if (ext === "webp") return `data:image/webp;base64,${value}`;
  return `data:image/png;base64,${value}`;
}

function extractBase64Buffer(content: string): Buffer {
  const value = String(content || "").trim();
  const match = value.match(/base64,([A-Za-z0-9+/=]+)/);
  return Buffer.from(match && match[1] ? match[1] : value, "base64");
}

function bufferToDataUrl(buffer: Buffer, mime = "image/png"): string {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return LOCAL_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function imageOutputToBuffer(content: string): Promise<Buffer> {
  const trimmed = String(content || "").trim();
  if (!trimmed) {
    throw new Error("图像模型未返回图片内容");
  }
  if (/^data:image\//i.test(trimmed) || /^iVBOR|^\/9j\/|^R0lGOD|^UklGR/i.test(trimmed)) {
    return extractBase64Buffer(trimmed);
  }
  const markdownMatch = trimmed.match(/!\[[^\]]*]\((.+?)\)/);
  const candidate = markdownMatch?.[1]?.trim() || trimmed;
  if (/^data:image\//i.test(candidate)) {
    return extractBase64Buffer(candidate);
  }
  if (/^https?:\/\//i.test(candidate)) {
    const response = await axios.get(candidate, {
      responseType: "arraybuffer",
      timeout: 30000,
      ...(isLocalUrl(candidate) ? { proxy: false } : {}),
    });
    return Buffer.from(response.data);
  }
  return extractBase64Buffer(candidate);
}

async function normalizeRoleSource(dataUrl: string): Promise<Buffer> {
  const source = extractBase64Buffer(dataUrl);
  return await sharp(source, { animated: true, pages: 1 })
    .resize(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE, {
      fit: "contain",
      background: { r: 248, g: 250, b: 252, alpha: 1 },
    })
    .png()
    .toBuffer();
}

async function normalizeRoleSourceForMatting(dataUrl: string): Promise<Buffer> {
  const source = extractBase64Buffer(dataUrl);
  return await sharp(source, { animated: true, pages: 1 })
    .resize(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
}

async function extractOpaqueBounds(input: Buffer): Promise<{ left: number; top: number; width: number; height: number } | null> {
  const prepared = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data, info } = prepared;
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const alphaIndex = (y * info.width + x) * info.channels + 3;
      const alpha = data[alphaIndex] ?? 0;
      if (alpha <= 14) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0 || maxY < 0) return null;
  const left = Math.max(0, minX - ALPHA_CROP_PADDING);
  const top = Math.max(0, minY - ALPHA_CROP_PADDING);
  const right = Math.min(info.width - 1, maxX + ALPHA_CROP_PADDING);
  const bottom = Math.min(info.height - 1, maxY + ALPHA_CROP_PADDING);
  return {
    left,
    top,
    width: right - left + 1,
    height: bottom - top + 1,
  };
}

async function fitTransparentCanvas(input: Buffer, width: number, height: number): Promise<Buffer> {
  return await sharp(input)
    .resize(width, height, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      position: "centre",
    })
    .png()
    .toBuffer();
}

async function resizeInside(input: Buffer, width: number, height: number): Promise<Buffer> {
  return await sharp(input)
    .resize(width, height, {
      fit: "inside",
      withoutEnlargement: false,
    })
    .png()
    .toBuffer();
}

async function chromaKeyForeground(input: Buffer): Promise<Buffer> {
  const prepared = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data, info } = prepared;
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const a = data[i + 3] ?? 255;
    const greenLead = g - Math.max(r, b);
    if (g > 120 && greenLead > 18) {
      const fade = Math.min(1, Math.max(0, (greenLead - 18) / 92));
      data[i + 3] = Math.max(0, Math.round(a * (1 - fade)));
    }
  }

  return await sharp(data, {
    raw: {
      width: info.width,
      height: info.height,
      channels: info.channels,
    },
  }).png().toBuffer();
}

async function normalizeForegroundLayer(input: Buffer, options?: { skipChromaKey?: boolean }): Promise<Buffer> {
  const prepared = options?.skipChromaKey
    ? await sharp(input).ensureAlpha().png().toBuffer()
    : await chromaKeyForeground(input);
  const bounds = await extractOpaqueBounds(prepared);
  const cropped = bounds
    ? await sharp(prepared).extract(bounds).png().toBuffer()
    : prepared;
  const availableWidth = Math.max(1, AVATAR_STD_SIZE - FOREGROUND_SIDE_PADDING * 2);
  const availableHeight = Math.max(1, AVATAR_STD_SIZE - FOREGROUND_TOP_PADDING - FOREGROUND_BOTTOM_PADDING);
  const resized = await resizeInside(cropped, availableWidth, availableHeight);
  const metadata = await sharp(resized).metadata();
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  const left = Math.max(0, Math.round((AVATAR_STD_SIZE - width) / 2));
  const top = Math.max(0, AVATAR_STD_SIZE - height - FOREGROUND_BOTTOM_PADDING);
  return await sharp({
    create: {
      width: AVATAR_STD_SIZE,
      height: AVATAR_STD_SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: resized,
        left,
        top,
      },
    ])
    .png()
    .toBuffer();
}

async function normalizeBackgroundLayer(input: Buffer): Promise<Buffer> {
  return await fitTransparentCanvas(input, AVATAR_BG_SIZE, AVATAR_BG_SIZE);
}

async function resolveImageConfig(userId: number) {
  const keys = ["storyImageModel", "editImage", "assetsImage"];
  for (const key of keys) {
    const config = await u.getPromptAi(key, userId);
    if ((config as any)?.manufacturer) return config as any;
  }
  throw new Error("未配置可用图像模型，请先配置 AI生图 或 图片编辑 模型");
}

async function resolveAvatarMattingConfig(userId: number): Promise<ImageAiConfig | null> {
  const config = await u.getPromptAi("storyAvatarMattingModel", userId);
  if ((config as any)?.manufacturer) {
    return config as ImageAiConfig;
  }
  return null;
}

function isBriaAvatarMattingConfig(config: ImageAiConfig | null | undefined): config is ImageAiConfig {
  return String(config?.manufacturer || "").trim().toLowerCase() === "bria"
    && !!String(config?.apiKey || "").trim();
}

function isAliyunAvatarMattingConfig(config: ImageAiConfig | null | undefined): config is ImageAiConfig {
  return String(config?.manufacturer || "").trim().toLowerCase() === "aliyun_imageseg"
    && !!String(config?.apiKey || "").trim();
}

function isTencentAvatarMattingConfig(config: ImageAiConfig | null | undefined): config is ImageAiConfig {
  return String(config?.manufacturer || "").trim().toLowerCase() === "tencent_ci"
    && !!String(config?.apiKey || "").trim()
    && !!String(config?.baseURL || "").trim();
}

function normalizeBriaBaseUrl(baseURL?: string): string {
  const normalized = String(baseURL || "").trim().replace(/\/+$/, "");
  if (!normalized) return "https://engine.prod.bria-api.com/v2/image/edit";
  if (/\/(remove_background|erase_foreground)$/i.test(normalized)) {
    return normalized.replace(/\/(remove_background|erase_foreground)$/i, "");
  }
  return normalized;
}

function normalizeAliyunBaseUrl(baseURL?: string): string {
  const normalized = String(baseURL || "").trim().replace(/\/+$/, "");
  return normalized || ALIYUN_IMAGESEG_BASE_URL;
}

function resolveAliyunEndpoint(baseURL?: string): string {
  try {
    return new URL(normalizeAliyunBaseUrl(baseURL)).host;
  } catch {
    return new URL(ALIYUN_IMAGESEG_BASE_URL).host;
  }
}

function resolveAliyunRegionId(baseURL?: string): string {
  const endpoint = resolveAliyunEndpoint(baseURL);
  const matched = endpoint.match(/imageseg\.([^.]+)\.aliyuncs\.com/i);
  return matched?.[1]?.trim() || ALIYUN_IMAGESEG_DEFAULT_REGION_ID;
}

function parseAliyunAccessKeyPair(apiKey: string): AliyunAccessKeyPair {
  const raw = String(apiKey || "").trim();
  if (!raw) {
    throw new Error("阿里云主体分离缺少 AccessKey 配置");
  }
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      const accessKeyId = String(parsed?.accessKeyId || parsed?.AccessKeyId || "").trim();
      const accessKeySecret = String(parsed?.accessKeySecret || parsed?.AccessKeySecret || "").trim();
      if (accessKeyId && accessKeySecret) {
        return { accessKeyId, accessKeySecret };
      }
    } catch {
      // noop
    }
  }

  const pipeIndex = raw.indexOf("|");
  if (pipeIndex > 0) {
    const accessKeyId = raw.slice(0, pipeIndex).trim();
    const accessKeySecret = raw.slice(pipeIndex + 1).trim();
    if (accessKeyId && accessKeySecret) {
      return { accessKeyId, accessKeySecret };
    }
  }

  const lines = raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (lines.length >= 2) {
    return {
      accessKeyId: lines[0],
      accessKeySecret: lines.slice(1).join(""),
    };
  }

  throw new Error("阿里云主体分离的 API Key 格式无效，请填写 AccessKeyId|AccessKeySecret 或 JSON");
}

function parseTencentAccessKeyPair(apiKey: string): TencentAccessKeyPair {
  const raw = String(apiKey || "").trim();
  if (!raw) {
    throw new Error("腾讯云主体分离缺少 SecretId / SecretKey 配置");
  }
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      const secretId = String(parsed?.secretId || parsed?.SecretId || "").trim();
      const secretKey = String(parsed?.secretKey || parsed?.SecretKey || "").trim();
      const sessionToken = String(parsed?.sessionToken || parsed?.SessionToken || parsed?.token || "").trim();
      if (secretId && secretKey) {
        return {
          secretId,
          secretKey,
          sessionToken: sessionToken || undefined,
        };
      }
    } catch {
      // noop
    }
  }

  const pipeParts = raw.split("|").map((item) => item.trim()).filter(Boolean);
  if (pipeParts.length >= 2) {
    return {
      secretId: pipeParts[0],
      secretKey: pipeParts[1],
      sessionToken: pipeParts[2] || undefined,
    };
  }

  const lines = raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (lines.length >= 2) {
    return {
      secretId: lines[0],
      secretKey: lines[1],
      sessionToken: lines[2] || undefined,
    };
  }

  throw new Error("腾讯云主体分离的 API Key 格式无效，请填写 SecretId|SecretKey 或 JSON");
}

function parseTencentCosBucketConfig(baseURL?: string): TencentCosBucketConfig {
  const raw = String(baseURL || "").trim();
  if (!raw) {
    throw new Error("腾讯云主体分离缺少 COS 存储桶地址，请填写标准 COS 桶域名");
  }
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      const bucket = String(parsed?.bucket || parsed?.Bucket || "").trim();
      const region = String(parsed?.region || parsed?.Region || "").trim();
      if (bucket && region) {
        return { bucket, region };
      }
    } catch {
      // noop
    }
  }

  const pipeParts = raw.split("|").map((item) => item.trim()).filter(Boolean);
  if (pipeParts.length >= 2 && !/^https?:\/\//i.test(pipeParts[0])) {
    return {
      bucket: pipeParts[0],
      region: pipeParts[1],
    };
  }

  const normalizedUrl = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let host = "";
  try {
    host = new URL(normalizedUrl).host;
  } catch {
    throw new Error("腾讯云主体分离的 Base URL 无效，请填写标准 COS 桶域名");
  }
  const matched = host.match(/^([^.]+)\.(?:cos|ci)\.([^.]+)\.myqcloud\.com$/i);
  if (!matched) {
    throw new Error("腾讯云主体分离的 Base URL 必须是标准 COS 桶域名，例如 https://bucket-appid.cos.ap-shanghai.myqcloud.com");
  }
  return {
    bucket: String(matched[1] || "").trim(),
    region: String(matched[2] || "").trim(),
  };
}

function resolveAliyunMattingAction(model?: string): AliyunMattingAction {
  const normalized = String(model || "").trim().toLowerCase();
  if (normalized === "segmenthdbody" || normalized.includes("hdbody")) {
    return {
      action: "SegmentHDBody",
      requestType: "SegmentHDBodyAdvanceRequest",
      requestField: "imageURLObject",
      sdkMethod: "segmentHDBodyAdvance",
    };
  }
  if (normalized === "segmentbody" || normalized.endsWith("body")) {
    return {
      action: "SegmentBody",
      requestType: "SegmentBodyAdvanceRequest",
      requestField: "imageURLObject",
      sdkMethod: "segmentBodyAdvance",
    };
  }
  if (normalized === "segmenthdcommonimage" || normalized.includes("hdcommon")) {
    return {
      action: "SegmentHDCommonImage",
      requestType: "SegmentHDCommonImageAdvanceRequest",
      requestField: "imageUrlObject",
      sdkMethod: "segmentHDCommonImageAdvance",
    };
  }
  return {
    action: "SegmentCommonImage",
    requestType: "SegmentCommonImageAdvanceRequest",
    requestField: "imageURLObject",
    sdkMethod: "segmentCommonImageAdvance",
  };
}

function resolveTencentMattingAction(model?: string): "AIPortraitMatting" {
  const normalized = String(model || "").trim().toLowerCase();
  if (!normalized || normalized === "aiportraitmatting" || normalized === "portraitmatting") {
    return "AIPortraitMatting";
  }
  return "AIPortraitMatting";
}

function extractAliyunImageUrlFromResult(input: any): string {
  const directCandidates = [
    input?.ImageURL,
    input?.ImageUrl,
    input?.URL,
    input?.Url,
    input?.OutputURL,
    input?.OutputUrl,
    input?.ForegroundURL,
    input?.ForegroundUrl,
    input?.Data?.ImageURL,
    input?.Data?.ImageUrl,
    input?.data?.imageURL,
    input?.data?.imageUrl,
    input?.Data?.URL,
    input?.Data?.Url,
    input?.Result?.ImageURL,
    input?.Result?.ImageUrl,
    input?.result?.imageURL,
    input?.result?.imageUrl,
    input?.Result?.URL,
    input?.Result?.Url,
  ];
  for (const candidate of directCandidates) {
    const value = String(candidate || "").trim();
    if (value) return value;
  }
  const rawResult = input?.Data?.Result ?? input?.Result;
  if (typeof rawResult === "string") {
    try {
      return extractAliyunImageUrlFromResult(JSON.parse(rawResult));
    } catch {
      return "";
    }
  }
  if (rawResult && typeof rawResult === "object") {
    return extractAliyunImageUrlFromResult(rawResult);
  }
  return "";
}

function extractAliyunErrorDetailFromData(input: any, httpStatus: number | null = null): AliyunErrorDetail {
  return {
    httpStatus,
    code: String(
      input?.Code
      || input?.code
      || input?.Data?.Code
      || input?.Data?.code
      || input?.data?.code
      || "",
    ).trim(),
    message: String(
      input?.Message
      || input?.message
      || input?.Data?.Message
      || input?.Data?.message
      || input?.data?.message
      || "",
    ).trim(),
    requestId: String(
      input?.RequestId
      || input?.requestId
      || input?.Data?.RequestId
      || input?.Data?.requestId
      || input?.data?.requestId
      || "",
    ).trim(),
  };
}

function extractAliyunErrorDetail(err: unknown): AliyunErrorDetail {
  if (axios.isAxiosError(err)) {
    const detail = extractAliyunErrorDetailFromData(err.response?.data, Number(err.response?.status || 0) || null);
    if (detail.message) return detail;
    return {
      ...detail,
      message: String(err.message || "").trim(),
    };
  }
  const detail = extractAliyunErrorDetailFromData((err as any)?.data, Number((err as any)?.data?.httpCode || 0) || null);
  return {
    httpStatus: detail.httpStatus,
    code: detail.code || String((err as any)?.code || "").trim(),
    message: detail.message || String((err as any)?.message || err || "").trim(),
    requestId: detail.requestId || String((err as any)?.requestId || "").trim(),
  };
}

function formatAliyunErrorMessage(detail: AliyunErrorDetail, fallback: string): string {
  const head = detail.code
    ? `[${detail.code}] ${detail.message || fallback}`.trim()
    : (detail.message || fallback);
  const extraParts = [
    detail.httpStatus ? `HTTP ${detail.httpStatus}` : "",
    detail.requestId ? `RequestId: ${detail.requestId}` : "",
  ].filter(Boolean);
  return extraParts.length ? `${head} (${extraParts.join(", ")})` : head;
}

function extractTencentErrorDetail(err: unknown): TencentErrorDetail {
  const source = err as any;
  const serviceError = source?.error && typeof source.error === "object" ? source.error : null;
  return {
    httpStatus: Number(source?.statusCode || 0) || null,
    code: String(source?.code || serviceError?.Code || "").trim(),
    message: String(source?.message || serviceError?.Message || source?.error || err || "").trim(),
    requestId: String(
      source?.RequestId
      || source?.requestId
      || source?.headers?.["x-cos-request-id"]
      || source?.headers?.["x-ci-request-id"]
      || "",
    ).trim(),
  };
}

function formatTencentErrorMessage(detail: TencentErrorDetail, fallback: string): string {
  const head = detail.code
    ? `[${detail.code}] ${detail.message || fallback}`.trim()
    : (detail.message || fallback);
  const extraParts = [
    detail.httpStatus ? `HTTP ${detail.httpStatus}` : "",
    detail.requestId ? `RequestId: ${detail.requestId}` : "",
  ].filter(Boolean);
  return extraParts.length ? `${head} (${extraParts.join(", ")})` : head;
}

function buildAliyunErrorFromData(input: any, fallback: string, httpStatus: number | null = null): Error | null {
  const detail = extractAliyunErrorDetailFromData(input, httpStatus);
  if (!detail.code && !detail.message && !detail.requestId && !detail.httpStatus) {
    return null;
  }
  return new Error(formatAliyunErrorMessage(detail, fallback));
}

function rethrowAliyunRequestError(err: unknown, context: string): never {
  const detail = extractAliyunErrorDetail(err);
  console.warn("[separateRoleAvatar] aliyun api request failed", {
    context,
    httpStatus: detail.httpStatus,
    code: detail.code,
    requestId: detail.requestId,
    message: detail.message,
  });
  throw new Error(formatAliyunErrorMessage(detail, `${context}失败`));
}

function rethrowTencentRequestError(err: unknown, context: string): never {
  const detail = extractTencentErrorDetail(err);
  console.warn("[separateRoleAvatar] tencent ci request failed", {
    context,
    httpStatus: detail.httpStatus,
    code: detail.code,
    requestId: detail.requestId,
    message: detail.message,
  });
  throw new Error(formatTencentErrorMessage(detail, `${context}失败`));
}

function createAliyunImagesegClient(config: ImageAiConfig): any {
  const { accessKeyId, accessKeySecret } = parseAliyunAccessKeyPair(config.apiKey);
  // 官方 AdvanceRequest 会先调用 AuthorizeFileUpload，再把文件流上传到阿里云认可的 OSS 地址。
  // 这样可以避开外部临时链接被 InvalidImage.URL 拒绝的问题。
  const OpenApi = require("@alicloud/openapi-client");
  const Imageseg = require("@alicloud/imageseg20191230");
  const clientConfig = new OpenApi.Config({
    accessKeyId,
    accessKeySecret,
    endpoint: resolveAliyunEndpoint(config.baseURL),
    regionId: resolveAliyunRegionId(config.baseURL),
  });
  clientConfig.protocol = "HTTPS";
  return {
    sdk: Imageseg,
    client: new Imageseg.default(clientConfig),
  };
}

function createTencentCosClient(config: ImageAiConfig): { client: any; bucketConfig: TencentCosBucketConfig } {
  const { secretId, secretKey, sessionToken } = parseTencentAccessKeyPair(config.apiKey);
  const bucketConfig = parseTencentCosBucketConfig(config.baseURL);
  const COS = require("cos-nodejs-sdk-v5");
  const client = new COS({
    SecretId: secretId,
    SecretKey: secretKey,
    SecurityToken: sessionToken || undefined,
  });
  return { client, bucketConfig };
}

async function fetchRemoteImageBuffer(url: string, headers?: Record<string, string>): Promise<Buffer> {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 90000,
    headers,
    ...(isLocalUrl(url) ? { proxy: false } : {}),
  });
  return Buffer.from(response.data);
}

async function waitBriaResultImageUrl(config: ImageAiConfig, responseData: any): Promise<string> {
  const statusUrl = String(responseData?.status_url || "").trim();
  const requestId = String(responseData?.request_id || "").trim();
  const directStatusUrl = statusUrl || (
    requestId
      ? `${normalizeBriaBaseUrl(config.baseURL).replace(/\/image\/edit$/i, "")}/status/${requestId}`
      : ""
  );
  if (!directStatusUrl) {
    throw new Error("Bria 任务已创建，但未返回结果地址");
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const statusResponse = await axios.get(directStatusUrl, {
      headers: {
        api_token: String(config.apiKey || "").trim(),
      },
      timeout: 30000,
    });
    const status = String(statusResponse.data?.status || "").trim().toUpperCase();
    const imageUrl = String(statusResponse.data?.result?.image_url || "").trim();
    if (imageUrl) return imageUrl;
    if (status === "ERROR" || status === "UNKNOWN") {
      const errText = String(
        statusResponse.data?.error?.message
        || statusResponse.data?.error?.detail
        || statusResponse.data?.message
        || "Bria 异步任务失败",
      ).trim();
      throw new Error(errText || "Bria 异步任务失败");
    }
  }
  throw new Error("Bria 异步任务超时，请稍后重试");
}

async function callBriaEdit(
  config: ImageAiConfig,
  path: "remove_background" | "erase_foreground",
  payload: Record<string, unknown>,
): Promise<Buffer> {
  const endpoint = `${normalizeBriaBaseUrl(config.baseURL)}/${path}`;
  const response = await axios.post(endpoint, payload, {
    headers: {
      "Content-Type": "application/json",
      api_token: String(config.apiKey || "").trim(),
    },
    timeout: 90000,
  });
  const imageUrl = String(response.data?.result?.image_url || response.data?.image_url || "").trim()
    || await waitBriaResultImageUrl(config, response.data);
  if (!imageUrl) {
    throw new Error(`Bria ${path} 未返回图片结果`);
  }
  return await fetchRemoteImageBuffer(imageUrl);
}

async function callAliyunMatting(
  input: Buffer,
  config: ImageAiConfig,
): Promise<Buffer> {
  const action = resolveAliyunMattingAction(config.model);
  const { sdk, client } = createAliyunImagesegClient(config);
  const TeaUtil = require("@alicloud/tea-util");
  const RequestCtor = sdk[action.requestType];
  const request = new RequestCtor({
    [action.requestField]: Readable.from(input),
  });
  const runtime = new TeaUtil.RuntimeOptions({
    connectTimeout: 10000,
    readTimeout: 90000,
    autoretry: false,
    maxAttempts: 1,
  });
  let response;
  try {
    response = await client[action.sdkMethod](request, runtime);
  } catch (err) {
    rethrowAliyunRequestError(err, `阿里云主体分离 ${action.action}`);
  }
  const responseBody = response?.body ?? response;
  const imageUrl = extractAliyunImageUrlFromResult(responseBody);
  if (!imageUrl) {
    throw buildAliyunErrorFromData(responseBody, `阿里云主体分离 ${action.action} 未返回图片结果`)
      || new Error("阿里云主体分离未返回图片结果");
  }
  return await fetchRemoteImageBuffer(imageUrl);
}

async function callTencentPortraitMatting(
  input: Buffer,
  config: ImageAiConfig,
): Promise<Buffer> {
  const action = resolveTencentMattingAction(config.model);
  const { client, bucketConfig } = createTencentCosClient(config);
  const sourceKey = `toonflow/avatar-matting/source/${uuidv4()}.png`;
  try {
    try {
      await client.putObject({
        Bucket: bucketConfig.bucket,
        Region: bucketConfig.region,
        Key: sourceKey,
        Body: input,
        ContentType: "image/png",
      });
    } catch (err) {
      rethrowTencentRequestError(err, "腾讯云上传头像分离源图");
    }

    let response;
    try {
      response = await client.request({
        Bucket: bucketConfig.bucket,
        Region: bucketConfig.region,
        Key: sourceKey,
        Method: "GET",
        Query: {
          "ci-process": action,
        },
        RawBody: true,
      });
    } catch (err) {
      rethrowTencentRequestError(err, `腾讯云主体分离 ${action}`);
    }

    const body = response?.Body;
    if (Buffer.isBuffer(body)) {
      return body;
    }
    if (typeof body === "string" && body) {
      return Buffer.from(body, "binary");
    }
    throw new Error("腾讯云主体分离未返回图片结果");
  } finally {
    try {
      await client.deleteObject({
        Bucket: bucketConfig.bucket,
        Region: bucketConfig.region,
        Key: sourceKey,
      });
    } catch {
      // 临时源图清理失败不影响主流程
    }
  }
}

function buildForegroundPrompt(name: string): string {
  return [
    `参考图中的主角名称：${name}`,
    "请严格参考输入图，只生成同一个角色主体。",
    "必须保留角色的发型、五官、服装、配饰、体态、朝向和画风，不要改人设。",
    "必须保留人物当前完整可见主体，不要只剩半身，不要裁掉头发、手臂、腿、脚，不要把人物推近镜头。",
    "必须维持和参考图一致的取景范围与人物比例，不要重新构图，不要缩成小人，也不要放大成近景。",
    "必须删除原始背景、地面、边框、文字、水印、其他人物和额外道具。",
    "输出一张适合后续抠成透明层的角色主体图。",
    "背景必须是纯色绿色背景，RGB 0,255,0，无渐变、无阴影、无光斑、无地台。",
    "画面中只能出现角色主体和其穿着，不允许残留背景元素。",
  ].join("\n");
}

function buildBackgroundPrompt(name: string): string {
  return [
    `参考图中的主角名称：${name}`,
    "请根据参考图重建角色背后的原场景背景。",
    "必须保持与参考图一致的构图范围、透视关系和景别，不要重新推近、不要二次裁切。",
    "必须完全移除角色主体，不允许出现人物、脸、头发、手脚、衣物、剪影或半透明残影。",
    "要补全原本被人物遮挡的背景内容，保持原画的色调、景深、光线和构图氛围。",
    "输出纯背景图，不要文字、水印、边框，不要新增角色。",
  ].join("\n");
}

async function saveSeparatedRoleAvatarFiles(
  payload: SeparateRoleAvatarPayload & { userId: number; projectId: number | null },
  foregroundBuffer: Buffer,
  backgroundBuffer: Buffer,
): Promise<SeparateRoleAvatarResult> {
  const baseDir = payload.projectId && payload.projectId > 0
    ? `/${payload.projectId}/game/role`
    : `/user/${payload.userId}/game/role`;
  const foregroundFilePath = `${baseDir}/${uuidv4()}_fg.png`;
  const backgroundFilePath = `${baseDir}/${uuidv4()}_bg.png`;
  await u.oss.writeFile(foregroundFilePath, foregroundBuffer);
  await u.oss.writeFile(backgroundFilePath, backgroundBuffer);

  const foregroundPath = await u.oss.getFileUrl(foregroundFilePath);
  const backgroundPath = await u.oss.getFileUrl(backgroundFilePath);
  return {
    foregroundPath,
    foregroundFilePath,
    backgroundPath,
    backgroundFilePath,
  };
}

async function runDedicatedAvatarMattingJob(
  payload: SeparateRoleAvatarPayload & { userId: number; projectId: number | null },
  normalizedInput: string,
  config: ImageAiConfig,
): Promise<SeparateRoleAvatarResult> {
  const mattingInput = await normalizeRoleSourceForMatting(normalizedInput);
  const mattingDataUrl = bufferToDataUrl(mattingInput, "image/png");
  const [foregroundRaw, backgroundRaw] = await Promise.all([
    callBriaEdit(config, "remove_background", {
      image: mattingDataUrl,
      sync: true,
      preserve_alpha: true,
      visual_input_content_moderation: false,
    }),
    callBriaEdit(config, "erase_foreground", {
      image: mattingDataUrl,
      sync: true,
      preserve_alpha: false,
      visual_input_content_moderation: false,
    }),
  ]);

  const foregroundBuffer = await normalizeForegroundLayer(foregroundRaw, { skipChromaKey: true });
  const backgroundBuffer = await normalizeBackgroundLayer(backgroundRaw);
  return await saveSeparatedRoleAvatarFiles(payload, foregroundBuffer, backgroundBuffer);
}

async function createImageModelInputDataUrl(normalizedInput: string): Promise<string> {
  const modelInput = await normalizeRoleSource(normalizedInput);
  return bufferToDataUrl(modelInput, "image/png");
}

async function generateImageModelForegroundBuffer(
  modelInputDataUrl: string,
  safeName: string,
  config: ImageAiConfig,
): Promise<Buffer> {
  const foregroundRaw = await u.ai.image(
    {
      systemPrompt: "你是角色主体分离助手，只输出图片。",
      prompt: buildForegroundPrompt(safeName),
      imageBase64: [modelInputDataUrl],
      aspectRatio: "1:1",
      size: "2K",
    },
    config,
  );
  return await normalizeForegroundLayer(await imageOutputToBuffer(String(foregroundRaw || "")));
}

async function generateImageModelBackgroundBuffer(
  modelInputDataUrl: string,
  safeName: string,
  config: ImageAiConfig,
): Promise<Buffer> {
  const backgroundRaw = await u.ai.image(
    {
      systemPrompt: "你是角色背景补全助手，只输出图片。",
      prompt: buildBackgroundPrompt(safeName),
      imageBase64: [modelInputDataUrl],
      aspectRatio: "1:1",
      size: "2K",
    },
    config,
  );
  return await normalizeBackgroundLayer(await imageOutputToBuffer(String(backgroundRaw || "")));
}

async function runAliyunAvatarMattingJob(
  payload: SeparateRoleAvatarPayload & { userId: number; projectId: number | null },
  normalizedInput: string,
  config: ImageAiConfig,
): Promise<SeparateRoleAvatarResult> {
  const safeName = String(payload.name || "").trim() || "角色";
  const imageModelConfig = await resolveImageConfig(payload.userId);
  const [mattingInput, modelInputDataUrl] = await Promise.all([
    normalizeRoleSourceForMatting(normalizedInput),
    createImageModelInputDataUrl(normalizedInput),
  ]);
  const [foregroundRaw, backgroundBuffer] = await Promise.all([
    callAliyunMatting(mattingInput, config),
    generateImageModelBackgroundBuffer(modelInputDataUrl, safeName, imageModelConfig),
  ]);
  const foregroundBuffer = await normalizeForegroundLayer(foregroundRaw, { skipChromaKey: true });
  return await saveSeparatedRoleAvatarFiles(payload, foregroundBuffer, backgroundBuffer);
}

async function runTencentAvatarMattingJob(
  payload: SeparateRoleAvatarPayload & { userId: number; projectId: number | null },
  normalizedInput: string,
  config: ImageAiConfig,
): Promise<SeparateRoleAvatarResult> {
  const safeName = String(payload.name || "").trim() || "角色";
  const imageModelConfig = await resolveImageConfig(payload.userId);
  const [mattingInput, modelInputDataUrl] = await Promise.all([
    normalizeRoleSourceForMatting(normalizedInput),
    createImageModelInputDataUrl(normalizedInput),
  ]);
  const [foregroundRaw, backgroundBuffer] = await Promise.all([
    callTencentPortraitMatting(mattingInput, config),
    generateImageModelBackgroundBuffer(modelInputDataUrl, safeName, imageModelConfig),
  ]);
  const foregroundBuffer = await normalizeForegroundLayer(foregroundRaw, { skipChromaKey: true });
  return await saveSeparatedRoleAvatarFiles(payload, foregroundBuffer, backgroundBuffer);
}

async function runImageModelAvatarMattingJob(
  payload: SeparateRoleAvatarPayload & { userId: number; projectId: number | null },
  normalizedInput: string,
): Promise<SeparateRoleAvatarResult> {
  const safeName = String(payload.name || "").trim() || "角色";
  const modelInputDataUrl = await createImageModelInputDataUrl(normalizedInput);
  const config = await resolveImageConfig(payload.userId);

  const [foregroundBuffer, backgroundBuffer] = await Promise.all([
    generateImageModelForegroundBuffer(modelInputDataUrl, safeName, config),
    generateImageModelBackgroundBuffer(modelInputDataUrl, safeName, config),
  ]);
  return await saveSeparatedRoleAvatarFiles(payload, foregroundBuffer, backgroundBuffer);
}

async function ensureOwnedProjectId(projectId: number | null | undefined, userId: number): Promise<number | null> {
  const normalizedProjectId = Number(projectId || 0);
  if (!Number.isFinite(normalizedProjectId) || normalizedProjectId <= 0) {
    return null;
  }
  const owned = await u.db("t_project").where({ id: normalizedProjectId, userId }).first("id");
  if (!owned) {
    throw new Error("无权访问该项目");
  }
  return normalizedProjectId;
}

function normalizeRoleAvatarTask(row: RoleAvatarTaskRow | undefined | null) {
  return {
    taskId: Number(row?.id || 0),
    status: String(row?.status || ROLE_AVATAR_STATUS_FAILED),
    progress: Number(row?.progress || 0),
    message: String(row?.message || ""),
    errorMessage: String(row?.errorMessage || ""),
    foregroundPath: String(row?.foregroundPath || ""),
    foregroundFilePath: String(row?.foregroundFilePath || ""),
    backgroundPath: String(row?.backgroundPath || ""),
    backgroundFilePath: String(row?.backgroundFilePath || ""),
  };
}

async function updateRoleAvatarTask(taskId: number, patch: RoleAvatarTaskUpdate) {
  await u.db("t_roleAvatarTask")
    .where({ id: taskId })
    .update({
      ...patch,
      updateTime: nowTs(),
    });
}

async function getRoleAvatarTask(taskId: number, userId: number): Promise<RoleAvatarTaskRow | undefined> {
  return await u.db("t_roleAvatarTask")
    .where({ id: taskId, userId })
    .first();
}

async function createRoleAvatarTask(userId: number, projectId: number | null): Promise<RoleAvatarTaskRow> {
  const timestamp = nowTs();
  const insertResult = await u.db("t_roleAvatarTask").insert({
    userId,
    projectId: projectId || null,
    taskType: ROLE_AVATAR_TASK_TYPE,
    status: ROLE_AVATAR_STATUS_QUEUED,
    progress: 0,
    message: "等待处理",
    errorMessage: null,
    foregroundPath: null,
    foregroundFilePath: null,
    backgroundPath: null,
    backgroundFilePath: null,
    createTime: timestamp,
    updateTime: timestamp,
  });
  const taskId = Number(Array.isArray(insertResult) ? insertResult[0] : insertResult || 0);
  const row = await u.db("t_roleAvatarTask").where({ id: taskId }).first();
  if (!row) {
    throw new Error("创建头像分离任务失败");
  }
  return row as RoleAvatarTaskRow;
}

async function runSeparateRoleAvatarJob(
  payload: SeparateRoleAvatarPayload & { userId: number; projectId: number | null },
): Promise<SeparateRoleAvatarResult> {
  const normalizedInput = normalizeBase64Data(payload.base64Data, String(payload.fileName || ""));
  const avatarMattingConfig = await resolveAvatarMattingConfig(payload.userId);
  if (isBriaAvatarMattingConfig(avatarMattingConfig)) {
    try {
      return await runDedicatedAvatarMattingJob(payload, normalizedInput, avatarMattingConfig);
    } catch (err) {
      console.warn("[separateRoleAvatar] dedicated matting failed, fallback to image model", {
        userId: payload.userId,
        projectId: payload.projectId,
        manufacturer: avatarMattingConfig.manufacturer,
        message: u.error(err).message,
      });
    }
  }
  if (isAliyunAvatarMattingConfig(avatarMattingConfig)) {
    try {
      return await runAliyunAvatarMattingJob(payload, normalizedInput, avatarMattingConfig);
    } catch (err) {
      console.warn("[separateRoleAvatar] aliyun matting failed, fallback to image model", {
        userId: payload.userId,
        projectId: payload.projectId,
        manufacturer: avatarMattingConfig.manufacturer,
        message: u.error(err).message,
      });
    }
  }
  if (isTencentAvatarMattingConfig(avatarMattingConfig)) {
    try {
      return await runTencentAvatarMattingJob(payload, normalizedInput, avatarMattingConfig);
    } catch (err) {
      console.warn("[separateRoleAvatar] tencent ci matting failed, fallback to image model", {
        userId: payload.userId,
        projectId: payload.projectId,
        manufacturer: avatarMattingConfig.manufacturer,
        message: u.error(err).message,
      });
    }
  }
  return await runImageModelAvatarMattingJob(payload, normalizedInput);
}

async function runRoleAvatarTask(taskId: number, payload: SeparateRoleAvatarPayload & { userId: number; projectId: number | null }) {
  try {
    await updateRoleAvatarTask(taskId, {
      status: ROLE_AVATAR_STATUS_PROCESSING,
      progress: 10,
      message: "正在分离角色主体与背景",
      errorMessage: null,
    });
    const result = await runSeparateRoleAvatarJob(payload);
    await updateRoleAvatarTask(taskId, {
      status: ROLE_AVATAR_STATUS_SUCCESS,
      progress: 100,
      message: "处理完成",
      errorMessage: null,
      ...result,
    });
  } catch (err) {
    await updateRoleAvatarTask(taskId, {
      status: ROLE_AVATAR_STATUS_FAILED,
      progress: 0,
      message: "处理失败",
      errorMessage: u.error(err).message,
    });
  } finally {
    activeRoleAvatarTasks.delete(taskId);
  }
}

function startRoleAvatarTask(taskId: number, payload: SeparateRoleAvatarPayload & { userId: number; projectId: number | null }) {
  if (activeRoleAvatarTasks.has(taskId)) return;
  const promise = runRoleAvatarTask(taskId, payload);
  activeRoleAvatarTasks.set(taskId, promise);
  void promise.catch(() => undefined);
}

router.post(
  "/",
  validateFields({
    projectId: z.number().optional().nullable(),
    fileName: z.string().optional().nullable(),
    name: z.string().optional().nullable(),
    base64Data: z.string(),
    asyncTask: z.boolean().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const { projectId, fileName, name, base64Data, asyncTask } = req.body as SeparateRoleAvatarPayload & {
        asyncTask?: boolean | null;
      };
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }

      const ownedProjectId = await ensureOwnedProjectId(projectId, userId);
      const payload = {
        projectId: ownedProjectId,
        fileName,
        name,
        base64Data,
        userId,
      };

      if (asyncTask) {
        const taskRow = await createRoleAvatarTask(userId, ownedProjectId);
        const taskId = Number(taskRow.id || 0);
        startRoleAvatarTask(taskId, payload);
        return res.status(200).send(success(normalizeRoleAvatarTask(taskRow)));
      }

      const result = await runSeparateRoleAvatarJob(payload);
      return res.status(200).send(success(result));
    } catch (err) {
      const message = u.error(err).message;
      const status = message === "无权访问该项目" ? 403 : 500;
      console.error("[separateRoleAvatar] failed", {
        userId: Number((req as any)?.user?.id || 0),
        projectId: Number((req.body as any)?.projectId || 0) || null,
        fileName: String((req.body as any)?.fileName || "").trim(),
        name: String((req.body as any)?.name || "").trim(),
        message,
      });
      return res.status(status).send(error(message));
    }
  },
);

router.post(
  "/status",
  validateFields({
    taskId: z.number(),
  }),
  async (req, res) => {
    try {
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }
      const taskId = Number((req.body as any)?.taskId || 0);
      let taskRow = await getRoleAvatarTask(taskId, userId);
      if (!taskRow) {
        return res.status(404).send(error("未找到头像处理任务"));
      }

      const status = String(taskRow.status || "");
      if (
        [ROLE_AVATAR_STATUS_QUEUED, ROLE_AVATAR_STATUS_PROCESSING].includes(status)
        && !activeRoleAvatarTasks.has(taskId)
      ) {
        await updateRoleAvatarTask(taskId, {
          status: ROLE_AVATAR_STATUS_FAILED,
          progress: 0,
          message: "任务已中断，请重试",
          errorMessage: "任务已中断，请重试",
        });
        taskRow = await getRoleAvatarTask(taskId, userId);
      }

      return res.status(200).send(success(normalizeRoleAvatarTask(taskRow)));
    } catch (err) {
      return res.status(500).send(error(u.error(err).message));
    }
  },
);

export default router;
