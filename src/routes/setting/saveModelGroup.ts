import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

/**
 * 保存模型组：把当前 t_setting.languageModel 的完整 JSON 快照存为一个模型组。
 * - 不带 id：新建模型组
 * - 带 id：覆盖保存（重新快照当前配置覆写到该组，名称/备注一并更新）
 */
export default router.post(
  "/",
  validateFields({
    id: z.number().optional(),
    name: z.string(),
    remark: z.string().optional(),
  }),
  async (req, res) => {
    const { id, remark } = req.body;
    const userId = Number((req as any)?.user?.id || 0);
    const name = String(req.body?.name || "").trim();
    const now = Date.now();

    // 名称去掉首尾空白后必须非空
    if (!name) {
      return res.status(400).send(error("模型组名称不能为空"));
    }

    // 同一用户内名称唯一（覆盖保存时排除自身）
    const nameOwner = await u.db("t_modelGroup")
      .where({ userId, name })
      .where(function () {
        if (id) this.andWhereNot("id", Number(id));
      })
      .first("id");
    if (nameOwner) {
      return res.status(400).send(error("已存在同名模型组"));
    }

    // 读取当前槽位绑定 JSON 作为快照；不存在 t_setting 行时按空对象保存
    const setting = await u.db("t_setting").where({ userId }).first("languageModel");
    let languageModelJson = "{}";
    try {
      const parsed = JSON.parse(String(setting?.languageModel || "{}"));
      languageModelJson = JSON.stringify(parsed && typeof parsed === "object" ? parsed : {});
    } catch {
      // 现有数据损坏时按空快照保存，避免把坏数据带进模型组
      languageModelJson = "{}";
    }

    if (id) {
      // 覆盖保存：校验归属后重新快照覆写
      const group = await u.db("t_modelGroup").where({ id: Number(id), userId }).first("id");
      if (!group) {
        return res.status(404).send(error("模型组不存在"));
      }
      await u.db("t_modelGroup").where({ id: Number(id) }).update({
        name,
        remark: remark ?? null,
        languageModelJson,
        updateTime: now,
      });
      return res.status(200).send(success({ groupId: Number(id) }));
    }

    // 新建模型组
    const insertResult = await u.db("t_modelGroup").insert({
      userId,
      name,
      remark: remark ?? null,
      languageModelJson,
      createTime: now,
      updateTime: now,
    });
    const groupId = Number(Array.isArray(insertResult) ? insertResult[0] : insertResult);
    res.status(200).send(success({ groupId }));
  },
);
