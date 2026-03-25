import express from "express";
import * as zod from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import polishVoicePromptAgent from "@/agents/voicePromptPolish";

const router = express.Router();

// 语音提示词润色
export default router.post(
  "/",
  validateFields({
    text: zod.string(),
    style: zod.string().optional().nullable(),
  }),
  async (req, res) => {
    const { text, style } = req.body;
    const userId = Number((req as any)?.user?.id || 0);
    const result = await polishVoicePromptAgent({
      text,
      style,
      userId,
    });
    res.status(200).send(success(result));
  },
);
