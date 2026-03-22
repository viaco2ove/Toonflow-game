import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  STORYBOARD_META_TYPE,
  STORYBOARD_SESSION_PREFIX,
  getSessionIdFromType,
  getSessionMetaMap,
  getUserProjects,
  isSupportedChatType,
} from "@/lib/chatHistoryManager";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    all: z.boolean().optional(),
    ids: z
      .preprocess((value) => {
        if (typeof value === "number") return [value];
        return value;
      }, z.array(z.number().int().positive()))
      .optional(),
  }),
  async (req, res) => {
    const userId = Number((req as any)?.user?.id || 0);
    const all = Boolean(req.body.all);
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map((item: any) => Number(item)).filter((item: number) => Number.isFinite(item)) : [];

    if (!all && ids.length === 0) {
      return res.status(400).send(error("请提供 ids 或 all=true"));
    }

    const projects = await getUserProjects(userId);
    if (!projects.length) return res.status(200).send(success({ deletedCount: 0, deletedIds: [] }));
    const projectIds = projects.map((item) => item.id);

    if (all) {
      const allRows = await u
        .db("t_chatHistory")
        .whereIn("projectId", projectIds)
        .select("id", "type");
      const deletableIds = allRows
        .filter((row: any) => isSupportedChatType(String(row.type || "")) || String(row.type || "") === STORYBOARD_META_TYPE)
        .map((row: any) => Number(row.id))
        .filter((id) => Number.isFinite(id));

      if (!deletableIds.length) return res.status(200).send(success({ deletedCount: 0, deletedIds: [] }));
      await u.db("t_chatHistory").whereIn("id", deletableIds).delete();
      return res.status(200).send(success({ deletedCount: deletableIds.length, deletedIds: deletableIds }));
    }

    const targetRows = await u
      .db("t_chatHistory")
      .whereIn("id", ids)
      .whereIn("projectId", projectIds)
      .select("id", "projectId", "type");

    const deletableRows = targetRows.filter((row: any) => isSupportedChatType(String(row.type || "")) || String(row.type || "") === STORYBOARD_META_TYPE);
    const deletableIds = deletableRows.map((row: any) => Number(row.id)).filter((id: number) => Number.isFinite(id));
    if (!deletableIds.length) return res.status(200).send(success({ deletedCount: 0, deletedIds: [] }));

    await u.db("t_chatHistory").whereIn("id", deletableIds).delete();

    const removedSessionIdsByProject = new Map<number, Set<string>>();
    for (const row of deletableRows) {
      const type = String(row.type || "");
      if (!type.startsWith(STORYBOARD_SESSION_PREFIX)) continue;
      const sessionId = getSessionIdFromType(type);
      if (!sessionId) continue;
      const projectId = Number(row.projectId);
      if (!removedSessionIdsByProject.has(projectId)) removedSessionIdsByProject.set(projectId, new Set<string>());
      removedSessionIdsByProject.get(projectId)!.add(sessionId);
    }

    const cleanupProjectIds = Array.from(removedSessionIdsByProject.keys());
    if (cleanupProjectIds.length) {
      const metaMap = await getSessionMetaMap(cleanupProjectIds);
      for (const projectId of cleanupProjectIds) {
        const removedSessionIds = removedSessionIdsByProject.get(projectId);
        if (!removedSessionIds || removedSessionIds.size === 0) continue;
        const currentMetaMap = metaMap.get(projectId) || new Map<string, any>();
        const nextList = Array.from(currentMetaMap.values()).filter((item) => !removedSessionIds.has(String(item.id || "")));
        const data = JSON.stringify(nextList);
        const metaRow = await u.db("t_chatHistory").where({ projectId, type: STORYBOARD_META_TYPE }).first();
        if (metaRow) {
          await u.db("t_chatHistory").where("id", metaRow.id).update({ data });
        } else if (nextList.length > 0) {
          await u.db("t_chatHistory").insert({ projectId, type: STORYBOARD_META_TYPE, data, novel: "" });
        }
      }
    }

    return res.status(200).send(success({ deletedCount: deletableIds.length, deletedIds: deletableIds }));
  },
);
