import express from "express";
import { z } from "zod";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  getRuntimeStoryVoiceConfig,
  normalizePersistedVoiceConfig,
  normalizeVoiceBaseUrl,
  resolveUnsupportedVoiceModeReason,
} from "@/lib/voiceGateway";
import {
  buildGeneratedReferencePath,
  BUSINESS_VOICE_PRESET_SEED_TEXT,
  ensureBusinessVoicePresets,
  findBusinessVoicePreset,
} from "@/lib/businessVoicePresets";
import { getStoryVoiceDesignConfig } from "@/lib/voiceDesign";
import {
  buildProxyAudioUrl,
  loadReferenceAudioBuffer,
  synthesizeReferenceAudioFromMode,
  type VoiceMode,
} from "./preview";

const router = express.Router();

/**
 * 把用户传入的文本安全裁成单行，避免生成 key 时混入无意义空白。
 */
function trimText(input?: unknown): string {
  return String(input || "").trim();
}

/**
 * 统一把混合音色列表归一成稳定结构，避免 hash 和下游合成时出现重复项。
 */
function normalizeMixVoices(
  mixVoices: Array<{ voiceId?: string | null; weight?: number | null }> | null | undefined,
): Array<{ voiceId: string; weight: number }> {
  return (mixVoices || [])
    .map((item) => ({
      voiceId: trimText(item?.voiceId),
      weight: typeof item?.weight === "number" ? item.weight : 0.7,
    }))
    .filter((item) => item.voiceId);
}

/**
 * 复制/缓存 clone 参考音频，生成一个稳定可复用的参考文件路径。
 * clone 模式本身不会“重建音色”，但运行时统一走 clone 时仍需要一个稳定文件。
 */
async function generateCloneReferenceAudio(options: {
  manufacturer: string;
  configId: number;
  voiceId: string;
  roleId?: string | null;
  referenceAudioPath: string;
  referenceText: string;
}): Promise<string> {
  const cachePath = buildGeneratedReferencePath({
    manufacturer: options.manufacturer,
    configId: options.configId,
    mode: "clone",
    voiceId: options.voiceId,
    referenceAudioPath: options.referenceAudioPath,
    referenceText: options.referenceText,
  }, options.roleId);
  if (await u.oss.fileExists(cachePath)) {
    return cachePath;
  }
  const buffer = await loadReferenceAudioBuffer(options.referenceAudioPath);
  await u.oss.writeFile(cachePath, buffer);
  return cachePath;
}

/**
 * 文本预设模式下，如果用户选中的是业务内置预设，直接复用该预设的参考音频做 clone 源。
 * 这样生成出的文件和运行时 clone 通道完全一致，不会误把预设 id 当成真实 provider voiceId。
 */
async function resolveBusinessPresetReference(options: {
  userId: number;
  manufacturer: string;
  configId: number;
  voiceId: string;
  roleId?: string | null;
}): Promise<string> {
  const preset = findBusinessVoicePreset(options.voiceId);
  if (!preset) return "";
  await ensureBusinessVoicePresets(options.userId);
  return generateCloneReferenceAudio({
    manufacturer: options.manufacturer,
    configId: options.configId,
    voiceId: options.voiceId,
    roleId: options.roleId,
    referenceAudioPath: preset.referencePath,
    referenceText: preset.referenceText,
  });
}

/**
 * 生成成功后统一包装可下载、可复用的返回结果。
 * 同时把阿里第一次返回的自定义音色信息带回前端，避免“刚生成完又立刻走二次复刻”。
 */
function buildGeneratedVoiceResult(
  req: express.Request,
  audioPath: string,
  referenceText: string,
  options: {
    customVoiceId?: string;
    customVoiceMode?: string;
    requestModel?: string;
    targetModel?: string;
  } = {},
) {
  const segments = String(audioPath || "").split("/");
  const audioName = segments[segments.length - 1] || "generated_voice.wav";
  return {
    audioPath,
    audioName,
    audioUrl: buildProxyAudioUrl(req, null, audioPath),
    referenceText,
    customVoiceId: trimText(options.customVoiceId) || undefined,
    customVoiceMode: trimText(options.customVoiceMode) || undefined,
    requestModel: trimText(options.requestModel) || undefined,
    targetModel: trimText(options.targetModel) || undefined,
  };
}

