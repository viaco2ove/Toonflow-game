import express from "express";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import path from "node:path";

const router = express.Router();

function parseBase64(input: string): { buffer: Buffer; ext: string } {
  const match = input.match(/^data:([^;]+);base64,(.+)$/);
  let base64 = input;
  let ext = "wav";
  if (match) {
    base64 = match[2] || "";
    const mime = match[1] || "";
    const mapping: Record<string, string> = {
      "audio/wav": "wav",
      "audio/x-wav": "wav",
      "audio/mpeg": "mp3",
      "audio/mp3": "mp3",
      "audio/ogg": "ogg",
      "audio/webm": "webm",
      "audio/aac": "aac",
      "audio/flac": "flac",
    };
    if (mapping[mime]) {
      ext = mapping[mime];
    }
  }
  return {
    buffer: Buffer.from(base64, "base64"),
    ext,
  };
}

// 上传视频轨道音频（base64）
export default router.post(
  "/",
  validateFields({
    base64Data: z.string(),
    fileName: z.string().optional().nullable(),
    projectId: z.number().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const { base64Data, fileName, projectId } = req.body;
      const { buffer, ext } = parseBase64(base64Data);
      const safeExt = (fileName && path.extname(fileName).slice(1)) || ext || "wav";
      const folder = Number.isFinite(projectId) ? String(projectId) : "audio";
      const savePath = `/${folder}/audio/${uuid()}.${safeExt}`;
      await u.oss.writeFile(savePath, buffer);
      const url = await u.oss.getFileUrl(savePath);
      res.status(200).send(success({ filePath: savePath, url }));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
