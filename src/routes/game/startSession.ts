import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  createGameSessionId,
  getGameDb,
  normalizeChapterOutput,
  parseJsonSafe,
  normalizeRolePair,
  normalizeSessionState,
  nowTs,
  toJsonText,
} from "@/lib/gameEngine";
import {
  applyMemoryResultToState,
  applyNarrativeMemoryHintsToState,
  advanceNarrativeUntilPlayerTurn,
  resolveOpeningMessage,
  runNarrativeOrchestrator,
  RuntimeMessageInput,
  setRuntimeTurnState,
  summarizeNarrativePlan,
  triggerStoryMemoryRefreshInBackground,
} from "@/modules/game-runtime/engines/NarrativeOrchestrator";
import u from "@/utils";

const router = express.Router();

function isPublishedWorld(row: any): boolean {
  if (!row) return false;
  const publishStatus = String(row.publishStatus || "").trim();
  if (publishStatus === "published") return true;
  const settings = parseJsonSafe<Record<string, any>>(row.settings, {});
  return String(settings?.publishStatus || "").trim() === "published";
}

function normalizeSessionRow(row: any) {
  if (!row) return null;
  return {
    ...row,
    state: parseJsonSafe(row.stateJson, {}),
  };
}

function buildContentVersion(world: any, chapter: any, now: number): string {
  const worldVersion = Number(world?.updateTime || world?.createTime || now);
  const chapterVersion = Number(chapter?.updateTime || chapter?.createTime || 0);
  const worldId = Number(world?.id || 0);
  const chapterId = Number(chapter?.id || 0);

  if (chapterId > 0 && chapterVersion > 0) {
    return `w:${worldId}@${worldVersion};c:${chapterId}@${chapterVersion}`;
  }
  return `w:${worldId}@${worldVersion}`;
}

function scheduleOpeningMemoryRefresh(params: {
  sessionId: string;
  userId: number;
  world: any;
  chapter: any;
  state: Record<string, any>;
  recentMessages: RuntimeMessageInput[];
}) {
  triggerStoryMemoryRefreshInBackground({
    userId: params.userId,
    world: params.world,
    chapter: params.chapter,
    state: params.state,
    recentMessages: params.recentMessages,
    onResolved: async (memory) => {
      const row = await getGameDb()("t_gameSession").where({ sessionId: params.sessionId }).first();
      if (!row) return;
      const latestState = parseJsonSafe<Record<string, any>>(row.stateJson, {});
      applyMemoryResultToState(latestState, memory);
      await getGameDb()("t_gameSession").where({ sessionId: params.sessionId }).update({
        stateJson: toJsonText(latestState, {}),
        updateTime: nowTs(),
      });
    },
  });
}

