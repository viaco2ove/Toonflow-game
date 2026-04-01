import express from "express";
import { z } from "zod";
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

export default router.post(
  "/",
  validateFields({
    worldId: z.number().optional().nullable(),
    projectId: z.number(),
    name: z.string(),
    intro: z.string().optional().nullable(),
    coverPath: z.string().optional().nullable(),
    publishStatus: z.string().optional().nullable(),
    settings: z.any().optional().nullable(),
    playerRole: z.any().optional().nullable(),
    narratorRole: z.any().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const { worldId, projectId, name, intro, coverPath, publishStatus, settings, playerRole, narratorRole } = req.body;
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

      const rolePair = normalizeRolePair(playerRole, narratorRole);

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

      const normalizedCoverPath = String(coverPath || "").trim();
      const requestedPublishStatus = String(publishStatus || existing?.publishStatus || "draft").trim() || "draft";
      const isPublishRequest = requestedPublishStatus === "published";
      const normalizedPublishStatus = isPublishRequest ? "publishing" : requestedPublishStatus;
      const normalizedSettings = normalizeWorldSettings(settings, {
        coverPath: normalizedCoverPath,
        publishStatus: normalizedPublishStatus,
      });

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
