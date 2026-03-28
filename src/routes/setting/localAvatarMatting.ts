import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { getLocalAvatarMattingStatus, installLocalBiRefNet, LOCAL_BIREFNET_MANUFACTURER } from "@/lib/localAvatarMatting";

const router = express.Router();

function ensureLogin(req: express.Request, res: express.Response): number | null {
  const userId = Number((req as any)?.user?.id || 0);
  if (!Number.isFinite(userId) || userId <= 0) {
    res.status(401).send(error("用户未登录"));
    return null;
  }
  return userId;
}

router.post(
  "/status",
  validateFields({
    manufacturer: z.string().optional().nullable(),
    model: z.string().optional().nullable(),
  }),
  async (req, res) => {
    if (ensureLogin(req, res) == null) return;
    try {
      const status = await getLocalAvatarMattingStatus({
        manufacturer: String((req.body as any)?.manufacturer || LOCAL_BIREFNET_MANUFACTURER),
        model: String((req.body as any)?.model || ""),
      });
      return res.status(200).send(success(status));
    } catch (err) {
      return res.status(400).send(error(err instanceof Error ? err.message : "查询本地头像分离状态失败"));
    }
  },
);

router.post(
  "/install",
  validateFields({
    manufacturer: z.string().optional().nullable(),
    model: z.string().optional().nullable(),
  }),
  async (req, res) => {
    if (ensureLogin(req, res) == null) return;
    try {
      const status = await installLocalBiRefNet({
        manufacturer: String((req.body as any)?.manufacturer || LOCAL_BIREFNET_MANUFACTURER),
        model: String((req.body as any)?.model || ""),
      });
      return res.status(200).send(success(status));
    } catch (err) {
      return res.status(500).send(error(err instanceof Error ? err.message : "安装本地 BiRefNet 失败"));
    }
  },
);

export default router;
