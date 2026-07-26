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
 * 批量导入世界书条目。
 * - mode: "replace"（默认）先删该 worldId 旧条目，再批量插入；适合导入 worldbook.json 整体覆盖
 * - mode: "merge" 保留旧条目，只追加新条目
 * 入参 entries 可以是数组，也可以是 { entries: [...] }（兼容 worldbook.json 顶层结构）
 * 鉴权：worldId -> t_storyWorld -> t_project -> userId
 */
export default router.post(
  "/",
  validateFields({
    worldId: z.number(),
    entries: z.any(),
    mode: z.string().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const currentUserId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(currentUserId) || currentUserId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }
      const worldId = Number(req.body.worldId || 0);
      const modeRaw = String(req.body.mode || "replace").trim().toLowerCase();
      const mode = modeRaw === "merge" ? "merge" : "replace";
      if (!worldId) {
        return res.status(400).send(error("缺少 worldId"));
      }
      // entries 兼容两种形态：直接数组，或 { entries: [...] }（worldbook.json 顶层带元信息时）
      const rawEntries = Array.isArray(req.body.entries)
        ? req.body.entries
        : Array.isArray((req.body.entries as any)?.entries)
          ? (req.body.entries as any).entries
          : [];
      if (!rawEntries.length) {
        return res.status(400).send(error("没有可导入的条目"));
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

      const now = nowTs();
      const rows = rawEntries
        .map((item: any) => serializeWorldBookEntry(item, worldId))
        .map((row: any) => ({ ...row, createTime: now, updateTime: now }));

      let deletedCount = 0;
      if (mode === "replace") {
        const before = await db("t_worldBook").where({ worldId }).delete();
        deletedCount = Number(before || 0);
      }
      // 批量插入，单条失败不影响其余
      let imported = 0;
      for (const row of rows) {
        try {
          await db("t_worldBook").insert(row);
          imported += 1;
        } catch (oneErr) {
          console.warn("[importWorldBook] 单条插入失败，跳过", (oneErr as any)?.message || oneErr);
        }
      }
      res.status(200).send(success({ imported, deleted: deletedCount, mode }, `导入完成：新增 ${imported} 条${mode === "replace" ? `，替换旧条目 ${deletedCount} 条` : ""}`));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);