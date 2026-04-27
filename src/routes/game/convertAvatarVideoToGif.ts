import express from "express";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import {
  LOCAL_BIREFNET_MANUFACTURER,
  LOCAL_MODNET_MANUFACTURER,
} from "@/lib/localAvatarMatting";
import { runLocalBiRefNetMatting } from "@/lib/localAvatarMatting";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  callAliyunMatting,
  callBriaEdit,
  callTencentPortraitMatting,
  createApproximateBackgroundLayer,
  isAliyunAvatarMattingConfig,
  isBriaAvatarMattingConfig,
  isLocalBiRefNetAvatarMattingConfig,
  isTencentAvatarMattingConfig,
  normalizeBackgroundLayer,
  normalizeForegroundLayer,
  normalizeRoleSourceForMatting,
  resolveAvatarMattingConfig,
  type ImageAiConfig,
} from "@/routes/game/separateRoleAvatar";
import { DebugLogUtil } from "@/utils/debugLogUtil";
import u from "@/utils";

const router = express.Router();

const AVATAR_GIF_SIDE = 512;
const AVATAR_BG_SIDE = 768;
// 保留足够的动作帧，避免头像动图因为过度抽帧出现明显卡顿和动作缺失。
const DEFAULT_MAX_GIF_DURATION_SECONDS = 4;
// 头像动图需要保留原视频的主要动作观感；10fps 是质量与本地抠图耗时之间的折中。
const DEFAULT_GIF_FPS = 10;
// 先把抽帧压到头像目标尺寸附近，减少本地抠图模型的单帧推理成本。512/256/128/64
const DEFAULT_FRAME_OUTPUT_SIDE = 512;
// 逐帧抠图最消耗时间，允许通过环境变量提高同时处理的帧数。
const DEFAULT_VIDEO_MATTING_CONCURRENCY = 1;
const MAX_VIDEO_MATTING_CONCURRENCY = 6;
const MIN_VIDEO_DURATION_SECONDS = 1;
const MAX_VIDEO_DURATION_SECONDS = 12;
const MIN_VIDEO_FPS = 1;
const MAX_VIDEO_FPS = 24;
const MIN_FRAME_OUTPUT_SIDE = 64;
const MAX_FRAME_OUTPUT_SIDE = 1024;

const COMMON_WIN_FFMPEG_PATHS = [
  "D:\\Program Files\\ffmpeg-master-latest-win64-gpl-shared\\bin\\ffmpeg.exe",
  "C:\\Program Files\\ffmpeg-master-latest-win64-gpl-shared\\bin\\ffmpeg.exe",
  "D:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
  "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
];

let cachedFfmpegPath = "";

type VideoAvatarJobStatus = "queued" | "running" | "success" | "failed";

type VideoAvatarJobResult = {
  foregroundPath: string;
  foregroundFilePath: string;
  backgroundPath: string;
  backgroundFilePath: string;
  foregroundExt: string;
};

type VideoAvatarJob = {
  taskId: number;
  userId: number;
  normalizedProjectId: number;
  fileName: string;
  preferGif: boolean;
  ffmpegPath: string;
  tempDir: string;
  inputPath: string;
  inputExt: string;
  status: VideoAvatarJobStatus;
  progress: number;
  message: string;
  errorMessage: string;
  createdAt: number;
  updatedAt: number;
  result?: VideoAvatarJobResult;
};

type ProgressReporter = (progress: number, message: string) => void;

type VideoAnimationOptions = {
  durationSeconds: number;
  fps: number;
  frameOutputSide: number;
};

const VIDEO_AVATAR_JOB_TTL_MS = 30 * 60 * 1000;
const videoAvatarJobs = new Map<number, VideoAvatarJob>();
const videoAvatarQueue: VideoAvatarJob[] = [];
let activeVideoAvatarJob: VideoAvatarJob | null = null;
let nextVideoAvatarTaskId = 1;

/**
 * 统一打印视频头像转换链路的 DEBUG 运行日志。
 *
 * 用途：
 * - 精确定位 `/convertAvatarVideoToGif` 当前卡在哪个阶段；
 * - 在 pending 时快速判断是抽帧、逐帧抠图、背景生成、编码还是上传阶段变慢。
 */
function debugAvatarVideoRuntime(step: string, payload?: Record<string, unknown>): void {
  if (!DebugLogUtil.isDebugLogEnabled()) return;
  console.log("[game:avatar_video:runtime]", JSON.stringify({
    step,
    ...payload,
  }));
}

/**
 * 读取视频转动图的逐帧抠图并发量。
 *
 * `VIDEO_TO_ANIMATION_MULTIPLIED_SPEED=3` 表示同时抠 3 帧，
 * 不减少抽帧数量，也不改变动图 FPS，避免质量和动作完整度下降。
 */
function getVideoMattingConcurrency(config?: ImageAiConfig | null): number {
  const rawValue = readVideoAnimationEnvNumber(
    config,
    "VIDEO_TO_ANIMATION_MULTIPLIED_SPEED",
    DEFAULT_VIDEO_MATTING_CONCURRENCY,
    DEFAULT_VIDEO_MATTING_CONCURRENCY,
    MAX_VIDEO_MATTING_CONCURRENCY,
  );
  return Math.round(rawValue);
}

