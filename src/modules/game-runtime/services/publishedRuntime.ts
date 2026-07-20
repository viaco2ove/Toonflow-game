/**
 * 方向2：发布表（t_storyWorld_published / t_storyChapter_published）的 runtime 读取门面。
 *
 * 玩家侧 runtime 一律改读发布表，与作者草稿隔离。所有读取集中在此，
 * 避免散落的 db("t_storyChapter") 直查。字段名与草稿表一致，归一化函数可直接复用。
 *
 * 兼容旧 session：worldPublishId 为空时返回 null，调用方回退读草稿表（保证不崩）。
 */
import {
  getGameDb,
  JsonRecord,
  normalizeChapterOutput,
  normalizeWorldOutput,
  parseJsonSafe,
} from "@/lib/gameEngine";

/**
 * 按 worldId 读该故事的发布世界快照（已 normalize）。无则返回 null。
 * 单版本覆盖下 published 表 UNIQUE(worldId)，一个 worldId 对应一行。
 */
export async function loadPublishedWorld(worldId: number, db?: any): Promise<JsonRecord | null> {
  if (!Number.isFinite(worldId) || worldId <= 0) return null;
  const client = db || getGameDb();
  const row = await client("t_storyWorld_published").where({ worldId }).first();
  return normalizeWorldOutput(row);
}

/**
 * 按 worldPublishId + chapterId 读发布章节快照（已 normalizeChapterOutput）。
 * 用于 runtime 取当前章节正文/outline/运行配置。
 */
export async function loadPublishedChapter(
  worldPublishId: number,
  chapterId: number,
  db?: any,
): Promise<JsonRecord | null> {
  if (!Number.isFinite(worldPublishId) || worldPublishId <= 0) return null;
  if (!Number.isFinite(chapterId) || chapterId <= 0) return null;
  const client = db || getGameDb();
  const row = await client("t_storyChapter_published")
    .where({ worldPublishId, chapterId })
    .first();
  return normalizeChapterOutput(row);
}

/** 按 worldPublishId 读首章（sort asc, id asc），用于 runtime 无明确 chapterId 时回退。 */
export async function loadPublishedFirstChapter(worldPublishId: number, db?: any): Promise<JsonRecord | null> {
  if (!Number.isFinite(worldPublishId) || worldPublishId <= 0) return null;
  const client = db || getGameDb();
  const row = await client("t_storyChapter_published")
    .where({ worldPublishId })
    .orderBy("sort", "asc")
    .orderBy("chapterId", "asc")
    .first();
  return normalizeChapterOutput(row);
}

/** 读某章发布快照里的 trigger 行（从 triggersJson 解析，未解析返回空数组）。 */
export async function loadPublishedChapterTriggers(
  worldPublishId: number,
  chapterId: number,
  db?: any,
): Promise<any[]> {
  if (!Number.isFinite(worldPublishId) || worldPublishId <= 0) return [];
  if (!Number.isFinite(chapterId) || chapterId <= 0) return [];
  const client = db || getGameDb();
  const row = await client("t_storyChapter_published")
    .where({ worldPublishId, chapterId })
    .select("triggersJson")
    .first();
  return parseJsonSafe<any[]>(row?.triggersJson, []) || [];
}

/** 读某章发布快照里的 task 行（从 tasksJson 解析，未解析返回空数组）。 */
export async function loadPublishedChapterTasks(
  worldPublishId: number,
  chapterId: number,
  db?: any,
): Promise<any[]> {
  if (!Number.isFinite(worldPublishId) || worldPublishId <= 0) return [];
  if (!Number.isFinite(chapterId) || chapterId <= 0) return [];
  const client = db || getGameDb();
  const row = await client("t_storyChapter_published")
    .where({ worldPublishId, chapterId })
    .select("tasksJson")
    .first();
  return parseJsonSafe<any[]>(row?.tasksJson, []) || [];
}

/** 按 worldPublishId 读全部发布章节（已 normalize），用于章节列表等场景。 */
export async function loadPublishedChapters(worldPublishId: number, db?: any): Promise<JsonRecord[]> {
  if (!Number.isFinite(worldPublishId) || worldPublishId <= 0) return [];
  const client = db || getGameDb();
  const rows = await client("t_storyChapter_published")
    .where({ worldPublishId })
    .orderBy("sort", "asc")
    .orderBy("chapterId", "asc");
  return rows.map((row: any) => normalizeChapterOutput(row)).filter(Boolean);
}
