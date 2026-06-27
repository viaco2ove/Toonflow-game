import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { getGameDb, toJsonText } from "@/lib/gameEngine";
import { buildSessionMessageRevisitData, readSessionMessageRevisitData } from "@/modules/game-runtime/services/SessionService";
import { DebugLogUtil } from "@/utils/debugLogUtil";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    sessionId: z.string(),
    messageId: z.number(),
  }),
  async (req, res) => {
    try {
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }

      const sessionId = String(req.body.sessionId || "").trim();
      const messageId = Number(req.body.messageId || 0);
      if (!sessionId || !Number.isFinite(messageId) || messageId <= 0) {
        return res.status(400).send(error("参数不完整"));
      }

      const db = getGameDb();
      const session = await db("t_gameSession").where({ sessionId, userId }).first();
      if (!session) {
        return res.status(404).send(error("会话不存在"));
      }

      const targetMessage = await db("t_sessionMessage").where({ sessionId, id: messageId }).first();
      if (!targetMessage) {
        return res.status(404).send(error("消息不存在"));
      }

      const revisitData = readSessionMessageRevisitData(targetMessage.revisitData);
      if (!revisitData) {
        return res.status(409).send(error("当前台词暂不支持回溯"));
      }

      const now = Date.now();
      const restoredState = revisitData.st;
      const restoredChapterId = revisitData.c;
      const restoredStatus = revisitData.s;
      const restoredRound = revisitData.r;

      // ★ 根据被回溯消息的角色类型决定删除策略：
      //   - 用户消息（player）：连同自己一起删除（"回到说这句话之前"），让用户重新输入
      //   - 旁白/NPC 消息（narrator/npc）：保留自己，只删之后的
      const targetRoleType = String(targetMessage.roleType || "").trim();
      const isPlayerMessage = targetRoleType === "player";
      const deleteOperator = isPlayerMessage ? ">=" : ">";

      // ★ 回溯到用户消息时，强制把 turnState.canPlayerSpeak 设为 true（玩家即将重新发言）
      if (isPlayerMessage && restoredState && typeof restoredState === "object") {
        if (!restoredState.turnState || typeof restoredState.turnState !== "object") {
          restoredState.turnState = {};
        }
        restoredState.turnState.canPlayerSpeak = true;
      }

      await db.transaction(async (trx: any) => {
        await trx("t_sessionMessage")
          .where({ sessionId })
          .andWhere("id", deleteOperator, messageId)
          .delete();

        await trx("t_sessionStateSnapshot")
          .where({ sessionId })
          .andWhere((builder: any) => {
            if (Number.isFinite(restoredRound) && restoredRound >= 0) {
              builder.where("round", ">", restoredRound);
            } else {
              builder.where("createTime", ">", Number(targetMessage.createTime || 0));
            }
          })
          .delete();

        await trx("t_entityStateDelta")
          .where({ sessionId })
          .andWhereRaw(
            isPlayerMessage
              ? "CAST(CASE WHEN eventId LIKE 'message:%' THEN substr(eventId, 9) ELSE '0' END AS INTEGER) >= ?"
              : "CAST(CASE WHEN eventId LIKE 'message:%' THEN substr(eventId, 9) ELSE '0' END AS INTEGER) > ?",
            [messageId],
          )
          .delete();

        await trx("t_gameSession")
          .where({ sessionId, userId })
          .update({
            stateJson: toJsonText(restoredState, {}),
            chapterId: restoredChapterId,
            status: restoredStatus,
            updateTime: now,
          });

        await trx("t_sessionStateSnapshot").insert({
          sessionId,
          stateJson: toJsonText(restoredState, {}),
          reason: "revisit_message",
          round: restoredRound,
          createTime: now,
        });

        // ★ 用户消息已被删除，不需要更新 revisitData；只在保留消息时才更新
        if (!isPlayerMessage) {
          await trx("t_sessionMessage")
            .where({ sessionId, id: messageId })
            .update({
              revisitData: toJsonText(buildSessionMessageRevisitData({
                state: restoredState,
                chapterId: restoredChapterId,
                status: restoredStatus,
                capturedAt: now,
            }), {}),
          });
        }
      });

      // 检测是否处于小游戏模式
      const restoredRulebook = restoredState?.miniGame?.rulebook;
      const isMiniGameMode = !!(restoredRulebook && Object.keys(restoredRulebook || {}).length);

      if (DebugLogUtil.isDebugLogEnabled()) {
        console.log(`[story:revisit:debug] 回溯完成`, JSON.stringify({
          sessionId,
          messageId,
          isMiniGameMode: Boolean(isMiniGameMode),
          hasRulebook: !!(restoredRulebook && Object.keys(restoredRulebook || {}).length),
        }));
      }

      return res.status(200).send(success({
        success: true,
        isMiniGameMode: Boolean(isMiniGameMode),
        miniGameType: restoredRulebook?.gameType || null,
        // ★ 回溯到用户消息时，把原内容回填到输入框，方便用户直接修改/重发
        revisitedRoleType: targetRoleType,
        revisitedContent: isPlayerMessage ? String(targetMessage.content || "") : "",
        // 回溯后 state 里的 dynamicWorldGlobalBackground 单独提取出来返回给前端
        // （整个 state 已在 restoredState 里都有，但顶层字段方便前端快速访问）
        dynamicGlobalBackground: String(
          (restoredState as Record<string, any>)?.dynamicWorldGlobalBackground
          || (restoredState as Record<string, any>)?.memorySummary
          || ""
        ).trim(),
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || "回溯失败");
      return res.status(500).send(error(message));
    }
  },
);