/**
 * 读取数值型环境变量，并限制到安全范围内。
 */
function readBoundedEnvNumber(envName: string, defaultValue: number, minValue: number, maxValue: number): number {
  const rawValue = Number(String(process.env[envName] || "").trim());
  if (!Number.isFinite(rawValue) || rawValue <= 0) return defaultValue;
  return Math.max(minValue, Math.min(maxValue, rawValue));
}

/**
 * 根据当前头像分离配置推断视频转动图应该使用的本地模型档位。
 *
 * 用途：
 * - `local_modnet` 明确走 MODNet 专属环境变量；
 * - 兼容旧数据里“manufacturer 还是 local_birefnet，但 model 已经是 modnet-*”的过渡状态；
 * - 非本地模型或未配置时回退到通用环境变量。
 */
function resolveVideoAnimationEnvProfile(config?: ImageAiConfig | null): "MODNet" | "BIREFNET" | "" {
  const manufacturer = readConfigString(config, "manufacturer").trim().toLowerCase();
  const model = readConfigString(config, "model").trim().toLowerCase();
  if (manufacturer === LOCAL_MODNET_MANUFACTURER || model.startsWith("modnet")) return "MODNet";
  if (manufacturer === LOCAL_BIREFNET_MANUFACTURER) return "BIREFNET";
  return "";
}

/**
 * 读取单个视频动图参数，并优先命中 MODNet / BiRefNet 专属环境变量。
 *
 * 例如：
 * - MODNet 优先读 `GIF_FPS_MODNet`
 * - BiRefNet 优先读 `GIF_FPS_BIREFNET`
 * - 其他方案则回退读旧的 `GIF_FPS`
 */
function readVideoAnimationEnvNumber(
  config: ImageAiConfig | null | undefined,
  baseEnvName: string,
  defaultValue: number,
  minValue: number,
  maxValue: number,
): number {
  const profile = resolveVideoAnimationEnvProfile(config);
  const profileEnvName = profile ? `${baseEnvName}_${profile}` : "";
  if (profileEnvName) {
    const profileValue = readBoundedEnvNumber(profileEnvName, Number.NaN, minValue, maxValue);
    if (Number.isFinite(profileValue)) return profileValue;
  }
  return readBoundedEnvNumber(baseEnvName, defaultValue, minValue, maxValue);
}

/**
 * 读取视频转动图的质量配置。
 *
 * 这里会根据当前抠图模型选择不同的环境变量档位：
 * - MODNet 走 `*_MODNet`
 * - BiRefNet 走 `*_BIREFNET`
 * - 其他模型仍然兼容旧的通用变量
 */
function getVideoAnimationOptions(config?: ImageAiConfig | null): VideoAnimationOptions {
  return {
    durationSeconds: readVideoAnimationEnvNumber(
      config,
      "MAX_GIF_DURATION_SECONDS",
      DEFAULT_MAX_GIF_DURATION_SECONDS,
      MIN_VIDEO_DURATION_SECONDS,
      MAX_VIDEO_DURATION_SECONDS,
    ),
    fps: Math.round(readVideoAnimationEnvNumber(
      config,
      "GIF_FPS",
      DEFAULT_GIF_FPS,
      MIN_VIDEO_FPS,
      MAX_VIDEO_FPS,
    )),
    frameOutputSide: Math.round(readVideoAnimationEnvNumber(
      config,
      "FRAME_OUTPUT_SIDE",
      DEFAULT_FRAME_OUTPUT_SIDE,
      MIN_FRAME_OUTPUT_SIDE,
      MAX_FRAME_OUTPUT_SIDE,
    )),
  };
}

/**
 * 计算从某个时间点开始已经耗时多久。
 */
function elapsedMs(startMs: number): number {
  return Math.max(0, Date.now() - startMs);
}

/**
 * 限制百分比边界，防止前端显示异常进度。
 */
