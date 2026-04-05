import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { saveStoryRuntimeSettings } from "@/lib/storyRuntimeSettings";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    storyOrchestratorPayloadMode: z.enum(["compact", "advanced"]),
  }),
  async (req, res) => {
    const userId = Number((req as any)?.user?.id || 0);
    const result = await saveStoryRuntimeSettings({
      storyOrchestratorPayloadMode: req.body.storyOrchestratorPayloadMode,
    }, userId);
    res.status(200).send(success(result));
  },
);
