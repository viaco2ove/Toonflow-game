import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import {
  getGameDb,
  normalizeChapterOutput,
  normalizeRolePair,
  normalizeSessionState,
} from "@/lib/gameEngine";
import {
  RuntimeMessageInput,
  setRuntimeTurnState,
} from "@/modules/game-runtime/engines/NarrativeOrchestrator";
import {
  asDebugMessage,
  buildDebugMessageWithRevisitData,
  buildDebugRecentMessages,
  cacheAndBuildDebugStateSnapshot,
  debugMessageSchema,
  evaluateDebugRuntimeOutcome,
  isDebugFreePlotActive,
  loadCachedDebugRuntimeState,
  resolveNextChapter,
  saveDebugRevisitPoint,
  setPendingDebugChapterId,
  syncDebugChapterRuntime,
} from "./debugRuntimeShared";
import u from "@/utils";
import { DebugLogUtil } from "@/utils/debugLogUtil";

const router = express.Router();

/**
 * 刷新流式响应头，确保浏览器能尽快收到 NDJSON 事件。
 */
function flushStreamResponse(res: express.Response) {
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
  const anyRes = res as express.Response & { flush?: () => void };
  if (typeof anyRes.flush === "function") {
    anyRes.flush();
  }
}

/**
 * 向前端写入一条 NDJSON 流事件。
 */
function writeStreamLine(res: express.Response, payload: Record<string, unknown>) {
  res.write(`${JSON.stringify(payload)}\n`);
  flushStreamResponse(res);
}

/**
 * 把固定开场白切成较小片段，便于前端渐进展示。
 */
function splitTextIntoChunks(text: string): string[] {
  const normalized = String(text || "").replace(/\r/g, "").trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let buffer = "";
  for (const char of normalized) {
    buffer += char;
    if (/[。！？!?；;\n]/.test(char) || buffer.length >= 18) {
      chunks.push(buffer);
      buffer = "";
    }
  }
  if (buffer) {
    chunks.push(buffer);
  }
  return chunks;
}

/**
 * 从分片缓冲里提取完整句子事件，给前端做逐句高亮或字幕显示。
 */
function collectSentenceEvents(buffer: string, chunk: string) {
  const sentences: string[] = [];
  let nextBuffer = `${buffer}${chunk}`;
  while (/[。！？!?；;\n]/.test(nextBuffer)) {
    const matched = nextBuffer.match(/^[\s\S]*?[。！？!?；;\n]/);
    if (!matched) break;
    const sentence = matched[0].trim();
    nextBuffer = nextBuffer.slice(matched[0].length);
    if (sentence) {
      sentences.push(sentence);
    }
  }
  return {
    buffer: nextBuffer,
    sentences,
  };
}

/**
 * 把输入消息标准化成运行时消息。
 *
 * 用途：
 * - 调试 opening 也要把既有消息带进最近消息窗口；
 * - 这里只保留 speaker/roleType/eventType/content/createTime 这些运行态真正关心的字段。
 */
function normalizeRuntimeMessages(messages: unknown): RuntimeMessageInput[] {
  return Array.isArray(messages)
    ? messages.map((item) => {
      const record = item as Record<string, unknown>;
      return {
        role: String(record.role || ""),
        roleType: String(record.roleType || ""),
        eventType: String(record.eventType || ""),
        content: String(record.content || ""),
        createTime: Number(record.createTime || 0),
      };
    })
    : [];
}

/**
 * 调试 opening 落地后，服务端也要把运行态推进到“等待下一句正文”。
 *
 * 用途：
 * - 正式游玩只需要回放 preset 文案；
 * - 调试链还要更新缓存里的 debug state、回溯点和章节推进标记；
 * - 这样 opening 播完后，后续 debug orchestration 才会基于正确状态继续跑。
 */
