import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  getGameDb,
  normalizeWorldBookOutput,
} from "@/lib/gameEngine";
import u from "@/utils";

const router = express.Router();

/**
 * 列出某个世界的全部世界书条目。
 * 鉴权：通过 worldId -> t_storyWorld -> t_project -> userId 校验，用户只能查自己的世界。
 */
export default router.post(
  "/",
  validateFields({
    worldId: z.number(),
  }),
  async (req, res) => {
    try {
      const currentUserId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(currentUserId) || currentUserId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }
      const worldId = Number(req.body.worldId || 0);
      if (!worldId) {
        return res.status(400).send(error("缺少 worldId"));
      }
      const db = getGameDb();
      const owned = await db("t_storyWorld as w")
        .leftJoin("t_project as p", "w.projectId", "p.id")
        .where("w.id", worldId)
        .where("p.userId", currentUserId)
        .select("w.id")
        .first();
      if (!owned) {
        return res.status(403).send(error("无权访问该世界"));
      }
      const rows = await db("t_worldBook")
        .where({ worldId })
        .orderBy("sort", "asc")
        .orderBy("id", "asc");
      const entries = normalizeWorldBookOutput(rows);
      res.status(200).send(success({ entries }));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
