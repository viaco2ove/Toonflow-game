import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
const router = express.Router();

export default router.post("/", async (req, res) => {
  const userId = Number((req as any)?.user?.id || 0);
  const configData = await u
    .db("t_config")
    .whereNotIn("type", ["video", "voice"])
    .where("userId", userId)
    .select("*");

  res.status(200).send(success(configData));
});
