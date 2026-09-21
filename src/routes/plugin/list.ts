import express from "express";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";
import { listPlugins } from "@/lib/pluginRegistry";

const router = express.Router();

/** 列出当前用户已安装的插件 */
export default router.post("/", async (req, res) => {
  try {
    const userId = Number((req as any)?.user?.id || 0);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).send(error("用户未登录"));
    }
    const plugins = await listPlugins(userId);
    return res.status(200).send(success({ plugins }));
  } catch (err) {
    return res.status(500).send(error(u.error(err).message));
  }
});