import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";
import { setPluginEnabled } from "@/lib/pluginRegistry";

const router = express.Router();

/** 启用 / 禁用插件（只改状态，不删文件） */
export default router.post(
  "/",
  validateFields({
    pluginId: z.string(),
    enabled: z.boolean(),
  }),
  async (req, res) => {
    try {
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }
      const record = await setPluginEnabled(userId, req.body.pluginId, req.body.enabled);
      return res.status(200).send(success({
        pluginId: record.pluginId,
        enabled: Number(record.enabled) === 1,
        status: record.status,
      }));
    } catch (err) {
      return res.status(400).send(error(u.error(err).message));
    }
  },
);