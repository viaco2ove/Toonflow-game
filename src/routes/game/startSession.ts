import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  createGameSessionId,
  extractFirstChapterDialogueLine,
  getGameDb,
  normalizeChapterOutput,
  parseJsonSafe,
  normalizeRolePair,
  normalizeSessionState,
  nowTs,
  toJsonText,
} from "@/lib/gameEngine";
import { ensureWorldRolesWithAiParameterCards } from "@/lib/roleParameterCard";
import {
  buildChapterInitialSnapshotVersion,
  prewarmChapterInitialSnapshotCache,
  readChapterInitialSnapshotCache,
} from "@/lib/sessionInitialSnapshot";
import {
  applyMemoryResultToState,
  resolveOpeningMessage,
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
  const snapshotVersion = buildChapterInitialSnapshotVersion(world, chapter);
  if (snapshotVersion) {
    return snapshotVersion;
  }
  const worldVersion = Number(world?.updateTime || world?.createTime || now);
  return `w:${Number(world?.id || 0)}@${worldVersion}`;
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

      let world = await db("t_storyWorld as w")
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
      // 角色参数卡的补齐改成后台进行，避免首次进入故事时被慢模型卡住。
      void ensureWorldRolesWithAiParameterCards({
        userId: ownerUserId > 0 ? ownerUserId : currentUserId,
        world,
        persist: isOwnerWorld,
      }).catch((err) => {
        console.warn("[startSession] async role parameter card generation failed", {
          worldId: Number(worldId || 0),
          userId: currentUserId,
          message: (err as any)?.message || String(err),
        });
      });

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
      let state = normalizeSessionState(initialState, worldId, chapter ? Number(chapter.id) : null, rolePair, world);
      const openingMessages: RuntimeMessageInput[] = [];
      let openingPlan: ReturnType<typeof summarizeNarrativePlan> = null;
      if (chapter) {
        const cachedSnapshot = readChapterInitialSnapshotCache({ world, chapter });
        if (cachedSnapshot) {
          state = normalizeSessionState(cachedSnapshot.stateJson, worldId, Number(chapter.id), rolePair, world);
          openingPlan = cachedSnapshot.plan || null;
          openingMessages.push(...((Array.isArray(cachedSnapshot.messages) ? cachedSnapshot.messages : []) as RuntimeMessageInput[]));
        } else {
          const openingMessage = resolveOpeningMessage(world, chapter);
          const normalizedContent = String(chapter.content || "").replace(/\r\n/g, "\n");
          const explicitDialogueCount = (normalizedContent.match(/^@[^:\n：]+\s*[:：]/gm) || []).length;
          if (openingMessage && String(openingMessage.content || "").trim()) {
            openingMessages.push({
              role: String(openingMessage.role || state.narrator?.name || "旁白"),
              roleType: String(openingMessage.roleType || "narrator"),
              eventType: String(openingMessage.eventType || "on_enter_chapter"),
              content: String(openingMessage.content || ""),
              createTime: now,
            });
          }
          const firstDialogue = extractFirstChapterDialogueLine(chapter.content);
          const firstDialogueContent = String(firstDialogue?.line || "").trim();
          const openingContent = String(openingMessage?.content || "").trim();
          if (firstDialogue && firstDialogueContent && firstDialogueContent !== openingContent) {
            const firstDialogueRole = String(firstDialogue.role || "").trim();
            const narratorName = String(state.narrator?.name || "旁白").trim();
            const userName = String(state.player?.name || "用户").trim();
            let roleType = "npc";
            if (!firstDialogueRole || firstDialogueRole === narratorName || firstDialogueRole === "旁白") {
              roleType = "narrator";
            } else if (firstDialogueRole === userName || firstDialogueRole === "用户") {
              roleType = "player";
            }
            // 章节初始快照 miss 时，至少把正文里的第一条显式台词一起落到会话，避免首进只剩一条开场白。
            openingMessages.push({
              role: firstDialogueRole || narratorName,
              roleType,
              eventType: "on_enter_chapter",
              content: firstDialogueContent,
              createTime: now + 1,
            });
          }
          const shouldWaitUserInput = explicitDialogueCount <= 1 && openingMessages.length > 1;
          setRuntimeTurnState(state, world, {
            canPlayerSpeak: shouldWaitUserInput,
            expectedRoleType: shouldWaitUserInput ? "player" : "narrator",
            expectedRole: shouldWaitUserInput ? String(state.player?.name || "用户") : String(state.narrator?.name || "旁白"),
            lastSpeakerRoleType: String(openingMessages[openingMessages.length - 1]?.roleType || "narrator"),
            lastSpeaker: String(openingMessages[openingMessages.length - 1]?.role || state.narrator?.name || "旁白"),
          });
          // 首次没有命中缓存时，异步回填章节初始快照，供后续进入直接复用。
          void prewarmChapterInitialSnapshotCache({
            userId: currentUserId,
            world,
            chapter,
          }).catch((err) => {
            console.warn("[startSession] async initial snapshot prewarm failed", {
              worldId: Number(worldId || 0),
              chapterId: Number(chapter?.id || 0),
              userId: currentUserId,
              message: (err as any)?.message || String(err),
            });
          });
        }
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
