import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import {
  getGameDb,
  normalizeChapterOutput,
  normalizeRolePair,
  normalizeSessionState,
  parseJsonSafe,
} from "@/lib/gameEngine";
import {
  applyPlayerProfileFromMessageToState,
  allowPlayerTurn,
  runStorySpeakerContent,
  RuntimeMessageInput,
  runtimeStoryRoles,
  setRuntimeTurnState,
} from "@/modules/game-runtime/engines/NarrativeOrchestrator";
import {
  applyDebugNarrativeMessageProgress,
  cacheAndBuildDebugStateSnapshot,
  asDebugMessage,
  buildDebugMessageWithRevisitData,
  buildDebugRecentMessages,
  debugMessageSchema,
  evaluateDebugRuntimeOutcome,
  getPendingDebugChapterId,
  isDebugFreePlotActive,
  loadCachedDebugRuntimeState,
  resolveNextChapter,
  saveDebugRevisitPoint,
  setPendingDebugChapterId,
  syncDebugChapterRuntime,
  buildDebugEndDialogDetail,
} from "./debugRuntimeShared";
import u from "@/utils";

const router = express.Router();

function flushStreamResponse(res: express.Response) {
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
  const anyRes = res as express.Response & { flush?: () => void };
  if (typeof anyRes.flush === "function") {
    anyRes.flush();
  }
}

function writeStreamLine(res: express.Response, payload: Record<string, unknown>) {
  res.write(`${JSON.stringify(payload)}\n`);
  flushStreamResponse(res);
}

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
  if (buffer) chunks.push(buffer);
  return chunks;
}

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

