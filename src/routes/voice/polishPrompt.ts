import express from "express";
import * as zod from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import polishVoicePromptAgent from "@/agents/voicePromptPolish";
import { getStoryVoiceDesignConfig } from "@/lib/voiceDesign";

const router = express.Router();

/**
 * 仅在 debug 日志级别打印语音提示词润色链路，避免普通日志被刷屏。
 */
function isDebugLogEnabled(): boolean {
  return String(process.env.LOG_LEVEL || "").trim().toLowerCase() === "debug";
}

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
    configId: zod.number().optional().nullable(),
    mode: zod.string().optional().nullable(),
    provider: zod.string().optional().nullable(),
  }),
  async (req, res) => {
    const { text, configId, mode, provider } = req.body;
    const userId = Number((req as any)?.user?.id || 0);
    const context = await resolveVoicePromptContext(Number(configId || 0), userId);
    const voiceDesignConfig = String(mode || "").trim() === "prompt_voice"
      ? await getStoryVoiceDesignConfig(userId)
      : null;
    if (isDebugLogEnabled()) {
      console.log("[voice:polish:debug] request", {
        userId,
        configId: Number(configId || 0),
        mode: String(mode || "").trim(),
        provider: String(provider || "").trim(),
        manufacturer: context.manufacturer,
        model: context.model,
        voiceDesignModel: String(voiceDesignConfig?.model || "").trim(),
        textLength: String(text || "").trim().length,
      });
    }
    const result = await polishVoicePromptAgent({
      text,
      userId,
      mode,
      provider,
      manufacturer: context.manufacturer,
      model: context.model,
      voiceDesignModel: String(voiceDesignConfig?.model || "").trim(),
    });
    if (isDebugLogEnabled()) {
      console.log("[voice:polish:debug] result", {
        prompt: result.prompt,
        keywords: result.keywords,
        signalGroups: result.signalGroups,
        source: result.source,
      });
    }
    res.status(200).send(success(result));
  },
);
