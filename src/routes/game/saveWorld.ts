import express from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  getGameDb,
  normalizeRolePair,
  normalizeWorldSettings,
  normalizeWorldOutput,
  nowTs,
  toJsonText,
} from "@/lib/gameEngine";
import { ensureWorldRolesWithAiParameterCards } from "@/lib/roleParameterCard";
import { normalizeChapterOutput } from "@/lib/gameEngine";
import { prewarmChapterInitialSnapshotCache } from "@/lib/sessionInitialSnapshot";
import { publishWorldSynchronously } from "@/lib/worldPublish";
import u from "@/utils";

const router = express.Router();

/** 匹配 data:image/xxx;base64, 前缀（含 webp/png/jpeg/gif） */
const BASE64_IMAGE_RE = /^data:image\/([a-z0-9.+-]+);base64,/i;

/**
 * 判断字符串是否为 base64 图片（data URL 形式）。
 */
function isBase64Image(value: unknown): value is string {
  return typeof value === "string" && BASE64_IMAGE_RE.test(value.trim()) && value.length > 128;
}

/**
 * 把 base64 图片落盘为文件，返回可访问的文件路径。
 * 复用 uploadImage 的存储约定：/{projectId}/game/world/{uuid}.{ext}
 */
async function saveBase64ImageToProject(base64Data: string, projectId: number, userId: number): Promise<string> {
  const value = base64Data.trim();
  const mime = value.match(BASE64_IMAGE_RE)?.[1]?.toLowerCase() || "png";
  const ext = mime === "jpeg" ? "jpg" : mime;
  const imagePath = projectId > 0
    ? `/${projectId}/game/world/${uuidv4()}.${ext}`
    : `/user/${userId}/game/world/${uuidv4()}.${ext}`;
  const buffer = Buffer.from(value.replace(BASE64_IMAGE_RE, ""), "base64");
  await u.oss.writeFile(imagePath, buffer);
  return await u.oss.getFileUrl(imagePath);
}

/**
 * 递归遍历对象/数组，把所有 base64 图片字符串替换为落盘后的文件 URL。
 *
 * 兜底场景：前端偶尔会直接把 data:image/...;base64, 塞进 saveWorld 的
 * coverPath / settings / playerRole / narratorRole 里，导致巨大的 base64
 * 被原样存进 t_storyWorld 的 text 列，listWorlds/getWorld 全部被拖慢。
 * 这里统一拦截，落盘为文件后仅保留 URL。
 */
async function persistBase64ImagesDeep(
  input: unknown,
  projectId: number,
  userId: number,
): Promise<unknown> {
  if (typeof input === "string") {
    return isBase64Image(input) ? await saveBase64ImageToProject(input, projectId, userId) : input;
  }
  if (Array.isArray(input)) {
    const result: unknown[] = [];
    for (const item of input) {
      result.push(await persistBase64ImagesDeep(item, projectId, userId));
    }
    return result;
  }
  if (input && typeof input === "object") {
    const source = input as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      result[key] = await persistBase64ImagesDeep(source[key], projectId, userId);
    }
    return result;
  }
  return input;
}

