import {
  getGameDb,
  nowTs,
  parseJsonSafe,
  toJsonText,
} from "@/lib/gameEngine";
import u from "@/utils";
import {DebugLogUtil} from "@/utils/debugLogUtil";

type JsonRecord = Record<string, any>;

function normalizeText(input: unknown): string {
  const text = String(input ?? "").trim();
  if (!text || text === "null" || text === "undefined") return "";
  return text;
}

function asRecord(input: unknown): JsonRecord {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ...(parsed as JsonRecord) };
      }
    } catch { /* not valid JSON */ }
    return {};
  }
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

  /**
   * 严谨检测：必须完整匹配 "角色类型:万能角色" 或 "角色类型:系统角色"
   * 防止 description 里误包含 "万能角色" / "系统角色" 关键词导致误判。
   * 只在原始输入是字符串时才用于检测（避免 normalizeText(object) 变成 "[object]"）。
   */
  const rawSettingFallback = normalizeText(
    source.raw_setting || fieldMap["raw_setting"] || fieldMap["rawsetting"] || "",
  );
  const rawDescText = typeof input === "string" ? input : "";
  const combinedText = rawDescText + "\n" + rawSettingFallback;

  let roleType = normalizeText(source.role_type || fieldMap["role_type"] || fieldMap["roletype"] || "");
  if (!roleType) {
    if (/角色类型\s*[:：]\s*万能角色/i.test(combinedText)) {
      roleType = "general";
    } else if (/角色类型\s*[:：]\s*系统角色/i.test(combinedText)) {
      roleType = "system";
    }
  }
  // 兜底：合法枚举值
  if (!["npc", "narrator", "player", "system", "general"].includes(roleType)) {
    roleType = "npc";
  }

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
    roleType,
    // information 关键信息：记录角色身份备注、编排限制、发现限制等，由记忆管理器维护
    information: normalizeText(source.information ?? fieldMap["information"] ?? fieldMap["info"] ?? ""),
  };
}

