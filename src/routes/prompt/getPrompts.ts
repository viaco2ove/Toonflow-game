import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { DEFAULT_PROMPTS } from "@/lib/def.prompts";
const router = express.Router();

// 获取提示词
// defaultValue 始终用 def.prompts.ts 的最新值（覆盖表里可能残留的旧值）
export default router.get("/", async (req, res) => {
  const rows = (await u.db("t_prompts")) as Array<{ code: string; [k: string]: unknown }>;
  const data = rows.map((row) => ({
    ...row,
    defaultValue: DEFAULT_PROMPTS[row.code] ?? row.defaultValue ?? "",
  }));
  res.status(200).send(success(data));
});
