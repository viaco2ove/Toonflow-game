import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  commitSessionNarrativeTurn,
  isSessionServiceError,
} from "@/modules/game-runtime/services/SessionService";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    sessionId: z.string(),
    state: z.any().optional().nullable(),
    chapterId: z.number().optional().nullable(),
    status: z.string().optional().nullable(),
    role: z.string().optional().nullable(),
    roleType: z.string().optional().nullable(),
    eventType: z.string().optional().nullable(),
    content: z.string(),
    createTime: z.number().optional().nullable(),
    saveSnapshot: z.boolean().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const result = await commitSessionNarrativeTurn({
        sessionId: String(req.body.sessionId || ""),
        state: req.body.state,
        chapterId: req.body.chapterId,
        status: req.body.status,
        role: req.body.role,
        roleType: req.body.roleType,
        eventType: req.body.eventType,
        content: String(req.body.content || ""),
        createTime: req.body.createTime,
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
