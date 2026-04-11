import path from "node:path";
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

type RoleAssetCloneContext = {
  userId: number;
  targetRoleId: string;
  cache: Map<string, string>;
};

/**
 * 只把看起来像 OSS 相对路径的值当成资源路径。
 * 这样可以避免把角色描述里的普通文本误复制成文件。
 */
function looksLikeOssPath(value: string): boolean {
  const text = String(value || "").trim();
  if (!text.startsWith("/")) return false;
  if (text.length > 512) return false;
  if (/[\r\n]/.test(text)) return false;
  return !/^https?:\/\//i.test(text);
}

/**
 * 为导入后的角色资源生成全新路径。
 * 路径中带角色 id，方便后续排查“这份资源是谁导入出来的”。
 */
function buildImportedRoleAssetPath(input: {
  userId: number;
  targetRoleId: string;
  sourcePath: string;
}): string {
  const ext = path.extname(input.sourcePath).trim() || "";
  const sourceName = path.basename(input.sourcePath, ext).replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 32) || "asset";
  const fileId = u.uuid().replace(/-/g, "").slice(0, 12);
  return `/${input.userId}/game/import-role/${input.targetRoleId}/${sourceName}_${fileId}${ext}`;
}

/**
 * 复制单个角色资源文件，并在同一次导入请求里做路径去重。
 * 角色头像、背景图、参考音频如果多处复用，实际只会落一次盘。
 */
async function cloneOssPathIfNeeded(sourcePath: string, context: RoleAssetCloneContext): Promise<string> {
  const normalizedSourcePath = String(sourcePath || "").trim();
  if (!looksLikeOssPath(normalizedSourcePath)) {
    return normalizedSourcePath;
  }
  const cached = context.cache.get(normalizedSourcePath);
  if (cached) {
    return cached;
  }
  const fileExists = await u.oss.fileExists(normalizedSourcePath);
  if (!fileExists) {
    return normalizedSourcePath;
  }
  const nextPath = buildImportedRoleAssetPath({
    userId: context.userId,
    targetRoleId: context.targetRoleId,
    sourcePath: normalizedSourcePath,
  });
  const fileBuffer = await u.oss.getFile(normalizedSourcePath);
  await u.oss.writeFile(nextPath, fileBuffer);
  context.cache.set(normalizedSourcePath, nextPath);
  return nextPath;
}

/**
 * 深度遍历角色对象，把其中所有引用到的 OSS 路径都复制成独立资源。
 * 这样导入后的角色不会和原故事共享头像、背景图、参考音频等文件。
 */
async function cloneRoleAssets<T>(input: T, context: RoleAssetCloneContext): Promise<T> {
  if (typeof input === "string") {
    return (await cloneOssPathIfNeeded(input, context)) as T;
  }
  if (Array.isArray(input)) {
    const nextList = await Promise.all(input.map((item) => cloneRoleAssets(item, context)));
    return nextList as T;
  }
  if (input && typeof input === "object") {
    const entries = await Promise.all(
      Object.entries(input as Record<string, unknown>).map(async ([key, value]) => [key, await cloneRoleAssets(value, context)] as const),
    );
    return Object.fromEntries(entries) as T;
  }
  return input;
}

/**
 * 统一整理源世界里的角色对象，确保导入时一定是完整 NPC 结构。
 */
function normalizeImportSourceRole(roleRaw: unknown, fallbackId: string, fallbackName: string): JsonRecord | null {
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
 * 导入角色后必须生成新的稳定 id，避免当前草稿里与已有角色冲突。
 */
function buildImportedRoleId(): string {
  return `npc_${Date.now()}_${u.uuid().replace(/-/g, "").slice(0, 8)}`;
}

export default router.post(
  "/",
  validateFields({
    sourceWorldId: z.number(),
    roleId: z.string(),
  }),
  async (req, res) => {
    try {
      const currentUserId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(currentUserId) || currentUserId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }

      const sourceWorldId = Number(req.body.sourceWorldId || 0);
      const roleId = String(req.body.roleId || "").trim();
      if (!sourceWorldId || !roleId) {
        return res.status(400).send(error("缺少 sourceWorldId 或 roleId"));
      }

      const db = getGameDb();
      const sourceWorld = await db("t_storyWorld as w")
        .leftJoin("t_project as p", "w.projectId", "p.id")
        .where("w.id", sourceWorldId)
        .where("p.userId", currentUserId)
        .select("w.id", "w.name", "w.settings")
        .first();
      if (!sourceWorld) {
        return res.status(404).send(error("未找到来源故事"));
      }

      const settings = parseJsonSafe<JsonRecord>(sourceWorld.settings, {});
      const rawRoles = Array.isArray(settings.roles) ? settings.roles : [];
      const sourceRole = rawRoles
        .map((roleRaw, index) => normalizeImportSourceRole(roleRaw, `npc_${index + 1}`, `角色${index + 1}`))
        .find((item) => item && String(item.id || "").trim() === roleId);
      if (!sourceRole) {
        return res.status(404).send(error("未找到来源角色"));
      }

      const importedRoleId = buildImportedRoleId();
      const clonedRole = await cloneRoleAssets(sourceRole, {
        userId: currentUserId,
        targetRoleId: importedRoleId,
        cache: new Map<string, string>(),
      });
      clonedRole.id = importedRoleId;

      return res.status(200).send(success({
        role: clonedRole,
        sourceWorldId,
        sourceWorldName: String(sourceWorld.name || "").trim() || "未命名故事",
      }, "导入角色成功"));
    } catch (err) {
      return res.status(500).send(error(u.error(err).message));
    }
  },
);
