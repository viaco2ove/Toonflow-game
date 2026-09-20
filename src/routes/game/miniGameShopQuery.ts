/**
 * /game/miniGameShopQuery
 *
 * 商城小游戏轻量查询接口：
 *   - 玩家在面板里点"换一批" / 点类别 / 点"查看 XX 多少钱" 等场景
 *   - 直接调 AI 商城老板 prompt 拿到最新结果（narration / categories / items）
 *   - 不写消息、不触发 streamlines、不持久化 session 状态（这是"试穿间"，不是真买）
 *   - 不消耗编排资源，延迟 ~1-3s
 *
 * 区别于"用 addMessage 触发完整编排"：
 *   - addMessage 会落用户消息 → 触发 streamlines → 触发记忆整理 → 编排师 → 语音... 全套链路 5-15s
 *   - 本接口：一次 AI 调用，返回结果只刷前端面板 ~1-3s
 *
 * 真正的购买（confirm_purchase → 扣款/入背包）属于后续工作，目前本接口只负责"询价/换一批"。
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
    input: z.string().min(1).max(500),
  }),
  async (req, res) => {
    try {
      const currentUserId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(currentUserId) || currentUserId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }
      const sessionId = String(req.body?.sessionId || "").trim();
      const input = String(req.body?.input || "").trim();
      if (!sessionId || !input) {
        return res.status(400).send(error("sessionId / input 不能为空"));
      }

      // 只读 worldId 用于世界书注入；不读 session state
      const db = getGameDb();
      const row = await db("t_gameSession")
        .where({ sessionId, userId: currentUserId })
        .select("worldId", "sessionId")
        .first();
      if (!row) {
        return res.status(404).send(error("会话不存在"));
      }
      const worldId = Number(row.worldId || 0) || undefined;

      const result = await resolveShopIntent(input, currentUserId, worldId);
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
