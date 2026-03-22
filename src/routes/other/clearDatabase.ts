import initDB from "@/lib/initDB";

import { db } from "@/utils/db";
import express from "express";
import { success, error } from "@/lib/responseFormat";
const router = express.Router();

// 清空所有表 (sqlite)
export default router.post("/", async (req, res) => {
  const userId = Number((req as any)?.user?.id || 0);
  if (userId !== 1) {
    return res.status(403).send(error("无权限执行该操作"));
  }
  await initDB(db, true);
  res.status(200).send(success("清空数据库成功"));
});
