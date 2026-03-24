import express from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import u from "@/utils";

const router = express.Router();

function extractBase64(raw: string): Buffer {
  const value = String(raw || "").trim();
  const match = value.match(/base64,([A-Za-z0-9+/=]+)/);
  return Buffer.from(match && match[1] ? match[1] : value, "base64");
}

function pickExtension(base64Data: string, fileName: string): string {
  const nameExt = String(fileName || "").trim().split(".").pop()?.toLowerCase() || "";
  const safeNameExt = nameExt.replace(/[^a-z0-9]/g, "");
  if (safeNameExt) {
    return safeNameExt === "jpeg" ? "jpg" : safeNameExt;
  }

  const mime = String(base64Data || "").match(/^data:([^;]+);base64,/i)?.[1]?.toLowerCase() || "";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  return "png";
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number().optional().nullable(),
    type: z.enum(["role", "scene"]),
    fileName: z.string().optional().nullable(),
    base64Data: z.string(),
  }),
  async (req, res) => {
    try {
      const { projectId, type, fileName, base64Data } = req.body as {
        projectId?: number | null;
        type: "role" | "scene";
        fileName?: string | null;
        base64Data: string;
      };
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }

      const normalizedProjectId = Number(projectId || 0);
      if (normalizedProjectId > 0) {
        const owned = await u.db("t_project")
          .where({ id: normalizedProjectId, userId })
          .first("id");
        if (!owned) {
          return res.status(403).send(error("无权访问该项目"));
        }
      }

      const ext = pickExtension(base64Data, String(fileName || ""));
      const imagePath = normalizedProjectId > 0
        ? `/${normalizedProjectId}/game/${type}/${uuidv4()}.${ext}`
        : `/user/${userId}/game/${type}/${uuidv4()}.${ext}`;

      await u.oss.writeFile(imagePath, extractBase64(base64Data));
      const path = await u.oss.getFileUrl(imagePath);

      return res.status(200).send(success({ path, filePath: imagePath }));
    } catch (err) {
      return res.status(500).send(error(u.error(err).message));
    }
  },
);