function clampProgress(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * 更新视频头像任务进度，并同步输出 DEBUG 日志。
 */
function updateVideoAvatarJob(job: VideoAvatarJob, progress: number, message: string): void {
  job.progress = clampProgress(progress);
  job.message = message;
  job.updatedAt = Date.now();
  debugAvatarVideoRuntime("job:progress", {
    taskId: job.taskId,
    status: job.status,
    progress: job.progress,
    message,
  });
}

/**
 * 计算任务在等待队列中的位置；运行中或已结束任务返回 0。
 */
function getVideoAvatarQueuePosition(job: VideoAvatarJob): number {
  if (job.status !== "queued") return 0;
  const index = videoAvatarQueue.findIndex((item) => item.taskId === job.taskId);
  return index >= 0 ? index + 1 : 0;
}

/**
 * 清理已经结束且超过 TTL 的视频头像任务，避免内存长期增长。
 */
function cleanupVideoAvatarJobs(): void {
  const now = Date.now();
  for (const [taskId, job] of videoAvatarJobs.entries()) {
    if ((job.status === "success" || job.status === "failed") && now - job.updatedAt > VIDEO_AVATAR_JOB_TTL_MS) {
      videoAvatarJobs.delete(taskId);
    }
  }
}

/**
 * 返回给前端/安卓的短轮询任务状态。
 */
function buildVideoAvatarJobResponse(job: VideoAvatarJob): Record<string, unknown> {
  return {
    taskId: job.taskId,
    jobId: job.taskId,
    status: job.status,
    progress: job.progress,
    message: job.message,
    errorMessage: job.errorMessage,
    queuePosition: getVideoAvatarQueuePosition(job),
    foregroundPath: job.result?.foregroundPath || "",
    foregroundFilePath: job.result?.foregroundFilePath || "",
    backgroundPath: job.result?.backgroundPath || "",
    backgroundFilePath: job.result?.backgroundFilePath || "",
    foregroundExt: job.result?.foregroundExt || "",
  };
}

/**
 * 从 base64 或 data URL 中提取原始二进制内容。
 */
function extractBase64(raw: string): Buffer {
  const value = String(raw || "").trim();
  const match = value.match(/base64,([A-Za-z0-9+/=]+)/);
  return Buffer.from(match && match[1] ? match[1] : value, "base64");
}

/**
 * 根据 data URL 或文件名推断视频扩展名。
 */
function inferVideoExtension(base64Data: string, fileName: string): string {
  const nameExt = String(fileName || "").trim().split(".").pop()?.toLowerCase() || "";
  if (nameExt) return nameExt.replace(/[^a-z0-9]/g, "");
  const mime = String(base64Data || "").match(/^data:([^;]+);base64,/i)?.[1]?.toLowerCase() || "";
  if (mime === "video/mp4") return "mp4";
  if (mime === "video/x-m4v") return "m4v";
  if (mime === "video/quicktime") return "mov";
  return "mp4";
}

/**
 * 校验视频格式是否属于当前支持范围。
 */
function assertSupportedVideo(base64Data: string, fileName: string): void {
  const ext = inferVideoExtension(base64Data, fileName);
  const mime = String(base64Data || "").match(/^data:([^;]+);base64,/i)?.[1]?.toLowerCase() || "";
  const supportedExt = new Set(["mp4", "m4v", "mov"]);
  const supportedMime = new Set(["", "video/mp4", "video/x-m4v", "video/quicktime", "application/octet-stream"]);
  if (!supportedExt.has(ext) || !supportedMime.has(mime)) {
    throw new Error("仅支持上传 MP4 视频转换 GIF");
  }
}

/**
 * 把 Windows 路径转换成 WSL 可访问路径。
 */
function convertWindowsPathToWsl(input: string): string {
  const raw = String(input || "").trim();
  const match = raw.match(/^([A-Za-z]):\\(.*)$/);
  if (!match) return raw;
  const drive = match[1]!.toLowerCase();
  const tail = match[2]!.replace(/\\/g, "/");
  return `/mnt/${drive}/${tail}`;
}

/**
 * 自动定位 ffmpeg 可执行文件。
 */
function discoverFfmpegPath(): string {
  if (cachedFfmpegPath) return cachedFfmpegPath;

  const envPath = String(process.env.FFMPEG_PATH || "").trim();
  if (envPath && existsSync(envPath)) {
    cachedFfmpegPath = envPath;
    return cachedFfmpegPath;
  }

  for (const candidate of COMMON_WIN_FFMPEG_PATHS) {
    if (existsSync(candidate)) {
      cachedFfmpegPath = candidate;
      return cachedFfmpegPath;
    }
    const wslCandidate = convertWindowsPathToWsl(candidate);
    if (wslCandidate !== candidate && existsSync(wslCandidate)) {
      cachedFfmpegPath = wslCandidate;
      return cachedFfmpegPath;
    }
  }

  const syncLookup = process.platform === "win32"
    ? spawnSync("where", ["ffmpeg"], { encoding: "utf8", windowsHide: true })
    : spawnSync("cmd.exe", ["/c", "where", "ffmpeg"], { encoding: "utf8", windowsHide: true });
  const stdout = String(syncLookup.stdout || "").trim();
  const firstLine = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  if (firstLine) {
    const normalized = existsSync(firstLine) ? firstLine : convertWindowsPathToWsl(firstLine);
    if (existsSync(normalized)) {
      cachedFfmpegPath = normalized;
      return cachedFfmpegPath;
    }
  }

  throw new Error("未找到 ffmpeg，可先在系统中安装 ffmpeg 后再上传 MP4");
}

/**
 * 运行一次 ffmpeg，并在失败时返回最近几行错误信息。
 */
async function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  const startedAt = Date.now();
  debugAvatarVideoRuntime("ffmpeg:start", {
    ffmpegPath,
    args,
  });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        debugAvatarVideoRuntime("ffmpeg:success", {
          ffmpegPath,
          args,
          elapsedMs: elapsedMs(startedAt),
        });
        resolve();
        return;
      }
      const trimmed = stderr.trim().split(/\r?\n/).slice(-6).join("\n").trim();
      debugAvatarVideoRuntime("ffmpeg:failed", {
        ffmpegPath,
        args,
        elapsedMs: elapsedMs(startedAt),
        code: code ?? -1,
        error: trimmed,
      });
      reject(new Error(trimmed || `ffmpeg 执行失败（退出码 ${code ?? -1}）`));
    });
  });
}

/**
 * 统一生成角色媒体上传根路径。
 */