export default router.post(
  "/",
  validateFields({
    sessionId: z.string().optional().nullable(),
    worldId: z.number().optional().nullable(),
    chapterId: z.number().optional().nullable(),
    playerContent: z.string().optional().nullable(),
    state: z.any().optional().nullable(),
    messages: z.array(debugMessageSchema).optional().nullable(),
    plan: z.object({
      role: z.string().optional().nullable(),
      roleType: z.string().optional().nullable(),
      motive: z.string().optional().nullable(),
      eventType: z.string().optional().nullable(),
      presetContent: z.string().optional().nullable(),
    }).passthrough().optional().nullable(),
  }),
  async (req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    try {
      const db = getGameDb();
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        res.status(401);
        writeStreamLine(res, { type: "error", data: { message: "用户未登录" } });
        return;
      }

      const sessionId = String(req.body.sessionId || "").trim();
      const worldId = Number(req.body.worldId || 0);
      const chapterId = Number(req.body.chapterId || 0);
      const playerContent = String(req.body.playerContent || "").trim();
      const plan = (req.body.plan || {}) as Record<string, unknown>;
      const inputMessages = (Array.isArray(req.body.messages) ? req.body.messages : []) as RuntimeMessageInput[];

      let world: any = null;
      let chapter: any = null;
      let messages: RuntimeMessageInput[] = [];
      let state: Record<string, any> = {};
      if (sessionId) {
        const sessionRow = await db("t_gameSession").where({ sessionId }).first();
        if (!sessionRow) {
          res.status(404);
          writeStreamLine(res, { type: "error", data: { message: "会话不存在" } });
          return;
        }
        if (userId > 0 && Number(sessionRow.userId || 0) !== userId) {
          res.status(403);
          writeStreamLine(res, { type: "error", data: { message: "无权访问该会话" } });
          return;
        }
        world = await db("t_storyWorld as w")
          .leftJoin("t_project as p", "w.projectId", "p.id")
          .where("w.id", Number(sessionRow.worldId || 0))
          .select("w.*")
          .first();
        chapter = await db("t_storyChapter").where({ id: Number(sessionRow.chapterId || 0) }).first();
        chapter = normalizeChapterOutput(chapter);
        const rolePair = normalizeRolePair(world?.playerRole, world?.narratorRole);
        state = normalizeSessionState(
          sessionRow.stateJson,
          Number(sessionRow.worldId || 0),
          Number(chapter?.id || sessionRow.chapterId || 0) || null,
          rolePair,
          world,
        );
        const pendingPlan = parseJsonSafe<Record<string, unknown>>(state?.pendingNarrativePlan, {});
        if (!Object.keys(plan).length && Object.keys(pendingPlan).length) {
          Object.assign(plan, pendingPlan);
        }
        const rawRecentMessages = await db("t_sessionMessage").where({ sessionId }).orderBy("id", "desc").limit(20);
        messages = rawRecentMessages
          .reverse()
          .map((item: any) => ({
            role: String(item.role || ""),
            roleType: String(item.roleType || ""),
            eventType: String(item.eventType || ""),
            content: String(item.content || ""),
            createTime: Number(item.createTime || 0),
          }));
      } else {
        world = await db("t_storyWorld as w")
          .leftJoin("t_project as p", "w.projectId", "p.id")
          .where("w.id", worldId)
          .where("p.userId", userId)
          .select("w.*")
          .first();
      }
      if (!world) {
        res.status(404);
        writeStreamLine(res, { type: "error", data: { message: "未找到故事" } });
        return;
      }

      if (!sessionId) {
        if (chapterId > 0) {
          chapter = await db("t_storyChapter").where({ id: chapterId, worldId }).first();
        }
        if (!chapter) {
          chapter = await db("t_storyChapter").where({ worldId }).orderBy("sort", "asc").orderBy("id", "asc").first();
        }
        chapter = normalizeChapterOutput(chapter);
      }
      if (!chapter) {
        res.status(404);
        writeStreamLine(res, { type: "error", data: { message: "当前没有章节可游玩或者调试" } });
        return;
      }

      const rolePair = normalizeRolePair(world.playerRole, world.narratorRole);
      if (!sessionId) {
        const cachedRuntimeState = loadCachedDebugRuntimeState(req.body.state, userId, worldId);
        state = normalizeSessionState(
          cachedRuntimeState || req.body.state,
          worldId,
          Number(chapter.id || 0),
          rolePair,
          world,
        );
        if (playerContent) {
          applyPlayerProfileFromMessageToState(state, world, playerContent);
        }
        messages = inputMessages.map((item) => ({
          role: String(item.role || ""),
          roleType: String(item.roleType || ""),
          eventType: String(item.eventType || ""),
          content: String(item.content || ""),
          createTime: Number(item.createTime || 0),
        }));
      }
      const recentMessages = buildDebugRecentMessages(messages, String(state.player?.name || rolePair.playerRole.name || "用户"), playerContent);
      const roleName = String(plan.role || "").trim();
      const roleType = String(plan.roleType || "").trim() || "narrator";
      const eventType = String(plan.eventType || "on_orchestrated_reply").trim() || "on_orchestrated_reply";
      const presetContent = String(plan.presetContent || "").trim();

      writeStreamLine(res, {
        type: "start",
        data: {
          role: roleName,
          roleType,
          eventType,
        },
      });

      let content = presetContent;
      if (!content) {
        const roles = runtimeStoryRoles(world, state);
        const currentRole = roles.find((item) => item.name === roleName)
          || roles.find((item) => item.roleType === roleType && roleType !== "player")
          || null;
        if (!currentRole) {
          throw new Error("当前流式发言角色不存在");
        }
        let heartbeatTimer: NodeJS.Timeout | null = null;
        try {
          heartbeatTimer = setInterval(() => {
            try {
              writeStreamLine(res, {
                type: "heartbeat",
                data: {
                  stage: "speaker_generating",
                  timestamp: Date.now(),
                },
              });
            } catch {
              // 响应已关闭时忽略心跳异常，避免影响主流程。
            }
          }, 5000);
          content = await runStorySpeakerContent({
            userId,
            world,
            chapter,
            state,
            recentMessages,
            playerMessage: playerContent,
            currentRole,
            motive: String(plan.motive || "").trim(),
          });
        } finally {
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
          }
        }
      }

      const chunks = splitTextIntoChunks(content);
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

      let donePayload: Record<string, unknown> = {
        content,
        message: asDebugMessage({
          role: roleName || "旁白",
          roleType,
          eventType,
          content,
        }),
      };

      if (!sessionId) {
        syncDebugChapterRuntime(chapter, state);
        const emittedMessage: RuntimeMessageInput = {
          role: roleName || "旁白",
          roleType,
          eventType,
          content,
          createTime: Date.now(),
        };
        const normalizedEventType = String(emittedMessage.eventType || "").trim().toLowerCase();
        const isOpeningMessage = normalizedEventType === "on_opening";
        // 开场白属于章节外引导消息，只负责把用户带入故事，不应该直接推进章节正文或结束条件。
        // 否则回溯到“开场白”时，后端保存下来的 state 会已经跳到章节内容/结束条件，导致回溯快照脏掉。
        const phaseAdvance = isOpeningMessage
          ? { enteredUserPhase: false }
          : applyDebugNarrativeMessageProgress({
            chapter,
            state,
            role: String(emittedMessage.role || ""),
            roleType: String(emittedMessage.roleType || ""),
            content: String(emittedMessage.content || ""),
          });
        const debugFreePlotActive = isDebugFreePlotActive(state);
        const outcome = isOpeningMessage
          ? {
            result: "continue" as const,
            nextChapterId: null,
            matchedBy: "none" as const,
            matchedRule: null,
          }
          : await evaluateDebugRuntimeOutcome({
            chapter,
            state,
            messageContent: String(emittedMessage.content || ""),
            eventType: String(emittedMessage.eventType || ""),
            meta: {},
            recentMessages: [...recentMessages, emittedMessage],
            debugFreePlotActive,
          });

        let endDialog: string | null = null;
        if (outcome.result === "failed") {
          endDialog = "已失败";
          setRuntimeTurnState(state, world, {
            canPlayerSpeak: false,
            expectedRoleType: String(plan.nextRoleType || "narrator"),
            expectedRole: String(plan.nextRole || roleName || rolePair.narratorRole.name || "旁白"),
            lastSpeakerRoleType: roleType,
            lastSpeaker: roleName || rolePair.narratorRole.name || "旁白",
          });
        } else if (outcome.result === "success") {
          const nextChapter = await resolveNextChapter(db, worldId, chapter, outcome.nextChapterId);
          if (!nextChapter) {
            (state as any).debugFreePlot = {
              active: true,
              fromChapterId: Number(chapter.id || 0),
              unlockedAt: Date.now(),
            };
            endDialog = "进入自由剧情";
          } else {
            setPendingDebugChapterId(state, Number(nextChapter.id || 0));
            setRuntimeTurnState(state, world, {
              canPlayerSpeak: false,
              expectedRoleType: "narrator",
              expectedRole: String(rolePair.narratorRole.name || "旁白"),
              lastSpeakerRoleType: roleType,
              lastSpeaker: roleName || rolePair.narratorRole.name || "旁白",
            });
          }
        } else if (isOpeningMessage) {
          // 开场白结束后仍应由系统继续推进到第一章首轮编排，而不是在这里改变章节事件状态。
          setRuntimeTurnState(state, world, {
            canPlayerSpeak: false,
            expectedRoleType: "narrator",
            expectedRole: String(rolePair.narratorRole.name || "旁白"),
            lastSpeakerRoleType: roleType,
            lastSpeaker: roleName || rolePair.narratorRole.name || "旁白",
          });
        } else {
          const shouldYieldToUser = phaseAdvance.enteredUserPhase
            || String(plan.nextRoleType || "").trim().toLowerCase() === "player";
          if (shouldYieldToUser) {
            allowPlayerTurn(state, world, roleType, roleName || rolePair.narratorRole.name || "旁白");
          } else {
            setRuntimeTurnState(state, world, {
              canPlayerSpeak: false,
              expectedRoleType: String(plan.nextRoleType || "narrator"),
              expectedRole: String(plan.nextRole || roleName || rolePair.narratorRole.name || "旁白"),
              lastSpeakerRoleType: roleType,
              lastSpeaker: roleName || rolePair.narratorRole.name || "旁白",
            });
          }
        }

        const debugMessageCount = Math.max(0, Number(state.debugMessageCount || 0)) + 1;
        state.debugMessageCount = debugMessageCount;
        const snapshot = cacheAndBuildDebugStateSnapshot({
          userId,
          worldId,
          state,
        });
        // 调试回溯必须保存“截至当前台词”为止的完整消息列表，不能只存本轮新增的一句。
        saveDebugRevisitPoint(
          String(snapshot.debugRuntimeKey || ""),
          state,
          [...messages, emittedMessage],
          Number(chapter.id || 0) || null,
          debugMessageCount,
        );
        donePayload.message = buildDebugMessageWithRevisitData(
          emittedMessage,
          String(snapshot.debugRuntimeKey || ""),
          debugMessageCount,
          true,
        );
        donePayload = {
          ...donePayload,
          state: snapshot,
          chapterId: Number(chapter.id || 0),
          chapterTitle: String(chapter.title || ""),
          endDialog,
          endDialogDetail: buildDebugEndDialogDetail({
            endDialog,
            chapterTitle: String(chapter.title || ""),
            matchedBy: outcome.matchedBy,
            matchedRule: outcome.matchedRule,
          }),
          currentEventDigest: snapshot.currentEventDigest || null,
          eventDigestWindow: Array.isArray(snapshot.eventDigestWindow) ? snapshot.eventDigestWindow : [],
          eventDigestWindowText: String(snapshot.eventDigestWindowText || ""),
          pendingChapterId: getPendingDebugChapterId(state),
        };
      }

      writeStreamLine(res, {
        type: "done",
        data: donePayload,
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
