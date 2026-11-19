import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 更新模型组的名称与备注（不动快照内容，快照只随「保存/覆盖保存」更新）
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    name: z.string(),
    remark: z.string().optional(),
  }),
  async (req, res) => {
    const { id, remark } = req.body;
    const userId = Number((req as any)?.user?.id || 0);
    const name = String(req.body?.name || "").trim();

    if (!name) {
      return res.status(400).send(error("模型组名称不能为空"));
    }

    const group = await u.db("t_modelGroup").where({ id: Number(id), userId }).first("id", "name");
    if (!group) {
      return res.status(404).send(error("模型组不存在"));
    }

    // 名称有变化时做同用户内的重名校验
    if (name !== String(group.name || "")) {
      const nameOwner = await u.db("t_modelGroup")
        .where({ userId, name })
        .andWhereNot("id", Number(id))
        .first("id");
      if (nameOwner) {
        return res.status(400).send(error("已存在同名模型组"));
      }
    }

    await u.db("t_modelGroup").where({ id: Number(id) }).update({
      name,
      remark: remark ?? null,
      updateTime: Date.now(),
    });

    res.status(200).send(success({ groupId: Number(id) }));
  },
);
