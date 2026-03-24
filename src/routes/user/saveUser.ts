import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 获取用户
export default router.post(
  "/",
  validateFields({
    name: z.string().optional().nullable(),
    password: z.string().optional().nullable(),
    avatarPath: z.string().optional().nullable(),
    avatarBgPath: z.string().optional().nullable(),
    id: z.number().optional().nullable(),
  }),
  async (req, res) => {
    const { name, password, avatarPath, avatarBgPath } = req.body;
    const userId = Number((req as any)?.user?.id || 0);
    const payload: Record<string, string> = {};
    if (typeof name === "string") payload.name = name;
    if (typeof password === "string") payload.password = password;
    if (typeof avatarPath === "string") payload.avatarPath = avatarPath.trim();
    if (typeof avatarBgPath === "string") payload.avatarBgPath = avatarBgPath.trim();
    if (!Object.keys(payload).length) {
      return res.status(400).send(error("无需保存"));
    }
    await u.db("t_user").where("id", userId).update(payload);
    res.status(200).send(success("保存设置成功"));
  },
);
