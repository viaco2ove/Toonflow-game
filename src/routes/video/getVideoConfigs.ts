import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
const router = express.Router();

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

    const result = [...dbResult].sort((a, b) => {
      const ta = Number(new Date(a?.createdAt || 0).getTime() || 0);
      const tb = Number(new Date(b?.createdAt || 0).getTime() || 0);
      return tb - ta;
    });

    res.status(200).send(success(result));
  },
);