function roleMediaBasePath(userId: number, projectId?: number | null): string {
  const normalizedProjectId = Number(projectId || 0);
  return normalizedProjectId > 0
    ? `/${normalizedProjectId}/game/role`
    : `/user/${userId}/game/role`;
}

/**
 * 把二进制 PNG 转成 data URL，直接复用现有头像抠图能力。
 */
function bufferToDataUrl(buffer: Buffer, mime = "image/png"): string {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

/**
 * 读取并按名称顺序返回帧序列。
 */
async function listFramePaths(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir);
  return entries
    .filter((item) => /\.png$/i.test(item))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((item) => path.join(dir, item));
}

/**
 * 判断当前头像分离配置是否能用于视频逐帧真抠图。
 */
function supportsSemanticVideoMatting(config: ImageAiConfig | null): config is ImageAiConfig {
  return Boolean(config) && (
    isLocalBiRefNetAvatarMattingConfig(config)
    || isBriaAvatarMattingConfig(config)
    || isAliyunAvatarMattingConfig(config)
    || isTencentAvatarMattingConfig(config)
  );
}

/**
 * 从未知配置对象中安全读取字符串字段，避免类型守卫兜底分支被收窄为 never 后影响日志输出。
 */
function readConfigString(config: unknown, fieldName: string): string {
  if (!config || typeof config !== "object") return "";
  const value = (config as Record<string, unknown>)[fieldName];
  return typeof value === "string" ? value : "";
}

/**
 * 对单帧执行真抠图，并返回标准化前景层。
 */
async function matteVideoFrame(
  frameBuffer: Buffer,
  config: ImageAiConfig,
): Promise<{ normalizedInput: Buffer; foregroundRaw: Buffer; foregroundBuffer: Buffer }> {
  const startedAt = Date.now();
  const normalizedInput = await normalizeRoleSourceForMatting(bufferToDataUrl(frameBuffer));
  let foregroundRaw: Buffer;

  if (isLocalBiRefNetAvatarMattingConfig(config)) {
    const modelName = String(config.model || "").trim();
    foregroundRaw = await runLocalBiRefNetMatting(normalizedInput, modelName);
  } else if (isBriaAvatarMattingConfig(config)) {
    foregroundRaw = await callBriaEdit(config, "remove_background", {
      image: bufferToDataUrl(normalizedInput),
      sync: true,
      preserve_alpha: true,
      visual_input_content_moderation: false,
    });
  } else if (isAliyunAvatarMattingConfig(config)) {
    foregroundRaw = await callAliyunMatting(normalizedInput, config);
  } else if (isTencentAvatarMattingConfig(config)) {
    foregroundRaw = await callTencentPortraitMatting(normalizedInput, config);
  } else {
    throw new Error(`不支持的视频头像抠图模型: ${readConfigString(config, "manufacturer") || "未知"}`);
  }

  const foregroundBuffer = await normalizeForegroundLayer(foregroundRaw, { skipChromaKey: true });
  debugAvatarVideoRuntime("frame:matte:success", {
    manufacturer: readConfigString(config, "manufacturer"),
    model: readConfigString(config, "model"),
    inputBytes: frameBuffer.length,
    normalizedBytes: normalizedInput.length,
    foregroundBytes: foregroundBuffer.length,
    elapsedMs: elapsedMs(startedAt),
  });
  return {
    normalizedInput,
    foregroundRaw,
    foregroundBuffer,
  };
}

/**
 * 基于首帧抠图结果构造背景层。
 * Bria 直接走去主体背景接口，其余真实抠图方案复用近似背景重建。
 */
async function buildSemanticBackground(
  config: ImageAiConfig,
  normalizedInput: Buffer,
  foregroundRaw: Buffer,
): Promise<Buffer> {
  const startedAt = Date.now();
  if (isBriaAvatarMattingConfig(config)) {
    const backgroundRaw = await callBriaEdit(config, "erase_foreground", {
      image: bufferToDataUrl(normalizedInput),
      sync: true,
      preserve_alpha: false,
      visual_input_content_moderation: false,
    });
    const normalizedBackground = await normalizeBackgroundLayer(backgroundRaw);
    debugAvatarVideoRuntime("background:build:success", {
      manufacturer: String(config.manufacturer || ""),
      strategy: "bria_erase_foreground",
      elapsedMs: elapsedMs(startedAt),
      backgroundBytes: normalizedBackground.length,
    });
    return normalizedBackground;
  }
  const normalizedBackground = await createApproximateBackgroundLayer(normalizedInput, foregroundRaw);
  debugAvatarVideoRuntime("background:build:success", {
    manufacturer: readConfigString(config, "manufacturer"),
    strategy: "approximate_background_layer",
    elapsedMs: elapsedMs(startedAt),
    backgroundBytes: normalizedBackground.length,
  });
  return normalizedBackground;
}

/**
 * 从视频中抽出原始帧序列，供逐帧抠图使用。
 */
