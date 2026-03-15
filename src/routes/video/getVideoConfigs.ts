import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import { listStoryboardChatSessions, loadStoryboardChatSession } from "@/lib/storyboardChatSessionStore";
const router = express.Router();

const draftIdToVirtualId = (draftId: string): number => {
  let hash = 0;
  for (let i = 0; i < draftId.length; i++) {
    hash = (hash * 31 + draftId.charCodeAt(i)) | 0;
  }
  return -Math.max(1, Math.abs(hash));
};

// 获取视频配置列表
export default router.post(
  "/",
  validateFields({
    scriptId: z.number(),
  }),
  async (req, res) => {
    const rawScriptId = Number(req.body.scriptId || 0);
    const scriptId = Math.abs(rawScriptId);
    if (!Number.isFinite(scriptId) || scriptId <= 0) {
      return res.status(200).send(success([]));
    }

    // 查询该脚本下的所有视频配置
    const configs = await u
      .db("t_videoConfig")
      .leftJoin("t_config", "t_config.id", "t_videoConfig.aiConfigId")
      .where({ scriptId })
      .orderBy("createTime", "desc")
      .select("t_videoConfig.*", "t_videoConfig.manufacturer as configManufacturer", "t_config.manufacturer as aiManufacturer", "t_config.model as aiModel");

    // 解析数据库字段
    const dbResult = configs.map((config: any) => ({
      id: config.id,
      scriptId: config.scriptId,
      projectId: config.projectId,
      aiConfigId: config.aiConfigId,
      manufacturer: String(config.aiManufacturer || config.configManufacturer || "").trim() || "unknown",
      model: String(config.aiModel || "").trim() || "unknown-model",
      mode: config.mode,
      startFrame: config.startFrame ? JSON.parse(config.startFrame) : null,
      endFrame: config.endFrame ? JSON.parse(config.endFrame) : null,
      images: config.images ? JSON.parse(config.images) : [],
      resolution: config.resolution,
      duration: config.duration,
      prompt: config.prompt || "",
      selectedResultId: config.selectedResultId,
      createdAt: config.createTime ? new Date(config.createTime).toISOString() : new Date().toISOString(),
      audioEnabled: !!config.audioEnabled,
      isDraft: false,
    }));

    // 追加会话草稿配置（AI视频画布会话态，不入库）
    const scriptRow = await u.db("t_script").where({ id: scriptId }).first("projectId");
    const projectId = Number(scriptRow?.projectId || dbResult[0]?.projectId || 0);
    const draftScriptScopeId = -Math.abs(Number(scriptId));
    let draftResult: any[] = [];

    if (projectId > 0) {
      const sessions = await listStoryboardChatSessions(projectId, draftScriptScopeId);
      if (sessions.length > 0) {
        const loadedSessions = await Promise.all(
          sessions.map(async (session) => ({
            sessionId: session.id,
            loaded: await loadStoryboardChatSession(projectId, session.id),
          })),
        );
        const draftConfigsBySession = loadedSessions.map((item) => ({
          sessionId: item.sessionId,
          updatedAt: Number(item.loaded?.videoDraft?.updatedAt || Date.now()),
          configs: item.loaded?.videoDraft?.configs || [],
        }));

        const aiConfigIds = Array.from(
          new Set(
            draftConfigsBySession
              .flatMap((item) => item.configs)
              .map((item: any) => Number(item.aiConfigId || 0))
              .filter((id) => Number.isFinite(id) && id > 0),
          ),
        );
        const aiRows =
          aiConfigIds.length > 0
            ? await u.db("t_config").whereIn("id", aiConfigIds).select("id", "manufacturer", "model")
            : [];
        const aiMap = new Map<number, { manufacturer: string; model: string }>(
          aiRows.map((item: any) => [
            Number(item.id),
            {
              manufacturer: String(item.manufacturer || "").trim(),
              model: String(item.model || "").trim(),
            },
          ]),
        );

        draftResult = draftConfigsBySession.flatMap((sessionData) =>
          sessionData.configs.map((cfg: any) => {
            const virtualId = draftIdToVirtualId(String(cfg.draftId || ""));
            const aiInfo = aiMap.get(Number(cfg.aiConfigId || 0));
            return {
              id: virtualId,
              scriptId: Number(scriptId),
              projectId,
              aiConfigId: Number(cfg.aiConfigId || 0),
              manufacturer: String(aiInfo?.manufacturer || cfg.manufacturer || "").trim() || "unknown",
              model: String(aiInfo?.model || cfg.model || "").trim() || "unknown-model",
              mode: String(cfg.mode || "single"),
              startFrame: cfg.startFrame || null,
              endFrame: cfg.endFrame || null,
              images: Array.isArray(cfg.images) ? cfg.images : [],
              resolution: String(cfg.resolution || "720p"),
              duration: Number(cfg.duration || 5),
              prompt: String(cfg.prompt || ""),
              selectedResultId: null,
              createdAt: new Date(sessionData.updatedAt).toISOString(),
              audioEnabled: !!cfg.audioEnabled,
              isDraft: true,
            };
          }),
        );
      }
    }

    // 草稿优先，避免同id覆盖
    const mergedMap = new Map<number, any>();
    [...draftResult, ...dbResult].forEach((item) => {
      mergedMap.set(Number(item.id), item);
    });
    const result = Array.from(mergedMap.values()).sort((a, b) => {
      const ta = Number(new Date(a?.createdAt || 0).getTime() || 0);
      const tb = Number(new Date(b?.createdAt || 0).getTime() || 0);
      return tb - ta;
    });

    res.status(200).send(success(result));
  },
);
