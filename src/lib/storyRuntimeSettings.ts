import { db } from "@/utils/db";
import { getCurrentUserId } from "@/lib/requestContext";

export type StoryOrchestratorPayloadMode = "compact" | "advanced";

export interface StoryRuntimeSettings {
  storyOrchestratorPayloadMode: StoryOrchestratorPayloadMode;
}

const DEFAULT_STORY_RUNTIME_SETTINGS: StoryRuntimeSettings = {
  storyOrchestratorPayloadMode: "compact",
};

const STORY_RUNTIME_SETTINGS_KEY = "__storyRuntimeSettings";

function normalizePayloadMode(input: unknown): StoryOrchestratorPayloadMode {
  return String(input || "").trim().toLowerCase() === "advanced" ? "advanced" : "compact";
}

function normalizeUserId(userId?: number): number {
  const resolvedUserId = Number.isFinite(Number(userId)) && Number(userId) > 0 ? Number(userId) : getCurrentUserId(0);
  return Number.isFinite(resolvedUserId) && resolvedUserId > 0 ? resolvedUserId : 0;
}

export function parseStoryRuntimeSettingsBlob(input: unknown): StoryRuntimeSettings {
  let parsed: any = {};
  try {
    parsed = JSON.parse(String(input || "{}"));
  } catch {
    parsed = {};
  }
  const root = parsed && typeof parsed === "object" ? parsed : {};
  const settings = root[STORY_RUNTIME_SETTINGS_KEY] && typeof root[STORY_RUNTIME_SETTINGS_KEY] === "object"
    ? root[STORY_RUNTIME_SETTINGS_KEY]
    : {};
  return {
    storyOrchestratorPayloadMode: normalizePayloadMode(settings.storyOrchestratorPayloadMode),
  };
}

export function mergeStoryRuntimeSettingsBlob(input: unknown, patch: Partial<StoryRuntimeSettings>): string {
  let parsed: any = {};
  try {
    parsed = JSON.parse(String(input || "{}"));
  } catch {
    parsed = {};
  }
  const root = parsed && typeof parsed === "object" ? parsed : {};
  const current = parseStoryRuntimeSettingsBlob(input);
  root[STORY_RUNTIME_SETTINGS_KEY] = {
    storyOrchestratorPayloadMode: normalizePayloadMode(
      patch.storyOrchestratorPayloadMode ?? current.storyOrchestratorPayloadMode,
    ),
  };
  return JSON.stringify(root);
}

export async function getStoryRuntimeSettings(userId?: number): Promise<StoryRuntimeSettings> {
  const resolvedUserId = normalizeUserId(userId);
  if (!resolvedUserId) {
    return { ...DEFAULT_STORY_RUNTIME_SETTINGS };
  }
  const setting = await db("t_setting").where({ userId: resolvedUserId }).select("languageModel").first();
  return parseStoryRuntimeSettingsBlob(setting?.languageModel);
}

export async function saveStoryRuntimeSettings(
  patch: Partial<StoryRuntimeSettings>,
  userId?: number,
): Promise<StoryRuntimeSettings> {
  const resolvedUserId = normalizeUserId(userId);
  if (!resolvedUserId) {
    return { ...DEFAULT_STORY_RUNTIME_SETTINGS };
  }
  const setting = await db("t_setting").where({ userId: resolvedUserId }).first("id", "languageModel");
  const languageModel = mergeStoryRuntimeSettingsBlob(setting?.languageModel, patch);
  if (setting?.id) {
    await db("t_setting").where({ id: Number(setting.id) }).update({ languageModel });
  } else {
    const maxRow = await db("t_setting").max({ maxId: "id" }).first();
    const nextId = Number((maxRow as any)?.maxId || 0) + 1;
    await db("t_setting").insert({
      id: nextId,
      userId: resolvedUserId,
      tokenKey: "",
      imageModel: "{}",
      languageModel,
      projectId: null,
    });
  }
  return parseStoryRuntimeSettingsBlob(languageModel);
}
