import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { toExternalModelConfigRow } from "@/lib/modelConfigType";
const router = express.Router();

export default router.post("/", async (req, res) => {
  const userId = Number((req as any)?.user?.id || 0);
  const configData = await u
    .db("t_config")
    .whereNotIn("type", ["video"])
    .where("userId", userId)
    .select("*");
  console.log("[getSetting] SQL results:", configData.map((r) => ({ id: r.id, type: r.type, modelType: r.modelType, model: r.model, manufacturer: r.manufacturer })));
  res.status(200).send(success(configData.map((item) => toExternalModelConfigRow(item))));
});
