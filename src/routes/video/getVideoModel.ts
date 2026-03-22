import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 获取视频模型
export default router.post(
  "/",
  validateFields({}),
  async (req, res) => {
    const userId = Number((req as any)?.user?.id || 0);

    const data = await u.db("t_config").where("userId", userId).select("model");
    const modelData = [];

    for (const item of data) {
      if (item.model?.includes("sora")) {
        modelData.push("sora");
      }
      if (item.model?.includes("doubao")) {
        modelData.push("doubao");
      }
    }

    res.status(200).send(success(modelData));
  }
);
