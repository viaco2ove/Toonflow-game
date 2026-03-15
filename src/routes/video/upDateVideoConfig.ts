import express from "express";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import { listStoryboardChatSessions, loadStoryboardChatSession, saveStoryboardChatSession } from "@/lib/storyboardChatSessionStore";
const router = express.Router();
const META_TYPE = "storyboardAgent:sessions";

const draftIdToVirtualId = (draftId: string): number => {
  let hash = 0;
  for (let i = 0; i < draftId.length; i++) {
    hash = (hash * 31 + draftId.charCodeAt(i)) | 0;
  }
  return -Math.max(1, Math.abs(hash));
};

// 更新视频配置
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    scriptId: z.number().optional(),
    projectId: z.number().optional(),
    aiConfigId: z.number().optional(),
    mode: z.enum(["startEnd", "multi", "single", "text", ""]).optional(),
    resolution: z.string().optional(),
    duration: z.number().optional(),
    prompt: z.string().optional(),
    selectedResultId: z.number().nullable().optional(),
    startFrame: z.object().nullable().optional(),
    endFrame: z.object().nullable().optional(),
    images: z.array(z.object()).optional(),
    audioEnabled: z.boolean().optional(),
  }),
  async (req, res) => {
    const { id, scriptId, projectId, aiConfigId, mode, resolution, duration, prompt, selectedResultId, startFrame, endFrame, images, audioEnabled } = req.body;

    // 会话草稿配置（负ID）更新：写回会话，不写 t_videoConfig
    if (id < 0) {
      const scriptIdNum = Math.abs(Number(scriptId || 0));
      let projectIdNum = Number(projectId || 0);
      if (projectIdNum <= 0 && scriptIdNum > 0) {
        const scriptRow = await u.db("t_script").where({ id: scriptIdNum }).first("projectId");
        projectIdNum = Number(scriptRow?.projectId || 0);
      }
      const tryUpdateInSessions = async (
        projectIdValue: number,
        scopedScriptId: number,
        sessionItems?: Array<{ id: string; scriptId?: number; title?: string }>,
      ) => {
        const sessions = sessionItems?.length
          ? sessionItems
          : (await listStoryboardChatSessions(projectIdValue, scopedScriptId)).map((item) => ({
            id: item.id,
            scriptId: Number(item.scriptId),
            title: item.title,
          }));
        for (const session of sessions) {
          const loaded = await loadStoryboardChatSession(projectIdValue, session.id);
          if (!loaded?.videoDraft?.configs?.length) continue;
          const configs = loaded.videoDraft.configs;
          const index = configs.findIndex((item) => draftIdToVirtualId(String(item.draftId || "")) === id);
          if (index === -1) continue;
          const parsedSessionScopeId = Number(session.scriptId);
          const scopeIdToSave = Number.isFinite(parsedSessionScopeId) && parsedSessionScopeId !== 0 ? parsedSessionScopeId : scopedScriptId;

          const nextConfig = { ...configs[index] };
          if (aiConfigId !== undefined) {
            const aiConfig = await u.db("t_config").where({ id: aiConfigId }).first();
            if (!aiConfig) {
              return res.status(404).send(error("模型配置不存在"));
            }
            nextConfig.aiConfigId = Number(aiConfigId);
            nextConfig.manufacturer = String(aiConfig.manufacturer || "");
            nextConfig.model = String(aiConfig.model || "");
          }
          if (mode !== undefined && mode !== "") nextConfig.mode = mode;
          if (resolution !== undefined) nextConfig.resolution = resolution;
          if (duration !== undefined) nextConfig.duration = duration;
          if (prompt !== undefined) nextConfig.prompt = prompt;
          if (startFrame !== undefined) nextConfig.startFrame = startFrame;
          if (endFrame !== undefined) nextConfig.endFrame = endFrame;
          if (images !== undefined) nextConfig.images = images || [];
          if (audioEnabled !== undefined) nextConfig.audioEnabled = audioEnabled;

          const nextConfigs = [...configs];
          nextConfigs[index] = nextConfig;
          const nextDraft = {
            ...loaded.videoDraft,
            configs: nextConfigs,
            updatedAt: Date.now(),
          };

          await saveStoryboardChatSession({
            projectId: projectIdValue,
            sessionId: session.id,
            scriptId: scopeIdToSave,
            history: loaded.history || [],
            novelChapters: loaded.novelChapters || [],
            shots: loaded.shots || [],
            shotIdCounter: loaded.shotIdCounter || 0,
            videoDraft: nextDraft,
            pendingStoryboardPlan: loaded.pendingStoryboardPlan || null,
            titleIfMissing: (session as any).title,
          });

          return res.status(200).send(
            success({
              message: "更新视频草稿配置成功",
              data: {
                id,
                scriptId: Math.abs(scopeIdToSave),
                projectId: projectIdValue,
                aiConfigId: nextConfig.aiConfigId,
                manufacturer: nextConfig.manufacturer || "",
                model: nextConfig.model || "",
                mode: nextConfig.mode,
                startFrame: nextConfig.startFrame || null,
                endFrame: nextConfig.endFrame || null,
                images: Array.isArray(nextConfig.images) ? nextConfig.images : [],
                resolution: nextConfig.resolution || "720p",
                duration: Number(nextConfig.duration || 5),
                prompt: nextConfig.prompt || "",
                selectedResultId: selectedResultId ?? null,
                createdAt: new Date(nextDraft.updatedAt).toISOString(),
                audioEnabled: !!nextConfig.audioEnabled,
                isDraft: true,
              },
            }),
          );
        }
      };

      if (projectIdNum > 0 && scriptIdNum > 0) {
        const scopedScriptId = -Math.abs(scriptIdNum);
        const updated = await tryUpdateInSessions(projectIdNum, scopedScriptId);
        if (updated) return;
      }

      // 兼容旧前端：未传 scriptId/projectId 时，回退全量会话查找
      const metaRows = await u.db("t_chatHistory").where({ type: META_TYPE }).select("projectId", "data");
      for (const row of metaRows) {
        const pid = Number((row as any).projectId || 0);
        if (pid <= 0) continue;
        let sessionItems: Array<{ id: string; scriptId?: number; title?: string }> = [];
        try {
          const parsed = JSON.parse(String((row as any).data || "[]"));
          if (Array.isArray(parsed)) {
            sessionItems = parsed
              .map((item: any) => ({
                id: String(item?.id || "").trim(),
                scriptId: Number(item?.scriptId),
                title: typeof item?.title === "string" ? item.title : "",
              }))
              .filter((item) => item.id);
          }
        } catch {
          sessionItems = [];
        }
        if (!sessionItems.length) continue;
        const updated = await tryUpdateInSessions(pid, -Math.abs(scriptIdNum || 1), sessionItems);
        if (updated) return;
      }

      return res.status(404).send(error("草稿视频配置不存在"));
    }

    // 检查配置是否存在
    const existingConfig = await u.db("t_videoConfig").where({ id }).first();
    if (!existingConfig) {
      return res.status(404).send(error("视频配置不存在"));
    }

    // 构建更新对象
    const updateData: Record<string, any> = {
      updateTime: Date.now(),
    };

    if (aiConfigId !== undefined) {
      const aiConfig = await u.db("t_config").where({ id: aiConfigId }).first();
      if (!aiConfig) {
        return res.status(404).send(error("模型配置不存在"));
      }
      updateData.aiConfigId = aiConfigId;
      updateData.manufacturer = aiConfig.manufacturer || "";
    }
    if (mode !== undefined) {
      updateData.mode = mode;
    }
    if (resolution !== undefined) {
      updateData.resolution = resolution;
    }
    if (duration !== undefined) {
      updateData.duration = duration;
    }
    if (prompt !== undefined) {
      updateData.prompt = prompt;
    }
    if (selectedResultId !== undefined) {
      updateData.selectedResultId = selectedResultId;
    }
    if (startFrame !== undefined) {
      updateData.startFrame = startFrame ? JSON.stringify(startFrame) : null;;
    }
    if (endFrame !== undefined) {
      updateData.endFrame = endFrame ? JSON.stringify(endFrame) : null;;
    }
    if (images !== undefined) {
      updateData.images = images ? JSON.stringify(images) : null;
    }
    if (audioEnabled !== undefined) {
      updateData.audioEnabled = audioEnabled;
    }
    // 更新数据
    await u.db("t_videoConfig").where({ id }).update(updateData);

    // 获取更新后的数据
    const updatedConfig = await u.db("t_videoConfig").where({ id }).first();
    if (updatedConfig) {
      res.status(200).send(
        success({
          message: "更新视频配置成功",
          data: {
            id: updatedConfig.id,
            scriptId: updatedConfig.scriptId,
            projectId: updatedConfig.projectId,
            aiConfigId: updatedConfig.aiConfigId,
            manufacturer: updatedConfig.manufacturer,
            mode: updatedConfig.mode,
            startFrame: updatedConfig.startFrame ? JSON.parse(updatedConfig.startFrame) : null,
            endFrame: updatedConfig.endFrame ? JSON.parse(updatedConfig.endFrame) : null,
            images: updatedConfig.images ? JSON.parse(updatedConfig.images) : [],
            resolution: updatedConfig.resolution,
            duration: updatedConfig.duration,
            prompt: updatedConfig.prompt,
            selectedResultId: updatedConfig.selectedResultId,
            createdAt: new Date(updatedConfig.createTime!).toISOString(),
            audioEnabled: updatedConfig.audioEnabled,
          },
        }),
      );
    } else {
      res.status(200).send(error("更新配置失败"));
    }
  },
);
