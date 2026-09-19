import { z } from "zod";
import u from "@/utils";
import { DebugLogUtil } from "@/utils/debugLogUtil";
import { buildWorldKnowledgeText, normalizeWorldBookOutput } from "@/lib/gameEngine";
import { getPromptByCode } from "@/lib/promptHelper";
import { PROMPT_STORY_SELL_ITEM, PROMPT_STORY_MINI_GAME_SHOP } from "@/lib/def.prompts";
import { parseModelJsonObject } from "@/utils/ai/jsonParserUtils";

/** 从三种可能字段中提取物品显示名称，与 MiniGameController 的同步逻辑保持一致 */
function getItemDisplayName(item: InventoryItem): string {
  return String(item.name || (item as any).itemName || (item as any).title || "").trim();
}

export interface InventoryItem {
  name?: string;
  itemName?: string;
  title?: string;
  kind?: string;
  amount?: number;
  rarity?: string;
}

export interface SellItem {
  name: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

export interface SellIntentResult {
  sellItems: SellItem[];
  totalMoney: number;
  narration: string;
  tokenUsage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } | null;
  timing?: { buildMs?: number; invokeMs?: number; totalMs?: number } | null;
  requestPreview?: string;
  responsePreview?: string;
  _systemPrompt?: string;
}

/**
 * 商城意图解析结果：玩家输入 #打开商城 / 查看短刀多少钱 等指令时返回。
 *
 * 用途：
 * - 复用 sell-item prompt 的"系统商城"分支，避免再写一份并行 agent；
 * - 返回类别列表（categories）+ 单品价格（items）+ 询问语（narration），供前端渲染商城面板。
 */
export interface ShopIntentResult {
  action: "list_categories" | "show_items" | "confirm_purchase" | "free_chat";
  categories: Array<{ key: string; label: string; sampleItems?: string[] }>;
  items: Array<{ category: string; name: string; price: number; desc?: string }>;
  narration: string;
  tokenUsage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } | null;
  timing?: { buildMs?: number; invokeMs?: number; totalMs?: number } | null;
  requestPreview?: string;
  responsePreview?: string;
  _systemPrompt?: string;
}

const sellIntentSchema = {
  sell_items: z.array(z.object({
    item_name: z.string().describe("要出售的物品名称，精确匹配背包中的 name 字段"),
    quantity: z.number().min(1).describe("出售数量"),
    unit_price: z.number().min(0).describe("该物品的单价（金币）"),
    subtotal: z.number().min(0).describe("该物品小计（金币）"),
  })).describe("要出售的物品列表"),
  total_money: z.number().min(0).describe("本次出售获得的总金币"),
  narration: z.string().describe("交易旁白，语言风格契合游戏世界观，简洁自然，控制在50字以内"),
  reasoning: z.string().describe("推理过程：为什么这样匹配和计算"),
};

function buildSellIntentSchemaPrompt(): string {
  return `\n请按照以下 JSON Schema 格式返回结果:\n${JSON.stringify(
    z.toJSONSchema(z.object(sellIntentSchema)),
    null,
    2,
  )}\n只返回结果，不要将Schema返回。`;
}

/**
 * 获取卖出命令解析的模型配置。
 */
async function resolveSellModel(userId: number) {
  const primary = await u.getPromptAi("storyMiniGameModel", userId);
  if (String((primary as Record<string, unknown> | null)?.manufacturer || "").trim()) {
    return primary;
  }
  const eventProgressFallback = await u.getPromptAi("storyEventProgressModel", userId);
  if (String((eventProgressFallback as Record<string, unknown> | null)?.manufacturer || "").trim()) {
    return eventProgressFallback;
  }
  const orchestratorFallback = await u.getPromptAi("storyOrchestratorModel", userId);
  if (String((orchestratorFallback as Record<string, unknown> | null)?.manufacturer || "").trim()) {
    return orchestratorFallback;
  }
  throw new Error("物品出售解析对接的模型未配置");
}

/**
 * 读取物品出售解析的提示词。
 * 优先级：t_prompts.customValue > def.prompts.ts 默认值
 */
async function loadSellPrompt(): Promise<string> {
  return getPromptByCode("story-sell-item");
}

/** 商城小游戏专用提示词：t_prompts.customValue > def.prompts.ts 默认值 */
async function loadShopPrompt(): Promise<string> {
  return getPromptByCode("story-mini-game-shop");
}

/**
 * 定价规则表。
 * 用于生成提示词给 AI 参考。
 */
