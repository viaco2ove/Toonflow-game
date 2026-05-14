import express from "express";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
const router = express.Router();

// 更新提示词
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    customValue: z.string(),
    code: z.string(),
  }),
  async (req, res) => {
    const { id, customValue, code } = req.body;
    const userId = Number((req as any)?.user?.id || 0);
    const storyPromptCodes = new Set([
      "story-main",
      "story-orchestrator",
      "story-orchestrator-compact",
      "story-orchestrator-advanced",
      "story-speaker",
      "story-memory",
      "story-chapter",
      "story-event-progress",
      "story-mini-game",
      "story-mini-game-battle",
      "story-mini-game-fishing",
      "story-mini-game-werewolf",
      "story-mini-game-cultivation",
      "story-mini-game-mining",
      "story-mini-game-research-skill",
      "story-mini-game-alchemy",
      "story-mini-game-upgrade-equipment",
      "story-safety",
    ]);

    if (storyPromptCodes.has(String(code || "")) && userId !== 1) {
      return res.status(403).send(error("仅管理员可编辑 AI 故事提示词"));
    }

    await u
      .db("t_prompts")
      .update({
        customValue: customValue,
      })
      .where("id", id);

    res.status(200).send(success({ message: "更新提示词成功" }));
  },
);