async function extractVideoFrames(
  ffmpegPath: string,
  inputPath: string,
  framesDir: string,
  config?: ImageAiConfig | null,
): Promise<string[]> {
  const startedAt = Date.now();
  const { durationSeconds, fps, frameOutputSide } = getVideoAnimationOptions(config);
  const framePattern = path.join(framesDir, "frame_%04d.png");
  await runFfmpeg(ffmpegPath, [
    "-y",
    "-ss",
    "0",
    "-t",
    String(durationSeconds),
    "-i",
    inputPath,
    "-vf",
    `fps=${fps},scale=${frameOutputSide}:${frameOutputSide}:force_original_aspect_ratio=decrease:flags=lanczos`,
    framePattern,
  ]);
  const framePaths = await listFramePaths(framesDir);
  if (!framePaths.length) {
    throw new Error("视频抽帧失败，未生成可用帧");
  }
  debugAvatarVideoRuntime("frames:extract:success", {
    inputPath,
    framesDir,
    frameCount: framePaths.length,
    durationSeconds,
    fps,
    frameOutputSide,
    elapsedMs: elapsedMs(startedAt),
  });
  return framePaths;
}

type MatteFrameWriteResult = {
  frameIndex: number;
  normalizedInput: Buffer | null;
  foregroundRaw: Buffer | null;
};

/**
 * 对指定帧执行抠图并写入按序命名的透明 PNG。
 */
async function matteAndWriteVideoFrame(
  framePath: string,
  frameIndex: number,
  frameTotal: number,
  matteFramesDir: string,
  config: ImageAiConfig,
): Promise<MatteFrameWriteResult> {
  const frameStartedAt = Date.now();
  const frameBuffer = await fs.readFile(framePath);
  debugAvatarVideoRuntime("frame:start", {
    frameIndex,
    frameTotal,
    framePath,
    frameBytes: frameBuffer.length,
  });
  const mattingResult = await matteVideoFrame(frameBuffer, config);
  const outputPath = path.join(matteFramesDir, `frame_${String(frameIndex).padStart(4, "0")}.png`);
  await fs.writeFile(outputPath, mattingResult.foregroundBuffer);
  debugAvatarVideoRuntime("frame:done", {
    frameIndex,
    frameTotal,
    outputPath,
    outputBytes: mattingResult.foregroundBuffer.length,
    elapsedMs: elapsedMs(frameStartedAt),
  });
  return {
    frameIndex,
    normalizedInput: frameIndex === 1 ? mattingResult.normalizedInput : null,
    foregroundRaw: frameIndex === 1 ? mattingResult.foregroundRaw : null,
  };
}

/**
 * 使用真抠图方案输出透明动画和背景图。
 */