export const SELL_PRICING_RULES = {
  fish: { normal: 2, rare: 5, desc: "鱼：普通=2金，稀有=5金" },
  ore: { unit: 1, desc: "矿石：每个1金" },
  treasure: { price: 10, desc: "宝物：10金" },
  loot: { price: 3, desc: "战利品：3金" },
  pill: { price: 5, desc: "丹药：5金" },
  other: { price: 1, desc: "其他物品：1金" },
};

function buildSellPrompt(userInput: string, inventory: InventoryItem[]): string {
  const inventoryList = inventory.map((item, idx) => {
    const displayName = getItemDisplayName(item);
    const amount = item.amount || 1;
    const rarity = item.rarity || "normal";
    return `[${idx + 1}] ${displayName} | 种类: ${item.kind || "other"} | 数量: ${amount} | 稀有度: ${rarity}`;
  }).join("\n");

  const pricingDesc = Object.values(SELL_PRICING_RULES).map((r: any) => r.desc).join("\n");

  return `## 玩家背包（inventory）
${inventoryList || "(空)"}

## 玩家输入
"${userInput}"

## 定价规则
${pricingDesc}

## 任务
1. 根据玩家输入，从背包中匹配要出售的物品
2. 确定出售数量（不能超过背包中的实际数量）
3. 按定价规则计算总价
4. 生成简洁自然的交易旁白（50字以内）

## 匹配规则
- 如果玩家说"全部"，则出售背包中所有物品
- 如果玩家说"全部鱼"，则匹配所有种类为fish或名称含"鱼"的物品
- 如果玩家指定数量（如"3条"），但背包不足，只卖背包中有的数量
- 如果背包为空，返回空的 sell_items 和 0 总价`;
}

/**
 * 规范化卖出意图解析结果。
 */
function normalizeSellIntentResult(
  rawObject: Record<string, unknown> | null | undefined,
  inventory: InventoryItem[],
): SellIntentResult | null {
  const rawItems = Array.isArray(rawObject?.sell_items) ? rawObject.sell_items : [];

  // 构建物品名称到总数的映射（累加同名物品的数量）
  const inventoryAmountMap = new Map<string, number>();
  const inventoryNameMap = new Map<string, InventoryItem>();
  inventory.forEach((item) => {
    const name = getItemDisplayName(item);
    const amount = item.amount || 1;
    // 累加同名物品的数量
    inventoryAmountMap.set(name, (inventoryAmountMap.get(name) || 0) + amount);
    // 保存第一条记录作为参考
    if (!inventoryNameMap.has(name)) {
      inventoryNameMap.set(name, item);
    }
  });

  const sellItems: SellItem[] = [];
  for (const raw of rawItems) {
    const name = String(raw.item_name || "").trim();
    const quantity = Math.max(1, Number(raw.quantity || 1));
    const unitPrice = Math.max(0, Number(raw.unit_price || 0));
    const subtotal = Math.max(0, Number(raw.subtotal || 0));

    if (!name) continue;

    // 验证物品确实在背包中存在
    const actualAmount = inventoryAmountMap.get(name) || 0;
    if (actualAmount === 0) {
      if (DebugLogUtil.isDebugLogEnabled()) {
        console.log(`[SellService] 物品 ${name} 不在背包中，跳过`);
      }
      continue;
    }

    // 数量不能超过背包中的实际数量
    const actualQuantity = Math.min(quantity, actualAmount);

    sellItems.push({
      name,
      quantity: actualQuantity,
      unitPrice,
      subtotal: Math.min(subtotal, actualQuantity * unitPrice),
    });
  }

  const totalMoney = Math.max(0, Number(rawObject?.total_money || 0));
  const narration = String(rawObject?.narration || "交易完成。").trim();

  return {
    sellItems,
    totalMoney,
    narration,
  };
}

/**
 * 使用大模型解析卖出意图。
 *
 * @param userInput 玩家输入，如 "#卖出 青鱼"
 * @param inventory 玩家背包物品列表
 * @param userId 用户ID，用于获取模型配置
 */
