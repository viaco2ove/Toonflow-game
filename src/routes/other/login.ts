import express from "express";
import u from "@/utils";
import jwt from "jsonwebtoken";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
const router = express.Router();

async function getOrCreateTokenKey(userId: number): Promise<string> {
  const existed = await u.db("t_setting").where("userId", userId).select("id", "tokenKey").first();
  const tokenKey = String(existed?.tokenKey || "").trim();
  if (tokenKey) return tokenKey;

  const nextTokenKey = u.uuid().slice(0, 8);
  if (existed?.id) {
    await u.db("t_setting").where("id", existed.id).update({ tokenKey: nextTokenKey });
    return nextTokenKey;
  }

  const maxRow = await u.db("t_setting").max({ maxId: "id" }).first();
  const nextId = Number((maxRow as any)?.maxId || 0) + 1;
  await u.db("t_setting").insert({
    id: nextId,
    userId,
    tokenKey: nextTokenKey,
    imageModel: "{}",
    languageModel: "{}",
    projectId: null,
  });
  return nextTokenKey;
}

export function setToken(payload: string | object, expiresIn: string | number, secret: string): string {
  if (!payload || typeof secret !== "string" || !secret) {
    throw new Error("参数不合法");
  }
  return (jwt.sign as any)(payload, secret, { expiresIn });
}

// 登录
export default router.post(
  "/",
  validateFields({
    username: z.string(),
    password: z.string(),
  }),
  async (req, res) => {
    const { username, password } = req.body;

    const data = await u.db("t_user").where("name", "=", username).first();
    if (!data) return res.status(400).send(error("登录失败"));

    if (data!.password == password && data!.name == username) {
      const tokenKey = await getOrCreateTokenKey(Number(data.id));

      const token = setToken(
        {
          id: data!.id,
          name: data!.name,
        },
        "180Days",
        tokenKey,
      );

      return res.status(200).send(success({ token: "Bearer " + token, name: data!.name, id: data!.id }, "登录成功"));
    } else {
      return res.status(400).send(error("用户名或密码错误"));
    }
  },
);
