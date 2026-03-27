import express from "express";
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

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0", "::1"]);

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
      fit: "cover",
      position: "attention",
    })
    .png()
    .toBuffer();
}

async function chromaKeyForeground(input: Buffer): Promise<Buffer> {
  const prepared = await sharp(input)
    .resize(AVATAR_STD_SIZE, AVATAR_STD_SIZE, {
      fit: "cover",
      position: "attention",
    })
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

async function normalizeBackgroundLayer(input: Buffer): Promise<Buffer> {
  return await sharp(input)
    .resize(AVATAR_BG_SIZE, AVATAR_BG_SIZE, {
      fit: "cover",
      position: "centre",
    })
    .png()
    .toBuffer();
}

async function resolveImageConfig(userId: number) {
  const keys = ["storyImageModel", "editImage", "assetsImage"];
  for (const key of keys) {
    const config = await u.getPromptAi(key, userId);
    if ((config as any)?.manufacturer) return config as any;
  }
  throw new Error("未配置可用图像模型，请先配置 AI生图 或 图片编辑 模型");
}

function buildForegroundPrompt(name: string): string {
  return [
    `参考图中的主角名称：${name}`,
    "请严格参考输入图，只生成同一个角色主体。",
    "必须保留角色的发型、五官、服装、配饰、体态、朝向和画风，不要改人设。",
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
    "必须完全移除角色主体，不允许出现人物、脸、头发、手脚、衣物、剪影或半透明残影。",
    "要补全原本被人物遮挡的背景内容，保持原画的色调、景深、光线和构图氛围。",
    "输出纯背景图，不要文字、水印、边框，不要新增角色。",
  ].join("\n");
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number().optional().nullable(),
    fileName: z.string().optional().nullable(),
    name: z.string().optional().nullable(),
    base64Data: z.string(),
  }),
  async (req, res) => {
    try {
      const { projectId, fileName, name, base64Data } = req.body as {
        projectId?: number | null;
        fileName?: string | null;
        name?: string | null;
        base64Data: string;
      };
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }

      const normalizedProjectId = Number(projectId || 0);
      if (normalizedProjectId > 0) {
        const owned = await u.db("t_project").where({ id: normalizedProjectId, userId }).first("id");
        if (!owned) {
          return res.status(403).send(error("无权访问该项目"));
        }
      }

      const safeName = String(name || "").trim() || "角色";
      const normalizedInput = normalizeBase64Data(base64Data, String(fileName || ""));
      const modelInput = await normalizeRoleSource(normalizedInput);
      const modelInputDataUrl = bufferToDataUrl(modelInput, "image/png");
      const config = await resolveImageConfig(userId);

      const [foregroundRaw, backgroundRaw] = await Promise.all([
        u.ai.image(
          {
            systemPrompt: "你是角色主体分离助手，只输出图片。",
            prompt: buildForegroundPrompt(safeName),
            imageBase64: [modelInputDataUrl],
            aspectRatio: "1:1",
            size: "2K",
          },
          config,
        ),
        u.ai.image(
          {
            systemPrompt: "你是角色背景补全助手，只输出图片。",
            prompt: buildBackgroundPrompt(safeName),
            imageBase64: [modelInputDataUrl],
            aspectRatio: "1:1",
            size: "2K",
          },
          config,
        ),
      ]);

      const foregroundBuffer = await chromaKeyForeground(await imageOutputToBuffer(String(foregroundRaw || "")));
      const backgroundBuffer = await normalizeBackgroundLayer(await imageOutputToBuffer(String(backgroundRaw || "")));

      const baseDir = normalizedProjectId > 0 ? `/${normalizedProjectId}/game/role` : `/user/${userId}/game/role`;
      const foregroundFilePath = `${baseDir}/${uuidv4()}_fg.png`;
      const backgroundFilePath = `${baseDir}/${uuidv4()}_bg.png`;
      await u.oss.writeFile(foregroundFilePath, foregroundBuffer);
      await u.oss.writeFile(backgroundFilePath, backgroundBuffer);

      const foregroundPath = await u.oss.getFileUrl(foregroundFilePath);
      const backgroundPath = await u.oss.getFileUrl(backgroundFilePath);

      return res.status(200).send(success({
        foregroundPath,
        foregroundFilePath,
        backgroundPath,
        backgroundFilePath,
      }));
    } catch (err) {
      console.error("[separateRoleAvatar] failed", {
        userId: Number((req as any)?.user?.id || 0),
        projectId: Number((req.body as any)?.projectId || 0) || null,
        fileName: String((req.body as any)?.fileName || "").trim(),
        name: String((req.body as any)?.name || "").trim(),
        message: u.error(err).message,
      });
      return res.status(500).send(error(u.error(err).message));
    }
  },
);
