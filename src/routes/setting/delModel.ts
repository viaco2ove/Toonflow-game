import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
  }),
  async (req, res) => {
    const { id } = req.body;
    const userId = Number((req as any)?.user?.id || 0);
    await u.db("t_config").where({ id, userId }).delete();
    const setting = await u.db("t_setting").where({ userId }).first("id", "languageModel");
    if (setting?.id) {
      let mapping: Record<string, any> = {};
      try {
        const parsed = JSON.parse(String(setting.languageModel || "{}"));
        if (parsed && typeof parsed === "object") {
          mapping = parsed as Record<string, any>;
        }
      } catch {
        mapping = {};
      }
      const nextMapping: Record<string, any> = {};
      for (const [key, value] of Object.entries(mapping)) {
        if (Number(value) !== Number(id)) {
          nextMapping[key] = value;
        }
      }
      await u.db("t_setting").where({ id: Number(setting.id) }).update({
        languageModel: JSON.stringify(nextMapping),
      });
    }
    res.status(200).send(success("删除成功"));
  },
);
