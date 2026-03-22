import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 获取用户
export default router.post(
  "/",
  validateFields({
    name: z.string(),
    password: z.string(),
    id: z.number().optional().nullable(),
  }),
  async (req, res) => {
    const { name, password } = req.body;
    const userId = Number((req as any)?.user?.id || 0);
    await u.db("t_user").where("id", userId).update({
      name,
      password,
    });
    res.status(200).send(success("保存设置成功"));
  },
);