export default router.post(
  "/",
  validateFields({
    worldId: z.number(),
    chapterId: z.number().optional().nullable(),
    projectId: z.number().optional().nullable(),
    title: z.string().optional().nullable(),
    initialState: z.any().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const { worldId, chapterId, projectId, title, initialState } = req.body;
      const currentUserId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(currentUserId) || currentUserId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }
      const db = getGameDb();
      const now = nowTs();

      const world = await db("t_storyWorld as w")
        .leftJoin("t_project as p", "w.projectId", "p.id")
        .where("w.id", worldId)
        .select("w.*", "p.userId as ownerUserId")
        .first();
      if (!world) {
        return res.status(404).send(error("worldId 不存在，请先创建世界观"));
      }
      const ownerUserId = Number(world.ownerUserId || 0);
      const isOwnerWorld = ownerUserId > 0 && ownerUserId === currentUserId;
      if (!isOwnerWorld && !isPublishedWorld(world)) {
        return res.status(403).send(error("无权开始该故事会话"));
      }

      let chapter: any = null;
      const chapterIdNum = Number(chapterId);
      if (Number.isFinite(chapterIdNum) && chapterIdNum > 0) {
        chapter = await db("t_storyChapter").where({ id: chapterIdNum, worldId }).first();
      }
      if (!chapter) {
        chapter = await db("t_storyChapter").where({ worldId }).orderBy("sort", "asc").orderBy("id", "asc").first();
      }
      chapter = normalizeChapterOutput(chapter);

      const rolePair = normalizeRolePair(world.playerRole, world.narratorRole);
      const state = normalizeSessionState(initialState, worldId, chapter ? Number(chapter.id) : null, rolePair, world);
      const openingMessages: RuntimeMessageInput[] = [];
      let openingPlan: ReturnType<typeof summarizeNarrativePlan> = null;
      if (chapter) {
        const openingMessage = resolveOpeningMessage(world, chapter);
        if (openingMessage && String(openingMessage.content || "").trim()) {
          openingMessages.push({
            role: String(openingMessage.role || state.narrator?.name || "旁白"),
            roleType: String(openingMessage.roleType || "narrator"),
            eventType: String(openingMessage.eventType || "on_enter_chapter"),
            content: String(openingMessage.content || ""),
            createTime: now,
          });
        }
        setRuntimeTurnState(state, world, {
          canPlayerSpeak: false,
          expectedRoleType: "narrator",
          expectedRole: String(state.narrator?.name || "旁白"),
          lastSpeakerRoleType: String(openingMessages[openingMessages.length - 1]?.roleType || "narrator"),
          lastSpeaker: String(openingMessages[openingMessages.length - 1]?.role || state.narrator?.name || "旁白"),
        });
        const orchestrator = await runNarrativeOrchestrator({
          userId: currentUserId,
          world,
          chapter,
          state,
          recentMessages: openingMessages,
          playerMessage: "",
          maxRetries: 0,
        });
        const orchestrated = await advanceNarrativeUntilPlayerTurn({
          userId: currentUserId,
          world,
          chapter,
          state,
          recentMessages: openingMessages,
          playerMessage: "",
          initialResult: orchestrator,
          maxAutoTurns: 1,
        });
        openingPlan = summarizeNarrativePlan(orchestrator);
        openingMessages.push(...orchestrated.messages);
        applyNarrativeMemoryHintsToState(state, orchestrator.memoryHints);
      }

      const sessionId = createGameSessionId();
      const currentChapterId = Number(state.chapterId || chapter?.id || 0) || null;
      const payload = {
        sessionId,
        worldId,
        projectId: Number.isFinite(Number(projectId)) ? Number(projectId) : Number(world.projectId || 0),
        chapterId: currentChapterId,
        contentVersion: buildContentVersion(world, chapter, now),
        title: String(title || `${String(world.name || "世界")}-会话`).trim(),
        status: "active",
        stateJson: toJsonText(state, {}),
        userId: currentUserId,
        createTime: now,
        updateTime: now,
      };

      await db("t_gameSession").insert(payload);

      await db("t_sessionStateSnapshot").insert({
        sessionId,
        stateJson: payload.stateJson,
        reason: "session_start",
        round: Number(state.round || 0),
        createTime: now,
      });

      if (chapter && openingMessages.length > 0) {
        await db("t_sessionMessage").insert(
          openingMessages.map((message, index) => ({
            sessionId,
            role: String(message.role || state.narrator?.name || "旁白"),
            roleType: String(message.roleType || "narrator"),
            content: String(message.content || ""),
            eventType: String(message.eventType || "on_orchestrated_reply"),
            meta: toJsonText({
              chapterId: Number(chapter.id),
              ...(index > 0 && openingPlan
                ? {
                    source: openingPlan.source,
                    motive: openingPlan.motive,
                    nextRole: openingPlan.nextRole,
                    nextRoleType: openingPlan.nextRoleType,
                    chapterOutcome: openingPlan.chapterOutcome,
                    memoryHints: openingPlan.memoryHints,
                    triggerMemoryAgent: openingPlan.triggerMemoryAgent,
                  }
                : {}),
            }, {}),
            createTime: Number(message.createTime || now),
          })),
        );
      }

      if (chapter && openingPlan?.triggerMemoryAgent) {
        const rawRecentMessages = await db("t_sessionMessage").where({ sessionId }).orderBy("id", "desc").limit(20);
        scheduleOpeningMemoryRefresh({
          sessionId,
          userId: currentUserId,
          world,
          chapter,
          state,
          recentMessages: rawRecentMessages
            .reverse()
            .map((item: any) => ({
              role: String(item.role || ""),
              roleType: String(item.roleType || ""),
              eventType: String(item.eventType || ""),
              content: String(item.content || ""),
              createTime: Number(item.createTime || 0),
            })),
        });
      }

      const row = await db("t_gameSession").where({ sessionId }).first();
      res.status(200).send(success(normalizeSessionRow(row), "开始游玩会话成功"));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
