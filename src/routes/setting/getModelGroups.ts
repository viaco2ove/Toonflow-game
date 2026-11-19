import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
const router = express.Router();

// 获取当前用户的模型组列表（不含快照内容，快照只在应用时读取）
export default router.post("/", async (req, res) => {
  const userId = Number((req as any)?.user?.id || 0);
  const rows = await u.db("t_modelGroup")
    .where({ userId })
    .select("id", "name", "remark", "createTime", "updateTime")
    .orderBy("updateTime", "desc");

  res.status(200).send(success(rows));
});
