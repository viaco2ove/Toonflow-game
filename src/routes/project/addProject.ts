import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { normalizeRolePair, nowTs, toJsonText } from "@/lib/gameEngine";
const router = express.Router();

// 新增项目
export default router.post(
  "/",
  validateFields({
    name: z.string(),
    intro: z.string(),
    type: z.string(),
    artStyle: z.string(),
    videoRatio: z.string(),
  }),
  async (req, res) => {
    const { name, intro, type, artStyle, videoRatio } = req.body;
    const userId = Number((req as any)?.user?.id || 0);
    const createTime = Date.now();

    const projectId = await u.db.transaction(async (trx) => {
      const insertResult = await trx("t_project").insert({
        name,
        intro,
        type,
        artStyle,
        videoRatio,
        userId,
        createTime,
      });

      const id = Number(Array.isArray(insertResult) ? insertResult[0] : insertResult);
      const rolePair = normalizeRolePair(null, null);
      const now = nowTs();
      await trx("t_storyWorld").insert({
        projectId: id,
        name: String(name || "").trim() || "默认世界观",
        intro: "",
        settings: toJsonText({}, {}),
        playerRole: toJsonText(rolePair.playerRole, {}),
        narratorRole: toJsonText(rolePair.narratorRole, {}),
        createTime: now,
        updateTime: now,
      });

      return id;
    });

    res.status(200).send(success({ message: "新增项目成功", projectId }));
  }
);
