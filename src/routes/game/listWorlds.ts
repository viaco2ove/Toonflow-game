import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { getGameDb, normalizeWorldOutput, parseJsonSafe } from "@/lib/gameEngine";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }

      const db = getGameDb();
      const projectId = Number(req.body.projectId);
      let query = db("t_storyWorld as w")
        .leftJoin("t_project as p", "w.projectId", "p.id")
        .where("p.userId", userId);
      if (Number.isFinite(projectId) && projectId > 0) {
        query = query.andWhere("w.projectId", projectId);
      }

      const rows = await query
        .select("w.*")
        .orderBy("w.updateTime", "desc")
        .orderBy("w.id", "desc");

      if (!rows.length) {
        return res.status(200).send(success([]));
      }

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
              .count({ count: "id" })
              .groupBy("worldId")
          : Promise.resolve([]),
      ]);

      const chapterCountMap = new Map<number, number>(
        chapterCountRows.map((item: any) => [Number(item.worldId || 0), Number(item.count || 0)]),
      );
      const sessionCountMap = new Map<number, number>(
        sessionCountRows.map((item: any) => [Number(item.worldId || 0), Number(item.count || 0)]),
      );

      const list = rows.map((row: any) => {
        const worldId = Number(row.id || 0);
        const output = normalizeWorldOutput(row);
        return {
          ...output,
          chapterCount: chapterCountMap.get(worldId) || 0,
          sessionCount: sessionCountMap.get(worldId) || 0,
          settings: parseJsonSafe(row.settings, {}),
        };
      });

      res.status(200).send(success(list));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
