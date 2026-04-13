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
} from "./debugRuntimeShared";
import u from "@/utils";

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
 * 把完整台词拆成较小的流式片段，便于前端逐段显示。
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
  if (buffer) chunks.push(buffer);
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
 * /game/streamlines 只负责流式生成当前这句台词。
 * 其他运行态、事件视图、角色卡等信息禁止混入响应体，统一由 storyInfo 接口查询。
 */
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

      const recentMessages = buildDebugRecentMessages(
        messages,
        String(state.player?.name || rolePair.playerRole.name || "用户"),
        playerContent,
      );
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
              // 响应关闭后忽略心跳异常，避免心跳本身干扰主链路。
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

      const emittedMessage: RuntimeMessageInput = {
        role: roleName || "旁白",
        roleType,
        eventType,
        content,
        createTime: Date.now(),
      };

      if (!sessionId) {
        // 调试链仍然要在服务端推进运行态和回溯快照，只是不把这些信息塞进台词流响应。
        syncDebugChapterRuntime(chapter, state);
        const normalizedEventType = String(emittedMessage.eventType || "").trim().toLowerCase();
        const isOpeningMessage = normalizedEventType === "on_opening";
        const phaseAdvance = isOpeningMessage
          ? { enteredUserPhase: false }
          : await applyDebugNarrativeMessageProgress({
            chapter,
            state,
            role: String(emittedMessage.role || ""),
            roleType: String(emittedMessage.roleType || ""),
            eventType: String(emittedMessage.eventType || ""),
            content: String(emittedMessage.content || ""),
            recentMessages: [...recentMessages, emittedMessage],
            userId,
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

        if (outcome.result === "failed") {
          setRuntimeTurnState(state, world, {
            canPlayerSpeak: false,
            expectedRoleType: "narrator",
            expectedRole: String(rolePair.narratorRole.name || "旁白"),
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
          setRuntimeTurnState(state, world, {
            canPlayerSpeak: false,
            expectedRoleType: "narrator",
            expectedRole: String(rolePair.narratorRole.name || "旁白"),
            lastSpeakerRoleType: roleType,
            lastSpeaker: roleName || rolePair.narratorRole.name || "旁白",
          });
        } else if (phaseAdvance.enteredUserPhase) {
          allowPlayerTurn(state, world, roleType, roleName || rolePair.narratorRole.name || "旁白");
        } else {
          // streamlines 不允许决定“下一个具体是谁”，这里只维持系统继续推进的通用态。
          setRuntimeTurnState(state, world, {
            canPlayerSpeak: false,
            expectedRoleType: "narrator",
            expectedRole: String(rolePair.narratorRole.name || "旁白"),
            lastSpeakerRoleType: roleType,
            lastSpeaker: roleName || rolePair.narratorRole.name || "旁白",
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
      }

      writeStreamLine(res, {
        type: "done",
        data: {
          content,
          message: !sessionId
            ? buildDebugMessageWithRevisitData(
              emittedMessage,
              String(state.debugRuntimeKey || ""),
              Math.max(1, Number(state.debugMessageCount || 1)),
              true,
            )
            : asDebugMessage(emittedMessage),
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