async function applyDebugIntroductionProgress(input: {
  db: ReturnType<typeof getGameDb>;
  userId: number;
  worldId: number;
  world: any;
  chapter: any;
  state: Record<string, any>;
  messages: RuntimeMessageInput[];
  emittedMessage: RuntimeMessageInput;
}) {
  const {
    db,
    userId,
    worldId,
    world,
    chapter,
    state,
    messages,
    emittedMessage,
  } = input;
  const rolePair = normalizeRolePair(world?.playerRole, world?.narratorRole);
  const recentMessages = buildDebugRecentMessages(
    messages,
    String(state.player?.name || rolePair.playerRole.name || "用户"),
    "",
  );

  syncDebugChapterRuntime(chapter, state);
  const debugFreePlotActive = isDebugFreePlotActive(state);
  const outcome = await evaluateDebugRuntimeOutcome({
    chapter,
    state,
    messageContent: String(emittedMessage.content || ""),
    eventType: String(emittedMessage.eventType || ""),
    meta: {},
    recentMessages: [...recentMessages, emittedMessage],
    debugFreePlotActive,
  });

  if (outcome.result === "failed") {
    setRuntimeTurnState(state, world, {
      canPlayerSpeak: false,
      expectedRoleType: "narrator",
      expectedRole: String(rolePair.narratorRole.name || "旁白"),
      lastSpeakerRoleType: String(emittedMessage.roleType || "narrator"),
      lastSpeaker: String(emittedMessage.role || rolePair.narratorRole.name || "旁白"),
    });
  } else if (outcome.result === "success") {
    const nextChapter = await resolveNextChapter(db, worldId, chapter, outcome.nextChapterId);
    if (DebugLogUtil.isDebugLogEnabled()) {
      console.log("[story:chapter_ending_check:stats] sessionStatus: chapter_completed");
      console.log("[story:chapter_ending_check:stats] outcome: success");
      console.log(`[story:chapter_ending_check:stats] nextChapterId: ${nextChapter ? String(nextChapter.id || "") : ""}`);
    }
    if (!nextChapter) {
      (state as any).debugFreePlot = {
        active: true,
        fromChapterId: Number(chapter.id || 0),
        unlockedAt: Date.now(),
      };
    } else {
      setPendingDebugChapterId(state, Number(nextChapter.id || 0));
      setRuntimeTurnState(state, world, {
        canPlayerSpeak: false,
        expectedRoleType: "narrator",
        expectedRole: String(rolePair.narratorRole.name || "旁白"),
        lastSpeakerRoleType: String(emittedMessage.roleType || "narrator"),
        lastSpeaker: String(emittedMessage.role || rolePair.narratorRole.name || "旁白"),
      });
    }
  } else {
    setRuntimeTurnState(state, world, {
      canPlayerSpeak: false,
      expectedRoleType: "narrator",
      expectedRole: String(rolePair.narratorRole.name || "旁白"),
      lastSpeakerRoleType: String(emittedMessage.roleType || "narrator"),
      lastSpeaker: String(emittedMessage.role || rolePair.narratorRole.name || "旁白"),
    });
  }

  const fullMessages = [...messages, emittedMessage];
  const debugMessageCount = Math.max(0, Number(state.debugMessageCount || 0)) + 1;
  state.debugMessageCount = debugMessageCount;
  const snapshot = cacheAndBuildDebugStateSnapshot({
    userId,
    worldId,
    state,
  });
  const debugRuntimeKey = String(snapshot.debugRuntimeKey || "");
  saveDebugRevisitPoint(
    debugRuntimeKey,
    state,
    fullMessages,
    Number(chapter.id || 0) || null,
    debugMessageCount,
  );
  return {
    state,
    chapterId: Number(chapter.id || 0) || null,
    chapterTitle: String(chapter.title || ""),
    endDialog: String(state.debugEndDialog || "").trim() || null,
    endDialogDetail: String(state.debugEndDialogDetail || "").trim(),
    message: buildDebugMessageWithRevisitData(
      emittedMessage,
      debugRuntimeKey,
      Math.max(1, debugMessageCount),
      true,
    ),
  };
}

/**
 * /game/streamlines/introduction 只流式回放章节写死的 opening preset。
 *
 * 用途：
 * - opening 是作者写死的入场文案，不能再经过 speaker 模型改写；
 * - 正式游玩直接播放 preset；
 * - 调试链除了播放 preset，还要同步推进 debug 运行态与回溯点。
 */
