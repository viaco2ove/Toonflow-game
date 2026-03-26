import fs from "node:fs/promises";
import path from "node:path";
import axios from "axios";
import u from "@/utils";
import { createHash } from "crypto";
import { GatewayVoicePreset, normalizeVoiceBaseUrl } from "@/lib/voiceGateway";
import { ensureBundledVoicePresetSeed } from "@/lib/voicePresetSeeds";
import { getVoicePresetSeedDir } from "@/lib/runtimePaths";
import { getStoryVoiceDesignConfig, synthesizeVoiceDesignBuffer } from "@/lib/voiceDesign";

export interface BusinessVoicePreset extends GatewayVoicePreset {
  referencePath: string;
  referenceText: string;
  promptText: string;
  baseVoiceId: string;
  fallbackGender: "male" | "female";
}

export const BUSINESS_VOICE_PRESET_SEED_TEXT = "你好啊，有什么可以帮到你";
const BUSINESS_VOICE_PROVIDER = "story_clone_preset";

const BUSINESS_VOICE_PRESETS: BusinessVoicePreset[] = [
  {
    voiceId: "story_std_male",
    name: "标准男声（克隆）",
    provider: BUSINESS_VOICE_PROVIDER,
    modes: ["text"],
    description: "业务标准音色，通用男声，走克隆兼容链路",
    referencePath: "/system/voice-presets/story_std_male.wav",
    referenceText: BUSINESS_VOICE_PRESET_SEED_TEXT,
    promptText: "标准中文男声，清晰自然，通用对话，语速中等，咬字稳定，适合日常交流。",
    baseVoiceId: "default_male",
    fallbackGender: "male",
  },
  {
    voiceId: "story_std_female",
    name: "标准女声（克隆）",
    provider: BUSINESS_VOICE_PROVIDER,
    modes: ["text"],
    description: "业务标准音色，通用女声，走克隆兼容链路",
    referencePath: "/system/voice-presets/story_std_female.wav",
    referenceText: BUSINESS_VOICE_PRESET_SEED_TEXT,
    promptText: "标准中文女声，清晰自然，通用对话，语速中等，咬字稳定，适合日常交流。",
    baseVoiceId: "default_female",
    fallbackGender: "female",
  },
  {
    voiceId: "story_gentle_female",
    name: "温柔女声（克隆）",
    provider: BUSINESS_VOICE_PROVIDER,
    modes: ["text"],
    description: "业务标准音色，温柔女声，走克隆兼容链路",
    referencePath: "/system/voice-presets/story_gentle_female.wav",
    referenceText: BUSINESS_VOICE_PRESET_SEED_TEXT,
    promptText: "温柔女声，治愈，柔和，语速稍慢，带轻微故事感，亲切自然。",
    baseVoiceId: "default_female",
    fallbackGender: "female",
  },
  {
    voiceId: "story_lively_female",
    name: "活泼女声（克隆）",
    provider: BUSINESS_VOICE_PROVIDER,
    modes: ["text"],
    description: "业务标准音色，活泼女声，走克隆兼容链路",
    referencePath: "/system/voice-presets/story_lively_female.wav",
    referenceText: BUSINESS_VOICE_PRESET_SEED_TEXT,
    promptText: "活泼女声，明亮有朝气，语速中等偏快，表达灵动，带轻快笑意。",
    baseVoiceId: "default_female",
    fallbackGender: "female",
  },
  {
    voiceId: "story_steady_male",
    name: "沉稳男声（克隆）",
    provider: BUSINESS_VOICE_PROVIDER,
    modes: ["text"],
    description: "业务标准音色，沉稳男声，走克隆兼容链路",
    referencePath: "/system/voice-presets/story_steady_male.wav",
    referenceText: BUSINESS_VOICE_PRESET_SEED_TEXT,
    promptText: "沉稳男声，成熟冷静，语速中等偏慢，咬字厚实，带一点纪录片旁白感。",
    baseVoiceId: "default_male",
    fallbackGender: "male",
  },
  {
    voiceId: "story_narrator",
    name: "讲述者音色（克隆）",
    provider: BUSINESS_VOICE_PROVIDER,
    modes: ["text"],
    description: "业务标准音色，讲述者旁白，走克隆兼容链路",
    referencePath: "/system/voice-presets/story_narrator.wav",
    referenceText: BUSINESS_VOICE_PRESET_SEED_TEXT,
    promptText: "讲述者音色，旁白感，娓娓道来，稳重清晰，语速中等，富有故事层次。",
    baseVoiceId: "default_female",
    fallbackGender: "female",
  },
];

const generationLocks = new Map<string, Promise<void>>();

function trimText(input?: string | null): string {
  return String(input || "").trim();
}

function normalizeText(input?: string | null): string {
  return trimText(input).replace(/\s+/g, "").toLowerCase();
}

async function resolveLocalCloneGateway(userId: number): Promise<{ baseUrl: string; headers: Record<string, string> }> {
  const row = await u.db("t_config")
    .where({ type: "voice", userId, manufacturer: "ai_voice_tts" })
    .orderBy("id", "desc")
    .first();
  const baseUrl = normalizeVoiceBaseUrl(String(row?.baseUrl || "http://127.0.0.1:8000"));
  const headers: Record<string, string> = {};
  const apiKey = trimText(row?.apiKey);
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return { baseUrl, headers };
}

async function downloadRemoteAudio(sourceUrl: string): Promise<Buffer> {
  const response = await axios.get(sourceUrl, {
    responseType: "arraybuffer",
    timeout: 120000,
  });
  return Buffer.from(response.data);
}

