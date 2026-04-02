import {
  getGameDb,
  nowTs,
  parseJsonSafe,
  toJsonText,
} from "@/lib/gameEngine";
import u from "@/utils";

type JsonRecord = Record<string, any>;

function normalizeText(input: unknown): string {
  const text = String(input ?? "").trim();
  if (!text || text === "null" || text === "undefined") return "";
  return text;
}

function asRecord(input: unknown): JsonRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  return { ...(input as JsonRecord) };
}

function normalizeList(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.map((item) => normalizeText(item)).filter(Boolean).slice(0, 24);
  }
  return String(input || "")
    .split(/\r?\n|[；;、,，]/)
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .slice(0, 24);
}

function unwrapModelText(input: unknown): string {
  const text = normalizeText(input);
  if (!text) return "";
  return text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function parseFieldMap(rawText: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = unwrapModelText(rawText)
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^([a-zA-Z0-9_]+)\s*[:：]\s*(.+)$/);
    if (!match) continue;
    fields[String(match[1] || "").trim().toLowerCase()] = String(match[2] || "").trim();
  }
  return fields;
}

function parseBestEffortJson(rawText: string): JsonRecord {
  const text = unwrapModelText(rawText);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return asRecord(parsed);
  } catch {
    return {};
  }
}

function numberOrNull(input: unknown): number | null {
  const text = normalizeText(input);
  if (!text) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return Math.floor(value);
}

function normalizeParameterCard(input: unknown, fallback: {
  name: string;
  description: string;
  voice: string;
}): JsonRecord {
  const source = asRecord(input);
  const fieldMap = parseFieldMap(typeof input === "string" ? input : "");

  const read = (...keys: string[]) => {
    for (const key of keys) {
      const value = normalizeText(source[key]);
      if (value) return value;
      const mapped = normalizeText(fieldMap[key.toLowerCase()]);
      if (mapped) return mapped;
    }
    return "";
  };

  const age = numberOrNull(source.age ?? fieldMap["age"]);
  const level = numberOrNull(source.level ?? fieldMap["level"]);
  const hp = numberOrNull(source.hp ?? fieldMap["hp"]);
  const mp = numberOrNull(source.mp ?? fieldMap["mp"]);
  const money = numberOrNull(source.money ?? fieldMap["money"]);

  return {
    name: read("name") || fallback.name,
    raw_setting: read("raw_setting", "rawSetting") || fallback.description,
    gender: read("gender"),
    age,
    level: level ?? 1,
    level_desc: read("level_desc", "levelDesc") || "初入此界",
    personality: read("personality"),
    appearance: read("appearance"),
    voice: read("voice") || fallback.voice,
    skills: normalizeList(source.skills ?? fieldMap["skills"]),
    items: normalizeList(source.items ?? fieldMap["items"]),
    equipment: normalizeList(source.equipment ?? fieldMap["equipment"]),
    hp: hp ?? 100,
    mp: mp ?? 0,
    money: money ?? 0,
    other: normalizeList(source.other ?? fieldMap["other"]),
  };
}

function hasUsableParameterCard(input: unknown): boolean {
  const card = asRecord(input);
  if (!Object.keys(card).length) return false;
  return Object.values(card).some((value) => {
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "number") return Number.isFinite(value);
    return Boolean(normalizeText(value));
  });
}

function parseSettingsWithRoles(input: unknown): JsonRecord {
  const settings = parseJsonSafe<JsonRecord>(input, {});
  const roles = Array.isArray(settings.roles) ? settings.roles : [];
  return {
    ...settings,
    roles,
  };
}

async function resolveRoleCardModel(userId: number) {
  const primary = await u.getPromptAi("storyMemoryModel", userId);
  if (normalizeText((primary as JsonRecord)?.manufacturer)) {
    return primary;
  }
  const fallback = await u.getPromptAi("storyOrchestratorModel", userId);
  if (normalizeText((fallback as JsonRecord)?.manufacturer)) {
    return fallback;
  }
  return {};
}

