import { nowTs } from "@/lib/gameEngine";
import { DebugLogUtil } from "@/utils/debugLogUtil";

type JsonRecord = Record<string, any>;

function scalarText(input: unknown): string {
  return String(input ?? "").trim();
}

function asRecord(input: unknown): JsonRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  return input as JsonRecord;
}

function uniqueTexts(items: string[]): string[] {
  return Array.from(new Set(items.map((item) => scalarText(item)).filter(Boolean)));
}

/**
 * 判断一条用户输入是否显式要求“记忆管理”写回状态。
 * 这里只处理明确的 @记忆管理 指令，避免普通剧情文本被误写进参数卡。
 */
function extractMemoryDirectiveBody(messageContent: string): string {
  const raw = scalarText(messageContent);
  if (!raw) return "";
  const matched = raw.match(/^[＠@]\s*记忆管理\s*[:：]?\s*(.+)$/s);
  return scalarText(matched?.[1] || "");
}

/**
 * 从描述性句子里抽出更可能是“物品清单”的片段。
 * 例如“藏有炼炎决、灭魔尺...”应优先截取“藏有”后面的枚举部分。
 */
function extractInventoryClause(body: string): string {
  const normalized = scalarText(body);
  if (!normalized) return "";
  const keywords = ["藏有", "包括", "包含", "拥有", "获得", "收获", "得到", "展现", "展示", "里面有", "内部有", "有"];
  for (const keyword of keywords) {
    const index = normalized.lastIndexOf(keyword);
    if (index >= 0) {
      const tail = scalarText(normalized.slice(index + keyword.length));
      if (tail) return tail;
    }
  }
  return normalized;
}

/**
 * 清洗单个条目文本，剥掉叙述性前缀和无关尾缀，只保留适合进参数卡的名称。
 */
function normalizeDirectiveToken(token: string): string {
  return scalarText(token)
    .replace(/^[（(][^）)]*[）)]/g, "")
    .replace(/^(这枚|这些|这批|其中|还有|以及|并有|并且有|并且|并|和|与)/g, "")
    .replace(/^(空间波动|戒指内|戒指内部|内部空间|物品|东西)/g, "")
    .replace(/(展现在你眼前|出现在你眼前|摆在眼前|静置其中|等物品?)$/g, "")
    .replace(/[。；;]+$/g, "")
    .trim();
}

function splitDirectiveTokens(body: string): string[] {
  return extractInventoryClause(body)
    .split(/[，,、；;\n]/)
    .flatMap((item) => item.split(/(?:以及|还有|并有|并且有|并且|和|与)/))
    .map((item) => normalizeDirectiveToken(item))
    .filter(Boolean);
}

function isLikelySkill(token: string): boolean {
  return /(诀|决|功法|心法|身法|步|尺法|剑法|刀法|枪法|掌法|拳法|秘法|斗技|法诀|经)$/.test(token);
}

function isLikelyEquipment(token: string): boolean {
  return /(戒指|灭魔尺|尺|剑|刀|枪|弓|甲|盾|鼎|炉|鞭|锤|杖|斧|匕首|护腕|护符)$/.test(token);
}

function isLikelyItem(token: string): boolean {
  return /(^[一二三四五六七八九十百千万两\d]+(?:颗|枚|个|把|本|瓶|件|份|套))|丹|石|魔核|药|卷轴|卷|符|材料|矿石|晶核|药液|灵液|灵草|药草|果$/.test(token);
}

