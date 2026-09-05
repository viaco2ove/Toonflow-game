import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { getGameDb, normalizeWorldOutput } from "@/lib/gameEngine";
import u from "@/utils";

const router = express.Router();

// 调试日志函数
const debugLog = (req: express.Request, step: string, msg: string, data?: any) => {
  const userId = Number((req as any)?.user?.id || 0);
  console.log(`[listWorlds][userId=${userId}][${step}] ${msg}`, data ? JSON.stringify(data) : "");
};

export default router.post(
  "/",
  validateFields({
    projectId: z.number().optional().nullable(),
    includePublicPublished: z.boolean().optional().nullable(),
  }),
  async (req, res) => {
    const startTime = Date.now();
    try {
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }

      debugLog(req, "start", `userId=${userId} projectId=${req.body.projectId} includePublicPublished=${req.body.includePublicPublished}`);

      const db = getGameDb();
      const projectId = Number(req.body.projectId);
      const includePublicPublished = req.body.includePublicPublished === true;

      let query = db("t_storyWorld as w")
        .leftJoin("t_project as p", "w.projectId", "p.id")
        .where("p.userId", userId);
      if (Number.isFinite(projectId) && projectId > 0) {
        query = query.andWhere("w.projectId", projectId);
      }

      const ownRows = await query
        .select("w.*")
        .orderBy("w.updateTime", "desc")
        .orderBy("w.id", "desc");

      debugLog(req, "query_own_done", `got ${ownRows.length} own worlds, time=${Date.now() - startTime}ms`);

      let rows = ownRows;
      if (includePublicPublished) {
        debugLog(req, "query_public", "starting query public published worlds...");
        const publicRows = await db("t_storyWorld as w")
          .leftJoin("t_project as p", "w.projectId", "p.id")
          .whereNot("p.userId", userId)
          .select("w.*")
          .orderBy("w.updateTime", "desc")
          .orderBy("w.id", "desc");
        debugLog(req, "query_public_done", `got ${publicRows.length} public worlds, time=${Date.now() - startTime}ms`);

        const publishedPublicRows = publicRows.filter((row: any) => {
          const output = normalizeWorldOutput(row);
          if (!output) return false;
          return String(output.publishStatus || output.settings?.publishStatus || "draft") === "published";
        });
        debugLog(req, "filter_public", `filtered to ${publishedPublicRows.length} published public worlds`);

        const mergedMap = new Map<number, any>();
        [...ownRows, ...publishedPublicRows].forEach((row: any) => {
          const id = Number(row.id || 0);
          if (id > 0 && !mergedMap.has(id)) {
            mergedMap.set(id, row);
          }
        });
        rows = Array.from(mergedMap.values()).sort((a: any, b: any) => {
          const updateDiff = Number(b.updateTime || 0) - Number(a.updateTime || 0);
          if (updateDiff !== 0) return updateDiff;
          return Number(b.id || 0) - Number(a.id || 0);
        });
        debugLog(req, "merge_done", `merged total ${rows.length} worlds`);
      }

      if (!rows.length) {
        debugLog(req, "empty", `no worlds, returning [], time=${Date.now() - startTime}ms`);
        return res.status(200).send(success([]));
      }

      debugLog(req, "query_counts", `querying chapter/session counts for ${rows.length} worlds...`);
      const worldIds = rows.map((item: any) => Number(item.id || 0)).filter((id: number) => id > 0);
      const [chapterCountRows, sessionCountRows] = await Promise.all([
        worldIds.length
          ? db("t_storyChapter")
              .whereIn("worldId", worldIds)
              .select("worldId")
              .count({ count: "id" })
              .groupBy("worldId")
          : Promise.resolve([]),
        worldIds.length
          ? db("t_gameSession")
              .whereIn("worldId", worldIds)
              .select("worldId")
              .countDistinct({ count: "userId" })
              .groupBy("worldId")
          : Promise.resolve([]),
      ]);
      debugLog(req, "query_counts_done", `chapterCountRows=${chapterCountRows.length} sessionCountRows=${sessionCountRows.length}, time=${Date.now() - startTime}ms`);

      const chapterCountMap = new Map<number, number>(
        chapterCountRows.map((item: any) => [Number(item.worldId || 0), Number(item.count || 0)]),
      );
      const sessionCountMap = new Map<number, number>(
        sessionCountRows.map((item: any) => [Number(item.worldId || 0), Number(item.count || 0)]),
      );

      debugLog(req, "mapping", `mapping ${rows.length} rows to output...`);
      const list = rows.map((row: any) => {
        const worldId = Number(row.id || 0);
        const output = normalizeWorldOutput(row, { minimal: true });
        return {
          ...output,
          chapterCount: chapterCountMap.get(worldId) || 0,
          sessionCount: sessionCountMap.get(worldId) || 0,
        };
      });

      const totalTime = Date.now() - startTime;
      debugLog(req, "done", `returning ${list.length} worlds in ${totalTime}ms`);
      res.status(200).send(success(list));
    } catch (err) {
      debugLog(req, "error", `error: ${u.error(err).message}, time=${Date.now() - startTime}ms`);
      res.status(500).send(error(u.error(err).message));
    }
  },
);