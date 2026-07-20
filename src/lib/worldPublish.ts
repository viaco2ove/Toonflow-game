import {
  getGameDb,
  JsonRecord,
  normalizeChapterOutput,
  normalizeWorldOutput,
  normalizeWorldSettings,
  nowTs,
  parseJsonSafe,
  toJsonText,
} from "@/lib/gameEngine";
import { ensureWorldRolesWithAiParameterCards } from "@/lib/roleParameterCard";
import {
  buildChapterInitialSnapshotCache,
  ChapterInitialSnapshotCache,
} from "@/lib/sessionInitialSnapshot";

const PUBLISH_FAILURE_REASON_KEY = "publishFailureReason";
const CHAPTER_INITIAL_SNAPSHOT_KEY = "chapterInitialSnapshots";

function asRecord(input: unknown): JsonRecord {
  return input && typeof input === "object" && !Array.isArray(input) ? { ...(input as JsonRecord) } : {};
}

function sanitizePublishFailureReason(input: unknown): string {
  const raw = String(input || "").trim();
  if (!raw) return "";
  return raw.slice(0, 500);
}

function buildWorldSettingsWithPublishState(world: any, publishStatus: string, failureReason = ""): JsonRecord {
  const settings = normalizeWorldSettings(world?.settings, {
    coverPath: world?.coverPath,
    publishStatus,
  });
  if (failureReason) {
    settings[PUBLISH_FAILURE_REASON_KEY] = failureReason;
  } else {
    delete settings[PUBLISH_FAILURE_REASON_KEY];
  }
  return settings;
}

async function updateWorldPublishState(input: {
  worldId: number;
  world: any;
  publishStatus: string;
  failureReason?: string;
  playerRole?: unknown;
  narratorRole?: unknown;
  settings?: unknown;
}) {
  const db = getGameDb();
  const nextSettings = input.settings
    ? asRecord(input.settings)
    : buildWorldSettingsWithPublishState(input.world, input.publishStatus, input.failureReason || "");
  if (!input.failureReason) {
    delete nextSettings[PUBLISH_FAILURE_REASON_KEY];
  }
  await db("t_storyWorld")
    .where({ id: input.worldId })
    .update({
      publishStatus: input.publishStatus,
      playerRole: typeof input.playerRole === "undefined" ? input.world.playerRole : toJsonText(input.playerRole, {}),
      narratorRole: typeof input.narratorRole === "undefined" ? input.world.narratorRole : toJsonText(input.narratorRole, {}),
      settings: toJsonText(nextSettings, {}),
      updateTime: nowTs(),
    });
}

/**
 * 方向2：把已发布的草稿世界快照覆盖写入发布表（单版本）。
 * - t_storyWorld_published：UNIQUE(worldId)，存在则覆盖（保留 id），version 每次 +1。
 * - t_storyChapter_published：先删旧章节行，再按新 worldPublishId 批量插入。
 * - 额外快照每章的 t_chapterTrigger / t_chapterTask 行（runtime 也读这些，必须一并冻结）。
 *
 * 在 publishWorldSynchronously 成功更新草稿表 published 状态后调用，事务内执行。
 */
