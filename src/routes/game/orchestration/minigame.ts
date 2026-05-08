import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  orchestrateSessionTurn,
  isSessionServiceError,
} from "@/modules/game-runtime/services/SessionService";
import { DebugLogUtil } from "@/utils/debugLogUtil";

const router = express.Router();

/**
 * 小游戏编排专用接口。
 *
 * 用途：
 * - 战斗/陪练等小游戏回合的编排走这个独立接口，不走 /game/orchestration；
 * - 返回完整的 plan（含 eventType、presetContent 等），确保前端 streamlines 能正确消费；
 * - 前端每条消息串行：编排 → streamlines → 语音播放 → 编排，避免链式中断语音。
 *
 * 流程：编排agent(/game/orchestration/minigame) → 发言agent(/game/streamlines) → 语音预热(/game/streamvoice) → 语音播放(/voice/audioProxy)
 *
 * 其他信息只能通过 storyInfo 接口返回!!!!
 * 接口返回
 * {"code": 200, "data": {"role": "旁白","roleType": "narrator","motive": "介绍空间戒指当前的具体存储物品情况"}
 * ,"message": "成功"} data 只允许返回 谁说法，动机是什么.
 * 不允许返回任何其他信息！！！ 这不是大杂烩接口！！！！
 */
export default router.post(
  "/",
  validateFields({
    sessionId: z.string().min(1),
  }),
  async (req, res) => {
    const sessionId = String(req.body.sessionId || "").trim();
    if (!sessionId) {
      return res.status(400).send(error("sessionId 不能为空"));
    }
    try {
      const result = await orchestrateSessionTurn(sessionId);

      if (DebugLogUtil.isDebugLogEnabled()) {
        console.log("[story:orchestrator:minigame] 编排结果", JSON.stringify({
          sessionId,
          planRole: String(result.plan?.role || ""),
          planRoleType: String(result.plan?.roleType || ""),
          planEventType: String(result.plan?.eventType || ""),
          planAwaitUser: Boolean(result.plan?.awaitUser),
          planPresetContentLength: String(result.plan?.presetContent || "").length,
        }));
      }

      // 小游戏编排接口只返回角色和动机，符合前端消费规范。
      // 其他信息（sessionId/status/chapterId 等）通过 storyInfo 接口获取。
      return res.status(200).send(success({
        role: result.plan?.role || "",
        roleType: result.plan?.roleType || "",
        motive: result.plan?.motive || "",
        eventType: result.plan?.eventType || "",
      }));
    } catch (err) {
      if (isSessionServiceError(err)) {
        return res.status(err.status).send(error(err.message));
      }
      res.status(500).send(error(String((err as Error)?.message || "小游戏编排失败")));
    }
  },
);
