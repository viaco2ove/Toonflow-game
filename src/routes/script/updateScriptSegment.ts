import express from "express";
import { z } from "zod";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";

const router = express.Router();

async function normalizeSegmentSort(scriptId: number) {
  const rows = await u.db("t_scriptSegment").where({ scriptId }).orderBy("sort", "asc").orderBy("id", "asc").select("id");
  for (let index = 0; index < rows.length; index++) {
    await u.db("t_scriptSegment").where({ id: rows[index].id }).update({ sort: index + 1 });
  }
}

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    title: z.string().optional(),
    content: z.string().optional(),
    summary: z.string().optional(),
    startAnchor: z.string().optional(),
    endAnchor: z.string().optional(),
    sort: z.number().optional(),
  }),
  async (req, res) => {
    const { id, title, content, summary, startAnchor, endAnchor, sort } = req.body;
    const exists = await u.db("t_scriptSegment").where({ id }).first();
    if (!exists) {
      return res.status(404).send(error("剧情片段不存在"));
    }

    const payload: Record<string, any> = {
      updateTime: Date.now(),
    };
    if (typeof title === "string") payload.title = title;
    if (typeof content === "string") payload.content = content;
    if (typeof summary === "string") payload.summary = summary;
    if (typeof startAnchor === "string") payload.startAnchor = startAnchor;
    if (typeof endAnchor === "string") payload.endAnchor = endAnchor;
    if (typeof sort === "number" && Number.isFinite(sort)) payload.sort = Math.trunc(sort);

    await u.db("t_scriptSegment").where({ id }).update(payload);
    if (typeof payload.sort === "number") {
      await normalizeSegmentSort(Number(exists.scriptId));
    }
    const row = await u.db("t_scriptSegment").where({ id }).first();
    res.status(200).send(success(row));
  },
);
