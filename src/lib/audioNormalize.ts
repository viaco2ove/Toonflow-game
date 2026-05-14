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