export default router.post(
  "/",
  validateFields({
    worldId: z.number().optional().nullable(),
    projectId: z.number(),
    name: z.string(),
    intro: z.string().optional().nullable(),
    coverPath: z.string().optional().nullable(),
    publishStatus: z.string().optional().nullable(),
    /** 前端显式点击"存草稿"按钮时为 true，用于决定是否强制刷新角色参数卡 */
    forceRefreshRoleCards: z.boolean().optional().nullable(),
    settings: z.any().optional().nullable(),
    playerRole: z.any().optional().nullable(),
    narratorRole: z.any().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const { worldId, projectId, name, intro, coverPath, publishStatus, forceRefreshRoleCards, settings, playerRole, narratorRole } = req.body;
      console.log("[saveWorld] playerRole.description:", playerRole?.description);
      const db = getGameDb();
      const now = nowTs();
      const currentUserId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(currentUserId) || currentUserId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }

      const project = await db("t_project").where({ id: Number(projectId), userId: currentUserId }).first();
      if (!project) {
        return res.status(403).send(error("无权访问该项目"));
      }

      const worldIdNum = Number(worldId);
      let existing: any = null;
      if (Number.isFinite(worldIdNum) && worldIdNum > 0) {
        existing = await db("t_storyWorld as w")
          .leftJoin("t_project as p", "w.projectId", "p.id")
          .where("w.id", worldIdNum)
          .where("p.userId", currentUserId)
          .select("w.*")
          .first();
      }
      if (worldIdNum > 0 && !existing) {
        return res.status(404).send(error("未找到世界观"));
      }

      const rawCoverPath = String(coverPath || "").trim();
      const requestedPublishStatus = String(publishStatus || existing?.publishStatus || "draft").trim() || "draft";
      const isPublishRequest = requestedPublishStatus === "published";
      const normalizedPublishStatus = isPublishRequest ? "publishing" : requestedPublishStatus;

      // 兜底：把请求里的 base64 图片（coverPath/settings/playerRole/narratorRole 深处）落盘为文件。
      // 避免 data:image/... 原样写进 t_storyWorld 的 text 列，拖慢后续所有读取接口。
      const [persistedCoverPath, persistedSettings, persistedPlayerRole, persistedNarratorRole] = await Promise.all([
        isBase64Image(rawCoverPath) ? saveBase64ImageToProject(rawCoverPath, Number(projectId), currentUserId) : Promise.resolve(rawCoverPath),
        persistBase64ImagesDeep(settings, Number(projectId), currentUserId),
        persistBase64ImagesDeep(playerRole, Number(projectId), currentUserId),
        persistBase64ImagesDeep(narratorRole, Number(projectId), currentUserId),
      ]);
      if (persistedCoverPath !== rawCoverPath) {
        console.log("[saveWorld] persisted base64 cover image to file");
      }

      const normalizedCoverPath = persistedCoverPath;
      const normalizedSettings = normalizeWorldSettings(persistedSettings, {
        coverPath: normalizedCoverPath,
        publishStatus: normalizedPublishStatus,
      });
      const rolePair = normalizeRolePair(persistedPlayerRole, persistedNarratorRole);

      const payload = {
        name: String(name || "").trim(),
        intro: String(intro || "").trim(),
        coverPath: normalizedCoverPath,
        publishStatus: normalizedPublishStatus,
        settings: toJsonText(normalizedSettings, {}),
        playerRole: toJsonText(rolePair.playerRole, {}),
        narratorRole: toJsonText(rolePair.narratorRole, {}),
        updateTime: now,
      };

      let id = 0;
      if (existing?.id) {
        id = Number(existing.id);
        await db("t_storyWorld").where({ id }).update({
          ...payload,
          projectId: Number(existing.projectId || projectId),
        });
      } else {
        const insertPayload = {
          ...payload,
          projectId,
          createTime: now,
        };
        const insertResult = await db("t_storyWorld").insert(insertPayload);
        id = Number(Array.isArray(insertResult) ? insertResult[0] : insertResult);
      }

      const row = await db("t_storyWorld").where({ id }).first();
      if (isPublishRequest) {
        const publishedWorld = await publishWorldSynchronously({
          worldId: id,
          userId: currentUserId,
        });
        return res.status(200).send(success(publishedWorld, "故事已发布并完成预生成"));
      }
      // 前端显式"存草稿"按钮 → forceRefreshRoleCards=true → 强制刷新角色参数卡（含 roleType）
      void ensureWorldRolesWithAiParameterCards({
        userId: currentUserId,
        world: {
          ...row,
          id,
          name: payload.name,
          intro: payload.intro,
          playerRole: rolePair.playerRole,
          narratorRole: rolePair.narratorRole,
          settings: normalizedSettings,
        },
        persist: true,
        forceRefresh: forceRefreshRoleCards === true,
      }).catch((asyncErr) => {
        console.warn("[saveWorld] async role parameter card generation failed", {
          worldId: id,
          userId: currentUserId,
          message: (asyncErr as any)?.message || String(asyncErr),
        });
      });
      // 保存世界后预热首章快照，供首次开始故事时直接复用，减少首进场等待。
      void (async () => {
        const firstChapter = normalizeChapterOutput(
          await db("t_storyChapter").where({ worldId: id }).orderBy("sort", "asc").orderBy("id", "asc").first(),
        );
        if (!firstChapter) return;
        await prewarmChapterInitialSnapshotCache({
          userId: currentUserId,
          world: {
            ...row,
            id,
            name: payload.name,
            intro: payload.intro,
            playerRole: rolePair.playerRole,
            narratorRole: rolePair.narratorRole,
            settings: normalizedSettings,
          },
          chapter: firstChapter,
        });
      })().catch((asyncErr) => {
        console.warn("[saveWorld] async initial snapshot prewarm failed", {
          worldId: id,
          userId: currentUserId,
          message: (asyncErr as any)?.message || String(asyncErr),
        });
      });
      res.status(200).send(success(normalizeWorldOutput(row), existing ? "更新世界观成功" : "创建世界观成功"));
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