export async function resolveSellIntent(
  userInput: string,
  inventory: InventoryItem[],
  userId: number,
  worldId?: number,
): Promise<SellIntentResult | null> {
  if (!String(userInput || "").trim()) return null;
  if (!Array.isArray(inventory)) return null;

  const startedAt = Date.now();
  try {
    const modelConfig = await resolveSellModel(userId);
    // 从数据库加载提示词，无配置时使用默认提示词
    const dbPrompt = await loadSellPrompt();
    // ★ 世界书注入
    let worldKnowledge = "";
    if (worldId) {
      try {
        const rows = await u.db("t_worldBook").where({ worldId }).select("*");
        const entries = normalizeWorldBookOutput(rows);
        worldKnowledge = buildWorldKnowledgeText(entries, userInput, 300, "mini_game_sell_intent");
      } catch (e) {
        console.warn("[mini_game_sell_intent] 世界书加载失败", e);
      }
    }
    // 提示词优先级：t_prompts.customValue > def.prompts.ts 默认值（"story-sell-item" 标签页可维护）
    const systemPrompt = (dbPrompt || PROMPT_STORY_SELL_ITEM || "你是一个物品收购商人，帮助玩家将背包中的物品出售换钱。语言风格：简洁自然，符合修仙/古风世界观。输出要求：只匹配背包中实际存在的物品，数量不能超过持有量。") + (worldKnowledge ? `

【世界知识】
${worldKnowledge}` : "");

    const userPrompt = buildSellPrompt(userInput, inventory);
    const schemaPrompt = buildSellIntentSchemaPrompt();

    const result = await u.ai.text.invoke(
      {
        usageType: "物品出售解析",
        usageRemark: "sell-command",
        usageMeta: { stage: "storyMiniGameModel" },
        plainTextOutput: true,
        messages: [
          { role: "system", content: systemPrompt + schemaPrompt },
          { role: "user", content: userPrompt },
        ],
        maxRetries: 0,
      },
      modelConfig as any,
    );

    const rawResponse = String((result as any)?.text || "").trim();
    if (!rawResponse) return null;

    const rawObject = parseModelJsonObject(rawResponse);
    if (!rawObject) {
      console.warn("[SellService] 无法解析响应为 JSON:", rawResponse.slice(0, 200));
    }

    // 提取 token usage
    const usage = (result as any)?.usage;
    let tokenUsage: { inputTokens: number; outputTokens: number; reasoningTokens: number } | null = null;
    if (usage && typeof usage === "object") {
      tokenUsage = {
        inputTokens: Number(usage.inputTokens || 0) || 0,
        outputTokens: Number(usage.outputTokens || 0) || 0,
        reasoningTokens: Number(usage.outputTokenDetails?.reasoningTokens || usage.reasoningTokens || 0) || 0,
      };
    }

    const invokeMs = Date.now() - startedAt;

    if (DebugLogUtil.isDebugLogEnabled()) {
      console.log("[SellService] 原始响应:", rawResponse);
    }

    const normalized = normalizeSellIntentResult(rawObject, inventory);
    if (DebugLogUtil.isDebugLogEnabled()) {
      console.log("[SellService] 解析结果:", normalized);
      console.log("[SellService] 耗时:", invokeMs, "ms");
    }

    if (normalized) {
      normalized.tokenUsage = tokenUsage;
      normalized.timing = { buildMs: 0, invokeMs, totalMs: invokeMs };
      normalized.requestPreview = userPrompt;
      normalized.responsePreview = rawResponse;
      normalized._systemPrompt = systemPrompt + schemaPrompt;
    }

    return normalized;
  } catch (err) {
    console.error("[SellService] 解析失败:", err);
    return null;
  }
}

const shopIntentSchema = {
  action: z.enum(["list_categories", "show_items", "confirm_purchase", "free_chat"]).describe(
    "意图类型：list_categories=浏览商城 show_items=查看价格 confirm_purchase=确认买入 free_chat=闲聊",
  ),
  categories: z.array(z.object({
    key: z.string().describe("类别 key，英文，例如 weapon / armor / pill / ore / material"),
    label: z.string().describe("类别中文标签，例如 武器 / 防具 / 丹药 / 矿石 / 材料"),
    sampleItems: z.array(z.string()).optional().describe("该类下的代表物品名（可选）"),
  })).default([]).describe("商城类别列表"),
  items: z.array(z.object({
    category: z.string().describe("所属类别 key"),
    name: z.string().describe("物品名"),
    price: z.number().min(0).describe("单价（金币）"),
    desc: z.string().optional().describe("物品简介（可选）"),
  })).default([]).describe("本次问询涉及的物品价格列表"),
  narration: z.string().describe("回复用户的旁白，自然语言，控制在 200 字以内；如果是#打开商城，应该列出售卖的类别和示例物品；如果是#查看短刀多少钱，应该给出短刀的价格信息"),
};

function buildShopIntentSchemaPrompt(): string {
  return `
请按照以下 JSON Schema 格式返回结果:
${JSON.stringify(
    z.toJSONSchema(z.object(shopIntentSchema)),
    null,
    2,
  )}
只返回结果，不要将Schema返回。`;
}