export async function snapshotWorldToPublished(input: {
  worldId: number;
  userId: number;
  enrichedWorld: any;
  chapters: any[];
  publishedAt: number;
}): Promise<{ worldPublishId: number; version: number }> {
  const db = getGameDb();
  const worldId = Number(input.worldId || 0);
  const publishedAt = Number(input.publishedAt || 0);
  const enrichedWorld = input.enrichedWorld;
  const chapters = Array.isArray(input.chapters) ? input.chapters : [];

  return db.transaction(async (trx: any) => {
    // 1. 取现有 published 行 -> 决定 version 与是否复用 id
    const existing = await trx("t_storyWorld_published").where({ worldId }).first();
    const version = Number(existing?.version || 0) + 1;
    const publishedBy = String(input.userId || "");

    // 2. 读该 world 全部 trigger / task，按 chapterId 分组
    const chapterIds = chapters.map((c: any) => Number(c?.id || 0)).filter((id: number) => id > 0);
    const triggerRows = chapterIds.length
      ? await trx("t_chapterTrigger").whereIn("chapterId", chapterIds).orderBy("sort", "asc").orderBy("id", "asc")
      : [];
    const taskRows = chapterIds.length
      ? await trx("t_chapterTask").whereIn("chapterId", chapterIds).orderBy("sort", "asc").orderBy("id", "asc")
      : [];
    const triggersByChapter = new Map<number, any[]>();
    const tasksByChapter = new Map<number, any[]>();
    for (const row of triggerRows) {
      const cid = Number(row.chapterId || 0);
      if (!cid) continue;
      if (!triggersByChapter.has(cid)) triggersByChapter.set(cid, []);
      triggersByChapter.get(cid)!.push(row);
    }
    for (const row of taskRows) {
      const cid = Number(row.chapterId || 0);
      if (!cid) continue;
      if (!tasksByChapter.has(cid)) tasksByChapter.set(cid, []);
      tasksByChapter.get(cid)!.push(row);
    }

    // 3. 覆盖写 t_storyWorld_published（含 settings 里的 chapterInitialSnapshots）
    const worldPayload: Record<string, unknown> = {
      worldId,
      version,
      publishedAt,
      publishedBy,
      name: enrichedWorld?.name ?? null,
      intro: enrichedWorld?.intro ?? null,
      coverPath: enrichedWorld?.coverPath ?? null,
      settings: typeof enrichedWorld?.settings === "string"
        ? enrichedWorld.settings
        : toJsonText(enrichedWorld?.settings, {}),
      playerRole: typeof enrichedWorld?.playerRole === "string"
        ? enrichedWorld.playerRole
        : toJsonText(enrichedWorld?.playerRole, {}),
      narratorRole: typeof enrichedWorld?.narratorRole === "string"
        ? enrichedWorld.narratorRole
        : toJsonText(enrichedWorld?.narratorRole, {}),
      projectId: Number(enrichedWorld?.projectId || 0) || null,
      createTime: Number(enrichedWorld?.createTime || 0) || null,
      updateTime: Number(enrichedWorld?.updateTime || 0) || null,
    };

    let worldPublishId: number;
    if (existing?.id) {
      worldPublishId = Number(existing.id);
      worldPayload.id = worldPublishId;
      await trx("t_storyWorld_published").where({ id: worldPublishId }).update(worldPayload);
      // 删旧章节行
      await trx("t_storyChapter_published").where({ worldPublishId }).delete();
    } else {
      // 新 published 行：用 worldId 作为 id（单版本、稳定可预测，便于回填定位）
      worldPublishId = worldId;
      worldPayload.id = worldPublishId;
      await trx("t_storyWorld_published").insert(worldPayload);
    }

    // 4. 批量插入发布章节快照
    const chapterInsertRows = chapters.map((chapter: any) => ({
      id: Number(chapter.id || 0), // 用 chapterId 作 published 行 id（单版本下稳定唯一）
      worldPublishId,
      chapterId: Number(chapter.id || 0),
      title: chapter.title ?? null,
      content: chapter.content ?? null,
      runtimeOutline: typeof chapter.runtimeOutline === "string"
        ? chapter.runtimeOutline
        : toJsonText(chapter.runtimeOutline, {}),
      sort: Number(chapter.sort || 0) || null,
      openingRole: chapter.openingRole ?? null,
      openingText: chapter.openingText ?? null,
      bgmPath: chapter.bgmPath ?? null,
      bgmAutoPlay: chapter.bgmAutoPlay ?? null,
      backgroundPath: chapter.backgroundPath ?? null,
      entryCondition: chapter.entryCondition ?? null,
      completionCondition: chapter.completionCondition ?? null,
      showCompletionCondition: chapter.showCompletionCondition ?? null,
      triggersJson: JSON.stringify(triggersByChapter.get(Number(chapter.id || 0)) || []),
      tasksJson: JSON.stringify(tasksByChapter.get(Number(chapter.id || 0)) || []),
      publishedAt,
    }));
    if (chapterInsertRows.length) {
      await trx("t_storyChapter_published").insert(chapterInsertRows);
    }

    return { worldPublishId, version };
  });
}

