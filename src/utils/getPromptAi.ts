import { db } from "./db";
import { getCurrentUserId } from "@/lib/requestContext";
interface AiConfig {
  model?: string;
  apiKey: string;
  baseURL?: string;
  manufacturer: string;
}

const STRICT_MODEL_KEYS = new Set([
  "storyOrchestratorModel",
  "storyFastSpeakerModel",
  "storySpeakerModel",
  "storyMemoryModel",
  "storyImageModel",
  "storyAvatarMattingModel",
  "storyVoiceModel",
  "storyAsrModel",
  "storyVoiceDesignModel",
]);

export default async function getPromptAi(key: string, userId?: number): Promise<AiConfig | {}> {
  const resolvedUserId = Number.isFinite(Number(userId)) && Number(userId) > 0 ? Number(userId) : getCurrentUserId(0);
  if (!resolvedUserId) {
    return {};
  }
  const strictMode = STRICT_MODEL_KEYS.has(String(key || "").trim());
  const setting = await db("t_setting").where({ userId: resolvedUserId }).select("languageModel").first();
  let selectedConfigId = 0;
  try {
    const parsed = JSON.parse(String(setting?.languageModel || "{}"));
    selectedConfigId = Number((parsed as Record<string, any>)?.[key] || 0);
  } catch {
    selectedConfigId = 0;
  }

  let aiConfigData: any = null;
  if (selectedConfigId > 0) {
    aiConfigData = await db("t_config")
      .where({ id: selectedConfigId, userId: resolvedUserId })
      .select("model", "apiKey", "baseUrl as baseURL", "manufacturer")
      .first();
  }

  if (strictMode || selectedConfigId > 0) {
    return aiConfigData ? (aiConfigData as AiConfig) : {};
  }

  if (!aiConfigData) {
    // 兼容旧映射逻辑：当 languageModel 未配置时回退到 t_aiModelMap.configId
    aiConfigData = await db("t_aiModelMap")
      .leftJoin("t_config", "t_config.id", "t_aiModelMap.configId")
      .where("t_aiModelMap.key", key)
      .where("t_config.userId", resolvedUserId)
      .select("t_config.model", "t_config.apiKey", "t_config.baseUrl as baseURL", "t_config.manufacturer")
      .first();
  }

  if (!aiConfigData) {
    const fallbackTypeMap: Record<string, string> = {
      storyOrchestratorModel: "text",
      storyFastSpeakerModel: "text",
      storySpeakerModel: "text",
      storyMemoryModel: "text",
      storyImageModel: "image",
      storyAvatarMattingModel: "image",
      storyVoiceModel: "voice",
      storyAsrModel: "asr",
    };
    const fallbackType = fallbackTypeMap[key];
    if (fallbackType) {
      const query = db("t_config")
        .where({ userId: resolvedUserId })
        .modify((qb: any) => {
          if (fallbackType === "text") {
            qb.where("type", "text");
          } else if (fallbackType === "image") {
            qb.whereIn("type", ["image", "t2i", "i2i"]);
          } else if (fallbackType === "voice" || fallbackType === "asr") {
            qb.where("type", "voice");
            if (fallbackType === "asr") {
              qb.where("modelType", "asr");
            }
          }
        })
        .orderByRaw("case when manufacturer in ('t8star','openai') then 0 else 1 end")
        .orderBy("id", "desc")
        .select("model", "apiKey", "baseUrl as baseURL", "manufacturer");
      aiConfigData = await query.first();
    }
  }

  if (aiConfigData) {
    return aiConfigData as AiConfig;
  } else return {};
}
