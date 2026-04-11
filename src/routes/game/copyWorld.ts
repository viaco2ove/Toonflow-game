import path from "node:path";
import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  getGameDb,
  normalizeChapterOutput,
  normalizeWorldOutput,
  nowTs,
  parseJsonSafe,
  toJsonText,
  type JsonRecord,
} from "@/lib/gameEngine";
import u from "@/utils";

const router = express.Router();

type AssetCloneContext = {
  userId: number;
  worldId: number;
  cache: Map<string, string>;
};

/**
 * 构造草稿副本名称。
 * 复制后的故事必须和原故事区分开，同时保留原名方便用户识别来源。
 */
function buildCopiedWorldName(sourceName: string, timestamp: number): string {
  const baseName = String(sourceName || "").trim() || "未命名故事";
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  const second = `${date.getSeconds()}`.padStart(2, "0");
  return `${baseName}${year}${month}${day}_${hour}${minute}${second}`;
}

/**
 * 仅把“看起来像 OSS 相对路径”的值当成候选资源路径。
 * 这样可以避免把普通文案、条件文本、角色描述误当成文件路径复制。
 */
function looksLikeOssPath(value: string): boolean {
  const text = String(value || "").trim();
  if (!text.startsWith("/")) return false;
  if (text.length > 512) return false;
  if (/[\r\n]/.test(text)) return false;
  return !/^https?:\/\//i.test(text);
}

/**
 * 生成副本资源文件名，尽量保留原文件名语义，便于排查来源。
 */
function buildCopiedAssetPath(input: {
  userId: number;
  worldId: number;
  sourcePath: string;
}): string {
  const ext = path.extname(input.sourcePath).trim() || "";
  const sourceName = path.basename(input.sourcePath, ext).replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 32) || "asset";
  const fileId = u.uuid().replace(/-/g, "").slice(0, 12);
  return `/${input.userId}/game/world-copy/${input.worldId}/${sourceName}_${fileId}${ext}`;
}

/**
 * 复制单个 OSS 文件并返回新路径。
 * 同一路径在一次复制请求内只会真的拷贝一次，避免封面/设置中的重复引用重复落盘。
 */
async function cloneOssPathIfNeeded(sourcePath: string, context: AssetCloneContext): Promise<string> {
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
    // 源故事若引用了失效资源，这里保持原路径，避免整个复制流程因历史脏数据失败。
    return normalizedSourcePath;
  }
  const nextPath = buildCopiedAssetPath({
    userId: context.userId,
    worldId: context.worldId,
    sourcePath: normalizedSourcePath,
  });
  const fileBuffer = await u.oss.getFile(normalizedSourcePath);
  await u.oss.writeFile(nextPath, fileBuffer);
  context.cache.set(normalizedSourcePath, nextPath);
  return nextPath;
}

/**
 * 深度遍历世界配置/角色配置/章节配置，把其中引用到的 OSS 文件路径复制到新世界目录。
 * 复制后返回结构完全相同、但资源路径全新的一份对象。
 */
async function cloneStructuredAssets<T>(input: T, context: AssetCloneContext): Promise<T> {
  if (typeof input === "string") {
    return (await cloneOssPathIfNeeded(input, context)) as T;
  }
  if (Array.isArray(input)) {
    const nextList = await Promise.all(input.map((item) => cloneStructuredAssets(item, context)));
    return nextList as T;
  }
  if (input && typeof input === "object") {
    const entries = await Promise.all(
      Object.entries(input as Record<string, unknown>).map(async ([key, value]) => [key, await cloneStructuredAssets(value, context)] as const),
    );
    return Object.fromEntries(entries) as T;
  }
  return input;
}