function presetBundledPath(preset: BusinessVoicePreset): string {
  return path.join(getVoicePresetSeedDir(), path.basename(preset.referencePath));
}

async function writeBundledPresetFile(preset: BusinessVoicePreset, buffer: Buffer): Promise<void> {
  const targetPath = presetBundledPath(preset);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, buffer);
}

async function generatePresetBufferWithLocalPromptVoice(userId: number, preset: BusinessVoicePreset): Promise<Buffer> {
  const { baseUrl, headers } = await resolveLocalCloneGateway(userId);
  const response = await axios.post(
    `${baseUrl}/v1/tts`,
    {
      text: preset.referenceText,
      suppliers: "local",
      mode: "prompt_voice",
      voice_id: preset.baseVoiceId,
      prompt_text: preset.promptText,
      format: "wav",
      use_cache: true,
    },
    { headers, timeout: 120000 },
  );
  const data = response.data || {};
  const audioUrl = trimText(data.audio_url_full)
    || (trimText(data.audio_url) ? `${baseUrl}${String(data.audio_url).startsWith("/") ? "" : "/"}${data.audio_url}` : "");
  if (!audioUrl) {
    throw new Error(`生成标准音色失败: ${preset.name}`);
  }
  return downloadRemoteAudio(audioUrl);
}

async function generatePresetBuffer(userId: number, preset: BusinessVoicePreset, strictDesignModel: boolean): Promise<Buffer> {
  const voiceDesignConfig = await getStoryVoiceDesignConfig(userId);
  if (voiceDesignConfig) {
    const designed = await synthesizeVoiceDesignBuffer({
      userId,
      config: voiceDesignConfig,
      promptText: preset.promptText,
      previewText: preset.referenceText,
      preferredName: preset.voiceId,
      format: "wav",
    });
    return designed.buffer;
  }
  if (strictDesignModel) {
    throw new Error("请先在设置里配置语音设计模型");
  }
  return generatePresetBufferWithLocalPromptVoice(userId, preset);
}

async function ensurePresetGenerated(userId: number, preset: BusinessVoicePreset): Promise<void> {
  if (await u.oss.fileExists(preset.referencePath)) return;
  const seededFileName = preset.referencePath.split("/").pop();
  if (seededFileName) {
    const copiedPath = await ensureBundledVoicePresetSeed(seededFileName);
    if (copiedPath && (await u.oss.fileExists(preset.referencePath))) return;
  }
  const lockKey = preset.voiceId;
  const pending = generationLocks.get(lockKey);
  if (pending) {
    await pending;
    return;
  }
  const task = (async () => {
    if (await u.oss.fileExists(preset.referencePath)) return;
    const buffer = await generatePresetBuffer(userId, preset, false);
    await u.oss.writeFile(preset.referencePath, buffer);
  })();
  generationLocks.set(lockKey, task);
  try {
    await task;
  } finally {
    generationLocks.delete(lockKey);
  }
}

export function getBusinessVoicePresets(): BusinessVoicePreset[] {
  return BUSINESS_VOICE_PRESETS.map((item) => ({ ...item }));
}

export function findBusinessVoicePreset(voiceId?: string | null): BusinessVoicePreset | null {
  const key = trimText(voiceId);
  if (!key) return null;
  return BUSINESS_VOICE_PRESETS.find((item) => item.voiceId === key) || null;
}

export async function ensureBusinessVoicePresets(userId: number): Promise<BusinessVoicePreset[]> {
  const list = getBusinessVoicePresets();
  for (const preset of list) {
    try {
      await ensurePresetGenerated(userId, preset);
    } catch (err) {
      console.warn(`[voice] ensure business preset failed: ${preset.voiceId}`, err instanceof Error ? err.message : String(err));
    }
  }
  return list;
}

export async function regenerateBusinessVoicePresetFiles(userId: number): Promise<BusinessVoicePreset[]> {
  const list = getBusinessVoicePresets();
  for (const preset of list) {
    const buffer = await generatePresetBuffer(userId, preset, true);
    await writeBundledPresetFile(preset, buffer);
    await u.oss.writeFile(preset.referencePath, buffer);
  }
  return list;
}

export function inferVoiceGenderHint(input?: string | null): "male" | "female" | null {
  const value = normalizeText(input);
  if (!value) return null;
  const femaleTokens = [
    "female",
    "defaultfemale",
    "aliyundefaultfemale",
    "xiaoxiao",
    "cherry",
    "serena",
    "chelsie",
    "longanhuan",
    "女",
    "欢",
    "御姐",
    "少女",
  ];
  const maleTokens = [
    "male",
    "defaultmale",
    "aliyundefaultmale",
    "yunxi",
    "ethan",
    "longanyang",
    "男",
    "阳",
    "青年男性",
  ];
  if (femaleTokens.some((token) => value.includes(normalizeText(token)))) return "female";
  if (maleTokens.some((token) => value.includes(normalizeText(token)))) return "male";
  return null;
}

export function fallbackBusinessVoiceId(gender: "male" | "female" | null): string | null {
  if (gender === "male") return "story_std_male";
  if (gender === "female") return "story_std_female";
  return null;
}

export function buildGeneratedReferencePath(seed: Record<string, unknown>): string {
  const hash = createHash("md5").update(JSON.stringify(seed)).digest("hex");
  return `/system/voice-presets/generated/${hash}.wav`;
}
