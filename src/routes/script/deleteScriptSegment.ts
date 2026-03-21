import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
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
  }),
  async (req, res) => {
    const { id } = req.body;
    const row = await u.db("t_scriptSegment").where({ id }).first("id", "scriptId");
    await u.db("t_scriptSegment").where({ id }).delete();
    if (row?.scriptId != null) {
      await normalizeSegmentSort(Number(row.scriptId));
    }
    res.status(200).send(success({ id }));
  },
);
