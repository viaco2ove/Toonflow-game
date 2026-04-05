import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { getGameDb, toJsonText } from "@/lib/gameEngine";
import { buildSessionMessageRevisitData, readSessionMessageRevisitData } from "@/modules/game-runtime/services/SessionService";

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

      await db.transaction(async (trx: any) => {
        await trx("t_sessionMessage")
          .where({ sessionId })
          .andWhere("id", ">", messageId)
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
            "CAST(CASE WHEN eventId LIKE 'message:%' THEN substr(eventId, 9) ELSE '0' END AS INTEGER) > ?",
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
      });

      return res.status(200).send(success(true, "回溯成功"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || "回溯失败");
      return res.status(500).send(error(message));
    }
  },
);
