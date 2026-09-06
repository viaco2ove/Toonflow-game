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

/** 文件头特征：WebP `UklGR` / PNG `iVBORw0KGgo` / JPEG `/9j/` / GIF `R0lGOD` */
const RAW_BASE64_HEADER_RE = /^(UklGR[A-Za-z0-9+/=]{0,8}|iVBORw0KGgo[A-Za-z0-9+/=]{0,8}|\/9j\/[A-Za-z0-9+/=]{0,8}|R0lGOD[A-Za-z0-9+/=]{0,8})/;

/**
 * 把字符串里的图片 base64（无论有无 data URL 头）落盘，返回文件 URL。
 * 提取 base64 payload 时按"最后一个可能的图片文件头"为分界，
 * 之前的部分是文件名/路径等元信息（保留），之后的全部落盘。
 */
async function persistImageString(raw: string, projectId: number, userId: number): Promise<string> {
  const value = raw.trim();
  let mime = "";
  let payload = "";
  const dataMatch = value.match(BASE64_IMAGE_RE);
  if (dataMatch) {
    mime = String(dataMatch[1] || "").toLowerCase();
    payload = value.replace(BASE64_IMAGE_RE, "");
  } else {
    // 裸 base64：从字符串开头找到文件头
    const headerIdx = value.search(RAW_BASE64_HEADER_RE);
    if (headerIdx < 0) return raw; // 真的不是图片
    mime =
      value.startsWith("UklGR") ? "webp" :
      value.startsWith("iVBORw0KGgo") ? "png" :
      value.startsWith("/9j/") ? "jpeg" :
      value.startsWith("R0lGOD") ? "gif" : "";
    if (!mime) return raw;
    // 之前可能是一段无意义字符（一些字段名/JSON 残留），整体作 base64
    payload = value.substring(headerIdx);
  }
  // 容错：base64 字符集
  if (!/^[A-Za-z0-9+/=\s]+$/.test(payload)) return raw;
  // 太短不像图片
  if (payload.length < 256) return raw;

  const ext = mime === "jpeg" ? "jpg" : mime;
  const imagePath = projectId > 0
    ? `/${projectId}/game/world/${uuidv4()}.${ext}`
    : `/user/${userId}/game/world/${uuidv4()}.${ext}`;
  const buffer = Buffer.from(payload.replace(/\s+/g, ""), "base64");
  if (buffer.length < 16) return raw;
  await u.oss.writeFile(imagePath, buffer);
  return await u.oss.getFileUrl(imagePath);
}

/**
 * 判断字符串是否包含图片 base64（data URL 或裸 base64）。
 */
function isImageBase64String(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < 128) return false;
  if (BASE64_IMAGE_RE.test(trimmed)) return true;
  return RAW_BASE64_HEADER_RE.test(trimmed);
}

/**
 * 递归遍历对象/数组，把所有 base64 图片字符串（data URL 或裸 base64）替换为落盘后的文件 URL。
 *
 * 兜底场景：前端偶尔会直接把 base64 图片（甚至裸 base64 没 data URL 头）塞进
 * saveWorld 的 coverPath / settings / playerRole / narratorRole 里，导致上 MB 的二进制
 * 原样存进 t_storyWorld 的 text 列，listWorlds/getWorld 全部被拖慢。
 * 这里统一拦截，落盘为文件后仅保留 URL。
 */
async function persistBase64ImagesDeep(
  input: unknown,
  projectId: number,
  userId: number,
): Promise<unknown> {
  if (typeof input === "string") {
    if (isImageBase64String(input)) {
      try {
        return await persistImageString(input, projectId, userId);
      } catch (err) {
        console.warn("[saveWorld] persist base64 image failed, keep original string", {
          message: (err as Error)?.message,
          preview: input.slice(0, 60),
        });
        return input;
      }
    }
    return input;
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
        isImageBase64String(rawCoverPath) ? persistImageString(rawCoverPath, Number(projectId), currentUserId) : Promise.resolve(rawCoverPath),
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
