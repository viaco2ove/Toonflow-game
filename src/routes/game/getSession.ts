import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  extractFirstChapterDialogueLine,
  getGameDb,
  normalizeChapterOutput,
  readDefaultRuntimeEventViewState,
  normalizeRolePair,
  normalizeSessionState,
  normalizeMessageOutput,
  normalizeWorldOutput,
  toJsonText,
} from "@/lib/gameEngine";
import { ensureWorldRolesWithAiParameterCards } from "@/lib/roleParameterCard";
import { resolveOpeningMessage, setRuntimeTurnState } from "@/modules/game-runtime/engines/NarrativeOrchestrator";
import { initializeChapterProgressForState, syncChapterProgressWithRuntime } from "@/modules/game-runtime/engines/ChapterProgressEngine";
import u from "@/utils";

const router = express.Router();

function buildRecoveredOpeningMessages(world: any, chapter: any, state: Record<string, any>): Array<{
  role: string;
  roleType: string;
  eventType: string;
  content: string;
  createTime: number;
}> {
  const now = Date.now();
  const messages: Array<{
    role: string;
    roleType: string;
    eventType: string;
    content: string;
    createTime: number;
  }> = [];
  const openingMessage = resolveOpeningMessage(world, chapter);
  if (openingMessage && String(openingMessage.content || "").trim()) {
    messages.push({
      role: String(openingMessage.role || state.narrator?.name || "旁白"),
      roleType: String(openingMessage.roleType || "narrator"),
      eventType: String(openingMessage.eventType || "on_opening"),
      content: String(openingMessage.content || ""),
      createTime: now,
    });
  }
  const firstDialogue = extractFirstChapterDialogueLine(chapter?.content);
  const firstDialogueContent = String(firstDialogue?.line || "").trim();
  const openingContent = String(openingMessage?.content || "").trim();
  if (!firstDialogueContent || firstDialogueContent === openingContent) {
    return messages;
  }
  const firstDialogueRole = String(firstDialogue?.role || "").trim();
  const narratorName = String(state.narrator?.name || "旁白").trim();
  const userName = String(state.player?.name || "用户").trim();
  let roleType = "npc";
  if (!firstDialogueRole || firstDialogueRole === narratorName || firstDialogueRole === "旁白") {
    roleType = "narrator";
  } else if (firstDialogueRole === userName || firstDialogueRole === "用户") {
    roleType = "player";
  }
  messages.push({
    role: firstDialogueRole || narratorName,
    roleType,
    eventType: "on_enter_chapter",
    content: firstDialogueContent,
    createTime: now + 1,
  });
  return messages;
}

/**
 * 判断当前会话是否仍处于“只展示章节开局消息、尚未进入正式游玩”的阶段。
 *
 * 用途：
 * - 只有这种初始阶段才允许用最新章节配置覆盖旧 opening；
 * - 一旦已经有用户输入，就必须保留真实游玩记录，不能再重建消息。
 */
function shouldRepairInitialSessionMessages(params: {
  state: Record<string, any>;
  rawMessages: any[];
  expectedMessages: Array<{
    eventType: string;
    content: string;
  }>;
}): boolean {
  if (Number(params.state.round || 0) > 0) {
    return false;
  }
  if (!params.rawMessages.length) {
    return true;
  }
  const hasUserMessage = params.rawMessages.some((message) => String(message?.roleType || "").trim() === "player");
  if (hasUserMessage) {
    return false;
  }
  const firstExpectedMessage = params.expectedMessages[0];
  const firstActualMessage = params.rawMessages[0];
  if (!firstExpectedMessage) {
    return false;
  }
  if (String(firstActualMessage?.eventType || "").trim() !== String(firstExpectedMessage.eventType || "").trim()) {
    return true;
  }
  if (String(firstActualMessage?.content || "").trim() !== String(firstExpectedMessage.content || "").trim()) {
    return true;
  }
  return params.rawMessages.some((message, index) => {
    if (index === 0) return false;
    const actualEventType = String(message?.eventType || "").trim();
    const expectedMessage = params.expectedMessages[index];
    // opening 后如果直接残留 AI 自动续写，说明这批初始消息已经脏了，需要整体重建。
    if (actualEventType === "on_orchestrated_reply") {
      return true;
    }
    if (!expectedMessage) {
      return true;
    }
    return String(message?.content || "").trim() !== String(expectedMessage.content || "").trim();
  });
}

/**
 * 重建章节开局消息后，同步修正会话的初始 turnState 和章节事件进度。
 *
 * 用途：
 * - 避免只换了 opening 文案，但 turnState 仍停留在旧 AI 自动续写后的状态；
 * - 保持和 `startSession` 首次建会话时相同的回合起点。
 */
function repairInitialSessionState(params: {
  world: any;
  chapter: any;
  state: Record<string, any>;
  repairedMessages: Array<{
    role: string;
    roleType: string;
    eventType: string;
    content: string;
    createTime: number;
  }>;
}) {
  const normalizedContent = String(params.chapter?.content || "").replaceAll("\r\n", "\n");
  const explicitDialogueCount = (normalizedContent.match(/^@[^:\n：]+\s*[:：]/gm) || []).length;
  const shouldWaitUserInput = explicitDialogueCount <= 1 && params.repairedMessages.length > 1;
  initializeChapterProgressForState(params.chapter, params.state);
  setRuntimeTurnState(params.state, params.world, {
    canPlayerSpeak: shouldWaitUserInput,
    expectedRoleType: shouldWaitUserInput ? "player" : "narrator",
    expectedRole: shouldWaitUserInput
      ? String(params.state.player?.name || "用户")
      : String(params.state.narrator?.name || "旁白"),
    lastSpeakerRoleType: String(params.repairedMessages[params.repairedMessages.length - 1]?.roleType || "narrator"),
    lastSpeaker: String(params.repairedMessages[params.repairedMessages.length - 1]?.role || params.state.narrator?.name || "旁白"),
  });
  syncChapterProgressWithRuntime(params.chapter, params.state);
}

