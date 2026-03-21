import u from "@/utils";

type AIType = "text" | "image" | "video" | "voice";

interface BaseConfig {
  model: string;
  apiKey: string;
  manufacturer: string;
}

interface TextResData extends BaseConfig {
  baseURL: string;
  manufacturer: "deepSeek" | "deepseek" | "openAi" | "doubao" | "openai" | "t8star" | "other";
}

// 图像模型配置接口
interface ImageResData extends BaseConfig {
  manufacturer: "gemini" | "volcengine" | "kling" | "vidu" | "runninghub" | "apimart" | "other";
}

interface VideoResData extends BaseConfig {
  baseURL: string;
  manufacturer: "openAi" | "volcengine" | "runninghub" | "apimart" | "confyUI" | "t8star";
}

interface VoiceResData extends BaseConfig {
  baseURL: string;
  manufacturer: "ai_voice_tts" | "other";
}

type ResDataMap = {
  text: TextResData;
  image: ImageResData;
  video: VideoResData;
  voice: VoiceResData;
};

const errorMessages: Record<AIType, string> = {
  text: "文本模型配置不存在",
  image: "图像模型配置不存在",
  video: "视频模型配置不存在",
  voice: "语音模型配置不存在",
};

const needBaseURL: AIType[] = ["text", "video", "image", "voice"];

export default async function getConfig<T extends AIType>(aiType: T, manufacturer?: string): Promise<ResDataMap[T]> {
  const config = await u
    .db("t_config")
    .where("type", aiType)
    .modify((qb) => {
      if (manufacturer) {
        qb.where("manufacturer", manufacturer);
      }
    })
    .first();

  if (!config) throw new Error(errorMessages[aiType]);

  const result: BaseConfig = {
    model: config?.model ?? "",
    apiKey: config?.apiKey ?? "",
    manufacturer: config?.manufacturer ?? "",
  };

  if (needBaseURL.includes(aiType)) {
    return { ...result, baseURL: config.baseUrl } as ResDataMap[T];
  }

  return result as ResDataMap[T];
}
