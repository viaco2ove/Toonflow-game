import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  addSessionMessage,
  isSessionServiceError,
} from "@/modules/game-runtime/services/SessionService";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    sessionId: z.string(),
    roleType: z.enum(["player", "narrator", "npc", "system"]).optional().nullable(),
    role: z.string().optional().nullable(),
    content: z.string(),
    eventType: z.string().optional().nullable(),
    meta: z.any().optional().nullable(),
    attrChanges: z
      .array(
        z.object({
          entityType: z.string().optional().nullable(),
          entityId: z.string().optional().nullable(),
          field: z.string().optional().nullable(),
          value: z.any().optional(),
          source: z.string().optional().nullable(),
        }),
      )
      .optional()
      .nullable(),
    saveSnapshot: z.boolean().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const result = await addSessionMessage({
        sessionId: req.body.sessionId,
        roleType: req.body.roleType,
        role: req.body.role,
        content: req.body.content,
        eventType: req.body.eventType,
        meta: req.body.meta,
        attrChanges: req.body.attrChanges,
        saveSnapshot: req.body.saveSnapshot,
      });
      res.status(200).send(success(result));
    } catch (err) {
      if (isSessionServiceError(err)) {
        return res.status(err.status).send(error(err.message));
      }
      res.status(500).send(error(u.error(err).message));
    }
  },
);