export default router.post(
  "/",
  validateFields({
    sessionId: z.string(),
    messageLimit: z.number().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const { sessionId, messageLimit } = req.body;
      const db = getGameDb();
      const currentUserId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(currentUserId) || currentUserId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }
      const sessionIdValue = String(sessionId || "").trim();

      const row = await db("t_gameSession").where({ sessionId: sessionIdValue, userId: currentUserId }).first();
      if (!row) {
        return res.status(404).send(error("会话不存在"));
      }

      let world = await db("t_storyWorld as w")
        .leftJoin("t_project as p", "w.projectId", "p.id")
        .where("w.id", Number(row.worldId || 0))
        .select("w.*", "p.userId as ownerUserId")
        .first();
      const ownerUserId = Number(world?.ownerUserId || 0);
      if (world) {
        // 会话打开优先返回已保存的世界数据，缺卡补齐放后台做，避免继续聊时被慢模型阻塞。
        void ensureWorldRolesWithAiParameterCards({
          userId: ownerUserId > 0 ? ownerUserId : currentUserId,
          world,
          persist: ownerUserId > 0 && ownerUserId === currentUserId,
        }).catch((asyncErr) => {
          console.warn("[getSession] async role parameter card generation failed", {
            sessionId: sessionIdValue,
            worldId: Number(world?.id || 0),
            userId: currentUserId,
            message: (asyncErr as any)?.message || String(asyncErr),
          });
        });
      }
      const rolePair = normalizeRolePair(world?.playerRole, world?.narratorRole);
      const provisionalChapterId = Number(row.chapterId || 0) || null;
      const state = normalizeSessionState(
        row.stateJson,
        Number(row.worldId || 0),
        provisionalChapterId,
        rolePair,
        world,
      );
      const activeChapterId = Number(state.chapterId || provisionalChapterId || 0) || null;
      const messageLimitNum = Number(messageLimit);
      const limit = Number.isFinite(messageLimitNum) && messageLimitNum > 0 ? Math.min(messageLimitNum, 200) : 50;
      const eventView = readDefaultRuntimeEventViewState(state);

      const chapter = activeChapterId ? await db("t_storyChapter").where({ id: activeChapterId }).first() : null;
      const snapshot = await db("t_sessionStateSnapshot").where({ sessionId: sessionIdValue }).orderBy("id", "desc").first();
      let rawMessages = await db("t_sessionMessage").where({ sessionId: sessionIdValue }).orderBy("id", "desc").limit(limit);

      // 某些历史路径会把消息表清空，或者残留旧 opening / opening 后的错误自动续写。
      // 对仍停留在章节开局的会话，这里直接按当前章节配置校正初始消息。
      if (chapter && Number(state.round || 0) <= 0) {
        const repairedMessages = buildRecoveredOpeningMessages(world, chapter, state);
        const shouldRepair = shouldRepairInitialSessionMessages({
          state,
          rawMessages: rawMessages.slice().reverse(),
          expectedMessages: repairedMessages.map((message) => ({
            eventType: String(message.eventType || ""),
            content: String(message.content || ""),
          })),
        });
        if (shouldRepair && repairedMessages.length) {
          repairInitialSessionState({
            world,
            chapter,
            state,
            repairedMessages,
          });
          await db.transaction(async (trx: any) => {
            await trx("t_sessionMessage").where({ sessionId: sessionIdValue }).delete();
            await trx("t_sessionMessage").insert(
              repairedMessages.map((message) => ({
                sessionId: sessionIdValue,
                role: String(message.role || state.narrator?.name || "旁白"),
                roleType: String(message.roleType || "narrator"),
                content: String(message.content || ""),
                eventType: String(message.eventType || "on_orchestrated_reply"),
                createTime: Number(message.createTime || Date.now()),
              })),
            );
            await trx("t_gameSession")
              .where({ sessionId: sessionIdValue, userId: currentUserId })
              .update({
                stateJson: toJsonText(state, {}),
                updateTime: Date.now(),
              });
          });
          rawMessages = await db("t_sessionMessage").where({ sessionId: sessionIdValue }).orderBy("id", "desc").limit(limit);
        }
      }
      const messages = rawMessages.reverse().map((item: any) => normalizeMessageOutput(item));
      // getSession 也必须和 storyInfo 一样，使用章节行数据回填当前章节标题。
      // 否则安卓首次进入故事会先读到旧 state.chapterTitle，短时间内显示成上一章。
      state.chapterId = activeChapterId || 0;
      state.chapterTitle = String(chapter?.title || "").trim() || String(state.chapterTitle || "").trim();

      res.status(200).send(
        success({
          ...row,
          chapterId: activeChapterId,
          state,
          currentEventDigest: eventView.currentEventDigest,
          eventDigestWindow: eventView.eventDigestWindow,
          eventDigestWindowText: eventView.eventDigestWindowText,
          world: normalizeWorldOutput(world),
          chapter: normalizeChapterOutput(chapter),
          latestSnapshot: snapshot
            ? {
                ...snapshot,
                state: normalizeSessionState(
                  snapshot.stateJson,
                  Number(row.worldId || 0),
                  activeChapterId,
                  rolePair,
                  world,
                ),
              }
            : null,
          messages,
        }),
      );
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
