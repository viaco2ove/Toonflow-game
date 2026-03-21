import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 获取前要数据
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
  }),
  async (req, res) => {
    const { projectId } = req.body;

    const data = await u.db("t_script").where("projectId", projectId).select("*");
    const scriptIds = data.map((item: any) => Number(item.id)).filter((item: number) => Number.isFinite(item));
    const segmentRows = scriptIds.length
      ? await u.db("t_scriptSegment").whereIn("scriptId", scriptIds).orderBy("sort", "asc").select("*")
      : [];
    const segmentMap = new Map<number, any[]>();
    for (const item of segmentRows) {
      const key = Number(item.scriptId);
      const list = segmentMap.get(key) || [];
      list.push(item);
      segmentMap.set(key, list);
    }

    const result = data.map((item: any) => ({
      ...item,
      segments: segmentMap.get(Number(item.id)) || [],
    }));

    res.status(200).send(success(result));
  }
);
