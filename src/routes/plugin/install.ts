import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";
import { installPluginPackage } from "@/lib/pluginRegistry";
import { ensureEntryConsistency } from "@/lib/pluginEntryConsistency";

const router = express.Router();

/** 安装（或覆盖升级）插件：上传 base64 的 .tpg/zip 包 */
export default router.post(
  "/",
  validateFields({
    fileName: z.string().optional().nullable(),
    base64Data: z.string(),
  }),
  async (req, res) => {
    try {
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }
      const { fileName, base64Data } = req.body;
      const result = await installPluginPackage(userId, base64Data, fileName);
      // ★ 一致性保证：装完触发 esbuild 现编 + 清 entryModuleCache（同 CLI 装）
      //   失败仅警告，不阻塞安装成功状态
      try {
        const consistency = await ensureEntryConsistency(userId, result.dir || "", {
          reason: "http:/plugin/install",
        });
        (result as any).consistency = consistency;
      } catch (e: any) {
        (result as any).consistencyWarning = String(e?.message ?? e);
      }
      return res.status(200).send(success(result));
    } catch (err) {
      return res.status(400).send(error(u.error(err).message));
    }
  },
);