function normalizeShopIntentResult(rawObject: Record<string, unknown> | null | undefined): ShopIntentResult | null {
  if (!rawObject || typeof rawObject !== "object") return null;
  type ShopAction = "list_categories" | "show_items" | "confirm_purchase" | "free_chat";
  const VALID_ACTIONS: ShopAction[] = ["list_categories", "show_items", "confirm_purchase", "free_chat"];
  const rawAction = String((rawObject as any).action || "") as ShopAction;
  const action: ShopAction = VALID_ACTIONS.includes(rawAction) ? rawAction : "free_chat";
  const rawCats = Array.isArray((rawObject as any).categories) ? (rawObject as any).categories : [];
  const rawItems = Array.isArray((rawObject as any).items) ? (rawObject as any).items : [];
  const categories = rawCats.map((c: any) => ({
    key: String(c?.key || "").trim(),
    label: String(c?.label || "").trim(),
    sampleItems: Array.isArray(c?.sampleItems) ? c.sampleItems.map((s: any) => String(s || "").trim()).filter(Boolean) : undefined,
  })).filter((c: any) => c.key && c.label);
  const items = rawItems.map((it: any) => ({
    category: String(it?.category || "").trim(),
    name: String(it?.name || "").trim(),
    price: Number(it?.price || 0) || 0,
    desc: it?.desc ? String(it.desc).trim() : undefined,
  })).filter((it: any) => it.name);
  const narration = String((rawObject as any).narration || "").trim();
  return {
    action,
    categories,
    items,
    narration,
  };
}

/**
 * 解析玩家商城意图（#打开商城 / #查看短刀多少钱 / #查看武器类 等）。
 *
 * 复用 sell-item prompt 的"系统商城"分支；调用同款模型。
 */
export async function resolveShopIntent(
  userInput: string,
  userId: number,
  worldId?: number,
): Promise<ShopIntentResult | null> {
  if (!String(userInput || "").trim()) return null;
  const startedAt = Date.now();
  try {
    const modelConfig = await resolveSellModel(userId);
    const dbPrompt = await loadShopPrompt();
    let worldKnowledge = "";
    if (worldId) {
      try {
        const rows = await u.db("t_worldBook").where({ worldId }).select("*");
        const entries = normalizeWorldBookOutput(rows);
        worldKnowledge = buildWorldKnowledgeText(entries, userInput, 300, "mini_game_shop_intent");
      } catch (e) {
        console.warn("[mini_game_shop_intent] 世界书加载失败", e);
      }
    }
    const systemPrompt = (dbPrompt || PROMPT_STORY_MINI_GAME_SHOP || "你是一家世界里的系统商城老板，介绍商品、报价格、引导购买。") + (worldKnowledge ? `

【世界知识】
${worldKnowledge}` : "");
    const schemaPrompt = buildShopIntentSchemaPrompt();
    const userPrompt = `## 玩家输入
"${userInput}"

## 输出 action 对照
- 玩家想浏览/打开商城/闲聊开场 → action=list_categories，categories 填本世界观可购买的类别
- 玩家问具体物品价格 → action=show_items，items 填该物品的价格
- 玩家问某类物品清单 → action=show_items，categories+items 都填
- 玩家要买入 → action=confirm_purchase，items 填确认购买的商品和价格
- 其他闲聊 → action=free_chat，categories/items 留空`;
    const result = await u.ai.text.invoke(
      {
        usageType: "系统商城查询",
        usageRemark: "shop-command",
        usageMeta: { stage: "storyMiniGameModel" },
        plainTextOutput: true,
        messages: [
          { role: "system", content: systemPrompt + schemaPrompt },
          { role: "user", content: userPrompt },
        ],
        maxRetries: 0,
      },
      modelConfig as any,
    );
    const rawResponse = String((result as any)?.text || "").trim();
    if (!rawResponse) return null;
    const rawObject = parseModelJsonObject(rawResponse);
    const usage = (result as any)?.usage;
    let tokenUsage: { inputTokens: number; outputTokens: number; reasoningTokens: number } | null = null;
    if (usage && typeof usage === "object") {
      tokenUsage = {
        inputTokens: Number(usage.inputTokens || 0) || 0,
        outputTokens: Number(usage.outputTokens || 0) || 0,
        reasoningTokens: Number(usage.outputTokenDetails?.reasoningTokens || usage.reasoningTokens || 0) || 0,
      };
    }
    const invokeMs = Date.now() - startedAt;
    const normalized = normalizeShopIntentResult(rawObject);
    if (normalized) {
      normalized.tokenUsage = tokenUsage;
      normalized.timing = { buildMs: 0, invokeMs, totalMs: invokeMs };
      normalized.requestPreview = userPrompt;
      normalized.responsePreview = rawResponse;
      normalized._systemPrompt = systemPrompt + schemaPrompt;
    }
    return normalized;
  } catch (err) {
    console.error("[ShopService] 解析失败:", err);
    return null;
  }
}
