import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import {
  getGameDb,
  normalizeChapterOutput,
  normalizeRolePair,
  normalizeSessionState,
  parseJsonSafe,
  readChapterProgressState,
} from "@/lib/gameEngine";
import {
  applyPlayerProfileFromMessageToState,
  allowPlayerTurn,
  runStorySpeakerContent,
  RuntimeMessageInput,
  runtimeStoryRoles,
  setRuntimeTurnState,
} from "@/modules/game-runtime/engines/NarrativeOrchestrator";
import { generateTaskSpeech } from "@/modules/game-runtime/agents/taskMode/TaskSpeakerAgent";
import {
  applyDebugNarrativeMessageProgress,
  cacheAndBuildDebugStateSnapshot,
  asDebugMessage,
  buildDebugMessageWithRevisitData,
  buildDebugMessageSpeechCount,
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
import { DebugLogUtil } from "@/utils/debugLogUtil";
import { miniGameStateManager } from "@/modules/game-runtime/engines/MiniGameStateManager";

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
 * /game/streamlines/introduction 只流式回放章节写死的 opening preset。
 * 其他运行态、事件视图、角色卡等信息禁止混入响应体，统一由 storyInfo 接口查询。
 */
function createIntroductionHandler() {
  return async (req: express.Request, res: express.Response) => {
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
  };
}

/**
 * 把输入消息标准化成运行时消息。
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
 * 调试 opening 落地后，服务端也要把运行态推进到"等待下一句正文"。
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
    state,
  );

  syncDebugChapterRuntime(chapter, state);
  const debugFreePlotActive = isDebugFreePlotActive(state);
  // 获取当前事件进度，补充到 emittedMessage
  const chapterProgress = readChapterProgressState(state);
  const speechCount = buildDebugMessageSpeechCount(recentMessages, String(emittedMessage.role || ""), state);
  const emittedMessageWithProgress = {
    ...emittedMessage,
    eventIndex: chapterProgress?.eventIndex ?? null,
    stageIndex: chapterProgress?.stageIndex ?? 0,
    phaseId: chapterProgress?.phaseId ?? null,
    roleNumSpeechCurrEvent: speechCount.roleNumSpeechCurrEvent,
    roleNumSpeechCurrStage: speechCount.roleNumSpeechCurrStage,
  };
  const outcome = await evaluateDebugRuntimeOutcome({
    userId,
    world,
    chapter,
    state,
    messageContent: String(emittedMessage.content || ""),
    eventType: String(emittedMessage.eventType || ""),
    meta: {},
    recentMessages: [...recentMessages, emittedMessageWithProgress],
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

// 注册 /introduction 子路由（前端调用 /game/streamlines/introduction）
router.post("/introduction", createIntroductionHandler());

/**
 * /game/streamlines 只负责流式生成当前这句台词。
 * 其他运行态、事件视图、角色卡等信息禁止混入响应体，统一由 storyInfo 接口查询。
 */
router.post(
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
        } else if (Object.keys(pendingPlan).length) {
          // 小游戏编排接口只返回 role/roleType/motive，这里从 pendingPlan 补全 eventType 等关键字段
          if (!plan.eventType && pendingPlan.eventType) {
            plan.eventType = pendingPlan.eventType;
          }
          if (!plan.source && pendingPlan.source) {
            plan.source = pendingPlan.source;
          }
          if (!plan.presetContent && pendingPlan.presetContent) {
            plan.presetContent = pendingPlan.presetContent;
          }
          // ★ 任务模式专属字段：speakerRouteReason / taskMeta
          if (!plan.speakerRouteReason && pendingPlan.speakerRouteReason) {
            plan.speakerRouteReason = pendingPlan.speakerRouteReason;
          }
          if (!(plan as any).taskMeta && (pendingPlan as any).taskMeta) {
            (plan as any).taskMeta = (pendingPlan as any).taskMeta;
          }
          if (!plan.motive && pendingPlan.motive) {
            plan.motive = pendingPlan.motive;
          }
        }
        // 小游戏模式时，只用小游戏相关的消息，避免章节事件污染小游戏台词
        const isMiniGamePlan = pendingPlan && String(pendingPlan.source || "") === "rule";
        const rawRecentMessages = await db("t_sessionMessage").where({ sessionId }).orderBy("id", "desc").limit(20);
        let allMessages = rawRecentMessages
          .reverse()
          .map((item: any) => ({
            role: String(item.role || ""),
            roleType: String(item.roleType || ""),
            eventType: String(item.eventType || ""),
            content: String(item.content || ""),
            createTime: Number(item.createTime || 0),
          }));
        // 小游戏模式下过滤，只保留 on_mini_game 系列消息
        if (isMiniGamePlan) {
          messages = allMessages.filter((m: { eventType?: string }) => m.eventType?.startsWith("on_mini_game"));
          // 如果过滤后消息太少（小于3条），补上最新的几条
          if (messages.length < 3 && allMessages.length > 0) {
            messages = allMessages.slice(-3);
          }
        } else {
          messages = allMessages;
        }
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
        state,
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

      const roles = runtimeStoryRoles(world, state);
      const currentRole = roles.find((item) => item.name === roleName)
        || roles.find((item) => item.roleType === roleType && roleType !== "player")
        || null;
      if (!currentRole) {
        throw new Error("当前流式发言角色不存在");
      }
      // 预置文本不再直接回填到聊天框。
      //
      // 用途：
      // - 避免接口一返回就先插入固定文案，导致页面立刻出现“获取台词中”的伪台词框；
      // - opening / 规则分支 / 兜底分支仍可把旧 preset 文本当作生成提示，而不是最终输出；
      // - 这样所有正式台词统一经过 speaker 模型，输出风格才不会一半模板一半模型。
      const effectiveMotive = String(plan.motive || "").trim() || presetContent;
      let content = "";

      // 小游戏规则说明回合（on_mini_game_start）直接使用 presetContent 作为最终输出，
      // 跳过 speaker 模型。原因：规则说明包含完整的可选项列表，speaker 有字数限制会丢失关键信息。
      const isMiniGameStartEvent = eventType === "on_mini_game_start" && presetContent;
      // ★ 任务模式：plan 由 TaskDirector 编排好（含 speakerRouteReason="task-mode-plan"），
      //   这里调用 TaskSpeaker 生成自然语言台词，而不是走主线 speaker
      const isTaskModePlan = String(plan.speakerRouteReason || "").trim() === "task-mode-plan";
      // 任务完成（presetContent 已存好）直接落库，不走 Speaker
      const hasFinishedPreset = eventType === "on_mini_game_finished" && presetContent;
      if (isMiniGameStartEvent) {
        content = presetContent;
      } else if (hasFinishedPreset) {
        content = presetContent;
      } else if (isTaskModePlan) {
        // 任务模式：调用 TaskSpeakerAgent 生成台词
        let heartbeatTimer: NodeJS.Timeout | null = null;
        try {
          heartbeatTimer = setInterval(() => {
            try {
              writeStreamLine(res, {
                type: "heartbeat",
                data: { stage: "task_speaker_generating", timestamp: Date.now() },
              });
            } catch {
              // 心跳异常忽略
            }
          }, 5000);
          const card = (state.player?.parameterCardJson || {}) as Record<string, any>;
          const exec = (card.executing_task || {}) as Record<string, any>;
          const taskInfo = {
            objective: String(exec.objective || ""),
          };
          const npcCard = String(currentRole.parameterCardJson || currentRole.description || "");
          const taskMeta = (plan as any).taskMeta || {};
          const directorResult = {
            speaker: roleName,
            speakerRole: roleType === "npc" ? "npc" : "narrator",
            motive: effectiveMotive || "推进任务",
            taskType: String(taskMeta.taskType || "advance") as any,
            direction: String(taskMeta.direction || effectiveMotive || ""),
            expectedResult: String(taskMeta.expectedResult || "玩家推进任务"),
          } as const;
          const dialogueForSpeaker = recentMessages.map((m) => ({
            role: String((m as any).role || "?"),
            content: String((m as any).content || ""),
          }));
          const speakerResult = await generateTaskSpeech(
            directorResult as any,
            npcCard,
            taskInfo,
            dialogueForSpeaker,
            playerContent,
            userId,
          );
          content = String(speakerResult.content || "").trim() || effectiveMotive || "";
        } finally {
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
          }
        }
      } else {
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
            motive: effectiveMotive,
            eventType,
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

      const chapterProgressForEmitter = readChapterProgressState(state);
      const speechCount = buildDebugMessageSpeechCount(recentMessages, roleName || "旁白", state);
      const emittedMessage: RuntimeMessageInput = {
        role: roleName || "旁白",
        roleType,
        eventType,
        content,
        createTime: Date.now(),
        eventIndex: chapterProgressForEmitter?.eventIndex ?? null,
        stageIndex: chapterProgressForEmitter?.stageIndex ?? 0,
        phaseId: chapterProgressForEmitter?.phaseId ?? null,
        roleNumSpeechCurrEvent: speechCount.roleNumSpeechCurrEvent,
        roleNumSpeechCurrStage: speechCount.roleNumSpeechCurrStage,
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
            userId,
            world,
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
          if (DebugLogUtil.isDebugLogEnabled()) {
            // 这里记录当前台词落地后真正解析出来的下一章，避免摘要里只看到模型返回的空 nextChapterId。
            console.log(`[story:chapter_ending_check:stats] sessionStatus: chapter_completed`);
            console.log(`[story:chapter_ending_check:stats] outcome: success`);
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

      // 判断是剧情模式还是小游戏模式，用于日志输出
      const isMiniGameMode = miniGameStateManager.isMiniGameMode(state || {});
      if (DebugLogUtil.isDebugLogEnabled()) {
        if (isMiniGameMode) {
          const gameInfo = miniGameStateManager.getMiniGameStateInfo(state || {});
          console.log(`[story:streamlines:debug] 小游戏模式 - ${gameInfo.displayName || gameInfo.gameType} | ${gameInfo.phaseName || gameInfo.phase || "unknown"} | motive: ${String(plan.motive || "").slice(0, 50)}`);
        } else {
          console.log(`[story:streamlines:debug] 剧情模式 - role: ${roleName}, eventType: ${eventType}, contentPreview: ${String(content || "").slice(0, 80)}`);
        }
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

export default router;
