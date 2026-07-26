import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { getGameDb } from "@/lib/gameEngine";
import u from "@/utils";

const router = express.Router();

/**
 * 删除世界书条目。
 * 鉴权：条目 id -> t_worldBook.worldId -> t_storyWorld -> t_project -> userId
 */
export default router.post(
  "/",
  validateFields({
    id: z.number(),
  }),
  async (req, res) => {
    try {
      const currentUserId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(currentUserId) || currentUserId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }
      const id = Number(req.body.id || 0);
      if (!id) {
        return res.status(400).send(error("缺少 id"));
      }
      const db = getGameDb();
      // 两步鉴权：先查条目是否存在（区分 404 / 403），再校验 worldId 归属
      const entry = await db("t_worldBook").where({ id }).select("id", "worldId").first();
      if (!entry) {
        return res.status(404).send(error("条目不存在"));
      }
      const worldId = Number(entry.worldId || 0);
      const owned = await db("t_storyWorld as w")
        .leftJoin("t_project as p", "w.projectId", "p.id")
        .where("w.id", worldId)
        .where("p.userId", currentUserId)
        .select("w.id")
        .first();
      if (!owned) {
        return res.status(403).send(error("无权删除该条目"));
      }
      await db("t_worldBook").where({ id }).delete();
      res.status(200).send(success({ id }, "删除成功"));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);