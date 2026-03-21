import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getScriptSegments } from "@/lib/scriptSegment";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    scriptId: z.number(),
  }),
  async (req, res) => {
    const { scriptId } = req.body;
    const rows = await getScriptSegments(scriptId);
    res.status(200).send(success(rows));
  },
);
