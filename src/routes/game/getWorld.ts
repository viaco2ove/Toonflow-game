import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  getGameDb,
  normalizeRolePair,
  normalizeWorldOutput,
  nowTs,
  toJsonText,
} from "@/lib/gameEngine";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    worldId: z.number().optional().nullable(),
    projectId: z.number().optional().nullable(),
    autoCreate: z.boolean().optional().nullable(),
    defaultWorldName: z.string().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const { worldId, projectId, autoCreate, defaultWorldName } = req.body;
      const db = getGameDb();

      const worldIdNum = Number(worldId);
      const projectIdNum = Number(projectId);
      if ((!Number.isFinite(worldIdNum) || worldIdNum <= 0) && (!Number.isFinite(projectIdNum) || projectIdNum <= 0)) {
        return res.status(400).send(error("worldId 或 projectId 至少需要一个"));
      }

      let row: any = null;
      if (Number.isFinite(worldIdNum) && worldIdNum > 0) {
        row = await db("t_storyWorld").where({ id: worldIdNum }).first();
      }
      if (!row && Number.isFinite(projectIdNum) && projectIdNum > 0) {
        row = await db("t_storyWorld").where({ projectId: projectIdNum }).first();
      }
      if (!row && autoCreate && Number.isFinite(projectIdNum) && projectIdNum > 0) {
        const project = await db("t_project").where({ id: projectIdNum }).first();
        const rolePair = normalizeRolePair(null, null);
        const now = nowTs();
        await db("t_storyWorld").insert({
          projectId: projectIdNum,
          name: String(defaultWorldName || project?.name || "默认世界观"),
          intro: "",
          settings: toJsonText({}, {}),
          playerRole: toJsonText(rolePair.playerRole, {}),
          narratorRole: toJsonText(rolePair.narratorRole, {}),
          createTime: now,
          updateTime: now,
        });
        row = await db("t_storyWorld").where({ projectId: projectIdNum }).orderBy("id", "desc").first();
      }
      if (!row) {
        return res.status(404).send(error("未找到世界观配置"));
      }

      const chapterCountRow = await db("t_storyChapter").where({ worldId: Number(row.id) }).count({ count: "id" }).first();
      const sessionCountRow = await db("t_gameSession").where({ worldId: Number(row.id) }).count({ count: "id" }).first();

      const output = normalizeWorldOutput(row);
      res.status(200).send(
        success({
          ...output,
          chapterCount: Number((chapterCountRow as any)?.count || 0),
          sessionCount: Number((sessionCountRow as any)?.count || 0),
        }),
      );
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