export async function publishWorldSynchronously(input: {
  worldId: number;
  userId: number;
}) {  const db = getGameDb();
  const worldId = Number(input.worldId || 0);
  if (!worldId) {
    throw new Error("worldId 无效");
  }
  const userId = Number(input.userId || 0);
  if (!userId) {
    throw new Error("userId 无效");
  }
  let world = await db("t_storyWorld").where({ id: worldId }).first();
  if (!world) {
    throw new Error("世界观不存在");
  }

  const publishingSettings = buildWorldSettingsWithPublishState(world, "publishing");
  await updateWorldPublishState({
    worldId,
    world,
    publishStatus: "publishing",
    settings: publishingSettings,
  });

  try {
    world = await db("t_storyWorld").where({ id: worldId }).first();
    if (!world) {
      throw new Error("世界观不存在");
    }

    const enrichedWorld = await ensureWorldRolesWithAiParameterCards({
      userId,
      world,
      persist: false,
      forceRefresh: true,
    });
    const chapters = (
      await db("t_storyChapter")
        .where({ worldId })
        .orderBy("sort", "asc")
        .orderBy("id", "asc")
    )
      .map((row: any) => normalizeChapterOutput(row))
      .filter(Boolean);

    const nextSettings = buildWorldSettingsWithPublishState(enrichedWorld, "published");
    const snapshotMap = asRecord(nextSettings[CHAPTER_INITIAL_SNAPSHOT_KEY]) as Record<string, ChapterInitialSnapshotCache>;

    for (const chapter of chapters) {
      const snapshotSourceWorld = {
        ...enrichedWorld,
        settings: nextSettings,
      };
      const { snapshot } = await buildChapterInitialSnapshotCache({
        userId,
        world: snapshotSourceWorld,
        chapter,
      });
      snapshotMap[String(snapshot.chapterId)] = snapshot;
    }

    nextSettings[CHAPTER_INITIAL_SNAPSHOT_KEY] = snapshotMap;
    delete nextSettings[PUBLISH_FAILURE_REASON_KEY];

    await updateWorldPublishState({
      worldId,
      world: enrichedWorld,
      publishStatus: "published",
      playerRole: enrichedWorld.playerRole,
      narratorRole: enrichedWorld.narratorRole,
      settings: nextSettings,
    });

    // 方向2：草稿 published 成功后，把快照覆盖写入发布表（单版本，version+1）
    // 注意：enrichedWorld.settings 此刻还是旧值，含 chapterInitialSnapshots 的是 nextSettings，
    // 这里合并后再快照，确保发布表 settings 与草稿表一致。
    try {
      await snapshotWorldToPublished({
        worldId,
        userId,
        enrichedWorld: { ...enrichedWorld, settings: nextSettings },
        chapters,
        publishedAt: nowTs(),
      });
    } catch (snapshotErr) {
      // 快照写入失败不回滚草稿发布状态（草稿侧已 published），
      // 但记录原因并抛出，让作者看到发布异常。runtime 仍可回退读草稿（兼容旧 session 路径）。
      console.error("[worldPublish] snapshotWorldToPublished failed", {
        worldId,
        message: (snapshotErr as any)?.message || String(snapshotErr),
      });
      throw snapshotErr;
    }

    const publishedWorld = await db("t_storyWorld").where({ id: worldId }).first();
    return normalizeWorldOutput(publishedWorld);
  } catch (err) {
    const failureReason = sanitizePublishFailureReason((err as any)?.message || String(err));
    const latestWorld = await db("t_storyWorld").where({ id: worldId }).first();
    if (latestWorld) {
      const failedSettings = buildWorldSettingsWithPublishState(latestWorld, "publish_failed", failureReason);
      await updateWorldPublishState({
        worldId,
        world: latestWorld,
        publishStatus: "publish_failed",
        settings: failedSettings,
      });
    }
    throw err;
  }
}

export function getWorldPublishFailureReason(world: unknown): string {
  const settings = parseJsonSafe<JsonRecord>(asRecord(world).settings, {});
  return String(settings[PUBLISH_FAILURE_REASON_KEY] || "").trim();
}