async function renderSemanticAvatarAssets(
  ffmpegPath: string,
  inputPath: string,
  tempDir: string,
  preferGifOutput: boolean,
  config: ImageAiConfig,
  reportProgress?: ProgressReporter,
): Promise<{ animatedPath: string; animatedExt: string; backgroundPath: string }> {
  const startedAt = Date.now();
  const rawFramesDir = path.join(tempDir, "raw_frames");
  const matteFramesDir = path.join(tempDir, "matte_frames");
  const palettePath = path.join(tempDir, "palette.png");
  const webpPath = path.join(tempDir, "avatar.webp");
  const gifPath = path.join(tempDir, "avatar.gif");
  const backgroundPath = path.join(tempDir, "background.png");

  await Promise.all([
    fs.mkdir(rawFramesDir, { recursive: true }),
    fs.mkdir(matteFramesDir, { recursive: true }),
  ]);

  const mattingConcurrency = getVideoMattingConcurrency(config);
  const { fps } = getVideoAnimationOptions(config);
  const framePaths = await extractVideoFrames(ffmpegPath, inputPath, rawFramesDir, config);
  const concurrencyMessage = mattingConcurrency > 1 ? `（并发 ${mattingConcurrency} 帧）` : "";
  reportProgress?.(12, `已抽取 ${framePaths.length} 帧${concurrencyMessage}，开始逐帧抠图`);
  debugAvatarVideoRuntime("semantic:frames:ready", {
    frameCount: framePaths.length,
    fps,
    mattingConcurrency,
    preferGifOutput,
    manufacturer: String(config.manufacturer || ""),
    model: String(config.model || ""),
  });
  let firstNormalizedInput: Buffer | null = null;
  let firstForegroundRaw: Buffer | null = null;
  let completedFrames = 0;

  for (let batchStart = 0; batchStart < framePaths.length; batchStart += mattingConcurrency) {
    const batch = framePaths.slice(batchStart, batchStart + mattingConcurrency);
    const batchResults = await Promise.allSettled(batch.map(async (framePath, batchOffset) => {
      const frameIndex = batchStart + batchOffset + 1;
      const result = await matteAndWriteVideoFrame(framePath, frameIndex, framePaths.length, matteFramesDir, config);
      completedFrames += 1;
      reportProgress?.(
        12 + (completedFrames / framePaths.length) * 68,
        `正在抠图第 ${completedFrames}/${framePaths.length} 帧，并发 ${mattingConcurrency}`,
      );
      return result;
    }));

    for (const result of batchResults) {
      if (result.status !== "fulfilled") continue;
      const frameResult = result.value;
      if (frameResult.frameIndex === 1) {
        firstNormalizedInput = frameResult.normalizedInput;
        firstForegroundRaw = frameResult.foregroundRaw;
      }
    }

    const failedFrame = batchResults.find((result) => result.status === "rejected");
    if (failedFrame && failedFrame.status === "rejected") {
      throw failedFrame.reason;
    }
  }

  if (!firstNormalizedInput || !firstForegroundRaw) {
    throw new Error("视频抠图失败，未生成首帧结果");
  }

  const backgroundBuffer = await buildSemanticBackground(config, firstNormalizedInput, firstForegroundRaw);
  await fs.writeFile(backgroundPath, backgroundBuffer);
  reportProgress?.(84, "已生成背景，开始编码动图");
  debugAvatarVideoRuntime("semantic:background:saved", {
    backgroundPath,
    backgroundBytes: backgroundBuffer.length,
  });

  const mattePattern = path.join(matteFramesDir, "frame_%04d.png");
  let animatedPath = "";
  let animatedExt = "";

  if (!preferGifOutput) {
    try {
      await runFfmpeg(ffmpegPath, [
        "-y",
        "-framerate",
        String(fps),
        "-i",
        mattePattern,
        "-c:v",
        "libwebp_anim",
        "-lossless",
        "1",
        "-quality",
        "90",
        "-compression_level",
        "4",
        "-loop",
        "0",
        "-an",
        "-vsync",
        "0",
        webpPath,
      ]);
      animatedPath = webpPath;
      animatedExt = "webp";
      reportProgress?.(92, "透明 WebP 编码完成，准备上传资源");
      debugAvatarVideoRuntime("semantic:webp:success", {
        animatedPath,
      });
    } catch (webpErr) {
      console.warn("[convertAvatarVideoToGif] semantic webp encode failed, fallback to gif", {
        message: (webpErr as any)?.message || String(webpErr),
      });
    }
  }

  if (!animatedPath) {
    await runFfmpeg(ffmpegPath, [
      "-y",
      "-framerate",
      String(fps),
      "-i",
      mattePattern,
      "-vf",
      "palettegen=max_colors=255:reserve_transparent=1:stats_mode=full",
      palettePath,
    ]);

    await runFfmpeg(ffmpegPath, [
      "-y",
      "-framerate",
      String(fps),
      "-i",
      mattePattern,
      "-i",
      palettePath,
      "-lavfi",
      "paletteuse=dither=sierra2_4a:diff_mode=rectangle:alpha_threshold=96",
      "-gifflags",
      "-offsetting-transdiff",
      "-loop",
      "0",
      gifPath,
    ]);
    animatedPath = gifPath;
    animatedExt = "gif";
    reportProgress?.(92, "透明 GIF 编码完成，准备上传资源");
    debugAvatarVideoRuntime("semantic:gif:success", {
      animatedPath,
    });
  }

  debugAvatarVideoRuntime("semantic:assets:done", {
    animatedPath,
    animatedExt,
    backgroundPath,
    elapsedMs: elapsedMs(startedAt),
  });
  return {
    animatedPath,
    animatedExt,
    backgroundPath,
  };
}

/**
 * 保留旧的黑底色键流程，作为未配置头像分离模型时的兼容兜底。
 */
async function renderLegacyAvatarAssets(
  ffmpegPath: string,
  inputPath: string,
  tempDir: string,
  preferGifOutput: boolean,
  config?: ImageAiConfig | null,
  reportProgress?: ProgressReporter,
): Promise<{ animatedPath: string; animatedExt: string; backgroundPath: string }> {
  const startedAt = Date.now();
  const palettePath = path.join(tempDir, "palette.png");
  const webpPath = path.join(tempDir, "avatar.webp");
  const gifPath = path.join(tempDir, "avatar.gif");
  const backgroundPath = path.join(tempDir, "background.png");
  const { durationSeconds, fps } = getVideoAnimationOptions(config);

  const cropBg = `scale=${AVATAR_BG_SIDE}:${AVATAR_BG_SIDE}:force_original_aspect_ratio=increase:flags=lanczos,crop=${AVATAR_BG_SIDE}:${AVATAR_BG_SIDE}`;
  const cropAnimatedBase = `fps=${fps},scale=${AVATAR_GIF_SIDE}:${AVATAR_GIF_SIDE}:force_original_aspect_ratio=increase:flags=lanczos,crop=${AVATAR_GIF_SIDE}:${AVATAR_GIF_SIDE}`;
  const transparentAnimated = `${cropAnimatedBase},colorkey=0x000000:0.08:0.05,format=rgba`;

  let animatedPath = "";
  let animatedExt = "";
  debugAvatarVideoRuntime("legacy:encode:start", {
    preferGifOutput,
    durationSeconds,
    fps,
  });
  if (!preferGifOutput) {
    try {
      reportProgress?.(20, "正在使用色键兜底方式生成透明 WebP");
      await runFfmpeg(ffmpegPath, [
        "-y",
        "-ss",
        "0",
        "-t",
        String(durationSeconds),
        "-i",
        inputPath,
        "-vf",
        transparentAnimated,
        "-c:v",
        "libwebp_anim",
        "-lossless",
        "1",
        "-quality",
        "90",
        "-compression_level",
        "4",
        "-loop",
        "0",
        "-an",
        webpPath,
      ]);
      animatedPath = webpPath;
      animatedExt = "webp";
      reportProgress?.(86, "透明 WebP 编码完成，开始提取背景");
      debugAvatarVideoRuntime("legacy:webp:success", {
        animatedPath,
      });
    } catch (webpErr) {
      console.warn("[convertAvatarVideoToGif] legacy webp encode failed, fallback to gif", {
        message: (webpErr as any)?.message || String(webpErr),
      });
    }
  }

  if (!animatedPath) {
    reportProgress?.(20, "正在使用色键兜底方式生成透明 GIF");
    await runFfmpeg(ffmpegPath, [
      "-y",
      "-ss",
      "0",
      "-t",
      String(durationSeconds),
      "-i",
      inputPath,
      "-vf",
      `${transparentAnimated},palettegen=max_colors=255:reserve_transparent=1:stats_mode=full`,
      palettePath,
    ]);

    await runFfmpeg(ffmpegPath, [
      "-y",
      "-ss",
      "0",
      "-t",
      String(durationSeconds),
      "-i",
      inputPath,
      "-i",
      palettePath,
      "-lavfi",
      `${transparentAnimated}[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle:alpha_threshold=96`,
      "-gifflags",
      "-offsetting-transdiff",
      "-loop",
      "0",
      gifPath,
    ]);
    animatedPath = gifPath;
    animatedExt = "gif";
    reportProgress?.(86, "透明 GIF 编码完成，开始提取背景");
    debugAvatarVideoRuntime("legacy:gif:success", {
      animatedPath,
    });
  }

  await runFfmpeg(ffmpegPath, [
    "-y",
    "-ss",
    "0",
    "-i",
    inputPath,
    "-vframes",
    "1",
    "-vf",
    cropBg,
    backgroundPath,
  ]);
  reportProgress?.(92, "背景提取完成，准备上传资源");

  debugAvatarVideoRuntime("legacy:assets:done", {
    animatedPath,
    animatedExt,
    backgroundPath,
    elapsedMs: elapsedMs(startedAt),
  });
  return {
    animatedPath,
    animatedExt,
    backgroundPath,
  };
}

