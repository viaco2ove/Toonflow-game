import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  getGameDb,
  parseJsonSafe,
  type JsonRecord,
} from "@/lib/gameEngine";
import u from "@/utils";

const router = express.Router();

type ImportableRoleItem = {
  sourceWorldId: number;
  sourceWorldName: string;
  sourceWorldCoverPath: string;
  role: JsonRecord;
};

/**
 * 统一把任意角色对象整理成“可导入的 NPC 角色”结构。
 * 导入列表只应该显示 NPC，且必须保证 id / roleType / name 稳定可用。
 */
function normalizeImportableNpcRole(roleRaw: unknown, fallbackId: string, fallbackName: string): JsonRecord | null {
  const raw = parseJsonSafe<JsonRecord>(roleRaw, {});
  const roleType = String(raw.roleType || "npc").trim() || "npc";
  if (roleType !== "npc") return null;
  return {
    ...raw,
    id: String(raw.id || fallbackId).trim() || fallbackId,
    roleType,
    name: String(raw.name || fallbackName).trim() || fallbackName,
    avatarPath: String(raw.avatarPath || "").trim(),
    avatarBgPath: String(raw.avatarBgPath || "").trim(),
    description: String(raw.description || "").trim(),
    voice: String(raw.voice || "").trim(),
    voiceMode: String(raw.voiceMode || "text").trim() || "text",
    voicePresetId: String(raw.voicePresetId || "").trim(),
    voiceReferenceAudioPath: String(raw.voiceReferenceAudioPath || "").trim(),
    voiceReferenceAudioName: String(raw.voiceReferenceAudioName || "").trim(),
    voiceReferenceText: String(raw.voiceReferenceText || "").trim(),
    voicePromptText: String(raw.voicePromptText || "").trim(),
    voiceMixVoices: Array.isArray(raw.voiceMixVoices) ? raw.voiceMixVoices : [],
    sample: String(raw.sample || "").trim(),
    parameterCardJson: parseJsonSafe<JsonRecord | null>(raw.parameterCardJson, null),
  };
}

/**
 * 从世界配置里提取所有可导入 NPC。
 * 章节创建页的“导入角色”只需要其他故事的 NPC，不应该把用户/旁白带进来。
 */
function extractWorldImportableRoles(worldRow: any): ImportableRoleItem[] {
  const settings = parseJsonSafe<JsonRecord>(worldRow?.settings, {});
  const rawRoles = Array.isArray(settings.roles) ? settings.roles : [];
  return rawRoles
    .map((roleRaw, index) => {
      const role = normalizeImportableNpcRole(
        roleRaw,
        `npc_import_${Number(worldRow?.id || 0)}_${index + 1}`,
        `角色${index + 1}`,
      );
      if (!role) return null;
      return {
        sourceWorldId: Number(worldRow?.id || 0),
        sourceWorldName: String(worldRow?.name || "").trim() || "未命名故事",
        sourceWorldCoverPath: String(worldRow?.coverPath || settings.coverPath || "").trim(),
        role,
      } satisfies ImportableRoleItem;
    })
    .filter((item): item is ImportableRoleItem => !!item);
}

/**
 * 把故事名称和角色名称按中文排序，保证默认列表稳定且符合用户预期。
 */
function sortImportableRoles(list: ImportableRoleItem[]): ImportableRoleItem[] {
  return [...list].sort((left, right) => {
    const worldCompare = left.sourceWorldName.localeCompare(right.sourceWorldName, "zh-CN");
    if (worldCompare !== 0) return worldCompare;
    return String(left.role.name || "").localeCompare(String(right.role.name || ""), "zh-CN");
  });
}

export default router.post(
  "/",
  validateFields({
    excludeWorldId: z.number().optional().nullable(),
    worldName: z.string().optional().nullable(),
    roleName: z.string().optional().nullable(),
    page: z.number().optional().nullable(),
    pageSize: z.number().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const currentUserId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(currentUserId) || currentUserId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }

      const excludeWorldId = Number(req.body.excludeWorldId || 0);
      const worldName = String(req.body.worldName || "").trim();
      const roleName = String(req.body.roleName || "").trim();
      const page = Math.max(1, Number(req.body.page || 1));
      const pageSize = Math.max(1, Math.min(Number(req.body.pageSize || 20), 50));

      const db = getGameDb();
      let query = db("t_storyWorld as w")
        .leftJoin("t_project as p", "w.projectId", "p.id")
        .where("p.userId", currentUserId)
        .select("w.id", "w.name", "w.coverPath", "w.settings");

      if (excludeWorldId > 0) {
        query = query.whereNot("w.id", excludeWorldId);
      }
      if (worldName) {
        query = query.where("w.name", "like", `%${worldName}%`);
      }

      const worldRows = await query.orderBy("w.name", "asc").orderBy("w.id", "asc");
      const allRoles = sortImportableRoles(
        worldRows.flatMap((worldRow: any) => extractWorldImportableRoles(worldRow))
          .filter((item: ImportableRoleItem) => !roleName || String(item.role.name || "").includes(roleName)),
      );
      const total = allRoles.length;
      const start = (page - 1) * pageSize;
      const items = allRoles.slice(start, start + pageSize);

      return res.status(200).send(success({
        items,
        page,
        pageSize,
        total,
      }));
    } catch (err) {
      return res.status(500).send(error(u.error(err).message));
    }
  },
);
