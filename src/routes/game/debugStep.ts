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
  advanceNarrativeUntilPlayerTurn,
  applyMemoryResultToState,
  canPlayerSpeakNow,
  evaluateDebugChapterOutcome,
  resolveOpeningMessage,
  runNarrativeOrchestrator,
  runStoryMemoryManager,
  RuntimeMessageInput,
} from "@/modules/game-runtime/engines/NarrativeOrchestrator";
import { handleMiniGameTurn } from "@/modules/game-runtime/engines/MiniGameController";
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
        const opening = resolveOpeningMessage(world, chapter);
        const openingRuntimeMessage: RuntimeMessageInput = {
          role: String(opening.role || rolePair.narratorRole.name || "旁白"),
          roleType: String(opening.roleType || "narrator"),
          eventType: String(opening.eventType || "on_enter_chapter"),
          content: String(opening.content || ""),
          createTime: nowTs(),
        };
        const initialResult = await runNarrativeOrchestrator({
          userId,
          world,
          chapter,
          state,
          recentMessages: [openingRuntimeMessage],
          playerMessage: "",
        });
        const orchestrated = await advanceNarrativeUntilPlayerTurn({
          userId,
          world,
          chapter,
          state,
          recentMessages: [openingRuntimeMessage],
          playerMessage: "",
          initialResult,
        });
        const allMessages = [openingRuntimeMessage, ...orchestrated.messages];
        const memory = await runStoryMemoryManager({
          userId,
          world,
          chapter,
          state,
          recentMessages: allMessages,
        });
        applyMemoryResultToState(state, memory);
        return res.status(200).send(success({
          chapterId: Number(chapter.id || 0),
          chapterTitle: String(chapter.title || ""),
          state,
          endDialog: null,
          messages: allMessages.map((item) => asDebugMessage(item)),
        }));
      }

      if (!canPlayerSpeakNow(state, world)) {
        return res.status(409).send(error("当前还没轮到用户发言"));
      }

      const miniGameResult = await handleMiniGameTurn({
        userId,
        world,
        chapter,
        state,
        recentMessages,
        playerMessage: playerContent,
        mode: "debug",
      });
      if (miniGameResult?.intercepted) {
        return res.status(200).send(success({
          chapterId: Number(chapter.id || 0),
          chapterTitle: String(chapter.title || ""),
          state,
          endDialog: null,
          messages: miniGameResult.message ? [asDebugMessage({
            role: miniGameResult.message.role,
            roleType: miniGameResult.message.roleType,
            eventType: miniGameResult.message.eventType,
            content: miniGameResult.message.content,
            createTime: nowTs(),
          })] : [],
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
        const nextOpening = resolveOpeningMessage(world, nextChapter);
        const nextOpeningRuntimeMessage: RuntimeMessageInput = {
          role: String(nextOpening.role || rolePair.narratorRole.name || "旁白"),
          roleType: String(nextOpening.roleType || "narrator"),
          eventType: String(nextOpening.eventType || "on_enter_chapter"),
          content: String(nextOpening.content || ""),
          createTime: nowTs(),
        };
        const nextInitialResult = await runNarrativeOrchestrator({
          userId,
          world,
          chapter: nextChapter,
          state,
          recentMessages: [nextOpeningRuntimeMessage],
          playerMessage: "",
        });
        const nextOrchestrated = await advanceNarrativeUntilPlayerTurn({
          userId,
          world,
          chapter: nextChapter,
          state,
          recentMessages: [nextOpeningRuntimeMessage],
          playerMessage: "",
          initialResult: nextInitialResult,
        });
        const switchedMessages = [nextOpeningRuntimeMessage, ...nextOrchestrated.messages];
        const memory = await runStoryMemoryManager({
          userId,
          world,
          chapter: nextChapter,
          state,
          recentMessages: [
            ...recentMessages,
            ...switchedMessages,
          ],
        });
        applyMemoryResultToState(state, memory);
        return res.status(200).send(success({
          chapterId: Number(nextChapter.id || 0),
          chapterTitle: String(nextChapter.title || ""),
          state,
          endDialog: null,
          messages: switchedMessages.map((item) => asDebugMessage(item)),
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
      const orchestrated = await advanceNarrativeUntilPlayerTurn({
        userId,
        world,
        chapter,
        state,
        recentMessages,
        playerMessage: playerContent,
        initialResult: orchestrator,
      });
      if (orchestrated.chapterOutcome === "failed") {
        return res.status(200).send(success({
          chapterId: Number(chapter.id || 0),
          chapterTitle: String(chapter.title || ""),
          state,
          endDialog: "已失败",
          messages: orchestrated.messages.map((item) => asDebugMessage(item)),
        }));
      }
      if (orchestrated.chapterOutcome === "success") {
        const chapters = (await db("t_storyChapter").where({ worldId }).orderBy("sort", "asc").orderBy("id", "asc"))
          .map((item: any) => normalizeChapterOutput(item));
        const explicitNext = orchestrated.nextChapterId
          ? chapters.find((item: any) => Number(item.id) === Number(orchestrated.nextChapterId))
          : null;
        const currentIndex = chapters.findIndex((item: any) => Number(item.id) === Number(chapter.id));
        const nextChapter = explicitNext || (currentIndex >= 0 ? chapters[currentIndex + 1] : null) || null;
        if (!nextChapter) {
          return res.status(200).send(success({
            chapterId: Number(chapter.id || 0),
            chapterTitle: String(chapter.title || ""),
            state,
            endDialog: "已完结",
            messages: orchestrated.messages.map((item) => asDebugMessage(item)),
          }));
        }
        state.chapterId = Number(nextChapter.id || 0);
        const nextOpening = resolveOpeningMessage(world, nextChapter);
        const nextOpeningRuntimeMessage: RuntimeMessageInput = {
          role: String(nextOpening.role || rolePair.narratorRole.name || "旁白"),
          roleType: String(nextOpening.roleType || "narrator"),
          eventType: String(nextOpening.eventType || "on_enter_chapter"),
          content: String(nextOpening.content || ""),
          createTime: nowTs(),
        };
        const nextInitialResult = await runNarrativeOrchestrator({
          userId,
          world,
          chapter: nextChapter,
          state,
          recentMessages: [nextOpeningRuntimeMessage],
          playerMessage: "",
        });
        const nextOrchestrated = await advanceNarrativeUntilPlayerTurn({
          userId,
          world,
          chapter: nextChapter,
          state,
          recentMessages: [nextOpeningRuntimeMessage],
          playerMessage: "",
          initialResult: nextInitialResult,
        });
        const switchedMessages = [nextOpeningRuntimeMessage, ...nextOrchestrated.messages];
        const memory = await runStoryMemoryManager({
          userId,
          world,
          chapter: nextChapter,
          state,
          recentMessages: [
            ...recentMessages,
            ...orchestrated.messages,
            ...switchedMessages,
          ],
        });
        applyMemoryResultToState(state, memory);
        return res.status(200).send(success({
          chapterId: Number(nextChapter.id || 0),
          chapterTitle: String(nextChapter.title || ""),
          state,
          endDialog: null,
          messages: [
            ...orchestrated.messages.map((item) => asDebugMessage(item)),
            ...switchedMessages.map((item) => asDebugMessage(item)),
          ],
        }));
      }
      const memory = await runStoryMemoryManager({
        userId,
        world,
        chapter,
        state,
        recentMessages: [
          ...recentMessages,
          ...orchestrated.messages,
        ],
      });
      applyMemoryResultToState(state, memory);

      return res.status(200).send(success({
        chapterId: Number(chapter.id || 0),
        chapterTitle: String(chapter.title || ""),
        state,
        endDialog: null,
        messages: orchestrated.messages.map((item) => asDebugMessage(item)),
      }));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
