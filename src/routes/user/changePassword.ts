import express from "express";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    oldPassword: z.string().min(1),
    newPassword: z.string().min(6).max(64),
  }),
  async (req, res) => {
    const userId = Number((req as any)?.user?.id || 0);
    const oldPassword = String(req.body.oldPassword || "");
    const newPassword = String(req.body.newPassword || "");

    const user = await u.db("t_user").where({ id: userId }).first("id", "password");
    if (!user) {
      return res.status(404).send(error("账号不存在"));
    }
    if (String((user as any).password || "") !== oldPassword) {
      return res.status(400).send(error("原密码错误"));
    }

    await u.db("t_user").where({ id: userId }).update({ password: newPassword });
    return res.status(200).send(success({ message: "修改密码成功" }));
  },
);
