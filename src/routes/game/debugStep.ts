import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  getGameDb,
  normalizeChapterOutput,
  normalizeMessageOutput,
  normalizeRolePair,
  normalizeSessionState,
  nowTs,
} from "@/lib/gameEngine";
import {
  applyMemoryResultToState,
  applyOrchestratorResultToState,
  evaluateDebugChapterOutcome,
  resolveOpeningMessage,
  runNarrativeOrchestrator,
  runStoryMemoryManager,
  RuntimeMessageInput,
} from "@/modules/game-runtime/engines/NarrativeOrchestrator";
import u from "@/utils";

const router = express.Router();

const debugMessageSchema = z.object({
  role: z.string().optional().nullable(),
  roleType: z.string().optional().nullable(),
  eventType: z.string().optional().nullable(),
  content: z.string().optional().nullable(),
  createTime: z.number().optional().nullable(),
});

function asDebugMessage(input: any) {
  return normalizeMessageOutput({
    id: 0,
    role: String(input.role || "旁白"),
    roleType: String(input.roleType || "narrator"),
    eventType: String(input.eventType || "on_debug"),
    content: String(input.content || ""),
    createTime: Number(input.createTime || nowTs()),
    meta: {},
  });
}

function buildDebugRecentMessages(
  messages: RuntimeMessageInput[],
  playerRoleName: string,
  playerContent: string,
) {
  const normalizedContent = String(playerContent || "").trim();
  const list = messages.map((item) => ({
    role: String(item.role || ""),
    roleType: String(item.roleType || ""),
    eventType: String(item.eventType || ""),
    content: String(item.content || ""),
    createTime: Number(item.createTime || 0),
  }));
  if (!normalizedContent) {
    return list;
  }
  const last = list[list.length - 1];
  const hasTrailingPlayerMessage = Boolean(
    last
      && String(last.roleType || "").trim().toLowerCase() === "player"
      && String(last.content || "").trim() === normalizedContent,
  );
  if (hasTrailingPlayerMessage) {
    return list;
  }
  return [
    ...list,
    {
      role: String(playerRoleName || "用户"),
      roleType: "player",
      eventType: "on_message",
      content: normalizedContent,
      createTime: nowTs(),
    },
  ];
}

export default router.post(
  "/",
  validateFields({
    worldId: z.number(),
    chapterId: z.number().optional().nullable(),
    playerContent: z.string().optional().nullable(),
    state: z.any().optional().nullable(),
    messages: z.array(debugMessageSchema).optional().nullable(),
  }),
  async (req, res) => {
    try {
      const db = getGameDb();
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }

      const worldId = Number(req.body.worldId || 0);
      const chapterId = Number(req.body.chapterId || 0);
      const playerContent = String(req.body.playerContent || "").trim();
      const inputMessages = (Array.isArray(req.body.messages) ? req.body.messages : []) as RuntimeMessageInput[];

      const world = await db("t_storyWorld as w")
        .leftJoin("t_project as p", "w.projectId", "p.id")
        .where("w.id", worldId)
        .where("p.userId", userId)
        .select("w.*")
        .first();
      if (!world) {
        return res.status(404).send(error("未找到故事"));
      }

      let chapter: any = null;
      if (chapterId > 0) {
        chapter = await db("t_storyChapter").where({ id: chapterId, worldId }).first();
      }
      if (!chapter) {
        chapter = await db("t_storyChapter").where({ worldId }).orderBy("sort", "asc").orderBy("id", "asc").first();
      }
      chapter = normalizeChapterOutput(chapter);
      if (!chapter) {
        return res.status(404).send(error("当前没有章节可调试"));
      }

      const rolePair = normalizeRolePair(world.playerRole, world.narratorRole);
      const state = normalizeSessionState(req.body.state, worldId, Number(chapter.id || 0), rolePair);
      const messages = inputMessages.map((item) => ({
        role: String(item.role || ""),
        roleType: String(item.roleType || ""),
        eventType: String(item.eventType || ""),
        content: String(item.content || ""),
        createTime: Number(item.createTime || 0),
      }));
      const recentMessages = buildDebugRecentMessages(messages, String(rolePair.playerRole.name || "用户"), playerContent);

      if (!playerContent) {
        const openingMessage = asDebugMessage(resolveOpeningMessage(world, chapter));
        return res.status(200).send(success({
          chapterId: Number(chapter.id || 0),
          chapterTitle: String(chapter.title || ""),
          state,
          endDialog: null,
          messages: [openingMessage],
        }));
      }

      const outcome = evaluateDebugChapterOutcome(chapter, playerContent, recentMessages);
      if (outcome.result === "failed") {
        return res.status(200).send(success({
          chapterId: Number(chapter.id || 0),
          chapterTitle: String(chapter.title || ""),
          state,
          endDialog: "已失败",
          messages: [asDebugMessage({
            role: String(rolePair.narratorRole.name || "旁白"),
            roleType: "narrator",
            eventType: "on_debug_failed",
            content: `章节《${String(chapter.title || "当前章节")}》判定失败，调试结束。`,
          })],
        }));
      }

      if (outcome.result === "success") {
        const chapters = (await db("t_storyChapter").where({ worldId }).orderBy("sort", "asc").orderBy("id", "asc"))
          .map((item: any) => normalizeChapterOutput(item));
        const explicitNext = outcome.nextChapterId
          ? chapters.find((item: any) => Number(item.id) === Number(outcome.nextChapterId))
          : null;
        const currentIndex = chapters.findIndex((item: any) => Number(item.id) === Number(chapter.id));
        const nextChapter = explicitNext || (currentIndex >= 0 ? chapters[currentIndex + 1] : null) || null;
        if (!nextChapter) {
          return res.status(200).send(success({
            chapterId: Number(chapter.id || 0),
            chapterTitle: String(chapter.title || ""),
            state,
            endDialog: "已完结",
            messages: [asDebugMessage({
              role: String(rolePair.narratorRole.name || "旁白"),
              roleType: "narrator",
              eventType: "on_debug_complete",
              content: `章节《${String(chapter.title || "当前章节")}》完成，故事已完结。`,
            })],
          }));
        }
        state.chapterId = Number(nextChapter.id || 0);
        const openingMessage = asDebugMessage(resolveOpeningMessage(world, nextChapter));
        return res.status(200).send(success({
          chapterId: Number(nextChapter.id || 0),
          chapterTitle: String(nextChapter.title || ""),
          state,
          endDialog: null,
          messages: [openingMessage],
        }));
      }

      const orchestrator = await runNarrativeOrchestrator({
        userId,
        world,
        chapter,
        state,
        recentMessages,
        playerMessage: playerContent,
      });
      applyOrchestratorResultToState(state, orchestrator);
      const memory = await runStoryMemoryManager({
        userId,
        world,
        chapter,
        state,
        recentMessages: [
          ...recentMessages,
          {
            role: orchestrator.role,
            roleType: orchestrator.roleType,
            eventType: "on_debug_reply",
            content: orchestrator.content,
            createTime: nowTs(),
          },
        ],
      });
      applyMemoryResultToState(state, memory);

      return res.status(200).send(success({
        chapterId: Number(chapter.id || 0),
        chapterTitle: String(chapter.title || ""),
        state,
        endDialog: null,
        messages: [asDebugMessage({
          role: orchestrator.role,
          roleType: orchestrator.roleType,
          eventType: "on_debug_reply",
          content: orchestrator.content,
        })],
      }));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