export default router.post(
  "/",
  validateFields({
    sessionId: z.string().optional().nullable(),
    worldId: z.number().optional().nullable(),
    chapterId: z.number().optional().nullable(),
    state: z.any().optional().nullable(),
    messages: z.array(debugMessageSchema).optional().nullable(),
    plan: z.object({
      role: z.string().optional().nullable(),
      roleType: z.string().optional().nullable(),
      eventType: z.string().optional().nullable(),
      presetContent: z.string().optional().nullable(),
    }).passthrough(),
  }),
  async (req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    try {
      const plan = (req.body.plan || {}) as Record<string, unknown>;
      const role = String(plan.role || "旁白").trim() || "旁白";
      const roleType = String(plan.roleType || "narrator").trim() || "narrator";
      const eventType = String(plan.eventType || "on_opening").trim() || "on_opening";
      const presetContent = String(plan.presetContent || "").trim();
      if (!presetContent) {
        throw new Error("开场白为空，无法播放");
      }

      writeStreamLine(res, {
        type: "start",
        data: {
          role,
          roleType,
          eventType,
        },
      });

      const chunks = splitTextIntoChunks(presetContent);
      let sentenceBuffer = "";
      for (const chunk of chunks) {
        writeStreamLine(res, { type: "delta", data: { text: chunk } });
        const collected = collectSentenceEvents(sentenceBuffer, chunk);
        sentenceBuffer = collected.buffer;
        for (const sentence of collected.sentences) {
          writeStreamLine(res, { type: "sentence", data: { text: sentence } });
        }
      }
      const tailSentence = sentenceBuffer.trim();
      if (tailSentence) {
        writeStreamLine(res, { type: "sentence", data: { text: tailSentence } });
      }

      const emittedMessage: RuntimeMessageInput = {
        role,
        roleType,
        eventType,
        content: presetContent,
        createTime: Date.now(),
      };

      const sessionId = String(req.body.sessionId || "").trim();
      if (!sessionId) {
        const db = getGameDb();
        const userId = Number((req as any)?.user?.id || 0);
        if (!Number.isFinite(userId) || userId <= 0) {
          res.status(401);
          writeStreamLine(res, { type: "error", data: { message: "用户未登录" } });
          return;
        }

        const worldId = Number(req.body.worldId || 0);
        const chapterId = Number(req.body.chapterId || 0);
        const world = await db("t_storyWorld as w")
          .leftJoin("t_project as p", "w.projectId", "p.id")
          .where("w.id", worldId)
          .where("p.userId", userId)
          .select("w.*")
          .first();
        if (!world) {
          res.status(404);
          writeStreamLine(res, { type: "error", data: { message: "未找到故事" } });
          return;
        }

        let chapter = chapterId > 0
          ? await db("t_storyChapter").where({ id: chapterId, worldId }).first()
          : null;
        if (!chapter) {
          chapter = await db("t_storyChapter").where({ worldId }).orderBy("sort", "asc").orderBy("id", "asc").first();
        }
        chapter = normalizeChapterOutput(chapter);
        if (!chapter) {
          res.status(404);
          writeStreamLine(res, { type: "error", data: { message: "当前没有章节可调试" } });
          return;
        }

        const rolePair = normalizeRolePair(world.playerRole, world.narratorRole);
        const cachedRuntimeState = loadCachedDebugRuntimeState(req.body.state, userId, worldId);
        const state = normalizeSessionState(
          cachedRuntimeState || req.body.state,
          worldId,
          Number(chapter.id || 0),
          rolePair,
          world,
        );
        const messages = normalizeRuntimeMessages(req.body.messages);
        const progress = await applyDebugIntroductionProgress({
          db,
          userId,
          worldId,
          world,
          chapter,
          state,
          messages,
          emittedMessage,
        });

        writeStreamLine(res, {
          type: "done",
          data: {
            content: presetContent,
            message: progress.message,
            state: progress.state,
            chapterId: progress.chapterId,
            chapterTitle: progress.chapterTitle,
            endDialog: progress.endDialog,
            endDialogDetail: progress.endDialogDetail,
          },
        });
        return;
      }

      writeStreamLine(res, {
        type: "done",
        data: {
          content: presetContent,
          message: asDebugMessage(emittedMessage),
        },
      });
    } catch (err) {
      writeStreamLine(res, {
        type: "error",
        data: {
          message: u.error(err).message,
        },
      });
    } finally {
      res.end();
    }
  },
);
