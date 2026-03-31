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

export async function publishWorldSynchronously(input: {
  worldId: number;
  userId: number;
}) {
  const db = getGameDb();
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
