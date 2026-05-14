import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getAiTokenUsageStatsList } from "@/lib/aiTokenUsageLog";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    startTime: z.union([z.string(), z.number()]).optional(),
    endTime: z.union([z.string(), z.number()]).optional(),
    type: z.string().optional(),
    granularity: z.enum(["hour", "day", "month"]).optional(),
  }),
  async (req, res) => {
    const rows = await getAiTokenUsageStatsList(req.body || {});
    return res.status(200).send(success(rows));
  },
);
