import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

/**
 * 应用模型组：把模型组快照整体覆写回 t_setting.languageModel。
 * - 槽位条目（值为数字的 configId）逐项校验：配置必须存在且属于当前用户，失效条目剔除并计入 missingSlots
 * - 保留字段（__storyRuntimeSettings 等下划线开头）原样保留，不校验
 * - upsert 逻辑与 configurationModel 保持一致（无 t_setting 行时自动创建）
 */
export default router.post(
  "/",
  validateFields({
    id: z.number(),
  }),
  async (req, res) => {
    const { id } = req.body;
    const userId = Number((req as any)?.user?.id || 0);

    const group = await u.db("t_modelGroup").where({ id: Number(id), userId }).first("id", "name", "languageModelJson");
    if (!group) {
      return res.status(404).send(error("模型组不存在"));
    }

    // 解析快照，坏数据按空对象处理
    let snapshot: Record<string, any> = {};
    try {
      const parsed = JSON.parse(String(group.languageModelJson || "{}"));
      if (parsed && typeof parsed === "object") {
        snapshot = parsed as Record<string, any>;
      }
    } catch {
      return res.status(400).send(error("模型组快照数据损坏，无法应用"));
    }

    // 收集快照里的槽位 configId，一次性校验存在性与归属
    const slotEntries = Object.entries(snapshot).filter(([key, value]) => !key.startsWith("__") && Number.isFinite(Number(value)));
    const configIds = Array.from(new Set(slotEntries.map(([, value]) => Number(value)))).filter((configId) => configId > 0);
    const validConfigRows = configIds.length
      ? await u.db("t_config").whereIn("id", configIds).where("userId", userId).select("id")
      : [];
    const validConfigIds = new Set(validConfigRows.map((row: any) => Number(row.id)));

    // 剔除失效条目（原模型配置已被删除或属于其他用户），保留字段原样保留
    const nextMapping: Record<string, any> = {};
    const missingSlots: { key: string; configId: number }[] = [];
    for (const [key, value] of Object.entries(snapshot)) {
      if (key.startsWith("__")) {
        nextMapping[key] = value;
        continue;
      }
      const configId = Number(value);
      if (Number.isFinite(configId) && configId > 0 && validConfigIds.has(configId)) {
        nextMapping[key] = configId;
      } else {
        missingSlots.push({ key, configId: configId });
      }
    }

    const languageModel = JSON.stringify(nextMapping);
    const setting = await u.db("t_setting").where({ userId }).first("id");
    if (setting?.id) {
      await u.db("t_setting").where({ id: Number(setting.id) }).update({ languageModel });
    } else {
      const maxRow = await u.db("t_setting").max({ maxId: "id" }).first();
      const nextId = Number((maxRow as any)?.maxId || 0) + 1;
      await u.db("t_setting").insert({
        id: nextId,
        userId,
        tokenKey: u.uuid().slice(0, 8),
        imageModel: "{}",
        languageModel,
        projectId: null,
      });
    }

    res.status(200).send(success({
      groupName: String(group.name || ""),
      appliedCount: slotEntries.length - missingSlots.length,
      missingSlots,
    }));
  },
);
