import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  getGameDb,
  normalizeChapterOutput,
  parseJsonSafe,
  normalizeRolePair,
  normalizeSessionState,
  nowTs,
  readDefaultRuntimeEventViewState,
  toJsonText,
} from "@/lib/gameEngine";
import { ensureWorldRolesWithAiParameterCards } from "@/lib/roleParameterCard";
import {
  buildChapterInitialSnapshotVersion,
  prewarmChapterInitialSnapshotCache,
  readChapterInitialSnapshotCache,
} from "@/lib/sessionInitialSnapshot";
import {
  initializeChapterProgressForState,
  syncChapterProgressWithRuntime,
} from "@/modules/game-runtime/engines/ChapterProgressEngine";
import { clearSessionRevisitCache, withSessionLock } from "@/modules/game-runtime/services/SessionService";

const router = express.Router();

function isPublishedWorld(row: any): boolean {
  if (!row) return false;
  const publishStatus = String(row.publishStatus || "").trim();
  if (publishStatus === "published") return true;
  const settings = parseJsonSafe<Record<string, any>>(row.settings, {});
  return String(settings?.publishStatus || "").trim() === "published";
}

function buildContentVersion(world: any, chapter: any, now: number): string {
  const snapshotVersion = buildChapterInitialSnapshotVersion(world, chapter);
  if (snapshotVersion) {
    return snapshotVersion;
  }
  const worldVersion = Number(world?.updateTime || world?.createTime || now);
  return `w:${Number(world?.id || 0)}@${worldVersion}`;
}

/**
 * 重玩会话（原地重置，sessionId 不变）：
 * - 重新生成角色卡等动态数据（世界归属用户时才写回 t_storyWorld）
 * - 清空该会话的消息/快照/状态流水/角色记忆/插件数据
 * - 按首章重建 stateJson 并更新会话行（保留 sessionId/title/createTime）
 * - 之后由前端走 introduction → orchestration 链路重新生成开场白并开局
 */
export default router.post(
  "/",
  validateFields({
    sessionId: z.string(),
  }),
  async (req, res) => {
    try {
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }

      const sessionId = String(req.body.sessionId || "").trim();
      if (!sessionId) {
        return res.status(400).send(error("sessionId 不能为空"));
      }

      const db = getGameDb();
      const session = await db("t_gameSession")
        .where({ sessionId, userId })
        .select("id", "sessionId", "worldId", "worldPublishId")
        .first();
      if (!session) {
        return res.status(404).send(error("未找到会话"));
      }

      const worldId = Number(session.worldId || 0);
      if (!worldId) {
        return res.status(400).send(error("会话缺少故事信息，无法重玩"));
      }

      // 1. 获取故事世界（发布校验与 initStory 保持一致）
      let world = await db("t_storyWorld").where({ id: worldId }).first();
      if (!world) {
        return res.status(404).send(error("未找到故事"));
      }
      if (!isPublishedWorld(world)) {
        return res.status(403).send(error("故事未发布，无法重玩"));
      }
      const publishedWorldRow = await db("t_storyWorld_published").where({ worldId }).first();
      const worldPublishId = Number(publishedWorldRow?.id || 0) || 0;
      const publishedVersion = Number(publishedWorldRow?.version || 0) || 0;

      // 2. 重新生成角色卡（player/narrator/全部 NPC）并写回世界；LLM 失败时函数内部
      //    会回退静态卡不抛错，流程继续不阻塞重玩。
      //    归属保护：只有世界属于当前用户（通过项目归属判断）才允许重生成并写回，
      //    避免重玩"他人已发布故事"的会话时篡改别人世界的角色卡；他人的世界只重置会话。
      if (world) {
        const worldProject = world.projectId
          ? await db("t_project").where({ id: Number(world.projectId) }).first("userId")
          : null;
        const ownsWorld = Boolean(worldProject && Number(worldProject.userId || 0) === userId);
        if (ownsWorld) {
          await ensureWorldRolesWithAiParameterCards({
            userId,
            world,
            persist: true,
            forceRefresh: true,
          });
          // 卡片写回数据库后重新读行，保证 state 构建用的是最新角色卡
          world = await db("t_storyWorld").where({ id: worldId }).first();
        }
      }

      // 3. 重玩回到首章（与 initStory 的章节选择逻辑一致）
      let chapter: any = null;
      chapter = await db("t_storyChapter").where({ worldId }).orderBy("sort", "asc").orderBy("id", "asc").first();
      chapter = normalizeChapterOutput(chapter);
      if (!chapter) {
        return res.status(404).send(error("当前没有章节可游玩"));
      }

      // 4. 重建运行态 state（照 initStory：优先开局快照缓存，否则规范化构建）
      const rolePair = normalizeRolePair(world.playerRole, world.narratorRole);
      const snapshotCache = readChapterInitialSnapshotCache({ world, chapter });
      let state: Record<string, any>;
      if (snapshotCache) {
        state = parseJsonSafe<Record<string, any>>(snapshotCache.stateJson, {});
      } else {
        state = normalizeSessionState({}, worldId, Number(chapter.id || 0), rolePair, world);
        void prewarmChapterInitialSnapshotCache({ userId, world, chapter });
      }
      initializeChapterProgressForState(chapter, state);
      syncChapterProgressWithRuntime(chapter, state);

      // 5. 清空旧动态数据 + 原地更新会话行（保留 sessionId/title/createTime）
      const now = nowTs();
      await withSessionLock(sessionId, async () => {
        await db.transaction(async (trx: any) => {
          await trx("t_sessionMessage").where({ sessionId }).delete();
          await trx("t_sessionStateSnapshot").where({ sessionId }).delete();
          await trx("t_entityStateDelta").where({ sessionId }).delete();
          await trx("t_role_memory").where({ sessionId }).delete();
          await trx("t_plugin_session_data").where({ sessionId }).delete();
          await trx("t_gameSession").where({ sessionId, userId }).update({
            chapterId: Number(chapter.id || 0) || null,
            stateJson: toJsonText(state, {}),
            contentVersion: buildContentVersion(world, chapter, now),
            worldVersion: publishedVersion || null,
            updateTime: now,
          });
        });
      });
      clearSessionRevisitCache(sessionId);

      // 6. 返回与 initStory 同构的结果，前端直接走 introduction → orchestration 开局链路
      const eventView = readDefaultRuntimeEventViewState(state);
      return res.status(200).send(success({
        sessionId,
        worldId,
        chapterId: Number(chapter.id || 0),
        chapterTitle: String(chapter.title || ""),
        state,
        opening: null,
        firstChapter: null,
        currentEventDigest: eventView.currentEventDigest,
        eventDigestWindow: eventView.eventDigestWindow,
        eventDigestWindowText: eventView.eventDigestWindowText,
      }));
    } catch (err: any) {
      console.error("[game:replaySession:error]", err);
      const message = err instanceof Error ? err.message : String(err || "重玩失败");
      return res.status(500).send(error(message));
    }
  },
);
