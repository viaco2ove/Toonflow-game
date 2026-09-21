/**
 * /game/miniGameShopPurchase
 *
 * 商城小游戏轻量购买接口：
 *   - 玩家在面板点"购买"按钮触发
 *   - 不写消息、不触发 streamlines
 *   - confirm_purchase：直接扣款入背包，回写 session state
 *   - 其他 action（list_categories / show_items / free_chat）：纯 AI 查询，不动状态
 */
import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { resolveShopIntent } from "@/modules/game-runtime/services/MiniGameSellService";
import { getGameDb } from "@/lib/gameEngine";
import u from "@/utils";

const router = express.Router();

/** 从 session.stateJson 读取玩家当前金钱 */
function readPlayerMoney(sessionState: any): number {
  const root = sessionState || {};
  const player = root.player || root.playerRole || {};
  const card = player.parameterCardJson || player.parameter_card_json || {};
  return Number(card.money || 0);
}

/** 写入玩家金钱到 session.stateJson，返回新的金钱值 */
function writePlayerMoney(sessionState: any, newMoney: number): number {
  const root = sessionState as Record<string, any>;
  const player = root.player || root.playerRole || {};
  const card = (player.parameterCardJson || player.parameter_card_json || {}) as Record<string, any>;
  card.money = Math.max(0, newMoney);
  player.parameterCardJson = card;
  if (root.player) root.player = player;
  else root.playerRole = player;
  return card.money;
}

/** 从 session.stateJson 读取玩家背包 items */
function readPlayerItems(sessionState: any): string[] {
  const root = sessionState || {};
  const player = root.player || root.playerRole || {};
  const card = player.parameterCardJson || player.parameter_card_json || {};
  return Array.isArray(card.items) ? card.items.map((x: any) => String(x || "").trim()).filter(Boolean) : [];
}

/** 写入玩家背包 items 到 session.stateJson */
function writePlayerItems(sessionState: any, newItems: string[]): void {
  const root = sessionState as Record<string, any>;
  const player = root.player || root.playerRole || {};
  const card = (player.parameterCardJson || player.parameter_card_json || {}) as Record<string, any>;
  card.items = newItems;
  player.parameterCardJson = card;
  if (root.player) root.player = player;
  else root.playerRole = player;
}

export default router.post(
  "/",
  validateFields({
    sessionId: z.string(),
    itemName: z.string().min(1).max(200),
    itemCategory: z.string().max(50).optional(),
    expectedPrice: z.number().min(0).optional(),
  }),
  async (req, res) => {
    try {
      const currentUserId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(currentUserId) || currentUserId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }
      const sessionId = String(req.body?.sessionId || "").trim();
      const itemName = String(req.body?.itemName || "").trim();
      const itemCategory = String(req.body?.itemCategory || "").trim();
      const expectedPrice = Number(req.body?.expectedPrice || 0);
      if (!sessionId || !itemName) {
        return res.status(400).send(error("sessionId / itemName 不能为空"));
      }

      const db = getGameDb();
      const row = await db("t_gameSession")
        .where({ sessionId, userId: currentUserId })
        .select("sessionId", "stateJson")
        .first();
      if (!row) {
        return res.status(404).send(error("会话不存在"));
      }

      const sessionState = typeof row.stateJson === "string"
        ? JSON.parse(row.stateJson || "{}")
        : (row.stateJson || {});
      const worldId = Number(row.worldId || 0) || undefined;

      // 预读当前金钱和背包
      const currentMoney = readPlayerMoney(sessionState);
      const currentItems = readPlayerItems(sessionState);

      const priceHint = expectedPrice > 0 ? `（之前看到的报价 ${expectedPrice} 金）` : "";
      const categoryHint = itemCategory ? ` [${itemCategory}]` : "";
      const purchaseInput = `买${itemName}${categoryHint}${priceHint}`;

      const result = await resolveShopIntent(purchaseInput, currentUserId, worldId);
      if (!result) {
        return res.status(200).send(success({
          action: "free_chat",
          categories: [],
          items: [],
          narration: "商城老板没听到，请再说一次。",
        }));
      }

      // confirm_purchase：直接扣款入背包
      if (result.action === "confirm_purchase" && result.items && result.items.length > 0) {
        const purchasedItem = result.items[0];
        const price = purchasedItem.price || expectedPrice || 0;

        if (currentMoney < price) {
          // 钱不够，返回失败提示
          return res.status(200).send(success({
            action: "free_chat",
            categories: [],
            items: [],
            narration: `钱不够。这件要 ${price} 金，你只有 ${currentMoney} 金。`,
          }));
        }

        const newMoney = writePlayerMoney(sessionState, currentMoney - price);
        const newItems = [...currentItems, `${purchasedItem.name}（商城购入，${price} 金）`];
        writePlayerItems(sessionState, newItems);

        await db("t_gameSession").where({ sessionId }).update({
          stateJson: JSON.stringify(sessionState),
          updateTime: Math.floor(Date.now() / 1000),
        });

        return res.status(200).send(success({
          action: "purchased",
          categories: [],
          items: [],
          narration: result.narration
            || `已购入：${purchasedItem.name}，花了 ${price} 金，剩余 ${newMoney} 金。`,
        }));
      }

      // 其他 action（list_categories / show_items / free_chat）：纯查询，不动状态
      res.status(200).send(success({
        action: result.action,
        categories: result.categories,
        items: result.items,
        narration: result.narration,
      }));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
