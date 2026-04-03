import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { getGameDb, parseJsonSafe, readDefaultRuntimeEventViewState } from "@/lib/gameEngine";
import u from "@/utils";

const router = express.Router();

interface SessionEntry {
  item: any;
  runtimeState: Record<string, any>;
}

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

      let query = db("t_gameSession as s").where("s.userId", userId);
      if (Number.isFinite(projectId) && projectId > 0) {
        query = query.andWhere("s.projectId", projectId);
      }
      if (Number.isFinite(worldId) && worldId > 0) {
        query = query.andWhere("s.worldId", worldId);
      }
      const rawSessions = await query
        .select("s.*")
        .orderBy("s.updateTime", "desc")
        .orderBy("s.id", "desc");
      const rawSessionIds = rawSessions.map((item: any) => String(item.sessionId || "")).filter(Boolean);
      const playableMessageRows = rawSessionIds.length
        ? await db("t_sessionMessage")
          .whereIn("sessionId", rawSessionIds)
          .andWhere("roleType", "player")
          .andWhere("eventType", "on_message")
          .select("sessionId", "content")
        : [];
      const playableSessionIds = new Set<string>(
        playableMessageRows
          .filter((item: any) => String(item.content || "").trim())
          .map((item: any) => String(item.sessionId || "")),
      );
      const seenWorldIds = new Set<number>();
      const sessions = rawSessions.filter((item: any) => {
        const sessionId = String(item.sessionId || "");
        if (!playableSessionIds.has(sessionId)) {
          return false;
        }
        const worldIdValue = Number(item.worldId || 0);
        if (!Number.isFinite(worldIdValue) || worldIdValue <= 0) {
          return false;
        }
        if (seenWorldIds.has(worldIdValue)) {
          return false;
        }
        seenWorldIds.add(worldIdValue);
        return true;
      }).slice(0, limit);
      if (!sessions.length) {
        return res.status(200).send(success([]));
      }

      const sessionEntries: SessionEntry[] = sessions.map((item: any) => ({
        item,
        runtimeState: parseJsonSafe(item.stateJson, {}),
      }));
      const sessionIds = sessionEntries.map((entry: SessionEntry) => String(entry.item.sessionId || "")).filter(Boolean);
      const worldIdSet = Array.from(new Set(sessionEntries.map((entry: SessionEntry) => Number(entry.item.worldId || 0)).filter((id: number) => id > 0)));
      const chapterIdSet = Array.from(new Set(
        sessionEntries
          .map((entry: SessionEntry) => Number(entry.runtimeState?.chapterId || entry.item.chapterId || 0))
          .filter((id: number) => id > 0),
      ));
      const projectIdSet = Array.from(new Set(sessions.map((item: any) => Number(item.projectId || 0)).filter((id: number) => id > 0)));

      const [worldRows, chapterRows, projectRows] = await Promise.all([
        worldIdSet.length ? db("t_storyWorld").whereIn("id", worldIdSet).select("id", "name", "intro", "coverPath", "settings") : Promise.resolve([]),
        chapterIdSet.length ? db("t_storyChapter").whereIn("id", chapterIdSet).select("id", "title") : Promise.resolve([]),
        projectIdSet.length ? db("t_project").whereIn("id", projectIdSet).select("id", "name") : Promise.resolve([]),
      ]);

      const worldMap = new Map<number, any>(worldRows.map((item: any) => [Number(item.id), item]));
      const chapterNameMap = new Map<number, string>(chapterRows.map((item: any) => [Number(item.id), String(item.title || "")]));
      const projectNameMap = new Map<number, string>(projectRows.map((item: any) => [Number(item.id), String(item.name || "")]));

      const latestMessageRows = await Promise.all(
        sessionIds.map((sessionId: string) =>
          db("t_sessionMessage").where({ sessionId }).orderBy("id", "desc").first(),
        ),
      );
      const latestMessageMap = new Map<string, any>();
      latestMessageRows.forEach((item: any) => {
        if (item?.sessionId) {
          latestMessageMap.set(String(item.sessionId), item);
        }
      });

      const list = sessionEntries.map((entry: SessionEntry) => {
        const { item, runtimeState } = entry;
        const sessionId = String(item.sessionId || "");
        const worldIdValue = Number(item.worldId || 0);
        const chapterIdValue = Number(runtimeState?.chapterId || item.chapterId || 0);
        const projectIdValue = Number(item.projectId || 0);
        const latest = latestMessageMap.get(sessionId);
        const worldRow = worldMap.get(worldIdValue);
        const worldSettings = parseJsonSafe<any>(worldRow?.settings, {});
        const eventView = readDefaultRuntimeEventViewState(runtimeState);
        return {
          sessionId,
          worldId: worldIdValue,
          worldName: String(worldRow?.name || ""),
          worldIntro: String(worldRow?.intro || ""),
          worldCoverPath: String(worldRow?.coverPath || worldSettings?.coverPath || worldSettings?.coverBgPath || ""),
          chapterId: chapterIdValue > 0 ? chapterIdValue : null,
          chapterTitle: chapterIdValue > 0 ? chapterNameMap.get(chapterIdValue) || "" : "",
          projectId: projectIdValue || null,
          projectName: projectIdValue > 0 ? projectNameMap.get(projectIdValue) || "" : "",
          title: String(item.title || ""),
          status: String(item.status || ""),
          contentVersion: String(item.contentVersion || ""),
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
