import express from "express";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import { getOrCreateTokenKey, setToken } from "./login";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    username: z.string().trim().min(2).max(32),
    password: z.string().min(6).max(64),
  }),
  async (req, res) => {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    const existed = await u.db("t_user").where("name", username).first("id");
    if (existed) {
      return res.status(400).send(error("账号已存在"));
    }

    const maxRow = await u.db("t_user").max({ maxId: "id" }).first();
    const nextId = Number((maxRow as any)?.maxId || 0) + 1;
    await u.db("t_user").insert({
      id: nextId,
      name: username,
      password,
    });

    const tokenKey = await getOrCreateTokenKey(nextId);
    const token = setToken(
      {
        id: nextId,
        name: username,
      },
      "180Days",
      tokenKey,
    );

    return res.status(200).send(success({ token: "Bearer " + token, name: username, id: nextId }, "注册成功"));
  },
);
