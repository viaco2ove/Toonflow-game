import { db } from "@/utils/db";
import express from "express";
import { success, error } from "@/lib/responseFormat";
const router = express.Router();

// 清空所有表 (sqlite)：用 Knex 迁移的 rollback + latest 重建（取代旧的 initDB 强制重置）。
export default router.post("/", async (req, res) => {
  const userId = Number((req as any)?.user?.id || 0);
  if (userId !== 1) {
    return res.status(403).send(error("无权限执行该操作"));
  }
  try {
    // 倒序回滚所有迁移，然后重新执行 latest 重建 schema + 种子数据
    await db.migrate.rollback({}, true);
    await db.migrate.latest();
    res.status(200).send(success("清空数据库成功（所有迁移已 rollback 并重新执行）"));
  } catch (err) {
    res.status(500).send(error(String((err as Error)?.message || "清空数据库失败")));
  }
});
