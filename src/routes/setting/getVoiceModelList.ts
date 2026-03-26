import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { normalizePersistedVoiceConfig, resolveVoiceModelModes } from "@/lib/voiceGateway";

const router = express.Router();

export default router.post("/", async (req, res) => {
  const userId = Number((req as any)?.user?.id || 0);
  const configData = await u.db("t_config").where("type", "voice").where("userId", userId).select("*");
  const normalizedRows = configData.map((item) => {
    const normalized = normalizePersistedVoiceConfig({
      manufacturer: item.manufacturer,
      modelType: item.modelType,
      model: item.model,
      baseUrl: item.baseUrl,
    });
    return {
      ...item,
      ...normalized,
      modes: resolveVoiceModelModes({
        manufacturer: item.manufacturer,
        modelType: item.modelType,
        model: normalized.model,
      }),
    };
  });
  res.status(200).send(success(normalizedRows));
});
