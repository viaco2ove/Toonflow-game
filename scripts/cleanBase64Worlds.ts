/**
 * 一次性清理脚本：扫描 t_storyWorld 里 settings/playerRole/narratorRole 列，
 * 把所有 base64 图片（data URL 或裸 base64）提取落盘，替换为文件 URL。
 *
 * 用法：
 *   tsx scripts/cleanBase64Worlds.ts                # 全部扫描
 *   tsx scripts/cleanBase64Worlds.ts --worldId=44   # 只处理 id=44
 *   tsx scripts/cleanBase64Worlds.ts --dry-run       # 只打印，不修改
 */
import knex from "knex";
import { getDbPath } from "../src/lib/runtimePaths";
import u from "../src/utils";
import { v4 as uuidv4 } from "uuid";
import { Buffer } from "node:buffer";

const BASE64_IMAGE_RE = /^data:image\/([a-z0-9.+-]+);base64,/i;
const RAW_BASE64_HEADER_RE = /^(UklGR[A-Za-z0-9+/=]{0,8}|iVBORw0KGgo[A-Za-z0-9+/=]{0,8}|\/9j\/[A-Za-z0-9+/=]{0,8}|R0lGOD[A-Za-z0-9+/=]{0,8})/;

function isImageBase64(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < 128) return false;
  if (BASE64_IMAGE_RE.test(trimmed)) return true;
  return RAW_BASE64_HEADER_RE.test(trimmed);
}

async function persistImageString(raw: string, projectId: number, userId: number): Promise<string> {
  const value = raw.trim();
  let mime = "";
  let payload = "";
  const dataMatch = value.match(BASE64_IMAGE_RE);
  if (dataMatch) {
    mime = String(dataMatch[1] || "").toLowerCase();
    payload = value.replace(BASE64_IMAGE_RE, "");
  } else {
    const headerIdx = value.search(RAW_BASE64_HEADER_RE);
    if (headerIdx < 0) return raw;
    mime =
      value.startsWith("UklGR") ? "webp" :
      value.startsWith("iVBORw0KGgo") ? "png" :
      value.startsWith("/9j/") ? "jpeg" :
      value.startsWith("R0lGOD") ? "gif" : "";
    if (!mime) return raw;
    payload = value.substring(headerIdx);
  }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(payload)) return raw;
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

async function cleanDeep(input: unknown, projectId: number, userId: number): Promise<{ result: unknown; changed: number }> {
  let changed = 0;
  async function walk(node: unknown): Promise<unknown> {
    if (typeof node === "string") {
      if (isImageBase64(node)) {
        try {
          const url = await persistImageString(node, projectId, userId);
          if (url !== node) changed += 1;
          return url;
        } catch (err) {
          console.warn("[cleanBase64Worlds] persist failed:", (err as Error)?.message, "— keeping original");
          return node;
        }
      }
      return node;
    }
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      for (const item of node) out.push(await walk(item));
      return out;
    }
    if (node && typeof node === "object") {
      const src = node as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(src)) out[key] = await walk(src[key]);
      return out;
    }
    return node;
  }
  const result = await walk(input);
  return { result, changed };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const worldIdArg = args.find((a) => a.startsWith("--worldId="));
  const onlyWorldId = worldIdArg ? Number(worldIdArg.split("=")[1]) : null;

  const db = knex({
    client: "sqlite3",
    connection: { filename: getDbPath() },
    useNullAsDefault: true,
  });

  let query = db("t_storyWorld as w")
    .leftJoin("t_project as p", "w.projectId", "p.id")
    .select("w.id", "w.projectId", "w.settings", "w.playerRole", "w.narratorRole", "p.userId")
    .where(function () {
      this.where("w.settings", "like", "%UklGR%")
        .orWhere("w.settings", "like", "%iVBORw0KGgo%")
        .orWhere("w.settings", "like", "%/9j/4AAQ%")
        .orWhere("w.playerRole", "like", "%UklGR%")
        .orWhere("w.playerRole", "like", "%iVBORw0KGgo%")
        .orWhere("w.narratorRole", "like", "%UklGR%")
        .orWhere("w.narratorRole", "like", "%iVBORw0KGgo%");
    });
  if (onlyWorldId) query = query.where("w.id", onlyWorldId);
  const rows = await query;
  console.log(`[cleanBase64Worlds] ${rows.length} row(s) matched`);

  for (const row of rows) {
    const projectId = Number(row.projectId || 0);
    const userId = Number(row.userId || 0);
    console.log(`-- worldId=${row.id} projectId=${projectId} userId=${userId} --`);
    for (const column of ["settings", "playerRole", "narratorRole"] as const) {
      const raw = String((row as any)[column] || "");
      if (!isImageBase64(raw)) continue;
      console.log(`  cleaning ${column} (${raw.length} bytes)`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
      const { result, changed } = await cleanDeep(parsed, projectId, userId);
      if (changed === 0) {
        console.log(`    nothing to persist, skip`);
        continue;
      }
      const serialized = typeof result === "string" ? result : JSON.stringify(result);
      console.log(`    persisted ${changed} image(s), new size = ${serialized.length} bytes`);
      if (!dryRun) {
        await db("t_storyWorld").where({ id: row.id }).update({ [column]: serialized });
        console.log(`    updated ${column} in db`);
      }
    }
  }
  await db.destroy();
  console.log("[cleanBase64Worlds] done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});