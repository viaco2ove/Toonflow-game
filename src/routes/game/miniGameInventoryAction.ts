/**
 * /game/miniGameInventoryAction
 *
 * 背包小游戏轻量操作接口（卖出 / 整理）：
 *   - 玩家在面板里点 "卖出 1 个" 按钮 / 点 "整理物品" 按钮触发
 *   - 不落消息、不触发 streamlines，直接修改 session.player.parameterCardJson.items
 *   - 同时落 money（卖出加款）/ moneyDelta（整理不动钱）
 *   - 不调 AI
 */
import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { getGameDb } from "@/lib/gameEngine";
import { resolveSellIntent, consolidateInventoryWithAi, type InventoryItem } from "@/modules/game-runtime/services/MiniGameSellService";
import u from "@/utils";

const router = express.Router();

const actionSchema = z.union([
  z.object({
    type: z.literal("sell"),
    itemName: z.string().min(1).max(200),
    quantity: z.number().int().min(1).max(9999),
  }),
  z.object({
    type: z.literal("consolidate"),
  }),
]);

/** 从 session.stateJson 抠出玩家参数卡 items 列表 */
function readPlayerItems(sessionState: any): string[] {
  const root = (sessionState || {}) as Record<string, any>;
  // 兼容多种结构：state.player.parameterCardJson.items / state.playerRole.parameterCardJson.items
  const player = (root.player || root.playerRole || {}) as Record<string, any>;
  const card = (player.parameterCardJson || player.parameter_card_json || {}) as Record<string, any>;
  const items = Array.isArray(card.items) ? card.items : [];
  return items.map((x: any) => String(x || "").trim()).filter(Boolean);
}

function writePlayerItems(sessionState: any, newItems: string[]): void {
  const root = (sessionState || {}) as Record<string, any>;
  const player = (root.player || root.playerRole || {}) as Record<string, any>;
  const card = (player.parameterCardJson || player.parameter_card_json || {}) as Record<string, any>;
  card.items = newItems;
  player.parameterCardJson = card;
  if (root.player) root.player = player;
  else root.playerRole = player;
  // 回写（调用方会传引用，但保险起见也尝试写回 state 字段）
  if ("player" in root) {
    (root as any).player = player;
  } else if ("playerRole" in root) {
    (root as any).playerRole = player;
  }
}

function addPlayerMoney(sessionState: any, delta: number): number {
  const root = (sessionState || {}) as Record<string, any>;
  const player = (root.player || root.playerRole || {}) as Record<string, any>;
  const card = (player.parameterCardJson || player.parameter_card_json || {}) as Record<string, any>;
  const oldMoney = Number(card.money || 0);
  card.money = Math.max(0, oldMoney + delta);
  player.parameterCardJson = card;
  if (root.player) root.player = player;
  else root.playerRole = player;
  return card.money;
}

/**
 * 解析物品条目，支持四种形态：
 *   "银鲤×6"                          → { name:"银鲤", amount:6, suffix:"" }
 *   "银鲤×6（暂未售出，合计4800金）"    → { name:"银鲤", amount:6, suffix:"（暂未售出，合计4800金）" }
 *   "短刀（商城购入，8 金）"           → { name:"短刀", amount:1, suffix:"（商城购入，8 金）" }
 *   "短刀"                            → { name:"短刀", amount:1, suffix:"" }
 */
function parseItemName(raw: string): { name: string; amount: number; suffix: string } {
  const s = String(raw || "").trim();
  if (!s) return { name: "", amount: 0, suffix: "" };
  // 名称×N + 可选括号备注
  const m = s.match(/^(.+?)\s*[×x*]\s*(\d+)\s*([（(][^）)]*[)）])?\s*$/);
  if (m) return { name: m[1].trim(), amount: Number(m[2]), suffix: (m[3] || "").trim() };
  // 名称 + 括号备注（无 ×N）
  const m2 = s.match(/^(.+?)\s*([（(][^）)]*[)）])\s*$/);
  if (m2) return { name: m2[1].trim(), amount: 1, suffix: m2[2].trim() };
  return { name: s, amount: 1, suffix: "" };
}

