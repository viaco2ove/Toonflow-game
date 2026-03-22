import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 获取用户
export default router.get("/", async (req, res) => {
  const userId = Number((req as any)?.user?.id || 0);
  const data = await u.db("t_user").where("id", userId).select("*").first();

  res.status(200).send(success(data));
});