/**
 * 是否有可用的角色参数卡
 * @param input
 */
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
  worldGlobalBackground: string;
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
  /**
   * `role_type`：角色类型，如 `npc` / `narrator` / `player` / `system` /`general`
   *  也就是 `一般角色`/`旁白`/`用户`/`系统角色`/`万能角色`
   *  默认为 `npc`
   *  在角色设定提取到“角色类型:万能角色”时，会自动填充为 `general`
   *  在角色设定提取到“角色类型:系统角色”时，会自动填充为 `system`
   *  用户和旁白是特殊角色。不是角色设定中可配置的。为前端代码限定。
   */
  const roleType = normalizeText(role.roleType) || "npc";
  if (!roleName && !roleDesc) {
    return null;
  }

  const systemPrompt = [
    "你是故事角色参数卡生成器。",
    "你的任务是根据角色设定，生成用于故事编辑保存的静态角色参数卡。",
    "只输出 JSON，不要解释，不要代码块。",
    "字段固定为：name, raw_setting, gender, age, level, level_desc, personality, appearance, voice, skills, items, equipment, hp, mp, money, other, role_type, information。",
    "role_type 角色类型，枚举值：npc / narrator / player / system / general。",
    "  - 普通 NPC 用 npc",
    "  - 旁白用 narrator",
    "  - 用户角色用 player",
    "  - 万能角色（可扮演任意角色）用 general。 例如路人甲，某女子，某男子",
    "  - 系统角色（引导、自动播报等）用 system",
    "  用户和旁白是特殊角色，前端代码限定角色类型，不在角色设定中配置角色类型。" +
    "  注意用户依然走ai 分析角色参数卡！只是角色类型这个字段将会由程序自动填充。",
    "  如果设定中未明确说明角色类型，默认为 npc。",
    "如果信息不足，字符串填空串，列表填空数组，数值用合理默认值。",
    "这是静态设定卡，不要写剧情正文，不要写当前对话进度。",
  ].join("\n");

  const userPrompt = JSON.stringify(
    {
      world: {
        name: input.worldName,
        worldGlobalBackground: input.worldGlobalBackground,
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
    if (DebugLogUtil.isDebugLogEnabled()) {
      console.log("[DEBUG] 角色参数卡", JSON.stringify(rawText));
    }
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
    // 余额不足或外部模型失败时，直接退回基于静态描述的本地参数卡，避免每次进入故事都重复打失败请求。
    return normalizeParameterCard({}, {
      name: roleName,
      description: roleDesc,
      voice: roleVoice,
    });
  }
}

async function enrichRole(userId: number, worldName: string, worldGlobalBackground: string, role: unknown,forceRefresh: boolean= false): Promise<JsonRecord> {
  // role 可能是 JSON string（从 DB 读出的 playerRole），需要先 parse
  const raw = typeof role === "string" ? parseJsonSafe<JsonRecord>(role, {}) : asRecord(role);
  if (!Object.keys(raw).length && !forceRefresh) {
    return raw;
  }
  const generateRole = await generateRoleParameterCardWithAi({
    userId,
    worldName,
    worldGlobalBackground,
    role: raw,
  });
  if (!generateRole) return raw;
  // raw 是页面配置角色信息,主要是用于回填
  // parameterCardJson 是角色卡信息. 只要是用于生成游玩时的初始角色卡信息
  // parameterCardJson 只是用于生成动态数据。而不是动态数据自身
  if(!checkSpecRoleType(raw.roleType)){
    raw.roleType = generateRole.roleType;
  }
  const enrichedRole = {
    ...raw,
    parameterCardJson: generateRole,
  };
  if (DebugLogUtil.isDebugLogEnabled()) {
    console.log("[DEBUG] 角色参数卡 enrichedRole:", JSON.stringify(enrichedRole));
  }
  return enrichedRole;
}

function checkSpecRoleType(roleType:string){
  if(roleType==="player"|| roleType==="narrator"){
    return true;
  }
  return false;
}

/**
 * 构建一个角色参数卡 enricher，可选是否强制刷新
 * @param forceRefresh
 */
function buildEnrichRoleChecker(forceRefresh: boolean) {
  return async function enrichRoleIfNeeded(
    userId: number,
    worldName: string,
    worldGlobalBackground: string,
    role: unknown,
  ): Promise<JsonRecord> {
    if (!forceRefresh) {
      const raw = typeof role === "string" ? parseJsonSafe<JsonRecord>(role, {}) : asRecord(role);
      if(raw.roleType==="player"|| raw.roleType==="narrator"){
        // 玩家角色和旁白角色 没有parameterCardJson，raw 就是parameterCardJson
        if(hasUsableParameterCard(raw)){
          return raw;
        }
      }
      if (hasUsableParameterCard(raw.parameterCardJson)) {
        return raw;
      }
    }
    return enrichRole(userId, worldName, worldGlobalBackground, role,forceRefresh);
  };
}

export async function enrichWorldRolesWithAiParameterCards(input: {
  userId: number;
  worldName: string;
  worldGlobalBackground: string;
  playerRole: unknown;
  narratorRole: unknown;
  settings: unknown;
  /** 是否强制重新生成参数卡（用于角色编辑后发布场景） */
  forceRefresh?: boolean;
}): Promise<{
  playerRole: JsonRecord;
  narratorRole: JsonRecord;
  settings: JsonRecord;
}> {
  const forceRefresh = input.forceRefresh ?? false;
  const checkRole = buildEnrichRoleChecker(forceRefresh);

  const rawSettings = asRecord(input.settings);
  const rawRoles = Array.isArray(rawSettings.roles) ? rawSettings.roles : [];

  const [nextPlayerRole, nextNarratorRole, ...nextNpcRolesResults] = await Promise.all([
    checkRole(input.userId, input.worldName, input.worldGlobalBackground, input.playerRole),
    checkRole(input.userId, input.worldName, input.worldGlobalBackground, input.narratorRole),
    ...rawRoles.map((role) =>
      checkRole(input.userId, input.worldName, input.worldGlobalBackground, role),
    ),
  ]);

  const nextNpcRoles = nextNpcRolesResults as JsonRecord[];

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
  /** 是否强制重新生成参数卡（用于角色编辑后发布场景） */
  forceRefresh?: boolean;
}): Promise<JsonRecord> {
  const world = asRecord(input.world);
  if (!Object.keys(world).length) return world;
  const forceRefresh = input.forceRefresh ?? false;

  const settings = parseSettingsWithRoles(world.settings);
  const roles = Array.isArray(settings.roles) ? settings.roles : [];

  // 强制刷新时跳过"已有卡"的检查，直接全部重生成
  if (!forceRefresh) {
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
  }

  // world 可能是原始数据库行，settings 可能是字符串
  const w = (world || {}) as Record<string, any>;
  const wSettings = typeof w.settings === "string" ? parseJsonSafe(w.settings, {}) : (w.settings || {});
  const enriched = await enrichWorldRolesWithAiParameterCards({
    userId: Number(input.userId || 0),
    worldName: normalizeText(w.name),
    worldGlobalBackground: normalizeText(wSettings.globalBackground || w.globalBackground || w.intro),
    playerRole: world.playerRole,
    narratorRole: world.narratorRole,
    settings,
    forceRefresh,
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
