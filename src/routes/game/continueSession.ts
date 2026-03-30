import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  continueSessionNarrative,
  isSessionServiceError,
} from "@/modules/game-runtime/services/SessionService";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    sessionId: z.string(),
  }),
  async (req, res) => {
    try {
      const result = await continueSessionNarrative(String(req.body.sessionId || ""));
      res.status(200).send(success(result));
    } catch (err) {
      if (isSessionServiceError(err)) {
        return res.status(err.status).send(error(err.message));
      }
      res.status(500).send(error(u.error(err).message));
    }
  },
);
