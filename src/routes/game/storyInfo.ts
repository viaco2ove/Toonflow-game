import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  getGameDb,
  normalizeChapterOutput,
  normalizeRolePair,
  normalizeSessionState,
  normalizeWorldOutput,
  readDefaultRuntimeEventViewState,
} from "@/lib/gameEngine";
import {
  buildEffectiveDebugChapter,
  cacheAndBuildDebugStateSnapshot,
  getPendingDebugChapterId,
  isDebugFreePlotActive,
  loadCachedDebugRuntimeState,
  syncDebugChapterRuntime,
} from "./debugRuntimeShared";
import u from "@/utils";

const router = express.Router();

/**
 * 根据正式会话状态构造结束弹窗标题。
 *
 * 用途：
 * - 正式游玩和二次进入会话时，都统一由服务端给出“是否需要弹窗”的权威结论；
 * - 前端只负责展示，不再自行猜测失败状态对应的提示文案。
 */
function buildSessionEndDialog(status: string): string | null {
  const normalized = String(status || "").trim().toLowerCase();
  if (["failed", "dead", "lose", "loss"].includes(normalized)) return "结束条件失败";
  return null;
}

/**
 * 根据正式会话状态构造结束弹窗详情。
 *
 * 用途：
 * - 让“章节失败”在首次失败和再次进入会话时看到相同说明；
 * - 避免前端因为缺少细节，只能显示一句空泛的“当前故事已失败”。
 */
function buildSessionEndDialogDetail(status: string, chapterTitle?: string | null): string {
  const endDialog = buildSessionEndDialog(status);
  if (!endDialog) return "";
  const normalizedChapterTitle = String(chapterTitle || "当前章节").trim() || "当前章节";
  return `章节《${normalizedChapterTitle}》结束条件失败。当前故事已结束，可继续查看当前记录，或返回历史重新开始。`;
}

/**
 * 统一返回故事运行态信息。
 * 该接口专门承载故事设定、当前章节事件和调试锚点等非台词数据，
 * 用来替代 /streamlines和/orchestration 里原先的大杂烩响应。
 */