/**
 * 真实执行一个视频头像任务。队列只负责串行调度，生成逻辑集中在这里。
 */
async function processVideoAvatarJob(job: VideoAvatarJob): Promise<void> {
  const requestStartedAt = Date.now();
  job.status = "running";
  updateVideoAvatarJob(job, 1, "开始处理视频头像");

  try {
    const avatarMattingConfig = await resolveAvatarMattingConfig(job.userId);
    const animationOptions = getVideoAnimationOptions(avatarMattingConfig);
    debugAvatarVideoRuntime("request:start", {
      taskId: job.taskId,
      userId: job.userId,
      projectId: job.normalizedProjectId,
      fileName: job.fileName,
      preferGif: job.preferGif,
      mattingConcurrency: getVideoMattingConcurrency(avatarMattingConfig),
      animationEnvProfile: resolveVideoAnimationEnvProfile(avatarMattingConfig) || "DEFAULT",
      ...animationOptions,
    });
    updateVideoAvatarJob(job, 5, "视频文件已入队，开始读取头像抠图配置");

    const semanticMattingEnabled = supportsSemanticVideoMatting(avatarMattingConfig);
    debugAvatarVideoRuntime("matting:config", {
      taskId: job.taskId,
      semanticMattingEnabled,
      manufacturer: readConfigString(avatarMattingConfig, "manufacturer"),
      model: readConfigString(avatarMattingConfig, "model"),
    });
    updateVideoAvatarJob(job, 8, semanticMattingEnabled ? "使用本地/云端抠图模型逐帧处理" : "未配置抠图模型，使用色键兜底处理");

    const reportProgress: ProgressReporter = (progress, message) => updateVideoAvatarJob(job, progress, message);
    const assetResult = semanticMattingEnabled
      ? await renderSemanticAvatarAssets(job.ffmpegPath, job.inputPath, job.tempDir, job.preferGif, avatarMattingConfig, reportProgress)
      : await renderLegacyAvatarAssets(job.ffmpegPath, job.inputPath, job.tempDir, job.preferGif, avatarMattingConfig, reportProgress);

    if (!semanticMattingEnabled) {
      console.warn("[convertAvatarVideoToGif] avatar matting config missing, fallback to legacy colorkey", {
        taskId: job.taskId,
        userId: job.userId,
        manufacturer: readConfigString(avatarMattingConfig, "manufacturer"),
      });
    }

    const [animatedBuffer, bgBuffer] = await Promise.all([
      fs.readFile(assetResult.animatedPath),
      fs.readFile(assetResult.backgroundPath),
    ]);
    updateVideoAvatarJob(job, 94, "资源生成完成，正在上传");
    debugAvatarVideoRuntime("assets:loaded", {
      taskId: job.taskId,
      animatedPath: assetResult.animatedPath,
      animatedExt: assetResult.animatedExt,
      animatedBytes: animatedBuffer.length,
      backgroundPath: assetResult.backgroundPath,
      backgroundBytes: bgBuffer.length,
    });

    const basePath = roleMediaBasePath(job.userId, job.normalizedProjectId);
    const foregroundFilePath = `${basePath}/${uuidv4()}.${assetResult.animatedExt || "gif"}`;
    const backgroundFilePath = `${basePath}/${uuidv4()}.png`;
    await Promise.all([
      u.oss.writeFile(foregroundFilePath, animatedBuffer),
      u.oss.writeFile(backgroundFilePath, bgBuffer),
    ]);
    const [foregroundPath, backgroundUrl] = await Promise.all([
      u.oss.getFileUrl(foregroundFilePath),
      u.oss.getFileUrl(backgroundFilePath),
    ]);

    job.result = {
      foregroundPath,
      foregroundFilePath,
      backgroundPath: backgroundUrl,
      backgroundFilePath,
      foregroundExt: assetResult.animatedExt || "gif",
    };
    job.status = "success";
    updateVideoAvatarJob(job, 100, "视频头像生成完成");
    debugAvatarVideoRuntime("request:success", {
      taskId: job.taskId,
      foregroundPath,
      backgroundUrl,
      foregroundExt: assetResult.animatedExt || "gif",
      totalElapsedMs: elapsedMs(requestStartedAt),
    });
  } catch (err) {
    job.status = "failed";
    job.errorMessage = u.error(err).message;
    updateVideoAvatarJob(job, job.progress || 0, "视频头像生成失败");
    debugAvatarVideoRuntime("request:failed", {
      taskId: job.taskId,
      error: job.errorMessage,
      totalElapsedMs: elapsedMs(requestStartedAt),
    });
  } finally {
    debugAvatarVideoRuntime("temp:cleanup", {
      taskId: job.taskId,
      tempDir: job.tempDir,
    });
    await fs.rm(job.tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 串行消费视频头像队列，避免多个本地 BiRefNet 任务同时拖垮系统。
 */
function startNextVideoAvatarJob(): void {
  if (activeVideoAvatarJob || !videoAvatarQueue.length) return;
  const job = videoAvatarQueue.shift();
  if (!job) return;
  activeVideoAvatarJob = job;
  void (async () => {
    try {
      await processVideoAvatarJob(job);
    } finally {
      activeVideoAvatarJob = null;
      cleanupVideoAvatarJobs();
      startNextVideoAvatarJob();
    }
  })();
}

router.post(
  "/",
  validateFields({
    projectId: z.number().optional().nullable(),
    fileName: z.string().optional().nullable(),
    preferGif: z.boolean().optional().nullable(),
    base64Data: z.string(),
  }),
  async (req, res) => {
    const userId = Number((req as any)?.user?.id || 0);

    try {
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }

      const { projectId, fileName, preferGif, base64Data } = req.body as {
        projectId?: number | null;
        fileName?: string | null;
        preferGif?: boolean | null;
        base64Data: string;
      };

      debugAvatarVideoRuntime("request:start", {
        userId,
        projectId: Number(projectId || 0) || 0,
        fileName: String(fileName || ""),
        preferGif: Boolean(preferGif),
        base64Length: String(base64Data || "").length,
      });
      const normalizedProjectId = Number(projectId || 0);
      if (normalizedProjectId > 0) {
        const owned = await u.db("t_project")
          .where({ id: normalizedProjectId, userId })
          .first("id");
        if (!owned) {
          return res.status(403).send(error("无权访问该项目"));
        }
      }

      assertSupportedVideo(base64Data, String(fileName || ""));
      const ffmpegPath = discoverFfmpegPath();
      debugAvatarVideoRuntime("request:validated", {
        userId,
        normalizedProjectId,
        ffmpegPath,
      });
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "toonflow-avatar-video-"));
      const inputExt = inferVideoExtension(base64Data, String(fileName || ""));
      const inputPath = path.join(tempDir, `input.${inputExt}`);
      await fs.writeFile(inputPath, extractBase64(base64Data));
      debugAvatarVideoRuntime("input:written", {
        inputPath,
        inputExt,
      });

      cleanupVideoAvatarJobs();
      const job: VideoAvatarJob = {
        taskId: nextVideoAvatarTaskId++,
        userId,
        normalizedProjectId,
        fileName: String(fileName || "avatar.mp4"),
        preferGif: Boolean(preferGif),
        ffmpegPath,
        tempDir,
        inputPath,
        inputExt,
        status: "queued",
        progress: 0,
        message: "视频头像任务已进入队列",
        errorMessage: "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      videoAvatarJobs.set(job.taskId, job);
      videoAvatarQueue.push(job);
      startNextVideoAvatarJob();
      return res.status(200).send(success(buildVideoAvatarJobResponse(job)));
    } catch (err) {
      debugAvatarVideoRuntime("request:failed", {
        error: u.error(err).message,
      });
      return res.status(500).send(error(u.error(err).message));
    }
  },
);

router.post(
  "/status",
  validateFields({
    taskId: z.number().optional(),
    jobId: z.number().optional(),
  }),
  (req, res) => {
    cleanupVideoAvatarJobs();
    const taskId = Number(req.body.taskId || req.body.jobId || 0);
    const job = videoAvatarJobs.get(taskId);
    if (!job) {
      return res.status(404).send(error("视频头像任务不存在或已过期"));
    }
    return res.status(200).send(success(buildVideoAvatarJobResponse(job)));
  },
);

export default router;