function buildDefaultPlayerParameterCard(state: JsonRecord): JsonRecord {
  const player = asRecord(state.player);
  const current = asRecord(player.parameterCardJson);
  return {
    name: scalarText(current.name || player.name || "用户") || "用户",
    raw_setting: scalarText(current.raw_setting || current.rawSetting),
    gender: scalarText(current.gender),
    age: Number.isFinite(Number(current.age)) ? Number(current.age) : null,
    level: Number.isFinite(Number(current.level)) ? Number(current.level) : 1,
    level_desc: scalarText(current.level_desc || current.levelDesc) || "初入此界",
    personality: scalarText(current.personality),
    appearance: scalarText(current.appearance),
    voice: scalarText(current.voice || player.voice),
    skills: Array.isArray(current.skills) ? current.skills.map((item: unknown) => scalarText(item)).filter(Boolean) : [],
    items: Array.isArray(current.items) ? current.items.map((item: unknown) => scalarText(item)).filter(Boolean) : [],
    equipment: Array.isArray(current.equipment) ? current.equipment.map((item: unknown) => scalarText(item)).filter(Boolean) : [],
    hp: Number.isFinite(Number(current.hp)) ? Number(current.hp) : 100,
    mp: Number.isFinite(Number(current.mp)) ? Number(current.mp) : 0,
    money: Number.isFinite(Number(current.money)) ? Number(current.money) : 0,
    other: Array.isArray(current.other) ? current.other.map((item: unknown) => scalarText(item)).filter(Boolean) : [],
  };
}

/**
 * 将显式记忆指令里的物资清单写回用户参数卡。
 * 这是确定性状态写回，不依赖记忆管理模型自由发挥。
 */
export function applyExplicitMemoryDirectiveToPlayerCard(state: JsonRecord, messageContent: string): {
  applied: boolean;
  body: string;
  addedSkills: string[];
  addedItems: string[];
  addedEquipment: string[];
  addedOther: string[];
} {
  const body = extractMemoryDirectiveBody(messageContent);
  if (!body) {
    return { applied: false, body: "", addedSkills: [], addedItems: [], addedEquipment: [], addedOther: [] };
  }
  const tokens = splitDirectiveTokens(body);
  if (!tokens.length) {
    const emptyResult = { applied: false, body, addedSkills: [], addedItems: [], addedEquipment: [], addedOther: [] };
    DebugLogUtil.logPlayerMemoryDirective("story:memory_directive:stats", {
      mode: "explicit",
      ...emptyResult,
    });
    return emptyResult;
  }

  const addedSkills: string[] = [];
  const addedItems: string[] = [];
  const addedEquipment: string[] = [];
  const addedOther: string[] = [];

  tokens.forEach((token) => {
    if (!token || token.length > 40) return;
    if (isLikelySkill(token)) {
      addedSkills.push(token);
      return;
    }
    if (isLikelyEquipment(token)) {
      addedEquipment.push(token);
      return;
    }
    if (isLikelyItem(token)) {
      addedItems.push(token);
      return;
    }
    if (!/(空间|波动|展现|眼前|开阔|内部)/.test(token)) {
      addedOther.push(token);
    }
  });

  const hasAnyAddition = addedSkills.length > 0 || addedItems.length > 0 || addedEquipment.length > 0 || addedOther.length > 0;
  if (!hasAnyAddition) {
    const emptyResult = { applied: false, body, addedSkills: [], addedItems: [], addedEquipment: [], addedOther: [] };
    DebugLogUtil.logPlayerMemoryDirective("story:memory_directive:stats", {
      mode: "explicit",
      ...emptyResult,
    });
    return emptyResult;
  }

  const player = asRecord(state.player);
  const nextCard = buildDefaultPlayerParameterCard(state);
  nextCard.skills = uniqueTexts([...nextCard.skills, ...addedSkills]);
  nextCard.items = uniqueTexts([...nextCard.items, ...addedItems]);
  nextCard.equipment = uniqueTexts([...nextCard.equipment, ...addedEquipment]);
  nextCard.other = uniqueTexts([...nextCard.other, ...addedOther]);
  player.parameterCardJson = nextCard;
  player.parameterCardUpdateTime = nowTs();
  state.player = player;

  const result = {
    applied: true,
    body,
    addedSkills: uniqueTexts(addedSkills),
    addedItems: uniqueTexts(addedItems),
    addedEquipment: uniqueTexts(addedEquipment),
    addedOther: uniqueTexts(addedOther),
  };
  DebugLogUtil.logPlayerMemoryDirective("story:memory_directive:stats", {
    mode: "explicit",
    ...result,
  });
  return result;
}
