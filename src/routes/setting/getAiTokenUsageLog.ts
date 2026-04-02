import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getAiTokenUsageLogList } from "@/lib/aiTokenUsageLog";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    startTime: z.union([z.string(), z.number()]).optional(),
    endTime: z.union([z.string(), z.number()]).optional(),
    type: z.string().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  }),
  async (req, res) => {
    const rows = await getAiTokenUsageLogList(req.body || {});
    return res.status(200).send(success(rows));
  },
);
