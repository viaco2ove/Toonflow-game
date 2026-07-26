import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  getGameDb,
  normalizeWorldBookEntry,
  serializeWorldBookEntry,
  nowTs,
} from "@/lib/gameEngine";
import u from "@/utils";

const router = express.Router();

/**
 * 新建或更新世界书条目。
 * - entry.id 有值 -> 更新该 id 的条目（须校验归属）
 * - entry.id 无值 -> 新建，挂在 worldId 下
 * 鉴权：worldId -> t_storyWorld -> t_project -> userId
 */
export default router.post(
  "/",
  validateFields({
    worldId: z.number(),
    entry: z.any(),
  }),
  async (req, res) => {
    try {
      const currentUserId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(currentUserId) || currentUserId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }
      const worldId = Number(req.body.worldId || 0);
      const entryRaw = req.body.entry;
      if (!worldId || !entryRaw || typeof entryRaw !== "object") {
        return res.status(400).send(error("缺少 worldId 或 entry"));
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

      const normalized = normalizeWorldBookEntry(entryRaw);
      const entryId = Number((normalized as any).id);
      const now = nowTs();
      const payload = serializeWorldBookEntry(entryRaw, worldId);

      let savedId = 0;
      if (Number.isFinite(entryId) && entryId > 0) {
        // 更新：先确认该条目属于此 worldId，防止越权改他人条目
        const existing = await db("t_worldBook").where({ id: entryId, worldId }).first();
        if (!existing) {
          return res.status(404).send(error("条目不存在或不属于该世界"));
        }
        await db("t_worldBook").where({ id: entryId }).update({ ...payload, updateTime: now });
        savedId = entryId;
      } else {
        const insertResult = await db("t_worldBook").insert({ ...payload, createTime: now, updateTime: now });
        savedId = Number(Array.isArray(insertResult) ? insertResult[0] : insertResult);
      }
      const row = await db("t_worldBook").where({ id: savedId }).first();
      res.status(200).send(success({ entry: normalizeWorldBookEntry(row) }, savedId === entryId ? "更新成功" : "创建成功"));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);