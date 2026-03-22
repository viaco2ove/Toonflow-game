import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  getGameDb,
  normalizeRolePair,
  normalizeWorldOutput,
  nowTs,
  toJsonText,
} from "@/lib/gameEngine";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    worldId: z.number().optional().nullable(),
    projectId: z.number(),
    name: z.string(),
    intro: z.string().optional().nullable(),
    settings: z.any().optional().nullable(),
    playerRole: z.any().optional().nullable(),
    narratorRole: z.any().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const { worldId, projectId, name, intro, settings, playerRole, narratorRole } = req.body;
      const db = getGameDb();
      const now = nowTs();
      const rolePair = normalizeRolePair(playerRole, narratorRole);

      const worldIdNum = Number(worldId);
      let existing: any = null;
      if (Number.isFinite(worldIdNum) && worldIdNum > 0) {
        existing = await db("t_storyWorld").where({ id: worldIdNum }).first();
      }
      if (!existing) {
        existing = await db("t_storyWorld").where({ projectId }).first();
      }

      const payload = {
        projectId,
        name: String(name || "").trim(),
        intro: String(intro || "").trim(),
        settings: toJsonText(settings, {}),
        playerRole: toJsonText(rolePair.playerRole, {}),
        narratorRole: toJsonText(rolePair.narratorRole, {}),
        updateTime: now,
      };

      let id = 0;
      if (existing?.id) {
        id = Number(existing.id);
        await db("t_storyWorld").where({ id }).update(payload);
      } else {
        const insertPayload = {
          ...payload,
          createTime: now,
        };
        const insertResult = await db("t_storyWorld").insert(insertPayload);
        id = Number(Array.isArray(insertResult) ? insertResult[0] : insertResult);
      }

      const row = await db("t_storyWorld").where({ id }).first();
      res.status(200).send(success(normalizeWorldOutput(row), existing ? "更新世界观成功" : "创建世界观成功"));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
