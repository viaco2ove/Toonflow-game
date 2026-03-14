import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  buildHistoryPreview,
  getModeFromScriptId,
  getSessionIdFromType,
  getSessionMetaMap,
  getUserProjects,
  isStoryboardSessionType,
  isSupportedChatType,
  normalizeHistoryArray,
  parseNovelScriptId,
} from "@/lib/chatHistoryManager";

const router = express.Router();

type ChatHistoryListItem = {
  id: number;
  projectId: number;
  projectName: string;
  type: string;
  mode: string;
  sessionId: string;
  title: string;
  preview: string;
  messageCount: number;
  updatedAt: number;
};

export default router.post(
  "/",
  validateFields({
    keyword: z.string().optional(),
    page: z.number().int().min(1).optional(),
    pageSize: z.number().int().min(1).max(200).optional(),
  }),
  async (req, res) => {
    const userId = Number((req as any)?.user?.id || 1);
    const keyword = String(req.body.keyword || "").trim().toLowerCase();
    const page = Number(req.body.page || 1);
    const pageSize = Number(req.body.pageSize || 50);

    const projects = await getUserProjects(userId);
    if (!projects.length) {
      return res.status(200).send(success({ list: [], total: 0, page, pageSize }));
    }

    const projectMap = new Map<number, string>();
    const projectIds = projects.map((item) => item.id);
    for (const item of projects) projectMap.set(item.id, item.name);

    const sessionMetaMap = await getSessionMetaMap(projectIds);
    const rows = await u
      .db("t_chatHistory")
      .whereIn("projectId", projectIds)
      .select("id", "projectId", "type", "data", "novel");

    const result: ChatHistoryListItem[] = [];
    for (const row of rows) {
      const type = String(row.type || "");
      if (!isSupportedChatType(type)) continue;

      const projectId = Number(row.projectId);
      const projectName = projectMap.get(projectId) || `项目 ${projectId}`;
      const history = normalizeHistoryArray(row.data);
      const previewRaw = buildHistoryPreview(history);
      const messageCount = history.length;
      const rowId = Number(row.id || 0);
      const fallbackUpdatedAt = rowId;

      if (isStoryboardSessionType(type)) {
        const sessionId = getSessionIdFromType(type);
        const sessionMeta = sessionMetaMap.get(projectId)?.get(sessionId);
        const parsedScriptId = sessionMeta?.scriptId ?? parseNovelScriptId(row.novel);
        const title = sessionMeta?.title || (sessionId ? `会话 ${sessionId.slice(0, 8)}` : "会话");
        const preview = sessionMeta?.preview || previewRaw;
        const updatedAt = Number(sessionMeta?.updatedAt || fallbackUpdatedAt);
        result.push({
          id: rowId,
          projectId,
          projectName,
          type,
          mode: getModeFromScriptId(parsedScriptId),
          sessionId,
          title,
          preview,
          messageCount,
          updatedAt,
        });
        continue;
      }

      const title = type === "outlineAgent" ? "大纲会话" : "旧版分镜会话";
      const mode = type === "outlineAgent" ? "outline" : "legacy";
      result.push({
        id: rowId,
        projectId,
        projectName,
        type,
        mode,
        sessionId: "",
        title,
        preview: previewRaw,
        messageCount,
        updatedAt: fallbackUpdatedAt,
      });
    }

    const filtered = keyword
      ? result.filter((item) => {
          const text = `${item.title} ${item.preview} ${item.projectName}`.toLowerCase();
          return text.includes(keyword);
        })
      : result;

    filtered.sort((a, b) => b.updatedAt - a.updatedAt);

    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const list = filtered.slice(start, end);

    return res.status(200).send(success({ list, total, page, pageSize }));
  },
);