/** 重组物品条目：名称 + 分隔符 + 数量 + 备注 */
function composeItemName(name: string, amount: number, suffix: string, sep = "×"): string {
  const base = amount > 1 ? `${name}${sep}${amount}` : name;
  return suffix ? `${base}${suffix}` : base;
}

export default router.post(
  "/",
  validateFields({
    sessionId: z.string(),
    action: actionSchema,
  }),
  async (req, res) => {
    try {
      const currentUserId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(currentUserId) || currentUserId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }
      const sessionId = String(req.body?.sessionId || "").trim();
      const action = req.body?.action as z.infer<typeof actionSchema>;
      if (!sessionId || !action) {
        return res.status(400).send(error("sessionId / action 不能为空"));
      }

      const db = getGameDb();
      const row = await db("t_gameSession")
        .where({ sessionId, userId: currentUserId })
        .select("sessionId", "stateJson")
        .first();
      if (!row) {
        return res.status(404).send(error("会话不存在"));
      }

      const sessionState = typeof row.stateJson === "string" ? JSON.parse(row.stateJson || "{}") : (row.stateJson || {});
      let items = readPlayerItems(sessionState);

      if (action.type === "sell") {
        const targetName = action.itemName;
        // 计算当前玩家持有的目标物品数量（用于上限保护）
        let totalHave = 0;
        for (const it of items) {
          const { name, amount } = parseItemName(it);
          if (name === targetName) totalHave += amount;
        }
        const targetAmount = totalHave;
        const quantity = Math.min(Math.max(1, action.quantity), Math.max(1, targetAmount));
        const actualSold = Math.min(quantity, targetAmount);
        // 逐条扣减：同一条物品里先扣；跨多条时依次扣
        let leftToSell = actualSold;
        const newItems: string[] = [];
        for (const it of items) {
          const parsed = parseItemName(it);
          if (leftToSell > 0 && parsed.name === targetName && parsed.amount > 0) {
            const take = Math.min(leftToSell, parsed.amount);
            const remaining = parsed.amount - take;
            leftToSell -= take;
            if (remaining > 0) {
              newItems.push(composeItemName(parsed.name, remaining, parsed.suffix));
            }
            // remaining === 0 → 整条删除（不 push）
          } else {
            newItems.push(it);
          }
        }
        items = newItems;
        // 让 AI 估价：传玩家当前真实背包（items 已扣减，含剩余数量）
        const inventory: InventoryItem[] = items.map((it: string) => {
          const { name, amount } = parseItemName(it);
          return { name, amount, kind: "other" as const };
        });
        const ai = await resolveSellIntent(`#卖出 ${targetName} ${actualSold}个`, inventory, currentUserId);
        const sellPrice = ai?.totalMoney || 1;
        const newMoney = addPlayerMoney(sessionState, sellPrice);
        writePlayerItems(sessionState, items);

        // 落库
        await db("t_gameSession").where({ sessionId }).update({
          stateJson: JSON.stringify(sessionState),
          updateTime: Math.floor(Date.now() / 1000),
        });

        return res.status(200).send(success({
          items,
          money: newMoney,
          sellPrice,
          narration: ai?.narration || `卖了 1 个 ${targetName}，到手 ${sellPrice} 金。`,
        }));
      }

      if (action.type === "consolidate") {
        // ★ 走 AI 整理：玩家的 items 有一条元素塞多个物品的脏数据（memory_manager 追加导致），
        //   纯字符串合并拆不开，交给 AI 拆串/合并同名/清理失效条目
        const worldRow = await db("t_gameSession")
          .where({ sessionId })
          .select("worldId")
          .first();
        const ai = await consolidateInventoryWithAi(
          items,
          currentUserId,
          Number(worldRow?.worldId || 0) || undefined,
        );
        if (!ai || !Array.isArray(ai.items)) {
          return res.status(200).send(error("物品整理失败，请稍后再试"));
        }
        items = ai.items;
        writePlayerItems(sessionState, items);

        await db("t_gameSession").where({ sessionId }).update({
          stateJson: JSON.stringify(sessionState),
          updateTime: Math.floor(Date.now() / 1000),
        });

        return res.status(200).send(success({
          items,
          money: Number(((sessionState as any).player?.parameterCardJson?.money) || 0),
          narration: ai.narration || `物品已整理：${items.join("、")}`,
        }));
      }

      return res.status(400).send(error("未知 action"));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);