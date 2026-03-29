import express from "express";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import u from "@/utils";

const router = express.Router();

const AVATAR_GIF_SIDE = 512;
const AVATAR_BG_SIDE = 768;
const MAX_GIF_DURATION_SECONDS = 4;
const GIF_FPS = 10;

const COMMON_WIN_FFMPEG_PATHS = [
  "D:\\Program Files\\ffmpeg-master-latest-win64-gpl-shared\\bin\\ffmpeg.exe",
  "C:\\Program Files\\ffmpeg-master-latest-win64-gpl-shared\\bin\\ffmpeg.exe",
  "D:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
  "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
];

let cachedFfmpegPath = "";

function extractBase64(raw: string): Buffer {
  const value = String(raw || "").trim();
  const match = value.match(/base64,([A-Za-z0-9+/=]+)/);
  return Buffer.from(match && match[1] ? match[1] : value, "base64");
}

function inferVideoExtension(base64Data: string, fileName: string): string {
  const nameExt = String(fileName || "").trim().split(".").pop()?.toLowerCase() || "";
  if (nameExt) return nameExt.replace(/[^a-z0-9]/g, "");
  const mime = String(base64Data || "").match(/^data:([^;]+);base64,/i)?.[1]?.toLowerCase() || "";
  if (mime === "video/mp4") return "mp4";
  if (mime === "video/x-m4v") return "m4v";
  if (mime === "video/quicktime") return "mov";
  return "mp4";
}

function assertSupportedVideo(base64Data: string, fileName: string): void {
  const ext = inferVideoExtension(base64Data, fileName);
  const mime = String(base64Data || "").match(/^data:([^;]+);base64,/i)?.[1]?.toLowerCase() || "";
  const supportedExt = new Set(["mp4", "m4v", "mov"]);
  const supportedMime = new Set(["", "video/mp4", "video/x-m4v", "video/quicktime", "application/octet-stream"]);
  if (!supportedExt.has(ext) || !supportedMime.has(mime)) {
    throw new Error("仅支持上传 MP4 视频转换 GIF");
  }
}

function convertWindowsPathToWsl(input: string): string {
  const raw = String(input || "").trim();
  const match = raw.match(/^([A-Za-z]):\\(.*)$/);
  if (!match) return raw;
  const drive = match[1]!.toLowerCase();
  const tail = match[2]!.replace(/\\/g, "/");
  return `/mnt/${drive}/${tail}`;
}

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
      const trimmed = stderr.trim().split(/\r?\n/).slice(-6).join("\n").trim();
      reject(new Error(trimmed || `ffmpeg 执行失败（退出码 ${code ?? -1}）`));
    });
  });
}

function roleMediaBasePath(userId: number, projectId?: number | null): string {
  const normalizedProjectId = Number(projectId || 0);
  return normalizedProjectId > 0
    ? `/${normalizedProjectId}/game/role`
    : `/user/${userId}/game/role`;
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number().optional().nullable(),
    fileName: z.string().optional().nullable(),
    base64Data: z.string(),
  }),
  async (req, res) => {
    const userId = Number((req as any)?.user?.id || 0);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).send(error("用户未登录"));
    }

    const { projectId, fileName, base64Data } = req.body as {
      projectId?: number | null;
      fileName?: string | null;
      base64Data: string;
    };

    try {
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
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "toonflow-avatar-video-"));
      try {
        const inputExt = inferVideoExtension(base64Data, String(fileName || ""));
        const inputPath = path.join(tempDir, `input.${inputExt}`);
        const palettePath = path.join(tempDir, "palette.png");
        const gifPath = path.join(tempDir, "avatar.gif");
        const backgroundPath = path.join(tempDir, "background.png");
        await fs.writeFile(inputPath, extractBase64(base64Data));

        const cropGif = `fps=${GIF_FPS},scale=${AVATAR_GIF_SIDE}:${AVATAR_GIF_SIDE}:force_original_aspect_ratio=increase,crop=${AVATAR_GIF_SIDE}:${AVATAR_GIF_SIDE}`;
        const cropBg = `scale=${AVATAR_BG_SIDE}:${AVATAR_BG_SIDE}:force_original_aspect_ratio=increase,crop=${AVATAR_BG_SIDE}:${AVATAR_BG_SIDE}`;

        await runFfmpeg(ffmpegPath, [
          "-y",
          "-ss",
          "0",
          "-t",
          String(MAX_GIF_DURATION_SECONDS),
          "-i",
          inputPath,
          "-vf",
          `${cropGif},palettegen=max_colors=128:stats_mode=diff`,
          palettePath,
        ]);

        await runFfmpeg(ffmpegPath, [
          "-y",
          "-ss",
          "0",
          "-t",
          String(MAX_GIF_DURATION_SECONDS),
          "-i",
          inputPath,
          "-i",
          palettePath,
          "-lavfi",
          `${cropGif}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5`,
          "-loop",
          "0",
          gifPath,
        ]);

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

        const [gifBuffer, bgBuffer] = await Promise.all([
          fs.readFile(gifPath),
          fs.readFile(backgroundPath),
        ]);

        const basePath = roleMediaBasePath(userId, normalizedProjectId);
        const foregroundFilePath = `${basePath}/${uuidv4()}.gif`;
        const backgroundFilePath = `${basePath}/${uuidv4()}.png`;
        await Promise.all([
          u.oss.writeFile(foregroundFilePath, gifBuffer),
          u.oss.writeFile(backgroundFilePath, bgBuffer),
        ]);
        const [foregroundPath, backgroundUrl] = await Promise.all([
          u.oss.getFileUrl(foregroundFilePath),
          u.oss.getFileUrl(backgroundFilePath),
        ]);

        return res.status(200).send(success({
          foregroundPath,
          foregroundFilePath,
          backgroundPath: backgroundUrl,
          backgroundFilePath,
        }));
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    } catch (err) {
      return res.status(500).send(error(u.error(err).message));
    }
  },
);
