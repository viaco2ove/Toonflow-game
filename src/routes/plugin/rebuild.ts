/**
 * POST /plugin/rebuild
 * 触发插件入口一致性保证（esbuild 现编 + 清 entryModuleCache）
 *
 * 三个调用方：
 *   1) toonflow-game-plugins/src/toon_plugins/cli.py install_cmd() 装完调
 *   2) 网页端 5175 装完（routes/plugin/install.ts 后追加调用）
 *   3) vite dev-host 启动时调（开发模式 5175 转发到 60002）
 *
 * Body: { userId: number, pluginId: string, reason?: string }
 *   注：userId 当前从鉴权中间件（req.user.id）取，但接口预留 body 字段便于
 *       toonflow-game-plugins CLI 直接调（它拿不到 req.user）
 */
import express from "express";
import { success, error } from "@/lib/responseFormat";
import { ensureEntryConsistency } from "@/lib/pluginEntryConsistency";

const router = express.Router();

router.post("/", async (req, res) => {
  const body = (req.body || {}) as { userId?: number; pluginId?: string; reason?: string };
  const userId = Number((req as any)?.user?.id ?? body.userId ?? 0);
  const pluginId = String(body.pluginId ?? "").trim();
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(401).send(error("用户未登录"));
  }
  if (!pluginId) {
    return res.status(400).send(error("缺少 pluginId"));
  }
  const reason = String(body.reason ?? "http:/plugin/rebuild");
  try {
    const result = await ensureEntryConsistency(userId, pluginId, { reason });
    return res.send(success({
      ...result,
      warning: result.ok ? null : `一致性检查失败：${result.rebuildError || result.cacheClearError || "未知"}`,
    }));
  } catch (e: any) {
    return res.status(500).send(error(`rebuild 异常: ${e?.message ?? String(e)}`));
  }
});

export default router;