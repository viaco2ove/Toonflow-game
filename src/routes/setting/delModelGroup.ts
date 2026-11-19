import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 删除模型组（只删组记录本身，不影响 t_config 与当前槽位绑定）
export default router.post(
  "/",
  validateFields({
    id: z.number(),
  }),
  async (req, res) => {
    const { id } = req.body;
    const userId = Number((req as any)?.user?.id || 0);

    const group = await u.db("t_modelGroup").where({ id: Number(id), userId }).first("id");
    if (!group) {
      return res.status(404).send(error("模型组不存在"));
    }

    await u.db("t_modelGroup").where({ id: Number(id) }).delete();
    res.status(200).send(success("删除成功"));
  },
);
