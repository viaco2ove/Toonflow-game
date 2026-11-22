import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const COMMON_WIN_FFMPEG_PATHS = [
  "D:\\Program Files\\ffmpeg-master-latest-win64-gpl-shared\\bin\\ffmpeg.exe",
  "C:\\Program Files\\ffmpeg-master-latest-win64-gpl-shared\\bin\\ffmpeg.exe",
  "D:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
  "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
];

let cachedFfmpegPath = "";

/**
 * 把 Windows 盘符路径转成 WSL 可访问路径，保证同一套发现逻辑能在两边都工作。
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
 * 找到系统里的 ffmpeg 可执行文件。
 * 语音设计接口返回的音频格式不总是 clone 可直接使用，因此这里统一依赖 ffmpeg 做格式收口。
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

  const lookup = process.platform === "win32"
    ? spawnSync("where", ["ffmpeg"], { encoding: "utf8", windowsHide: true })
    : spawnSync("sh", ["-lc", "command -v ffmpeg"], { encoding: "utf8" });
  const firstLine = String(lookup.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
  if (firstLine) {
    const normalized = existsSync(firstLine) ? firstLine : convertWindowsPathToWsl(firstLine);
    if (existsSync(normalized)) {
      cachedFfmpegPath = normalized;
      return cachedFfmpegPath;
    }
  }

  throw new Error("未找到 ffmpeg，无法规范化参考音频");
}

/**
 * 执行一次 ffmpeg 转码命令，失败时把 stderr 尾部带出来，方便定位格式问题。
 */
async function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
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
        resolve();
        return;
      }
      const detail = stderr.trim().split(/\r?\n/).slice(-6).join("\n").trim();
      reject(new Error(detail || `ffmpeg 执行失败（退出码 ${code ?? -1}）`));
    });
  });
}

/**
 * 执行一次 ffmpeg 命令并捕获输出（用于探测时长这类需要读取 stderr 的场景）。
 * 退出码非 0 时不抛错——ffmpeg 解析时长时本来就以非 0 退出，输出里仍带 Duration 信息。
 */
async function runFfmpegCapture(ffmpegPath: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve) => {
    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk || "");
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk || "");
    });
    child.on("error", () => resolve(output));
    child.on("close", () => resolve(output));
  });
}

/**
 * 把任意可解码的音频 Buffer 统一转成阿里 clone 可稳定解码的 24kHz / mono / 16bit PCM WAV。
 * 这样“提示词生成的参考音频”后续再走 clone 通道时，不会因为浮点 wav 或采样率差异被拒。
 */
export async function normalizeAudioBufferToPcmWav(options: {
  buffer: Buffer;
  sourceExt?: string | null;
  sampleRate?: number | null;
}): Promise<Buffer> {
  const ffmpegPath = discoverFfmpegPath();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "toonflow-voice-norm-"));
  try {
    const inputExt = String(options.sourceExt || "wav").trim().toLowerCase() || "wav";
    const inputPath = path.join(tempDir, `input.${inputExt}`);
    const outputPath = path.join(tempDir, "normalized.wav");
    await fs.writeFile(inputPath, options.buffer);
    await runFfmpeg(ffmpegPath, [
      "-y",
      "-i",
      inputPath,
      "-ac",
      "1",
      "-ar",
      String(Number(options.sampleRate || 24000) || 24000),
      "-acodec",
      "pcm_s16le",
      "-f",
      "wav",
      outputPath,
    ]);
    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 读取音频时长（秒）。
 * 解析失败时返回 null（表示未知，而不是 0，避免误判为"无需裁剪"）。
 */
export async function probeAudioDurationSeconds(options: {
  buffer: Buffer;
  sourceExt?: string | null;
}): Promise<number | null> {
  const ffmpegPath = discoverFfmpegPath();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "toonflow-voice-probe-"));
  try {
    const inputExt = String(options.sourceExt || "wav").trim().toLowerCase() || "wav";
    const inputPath = path.join(tempDir, `input.${inputExt}`);
    await fs.writeFile(inputPath, options.buffer);
    const output = await runFfmpegCapture(ffmpegPath, ["-i", inputPath, "-f", "null", "-"]);
    // ffmpeg 解析失败时 stderr 里会有 "Duration: HH:MM:SS.ss"
    const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!match) return null;
    const [, hours, minutes, seconds] = match;
    return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  } catch {
    return null;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 把音频裁剪到指定时长上限（从开头截取），并转成 16kHz / mono / 16bit PCM WAV。
 *
 * 用途：SiliconFlow 的声音克隆要求参考音频不超过 30 秒，
 * 超长会返回 code 20015「audio longer than 30s is not supported」。
 * 这里统一在上传前裁剪，避免整个克隆请求失败。
 *
 * 裁剪后音频短于原时长，说明确实做了截断；返回 null 表示无需裁剪（调用方保留原 buffer）。
 */
export async function trimAudioBufferToDuration(options: {
  buffer: Buffer;
  sourceExt?: string | null;
  maxSeconds: number;
  sampleRate?: number | null;
}): Promise<Buffer | null> {
  const duration = await probeAudioDurationSeconds(options);
  if (duration === null) return null;
  const maxSeconds = Number(options.maxSeconds || 0);
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) return null;
  // 留一点余量，避免编码误差导致刚好卡在上限
  if (duration <= maxSeconds - 0.5) return null;

  const ffmpegPath = discoverFfmpegPath();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "toonflow-voice-trim-"));
  try {
    const inputExt = String(options.sourceExt || "wav").trim().toLowerCase() || "wav";
    const inputPath = path.join(tempDir, `input.${inputExt}`);
    const outputPath = path.join(tempDir, "trimmed.wav");
    await fs.writeFile(inputPath, options.buffer);
    await runFfmpeg(ffmpegPath, [
      "-y",
      "-i",
      inputPath,
      "-t",
      String(maxSeconds),
      "-ac",
      "1",
      "-ar",
      String(Number(options.sampleRate || 16000) || 16000),
      "-acodec",
      "pcm_s16le",
      "-f",
      "wav",
      outputPath,
    ]);
    const trimmed = await fs.readFile(outputPath);
    return trimmed.length ? trimmed : null;
  } catch (err) {
    console.warn("[audioNormalize] 裁剪音频失败，保留原音频:", err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