export default router.post(
  "/",
  validateFields({
    sessionId: z.string().optional().nullable(),
    worldId: z.number().optional().nullable(),
    chapterId: z.number().optional().nullable(),
    state: z.any().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const db = getGameDb();
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }

      const sessionId = String(req.body.sessionId || "").trim();
      const worldId = Number(req.body.worldId || 0);
      const chapterId = Number(req.body.chapterId || 0);

      if (sessionId) {
        const sessionRow = await db("t_gameSession").where({ sessionId, userId }).first();
        if (!sessionRow) {
          return res.status(404).send(error("会话不存在"));
        }
        const world = await db("t_storyWorld as w")
          .leftJoin("t_project as p", "w.projectId", "p.id")
          .where("w.id", Number(sessionRow.worldId || 0))
          .select("w.*", "p.userId as ownerUserId")
          .first();
        const rolePair = normalizeRolePair(world?.playerRole, world?.narratorRole);
        const activeState = normalizeSessionState(
          sessionRow.stateJson,
          Number(sessionRow.worldId || 0),
          Number(sessionRow.chapterId || 0) || null,
          rolePair,
          world,
        );
        const activeChapterId = Number(activeState.chapterId || sessionRow.chapterId || 0) || null;
        const chapter = activeChapterId
          ? await db("t_storyChapter").where({ id: activeChapterId }).first()
          : null;
        const sessionStatus = String(sessionRow.status || "active").trim() || "active";
        // storyInfo 是前端故事设定/事件面板的权威来源。
        // 这里必须用章节行数据回填标题，防止旧 state.chapterTitle 残留为别的章节名。
        activeState.chapterId = activeChapterId || 0;
        activeState.chapterTitle = String(chapter?.title || "").trim() || String(activeState.chapterTitle || "").trim();
        const eventView = readDefaultRuntimeEventViewState(activeState);
        const sessionEndDialog = buildSessionEndDialog(sessionStatus);
        return res.status(200).send(success({
          worldId: Number(sessionRow.worldId || 0),
          status: sessionStatus,
          chapterId: activeChapterId,
          chapterTitle: String(chapter?.title || activeState.chapterTitle || ""),
          state: activeState,
          world: normalizeWorldOutput(world),
          chapter: normalizeChapterOutput(chapter),
          currentEventDigest: eventView.currentEventDigest,
          eventDigestWindow: eventView.eventDigestWindow,
          eventDigestWindowText: eventView.eventDigestWindowText,
          endDialog: sessionEndDialog,
          endDialogDetail: buildSessionEndDialogDetail(sessionStatus, chapter?.title || activeState.chapterTitle),
        }));
      }

      if (!worldId) {
        return res.status(400).send(error("worldId 不能为空"));
      }

      const world = await db("t_storyWorld as w")
        .leftJoin("t_project as p", "w.projectId", "p.id")
        .where("w.id", worldId)
        .where("p.userId", userId)
        .select("w.*")
        .first();
      if (!world) {
        return res.status(404).send(error("未找到故事"));
      }

      let chapter = null;
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
      const cachedRuntimeState = loadCachedDebugRuntimeState(req.body.state, userId, worldId);
      const activeState = normalizeSessionState(
        cachedRuntimeState || req.body.state,
        worldId,
        Number(chapter.id || 0),
        rolePair,
        world,
      );
      // 调试 storyInfo 必须优先信“待进入下一章”的运行态标记。
      // 当上一章刚成功、下一句确认台词已经落地，但前端仍带着旧 chapterId 拉取 storyInfo 时，
      // 如果继续只信旧请求参数，就会让标题和事件面板永远停在上一章。
      const pendingChapterId = getPendingDebugChapterId(activeState);
      const runtimeChapterId = Number(activeState.chapterId || 0);
      const effectiveChapterId = Number.isFinite(pendingChapterId || 0) && Number(pendingChapterId || 0) > 0
        ? Number(pendingChapterId || 0)
        : Number.isFinite(runtimeChapterId) && runtimeChapterId > 0
          ? runtimeChapterId
          : Number(chapter.id || 0);
      if (effectiveChapterId > 0 && effectiveChapterId !== Number(chapter.id || 0)) {
        const runtimeChapterRow = await db("t_storyChapter").where({ id: effectiveChapterId, worldId }).first();
        if (runtimeChapterRow) {
          chapter = normalizeChapterOutput(runtimeChapterRow);
        }
      }
      if (!chapter) {
        return res.status(404).send(error("当前没有章节可调试"));
      }
      const effectiveChapter = buildEffectiveDebugChapter(chapter, isDebugFreePlotActive(activeState));
      // 调试 storyInfo 返回前，必须先把缓存态同步回当前章节。
      // 否则前端会读到旧章节遗留的 phase/title，出现“标题还是第1章，面板像第2章”的混合态。
      syncDebugChapterRuntime(effectiveChapter, activeState);
      activeState.chapterId = Number(chapter.id || 0) || 0;
      activeState.chapterTitle = String(chapter.title || "").trim() || String(activeState.chapterTitle || "").trim();
      const snapshot = cacheAndBuildDebugStateSnapshot({
        userId,
        worldId,
        state: activeState,
      });

      return res.status(200).send(success({
        worldId,
        chapterId: Number(chapter.id || 0),
        chapterTitle: String(chapter.title || activeState.chapterTitle || ""),
        state: snapshot,
        world: normalizeWorldOutput(world),
        chapter,
        currentEventDigest: snapshot.currentEventDigest || null,
        eventDigestWindow: Array.isArray(snapshot.eventDigestWindow) ? snapshot.eventDigestWindow : [],
        eventDigestWindowText: String(snapshot.eventDigestWindowText || ""),
      }));
    } catch (err) {
      return res.status(500).send(error(u.error(err).message));
    }
  },
);
