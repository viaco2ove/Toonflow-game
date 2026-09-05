import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { getGameDb, parseJsonSafe, readDefaultRuntimeEventViewState } from "@/lib/gameEngine";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number().optional().nullable(),
    worldId: z.number().optional().nullable(),
    limit: z.number().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }

      const db = getGameDb();
      const projectId = Number(req.body.projectId);
      const worldId = Number(req.body.worldId);
      const limitNum = Number(req.body.limit);
      const limit = Number.isFinite(limitNum) && limitNum > 0 ? Math.min(limitNum, 100) : 30;

      // 1. 只查必要字段（避免 stateJson 等大字段）
      let query = db("t_gameSession as s").where("s.userId", userId);
      if (Number.isFinite(projectId) && projectId > 0) {
        query = query.andWhere("s.projectId", projectId);
      }
      if (Number.isFinite(worldId) && worldId > 0) {
        query = query.andWhere("s.worldId", worldId);
      }
      const rawSessions = await query
        .select(
          "s.id",
          "s.sessionId",
          "s.worldId",
          "s.projectId",
          "s.chapterId",
          "s.title",
          "s.status",
          "s.contentVersion",
          "s.worldPublishId",
          "s.worldVersion",
          "s.stateJson",
          "s.updateTime",
          "s.createTime",
        )
        .orderBy("s.updateTime", "desc")
        .orderBy("s.id", "desc")
        .limit(limit * 2); // 多查一些，过滤后会留 limit 条

      // 2. 过滤：有 player 消息 + 按 worldId 去重
      const sessionIds = rawSessions.map((item: any) => String(item.sessionId || "")).filter(Boolean);
      const [playableMessageRows, latestMessageRows] = await Promise.all([
        sessionIds.length
          ? db("t_sessionMessage")
              .whereIn("sessionId", sessionIds)
              .andWhere("roleType", "player")
              .andWhere("eventType", "on_message")
              .select("sessionId")
              .groupBy("sessionId")
          : Promise.resolve([]),
        sessionIds.length
          ? db("t_sessionMessage as m1")
              .whereIn("sessionId", sessionIds)
              .whereRaw(
                `m1.id = (SELECT MAX(m2.id) FROM t_sessionMessage m2 WHERE m2.sessionId = m1.sessionId)`,
              )
              .select("m1.sessionId", "m1.id", "m1.role", "m1.roleType", "m1.eventType", "m1.content", "m1.createTime")
          : Promise.resolve([]),
      ]);

      const playableSessionIds = new Set<string>(
        playableMessageRows.map((item: any) => String(item.sessionId || "")),
      );
      const latestMessageMap = new Map<string, any>();
      latestMessageRows.forEach((item: any) => {
        if (item?.sessionId) latestMessageMap.set(String(item.sessionId), item);
      });

      const seenWorldIds = new Set<number>();
      const sessions = rawSessions.filter((item: any) => {
        const sessionId = String(item.sessionId || "");
        if (!playableSessionIds.has(sessionId)) return false;
        const wid = Number(item.worldId || 0);
        if (!Number.isFinite(wid) || wid <= 0) return false;
        if (seenWorldIds.has(wid)) return false;
        seenWorldIds.add(wid);
        return true;
      }).slice(0, limit);

      if (!sessions.length) {
        return res.status(200).send(success([]));
      }

      // 3. 批量查 world / chapter / project（只查必要字段，不查 settings）
      const worldIdSet = Array.from(seenWorldIds);
      const chapterIdSet = Array.from(new Set(
        sessions
          .map((s: any) => {
            const state = parseJsonSafe<Record<string, any>>(s.stateJson, {});
            return Number(state?.chapterId || s.chapterId || 0);
          })
          .filter((id: number) => id > 0),
      ));
      const projectIdSet = Array.from(new Set(sessions.map((s: any) => Number(s.projectId || 0)).filter((id: number) => id > 0)));

      const [worldRows, chapterRows, projectRows, publishedRows] = await Promise.all([
        worldIdSet.length
          ? db("t_storyWorld").whereIn("id", worldIdSet).select("id", "name", "intro", "coverPath")
          : Promise.resolve([]),
        chapterIdSet.length
          ? db("t_storyChapter").whereIn("id", chapterIdSet).select("id", "title")
          : Promise.resolve([]),
        projectIdSet.length
          ? db("t_project").whereIn("id", projectIdSet).select("id", "name")
          : Promise.resolve([]),
        worldIdSet.length
          ? db("t_storyWorld_published").whereIn("worldId", worldIdSet).select("worldId", "version")
          : Promise.resolve([]),
      ]);

      const worldMap = new Map<number, any>(worldRows.map((item: any) => [Number(item.id), item]));
      const chapterNameMap = new Map<number, string>(chapterRows.map((item: any) => [Number(item.id), String(item.title || "")]));
      const projectNameMap = new Map<number, string>(projectRows.map((item: any) => [Number(item.id), String(item.name || "")]));
      const publishedVersionMap = new Map<number, number>(
        publishedRows.map((item: any) => [Number(item.worldId), Number(item.version || 0)]),
      );

      const list = sessions.map((item: any) => {
        const sessionId = String(item.sessionId || "");
        const worldIdValue = Number(item.worldId || 0);
        const runtimeState = parseJsonSafe<Record<string, any>>(item.stateJson, {});
        const chapterIdValue = Number(runtimeState?.chapterId || item.chapterId || 0);
        const projectIdValue = Number(item.projectId || 0);
        const latest = latestMessageMap.get(sessionId);
        const worldRow = worldMap.get(worldIdValue);
        const resolvedChapterTitle = chapterIdValue > 0 ? chapterNameMap.get(chapterIdValue) || "" : "";

        // 同步 chapterId/chapterTitle 到 state
        if (runtimeState && typeof runtimeState === "object") {
          runtimeState.chapterId = chapterIdValue > 0 ? chapterIdValue : null;
          runtimeState.chapterTitle = resolvedChapterTitle || String(runtimeState.chapterTitle || "").trim();
        }

        const eventView = readDefaultRuntimeEventViewState(runtimeState);
        const publishedVersion = publishedVersionMap.get(worldIdValue) || 0;
        const sessionWorldVersion = Number(item.worldVersion || 0);
        const storyUpdated = publishedVersion > 0 && sessionWorldVersion > 0 && sessionWorldVersion < publishedVersion;
        // const alignReport = runtimeState?.alignReport || null;
        //
        return {
          sessionId,
          worldId: worldIdValue,
          worldName: String(worldRow?.name || ""),
          worldIntro: String(worldRow?.intro || ""),
          worldCoverPath: String(worldRow?.coverPath || ""),
          chapterId: chapterIdValue > 0 ? chapterIdValue : null,
          chapterTitle: resolvedChapterTitle,
          projectId: projectIdValue || null,
          projectName: projectIdValue > 0 ? projectNameMap.get(projectIdValue) || "" : "",
          title: String(item.title || ""),
          status: String(item.status || ""),
          contentVersion: String(item.contentVersion || ""),
          worldPublishId: Number(item.worldPublishId || 0) || null,
          worldVersion: Number(item.worldVersion || 0) || null,
          storyUpdated,
          // alignReport,
          updateTime: Number(item.updateTime || item.createTime || 0),
          state: runtimeState,
          currentEventDigest: eventView.currentEventDigest,
          eventDigestWindow: eventView.eventDigestWindow,
          eventDigestWindowText: eventView.eventDigestWindowText,
          latestMessage: latest
            ? {
                id: Number(latest.id || 0),
                role: String(latest.role || ""),
                roleType: String(latest.roleType || ""),
                eventType: String(latest.eventType || ""),
                content: String(latest.content || ""),
                createTime: Number(latest.createTime || 0),
              }
            : null,
        };
      });

      res.status(200).send(success(list));
    } catch (err) {
      console.error("[game] listSession failed", {
        route: "/game/listSession",
        userId: Number((req as any)?.user?.id || 0),
        requestBody: req.body || {},
        message: u.error(err).message,
        stack: (err as any)?.stack || "",
      });
      res.status(500).send(error(u.error(err).message));
    }
  },
);