export default router.post(
  "/",
  validateFields({
    worldId: z.number(),
  }),
  async (req, res) => {
    try {
      const sourceWorldId = Number(req.body.worldId || 0);
      const currentUserId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(currentUserId) || currentUserId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }

      const db = getGameDb();
      const sourceWorld = await db("t_storyWorld as w")
        .leftJoin("t_project as p", "w.projectId", "p.id")
        .where("w.id", sourceWorldId)
        .where("p.userId", currentUserId)
        .select("w.*")
        .first();
      if (!sourceWorld) {
        return res.status(404).send(error("未找到可复制的故事"));
      }

      const sourceChapters = await db("t_storyChapter")
        .where({ worldId: sourceWorldId })
        .orderBy("sort", "asc")
        .orderBy("id", "asc");
      const copiedAt = nowTs();
      const copiedName = buildCopiedWorldName(String(sourceWorld.name || ""), copiedAt);
      const sourceSettings = parseJsonSafe<JsonRecord>(sourceWorld.settings, {});
      const sourcePlayerRole = parseJsonSafe<JsonRecord>(sourceWorld.playerRole, {});
      const sourceNarratorRole = parseJsonSafe<JsonRecord>(sourceWorld.narratorRole, {});

      const copiedWorld = await db.transaction(async (trx: any) => {
        // 先创建一条新的草稿世界记录，拿到稳定 worldId 后再把所有资源复制到这个世界目录下。
        const insertWorldResult = await trx("t_storyWorld").insert({
          projectId: Number(sourceWorld.projectId || 0),
          name: copiedName,
          intro: String(sourceWorld.intro || "").trim(),
          coverPath: "",
          publishStatus: "draft",
          settings: toJsonText({}, {}),
          playerRole: toJsonText(sourcePlayerRole, {}),
          narratorRole: toJsonText(sourceNarratorRole, {}),
          createTime: copiedAt,
          updateTime: copiedAt,
        });
        const copiedWorldId = Number(Array.isArray(insertWorldResult) ? insertWorldResult[0] : insertWorldResult);
        const assetCloneContext: AssetCloneContext = {
          userId: currentUserId,
          worldId: copiedWorldId,
          cache: new Map<string, string>(),
        };

        const clonedCoverPath = await cloneOssPathIfNeeded(String(sourceWorld.coverPath || "").trim(), assetCloneContext);
        const clonedSettings = await cloneStructuredAssets(sourceSettings, assetCloneContext);
        const clonedPlayerRole = await cloneStructuredAssets(sourcePlayerRole, assetCloneContext);
        const clonedNarratorRole = await cloneStructuredAssets(sourceNarratorRole, assetCloneContext);

        // 新副本必须回到草稿态，避免复制已发布故事时把发布状态也一并带过去。
        clonedSettings.publishStatus = "draft";
        if (clonedCoverPath) {
          clonedSettings.coverPath = clonedCoverPath;
        }

        await trx("t_storyWorld").where({ id: copiedWorldId }).update({
          name: copiedName,
          intro: String(sourceWorld.intro || "").trim(),
          coverPath: clonedCoverPath,
          publishStatus: "draft",
          settings: toJsonText(clonedSettings, {}),
          playerRole: toJsonText(clonedPlayerRole, {}),
          narratorRole: toJsonText(clonedNarratorRole, {}),
          updateTime: copiedAt,
        });

        for (const chapterRow of sourceChapters) {
          const clonedEntryCondition = await cloneStructuredAssets(parseJsonSafe(chapterRow.entryCondition, null), assetCloneContext);
          const clonedCompletionCondition = await cloneStructuredAssets(parseJsonSafe(chapterRow.completionCondition, null), assetCloneContext);
          const clonedRuntimeOutline = await cloneStructuredAssets(parseJsonSafe(chapterRow.runtimeOutline, {}), assetCloneContext);
          const clonedBackgroundPath = await cloneOssPathIfNeeded(String(chapterRow.backgroundPath || "").trim(), assetCloneContext);
          const clonedBgmPath = await cloneOssPathIfNeeded(String(chapterRow.bgmPath || "").trim(), assetCloneContext);

          // 章节复制成草稿，确保新故事在草稿箱中可以独立编辑，不会继承原发布故事的章节状态。
          await trx("t_storyChapter").insert({
            worldId: copiedWorldId,
            chapterKey: String(chapterRow.chapterKey || "").trim(),
            backgroundPath: clonedBackgroundPath,
            openingRole: String(chapterRow.openingRole || "").trim(),
            openingText: String(chapterRow.openingText || "").trim(),
            bgmPath: clonedBgmPath,
            bgmAutoPlay: Number(chapterRow.bgmAutoPlay || 0) ? 1 : 0,
            showCompletionCondition: Number(chapterRow.showCompletionCondition || 0) ? 1 : 0,
            title: String(chapterRow.title || "").trim(),
            content: String(chapterRow.content || ""),
            entryCondition: toJsonText(clonedEntryCondition, null),
            completionCondition: toJsonText(clonedCompletionCondition, null),
            runtimeOutline: toJsonText(clonedRuntimeOutline, {}),
            sort: Number(chapterRow.sort || 0),
            status: "draft",
            createTime: copiedAt,
            updateTime: copiedAt,
          });
        }

        return trx("t_storyWorld").where({ id: copiedWorldId }).first();
      });

      const chapterCountRow = await db("t_storyChapter").where({ worldId: Number(copiedWorld.id) }).count({ count: "id" }).first();
      const sessionCountRow = await db("t_gameSession")
        .where({ worldId: Number(copiedWorld.id) })
        .countDistinct({ count: "userId" })
        .first();

      return res.status(200).send(success({
        ...normalizeWorldOutput(copiedWorld),
        chapterCount: Number((chapterCountRow as any)?.count || 0),
        sessionCount: Number((sessionCountRow as any)?.count || 0),
      }, "复制故事成功"));
    } catch (err) {
      return res.status(500).send(error(u.error(err).message));
    }
  },
);
