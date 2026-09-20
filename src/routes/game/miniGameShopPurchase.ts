/**
 * /game/miniGameShopPurchase
 *
 * 商城小游戏轻量购买接口：
 *   - 玩家在面板点"购买"按钮触发
 *   - 直接调 AI 商城老板 prompt 拿到 confirm_purchase 响应（narration + items）
 *   - 不写消息、不触发 streamlines、不持久化 session 状态
 *   - 真正的"扣款/入背包"目前仅返回 AI 确认，落地逻辑后续接入游戏运行时 writeback
 *
 * 区别于 addMessage 路径：
 *   - addMessage 落用户消息 → 触发 streamlines 编排 → 记忆整理 → 语音... 全套链路 5-15s
 *   - 本接口：单次 AI 调用，返回结果只刷前端面板 ~1-3s
 */
import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { resolveShopIntent } from "@/modules/game-runtime/services/MiniGameSellService";
import { getGameDb } from "@/lib/gameEngine";
import u from "@/utils";

const router = express.Router();

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
        .select("worldId", "sessionId")
        .first();
      if (!row) {
        return res.status(404).send(error("会话不存在"));
      }
      const worldId = Number(row.worldId || 0) || undefined;

      // 给 AI 一个明确购买意图的输入，让它返回 confirm_purchase action
      const priceHint = expectedPrice > 0 ? `（之前看到的报价 ${expectedPrice} 金）` : "";
      const categoryHint = itemCategory ? ` [${itemCategory}]` : "";
      const purchaseInput = `买一把 ${itemName}${categoryHint}${priceHint}`;

      const result = await resolveShopIntent(purchaseInput, currentUserId, worldId);
      if (!result) {
        return res.status(200).send(success({
          action: "free_chat",
          categories: [],
          items: [],
          narration: "商城老板没听到，请再说一次。",
        }));
      }

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
