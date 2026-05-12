import { z } from "zod";
import { parse } from "best-effort-json-parser";
import u from "@/utils";
import { DebugLogUtil } from "@/utils/debugLogUtil";

export interface InventoryItem {
  name: string;
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
 * 读取物品出售解析的提示词（从数据库）。
 */
async function loadSellPrompt(): Promise<string> {
  const row = await u.db("t_prompts")
    .where("code", "story-sell-item")
    .first("defaultValue", "customValue");
  return String(row?.customValue || row?.defaultValue || "").trim();
}

/**
 * 默认的物品出售解析提示词（数据库无配置时使用）。
 */
const DEFAULT_SELL_SYSTEM_PROMPT = `你是一个物品收购商人，帮助玩家将背包中的物品出售换钱。
语言风格：简洁自然，符合修仙/古风世界观。
输出要求：只匹配背包中实际存在的物品，数量不能超过持有量。`;

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
    const amount = item.amount || 1;
    const rarity = item.rarity || "normal";
    return `[${idx + 1}] ${item.name} | 种类: ${item.kind || "other"} | 数量: ${amount} | 稀有度: ${rarity}`;
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
    const name = item.name;
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
): Promise<SellIntentResult | null> {
  if (!String(userInput || "").trim()) return null;
  if (!Array.isArray(inventory)) return null;

  const startedAt = Date.now();
  try {
    const modelConfig = await resolveSellModel(userId);
    // 从数据库加载提示词，无配置时使用默认提示词
    const dbPrompt = await loadSellPrompt();
    const systemPrompt = dbPrompt || DEFAULT_SELL_SYSTEM_PROMPT;

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

    const parsedObject = rawResponse ? parse(rawResponse) : null;
    const rawObject = parsedObject && typeof parsedObject === "object"
      ? (parsedObject as Record<string, unknown>)
      : null;

    if (DebugLogUtil.isDebugLogEnabled()) {
      console.log("[SellService] 原始响应:", rawResponse);
    }

    const normalized = normalizeSellIntentResult(rawObject, inventory);
    if (DebugLogUtil.isDebugLogEnabled()) {
      console.log("[SellService] 解析结果:", normalized);
      console.log("[SellService] 耗时:", Date.now() - startedAt, "ms");
    }

    return normalized;
  } catch (err) {
    console.error("[SellService] 解析失败:", err);
    return null;
  }
}