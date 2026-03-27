import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { isVoiceDesignModelConfig } from "@/lib/modelConfigType";
const router = express.Router();

const SLOT_CONFIG_RULES: Record<string, { type: "text" | "image" | "voice" | "voice_design"; modelType?: "asr" | "tts" }> = {
  storyboardAgent: { type: "text" },
  outlineScriptAgent: { type: "text" },
  assetsPrompt: { type: "text" },
  generateScript: { type: "text" },
  videoPrompt: { type: "text" },
  storyOrchestratorModel: { type: "text" },
  storyMemoryModel: { type: "text" },
  storyboardImage: { type: "image" },
  assetsImage: { type: "image" },
  editImage: { type: "image" },
  storyImageModel: { type: "image" },
  storyVoiceDesignModel: { type: "voice_design" },
  storyVoiceModel: { type: "voice", modelType: "tts" },
  storyAsrModel: { type: "voice", modelType: "asr" },
};

function configMatchesSlotRule(
  key: string,
  config: { type?: string | null; modelType?: string | null; manufacturer?: string | null; model?: string | null },
): boolean {
  const rule = SLOT_CONFIG_RULES[String(key || "").trim()];
  if (!rule) return true;

  const type = String(config.type || "").trim().toLowerCase();
  const modelType = String(config.modelType || "").trim().toLowerCase();
  const isVoiceDesign = isVoiceDesignModelConfig(config);

  if (rule.type === "voice_design") {
    return isVoiceDesign;
  }
  if (rule.type === "text") {
    return type === "text" && !isVoiceDesign;
  }
  if (rule.type === "image") {
    return type === "image";
  }
  if (rule.type === "voice") {
    if (type !== "voice") return false;
    if (rule.modelType === "asr") return modelType === "asr";
    return modelType !== "asr";
  }
  return true;
}

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    configId: z.number(),
  }),
  async (req, res) => {
    const { id, configId } = req.body;
    const userId = Number((req as any)?.user?.id || 0);
    const mapRow = await u.db("t_aiModelMap").where({ id }).first("id", "key");
    if (!mapRow) {
      return res.status(404).send(error("映射项不存在"));
    }

    const config = await u.db("t_config").where({ id: configId, userId }).first("id", "type", "modelType", "manufacturer", "model");
    if (!config) {
      return res.status(403).send(error("无权绑定该模型配置"));
    }
    if (!configMatchesSlotRule(String(mapRow.key || ""), config)) {
      return res.status(400).send(error("所选模型配置类型与当前槽位不匹配"));
    }

    const setting = await u.db("t_setting").where({ userId }).first("id", "languageModel");
    let mapping: Record<string, number> = {};
    try {
      const parsed = JSON.parse(String(setting?.languageModel || "{}"));
      if (parsed && typeof parsed === "object") {
        mapping = parsed as Record<string, number>;
      }
    } catch {
      mapping = {};
    }
    mapping[String(mapRow.key)] = Number(configId);
    const languageModel = JSON.stringify(mapping);

    if (setting?.id) {
      await u.db("t_setting").where({ id: Number(setting.id) }).update({ languageModel });
    } else {
      const maxRow = await u.db("t_setting").max({ maxId: "id" }).first();
      const nextId = Number((maxRow as any)?.maxId || 0) + 1;
      await u.db("t_setting").insert({
        id: nextId,
        userId,
        tokenKey: u.uuid().slice(0, 8),
        imageModel: "{}",
        languageModel,
        projectId: null,
      });
    }

    res.status(200).send(success("配置成功"));
  },
);
