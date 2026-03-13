import express from "express";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
const router = express.Router();

// 更新视频配置
export default router.post(
  "/",
  validateFields({
    id: z.number(),
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
    const { id, aiConfigId, mode, resolution, duration, prompt, selectedResultId, startFrame, endFrame, images, audioEnabled } = req.body;

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