// 生成可复用音色文件
export default router.post(
  "/",
  validateFields({
    configId: z.number().optional().nullable(),
    roleId: z.string().optional().nullable(),
    mode: z.enum(["text", "clone", "mix", "prompt_voice"]),
    voiceId: z.string().optional().nullable(),
    referenceAudioPath: z.string().optional().nullable(),
    referenceText: z.string().optional().nullable(),
    promptText: z.string().optional().nullable(),
    mixVoices: z.array(
      z.object({
        voiceId: z.string(),
        weight: z.number().optional().nullable(),
      }),
    ).optional().nullable(),
    sampleRate: z.number().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const {
        configId,
        roleId,
        mode,
        voiceId,
        referenceAudioPath,
        referenceText,
        promptText,
        mixVoices,
        sampleRate,
      } = req.body as {
        configId?: number | null;
        roleId?: string | null;
        mode: VoiceMode;
        voiceId?: string | null;
        referenceAudioPath?: string | null;
        referenceText?: string | null;
        promptText?: string | null;
        mixVoices?: Array<{ voiceId?: string | null; weight?: number | null }> | null;
        sampleRate?: number | null;
      };

      const userId = Number((req as any)?.user?.id || 0);
      const persistedConfig = await getRuntimeStoryVoiceConfig(userId, configId);
      if (!persistedConfig) {
        return res.status(400).send(error("语音模型配置不存在"));
      }

      const normalizedConfig = normalizePersistedVoiceConfig({
        manufacturer: persistedConfig.manufacturer,
        modelType: persistedConfig.modelType,
        model: persistedConfig.model,
        baseUrl: persistedConfig.baseUrl,
      });
      const config = { ...persistedConfig, ...normalizedConfig };
      const manufacturer = trimText(config.manufacturer);
      const unsupportedReason = resolveUnsupportedVoiceModeReason({
        manufacturer,
        modelType: config.modelType,
        model: config.model,
        mode,
      });
      if (unsupportedReason) {
        return res.status(400).send(error(unsupportedReason));
      }

      const headers: Record<string, string> = {};
      if (trimText(config.apiKey)) {
        headers.Authorization = `Bearer ${trimText(config.apiKey)}`;
      }
      const baseUrl = normalizeVoiceBaseUrl(config.baseUrl);
      const normalizedVoiceId = trimText(voiceId);
      const normalizedReferenceText = trimText(referenceText);
      const normalizedPromptText = trimText(promptText);
      const normalizedMixVoices = normalizeMixVoices(mixVoices);
      const voiceDesignConfig = mode === "prompt_voice" ? await getStoryVoiceDesignConfig(userId) : null;

      if (mode === "prompt_voice" && !voiceDesignConfig) {
        return res.status(400).send(error("请先在设置里配置语音设计模型"));
      }
      if (mode === "clone" && !trimText(referenceAudioPath)) {
        return res.status(400).send(error("克隆模式需要参考音频"));
      }
      if (mode === "mix" && !normalizedMixVoices.length) {
        return res.status(400).send(error("混合模式需要选择音色"));
      }
      if (mode === "prompt_voice" && !normalizedPromptText) {
        return res.status(400).send(error("提示词模式需要填写提示词"));
      }

      if (mode === "clone") {
        const generatedPath = await generateCloneReferenceAudio({
          manufacturer,
          configId: Number(config.id || 0),
          voiceId: normalizedVoiceId,
          roleId: trimText(roleId),
          referenceAudioPath: trimText(referenceAudioPath),
          referenceText: normalizedReferenceText,
        });
        return res.status(200).send(success(buildGeneratedVoiceResult(req, generatedPath, normalizedReferenceText)));
      }

      if (mode === "text") {
        const businessPresetPath = await resolveBusinessPresetReference({
          userId,
          manufacturer,
          configId: Number(config.id || 0),
          voiceId: normalizedVoiceId,
          roleId: trimText(roleId),
        });
        if (businessPresetPath) {
          return res.status(200).send(success(buildGeneratedVoiceResult(req, businessPresetPath, BUSINESS_VOICE_PRESET_SEED_TEXT)));
        }
      }

      // 非 clone 模式继续复用现有“参考音频生成”能力，产出稳定 reference 文件。
      const generated = await synthesizeReferenceAudioFromMode({
        config,
        manufacturer,
        baseUrl,
        headers,
        mode,
        voiceId: normalizedVoiceId,
        promptText: normalizedPromptText,
        mixVoices: normalizedMixVoices,
        sampleRate,
        resolvedProvider: "",
        userId,
        voiceDesignConfig,
        roleId: trimText(roleId),
      });
      return res.status(200).send(success(buildGeneratedVoiceResult(
        req,
        generated.audioPath,
        BUSINESS_VOICE_PRESET_SEED_TEXT,
        {
          customVoiceId: generated.customVoiceId,
          customVoiceMode: generated.customVoiceId ? mode : "",
          requestModel: generated.requestModel,
          targetModel: generated.targetModel,
        },
      )));
    } catch (err) {
      return res.status(500).send(error((err as Error).message || "生成音色失败"));
    }
  },
);