async function generateRoleParameterCardWithAi(input: {
  userId: number;
  worldName: string;
  worldIntro: string;
  role: JsonRecord;
}): Promise<JsonRecord | null> {
  const config = await resolveRoleCardModel(input.userId);
  if (!normalizeText((config as JsonRecord)?.manufacturer)) {
    return null;
  }
  const role = asRecord(input.role);
  const roleName = normalizeText(role.name);
  const roleDesc = normalizeText(role.description);
  const roleVoice = normalizeText(role.voice);
  const roleType = normalizeText(role.roleType) || "npc";
  if (!roleName && !roleDesc) {
    return null;
  }

  const systemPrompt = [
    "你是故事角色参数卡生成器。",
    "你的任务是根据角色设定，生成用于故事编辑保存的静态角色参数卡。",
    "只输出 JSON，不要解释，不要代码块。",
    "字段固定为：name, raw_setting, gender, age, level, level_desc, personality, appearance, voice, skills, items, equipment, hp, mp, money, other。",
    "如果信息不足，字符串填空串，列表填空数组，数值用合理默认值。",
    "这是静态设定卡，不要写剧情正文，不要写当前对话进度。",
  ].join("\n");

  const userPrompt = JSON.stringify(
    {
      world: {
        name: input.worldName,
        intro: input.worldIntro,
      },
      role: {
        id: normalizeText(role.id),
        name: roleName,
        roleType,
        description: roleDesc,
        voice: roleVoice,
        sample: normalizeText(role.sample),
      },
      outputRules: {
        keepStaticOnly: true,
        language: "zh-CN",
      },
    },
    null,
    2,
  );

  try {
    const result = await u.ai.text.invoke(
      {
        plainTextOutput: true,
        usageType: "角色参数卡",
        usageRemark: `${input.worldName || "未知世界"} / ${roleName || "未命名角色"}`,
        usageMeta: {
          stage: "roleParameterCard",
          roleType,
        },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        maxRetries: 0,
      },
      config as any,
    );
    const rawText = unwrapModelText((result as any)?.text || "");
    const parsed = parseBestEffortJson(rawText);
    const card = normalizeParameterCard(Object.keys(parsed).length ? parsed : rawText, {
      name: roleName,
      description: roleDesc,
      voice: roleVoice,
    });
    return card;
  } catch (err) {
    console.warn("[role:param-card] ai failed", {
      role: roleName,
      roleType,
      manufacturer: (config as JsonRecord)?.manufacturer || "",
      model: (config as JsonRecord)?.model || "",
      message: (err as any)?.message || String(err),
    });
    return null;
  }
}

async function enrichRole(userId: number, worldName: string, worldIntro: string, role: unknown): Promise<JsonRecord> {
  const raw = asRecord(role);
  if (!Object.keys(raw).length) return raw;
  const generated = await generateRoleParameterCardWithAi({
    userId,
    worldName,
    worldIntro,
    role: raw,
  });
  if (!generated) return raw;
  return {
    ...raw,
    parameterCardJson: generated,
  };
}

export async function enrichWorldRolesWithAiParameterCards(input: {
  userId: number;
  worldName: string;
  worldIntro: string;
  playerRole: unknown;
  narratorRole: unknown;
  settings: unknown;
}): Promise<{
  playerRole: JsonRecord;
  narratorRole: JsonRecord;
  settings: JsonRecord;
}> {
  const rawSettings = asRecord(input.settings);
  const rawRoles = Array.isArray(rawSettings.roles) ? rawSettings.roles : [];
  const nextPlayerRole = hasUsableParameterCard(asRecord(input.playerRole)?.parameterCardJson)
    ? asRecord(input.playerRole)
    : await enrichRole(input.userId, input.worldName, input.worldIntro, input.playerRole);
  const nextNarratorRole = hasUsableParameterCard(asRecord(input.narratorRole)?.parameterCardJson)
    ? asRecord(input.narratorRole)
    : await enrichRole(input.userId, input.worldName, input.worldIntro, input.narratorRole);
  const nextNpcRoles = await Promise.all(
    rawRoles.map((role) => {
      const rawRole = asRecord(role);
      if (hasUsableParameterCard(rawRole.parameterCardJson)) {
        return rawRole;
      }
      return enrichRole(input.userId, input.worldName, input.worldIntro, rawRole);
    }),
  );

  return {
    playerRole: nextPlayerRole,
    narratorRole: nextNarratorRole,
    settings: {
      ...rawSettings,
      roles: nextNpcRoles,
    },
  };
}

export async function ensureWorldRolesWithAiParameterCards(input: {
  userId: number;
  world: unknown;
  persist?: boolean;
}): Promise<JsonRecord> {
  const world = asRecord(input.world);
  if (!Object.keys(world).length) return world;

  const settings = parseSettingsWithRoles(world.settings);
  const roles = Array.isArray(settings.roles) ? settings.roles : [];
  const needsCards = [
    world.playerRole,
    world.narratorRole,
    ...roles,
  ].some((role) => {
    const rawRole = asRecord(role);
    return !hasUsableParameterCard(rawRole.parameterCardJson);
  });

  if (!needsCards) {
    return {
      ...world,
      settings,
    };
  }

  const enriched = await enrichWorldRolesWithAiParameterCards({
    userId: Number(input.userId || 0),
    worldName: normalizeText(world.name),
    worldIntro: normalizeText(world.intro),
    playerRole: world.playerRole,
    narratorRole: world.narratorRole,
    settings,
  });

  const nextSettings = {
    ...settings,
    ...asRecord(enriched.settings),
    roles: Array.isArray(asRecord(enriched.settings).roles) ? asRecord(enriched.settings).roles : [],
  };

  const nextWorld: JsonRecord = {
    ...world,
    playerRole: enriched.playerRole,
    narratorRole: enriched.narratorRole,
    settings: nextSettings,
  };

  if (input.persist && Number(world.id || 0) > 0) {
    await getGameDb()("t_storyWorld")
      .where({ id: Number(world.id) })
      .update({
        playerRole: toJsonText(enriched.playerRole, {}),
        narratorRole: toJsonText(enriched.narratorRole, {}),
        settings: toJsonText(nextSettings, {}),
        updateTime: nowTs(),
      });
  }

  return nextWorld;
}
