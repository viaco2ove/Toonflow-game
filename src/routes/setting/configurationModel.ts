import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    configId: z.number(),
  }),
  async (req, res) => {
    const { id, configId } = req.body;
    const userId = Number((req as any)?.user?.id || 0);
    const mapRow = await u.db("t_aiModelMap").where({ id }).first("id", "key");
    if (!mapRow) {
      return res.status(404).send(error("映射项不存在"));
    }

    const config = await u.db("t_config").where({ id: configId, userId }).first("id");
    if (!config) {
      return res.status(403).send(error("无权绑定该模型配置"));
    }

    const setting = await u.db("t_setting").where({ userId }).first("id", "languageModel");
    let mapping: Record<string, number> = {};
    try {
      const parsed = JSON.parse(String(setting?.languageModel || "{}"));
      if (parsed && typeof parsed === "object") {
        mapping = parsed as Record<string, number>;
      }
    } catch {
      mapping = {};
    }
    mapping[String(mapRow.key)] = Number(configId);
    const languageModel = JSON.stringify(mapping);

    if (setting?.id) {
      await u.db("t_setting").where({ id: Number(setting.id) }).update({ languageModel });
    } else {
      const maxRow = await u.db("t_setting").max({ maxId: "id" }).first();
      const nextId = Number((maxRow as any)?.maxId || 0) + 1;
      await u.db("t_setting").insert({
        id: nextId,
        userId,
        tokenKey: u.uuid().slice(0, 8),
        imageModel: "{}",
        languageModel,
        projectId: null,
      });
    }

    res.status(200).send(success("配置成功"));
  },
);
