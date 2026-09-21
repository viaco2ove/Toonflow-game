import express from "express";
import { readPluginAsset } from "@/lib/pluginRegistry";

const router = express.Router();

/**
 * 读取插件内文件（GET，供 <script src> / iframe src / <img> 直接引用）。
 *
 * 浏览器直接发起的静态资源请求带不上 Authorization 头，
 * 但全局 JWT 中间件本身支持 req.query.token，
 * 因此前端拼接资源 URL 时附上 ?token=<jwt> 即可：
 *
 * GET /plugin/getAsset?pluginId=xxx&path=ui/game.html&token=<jwt>
 */
router.get("/", async (req, res) => {
  try {
    const userId = Number((req as any)?.user?.id || 0);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).send({ message: "用户未登录" });
    }
    const pluginId = String(req.query.pluginId || "").trim();
    const relPath = String(req.query.path || "").trim();
    if (!pluginId || !relPath) {
      return res.status(400).send({ message: "缺少 pluginId 或 path" });
    }
    const asset = await readPluginAsset(userId, pluginId, relPath);
    if (!asset) return res.status(404).send({ message: "插件资源不存在" });
    res.setHeader("Content-Type", asset.mime);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(asset.data);
  } catch {
    return res.status(500).send({ message: "读取插件资源失败" });
  }
});

export default router;