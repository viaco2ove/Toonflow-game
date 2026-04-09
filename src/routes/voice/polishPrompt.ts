import express from "express";
import * as zod from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import polishVoicePromptAgent from "@/agents/voicePromptPolish";

const router = express.Router();

/**
 * 根据配置 id 读取真实语音配置，避免前端传错厂商或模型导致润色策略跑偏。
 */
async function resolveVoicePromptContext(configId: number, userId: number): Promise<{
  manufacturer: string;
  model: string;
}> {
  if (!configId || configId <= 0) {
    return {
      manufacturer: "",
      model: "",
    };
  }
  const row = await u.db("t_config")
    .where({ id: configId, type: "voice", userId })
    .first();
  return {
    manufacturer: String(row?.manufacturer || "").trim(),
    model: String(row?.model || "").trim(),
  };
}

// 语音提示词润色
export default router.post(
  "/",
  validateFields({
    text: zod.string(),
    style: zod.string().optional().nullable(),
    configId: zod.number().optional().nullable(),
    mode: zod.string().optional().nullable(),
    provider: zod.string().optional().nullable(),
  }),
  async (req, res) => {
    const { text, style, configId, mode, provider } = req.body;
    const userId = Number((req as any)?.user?.id || 0);
    const context = await resolveVoicePromptContext(Number(configId || 0), userId);
    const result = await polishVoicePromptAgent({
      text,
      style,
      userId,
      mode,
      provider,
      manufacturer: context.manufacturer,
      model: context.model,
    });
    res.status(200).send(success(result));
  },
);
