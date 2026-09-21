import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";
import { uninstallPlugin } from "@/lib/pluginRegistry";

const router = express.Router();

/** 卸载插件：删除插件目录 + t_plugin 记录 */
export default router.post(
  "/",
  validateFields({
    pluginId: z.string(),
  }),
  async (req, res) => {
    try {
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }
      await uninstallPlugin(userId, req.body.pluginId);
      return res.status(200).send(success({ pluginId: req.body.pluginId }));
    } catch (err) {
      return res.status(400).send(error(u.error(err).message));
    }
  },
);