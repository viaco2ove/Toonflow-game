/**
 * 插件注册中心
 *
 * 职责：
 * 1. 插件安装（接收 base64 的 .tpg/zip 包 → 校验 manifest → 解压到插件目录 → 写 t_plugin 表）
 * 2. 卸载（删目录 + 删表记录）
 * 3. 启用/禁用（仅改表状态，不动文件）
 * 4. 列表查询（按用户）
 * 5. 静态资源读取（entry.js / ui/*.html / locales 等，带路径穿越防护）
 *
 * 插件目录约定：
 *   <数据根>/Toonflow-game/plugins/<userId>/<pluginId>/
 * 与 tavo 插件保持相同的包结构（manifest.json + entry.js + ui/ + locales/ [+ entry.py]）
 */

import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import { pipeline } from "stream/promises";
import { randomUUID } from "crypto";
import { getCurrentUserId } from "@/lib/requestContext";
import u from "@/utils";

export interface PluginManifest {
  specVersion: number;
  id: string;
  name?: { $t?: string; fallback?: string } | string;
  version?: string;
  author?: string;
  description?: { $t?: string; fallback?: string } | string;
  minAppVersion?: string;
  entry?: string;
  backendEntry?: string;
  cover?: string;
  permissions?: string[];
  contributes?: Record<string, any>;
  dependencies?: Record<string, string>;
}

export interface PluginRecord {
  id: number;
  userId: number;
  pluginId: string;
  name: string | null;
  version: string | null;
  author: string | null;
  description: string | null;
  dir: string;
  entry: string | null;
  backendEntry: string | null;
  manifestJson: string;
  enabled: number;
  status: string | null;
  installedAt: number | null;
  updatedAt: number | null;
}

/* ------------------------------------------------------------------ */
/* 路径                                                                */
/* ------------------------------------------------------------------ */

/** 插件根目录：<数据根>/Toonflow-game/plugins */
export function getPluginsRootDir(): string {
  // 与 getUploadRootDir 同源：<cwd>/Toonflow-game 或 Electron userData 下
  const { getUploadRootDir } = require("@/lib/runtimePaths");
  const uploadRoot = getUploadRootDir();
  // uploadRoot = <数据根>/Toonflow-game/uploads → plugins 目录与 uploads 平级
  return path.join(path.dirname(uploadRoot), "plugins");
}

/** 某用户的插件目录 */
export function getUserPluginsDir(userId: number): string {
  return path.join(getPluginsRootDir(), String(userId));
}

/** 某用户某插件的完整目录 */
export function getPluginDir(userId: number, pluginDirName: string): string {
  return path.join(getUserPluginsDir(userId), pluginDirName);
}

/* ------------------------------------------------------------------ */
/* manifest 解析                                                       */
/* ------------------------------------------------------------------ */

function readI18nText(value: PluginManifest["name"], manifestDir: string): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value || null;
  const fallback = String(value.fallback || "").trim();
  if (fallback) return fallback;
  // $t key 翻译暂不实现，直接用 fallback
  void manifestDir;
  return null;
}

export function parseManifest(raw: string, manifestDir: string): PluginManifest {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("manifest.json 不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("manifest.json 结构无效");
  if (!String(parsed.id || "").trim()) throw new Error("manifest.json 缺少 id");
  if (!String(parsed.entry || "").trim()) throw new Error("manifest.json 缺少 entry（前端入口）");
  const pluginId = String(parsed.id).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(pluginId)) {
    throw new Error(`插件 id 不合法: ${pluginId}（仅允许字母数字 . _ -）`);
  }
  const entry = String(parsed.entry || "").trim();
  if (/[\\/]/.test(entry.split("/").pop() || "")) {
    throw new Error("entry 不能包含路径分隔符之外的非法字符");
  }
  return {
    specVersion: Number(parsed.specVersion || 1),
    id: pluginId,
    name: parsed.name ?? undefined,
    version: String(parsed.version || "0.0.1"),
    author: String(parsed.author || ""),
    description: parsed.description ?? undefined,
    minAppVersion: String(parsed.minAppVersion || ""),
    entry,
    backendEntry: parsed.backendEntry ? String(parsed.backendEntry).trim() : undefined,
    cover: parsed.cover ? String(parsed.cover).trim() : undefined,
    permissions: Array.isArray(parsed.permissions) ? parsed.permissions.map(String) : [],
    contributes: parsed.contributes ?? undefined,
    dependencies: parsed.dependencies ?? {},
  };
}

/* ------------------------------------------------------------------ */
/* 安装                                                                */
/* ------------------------------------------------------------------ */

const PLUGIN_PACKAGE_MAX_BYTES = 100 * 1024 * 1024; // 100MB

function extractBase64(raw: string): Buffer {
  const value = String(raw || "").trim();
  const match = value.match(/base64,([A-Za-z0-9+/=]+)/);
  return Buffer.from(match && match[1] ? match[1] : value, "base64");
}

/** zip 内部路径安全检查：拒绝绝对路径 / 盘符 / .. 穿越 */
function isSafeEntryName(name: string): boolean {
  const normalized = name.replace(/\\/g, "/").trim();
  if (!normalized || normalized.startsWith("/") || normalized.includes("..")) return false;
  if (/^[a-zA-Z]:/.test(normalized)) return false;
  return true;
}

export interface InstallPluginResult {
  pluginId: string;
  version: string;
  dirName: string;
  upgraded: boolean;
}

export async function installPluginPackage(
  userId: number,
  base64Data: string,
  fileName?: string | null,
): Promise<InstallPluginResult> {
  const buffer = extractBase64(base64Data);
  if (!buffer.length) throw new Error("插件包内容为空");
  if (buffer.length > PLUGIN_PACKAGE_MAX_BYTES) throw new Error("插件包超过 100MB 限制");

  const extract = require("extract-zip");
  const tmpDir = path.join(getPluginsRootDir(), ".tmp", `${Date.now()}-${randomUUID().slice(0, 8)}`);
  await fsp.mkdir(tmpDir, { recursive: true });

  try {
    const tmpZip = path.join(tmpDir, "package.zip");
    await fsp.writeFile(tmpZip, buffer);
    await extract(tmpZip, { dir: tmpDir, onEntry: (entry: any) => {
      if (!isSafeEntryName(entry.fileName)) throw new Error(`插件包包含不安全路径: ${entry.fileName}`);
    } });

    // 定位 manifest.json：根目录优先，其次唯一子目录（zip 打包时常见的外层文件夹）
    let manifestDir = tmpDir;
    if (!fs.existsSync(path.join(manifestDir, "manifest.json"))) {
      const children = await fsp.readdir(manifestDir, { withFileTypes: true });
      const dirs = children.filter((c) => c.isDirectory());
      const subManifestDirs = dirs
        .map((d) => path.join(tmpDir, d.name))
        .filter((p) => fs.existsSync(path.join(p, "manifest.json")));
      if (subManifestDirs.length === 1) {
        manifestDir = subManifestDirs[0];
      } else {
        throw new Error("插件包根目录（或唯一子目录）缺少 manifest.json");
      }
    }

    const manifestRaw = await fsp.readFile(path.join(manifestDir, "manifest.json"), "utf8");
    const manifest = parseManifest(manifestRaw, manifestDir);

    // 校验前端入口文件存在
    const entryAbs = path.join(manifestDir, manifest.entry || "entry.js");
    if (!fs.existsSync(entryAbs)) throw new Error(`插件入口文件不存在: ${manifest.entry}`);

    // 计算目录占用，供前端展示
    // 目标目录：<pluginsRoot>/<userId>/<pluginId>
    const targetDir = getPluginDir(userId, manifest.id);
    const upgraded = await u.db("t_plugin").where({ userId, pluginId: manifest.id }).first();
    let upgradedFrom: string | null = null;
    // 无论是否 DB 有记录，只要 targetDir 存在就先清理（避免 Windows rename 覆盖非空目录报错）
    if (fs.existsSync(targetDir)) {
      const trashDir = targetDir + ".old-" + Date.now();
      await fsp.rename(targetDir, trashDir);
      await fsp.rm(trashDir, { recursive: true, force: true }).catch(() => undefined);
    }
    if (upgraded) {
      upgradedFrom = String(upgraded.version || "");
    }
    await fsp.mkdir(path.dirname(targetDir), { recursive: true });
    await fsp.rename(manifestDir, targetDir);
    // Windows rename 失败时退回 copy+delete
    if (!fs.existsSync(path.join(targetDir, "manifest.json"))) {
      await fsp.cp(manifestDir, targetDir, { recursive: true }).catch(async () => {
        await fsp.rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
        throw new Error("插件文件复制失败");
      });
    }

    const now = Date.now();
    const name = readI18nText(manifest.name, targetDir);
    const description = readI18nText(manifest.description, targetDir);
    if (upgraded) {
      await u.db("t_plugin").where({ userId, pluginId: manifest.id }).update({
        name, version: manifest.version, author: manifest.author,
        description, dir: manifest.id, entry: manifest.entry,
        backendEntry: manifest.backendEntry || null,
        manifestJson: manifestRaw, enabled: 1, status: "installed",
        updatedAt: now,
      });
    } else {
      await u.db("t_plugin").insert({
        userId, pluginId: manifest.id, name, version: manifest.version,
        author: manifest.author, description, dir: manifest.id,
        entry: manifest.entry, backendEntry: manifest.backendEntry || null,
        manifestJson: manifestRaw, enabled: 1, status: "installed",
        installedAt: now, updatedAt: now,
      });
    }

    return { pluginId: manifest.id, version: String(manifest.version || "0.0.1"), dirName: manifest.id, upgraded: !!upgraded && !!upgradedFrom };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ */
/* 卸载 / 启停                                                         */
/* ------------------------------------------------------------------ */

export async function uninstallPlugin(userId: number, pluginId: string): Promise<void> {
  const record = await u.db("t_plugin").where({ userId, pluginId }).first();
  if (!record) throw new Error("插件未安装");
  const targetDir = getPluginDir(userId, record.dir || pluginId);
  if (fs.existsSync(targetDir)) {
    // Windows 下可能有句柄未释放，改名再删，删不掉也不阻塞卸载（残留目录下次安装会被覆盖）
    const trashDir = targetDir + ".trash-" + Date.now();
    try {
      await fsp.rename(targetDir, trashDir);
      await fsp.rm(trashDir, { recursive: true, force: true });
    } catch {
      console.warn(`[plugin] 卸载清理目录失败（不阻塞）: ${targetDir}`);
    }
  }
  await u.db("t_plugin").where({ userId, pluginId }).del();
}

export async function setPluginEnabled(userId: number, pluginId: string, enabled: boolean): Promise<PluginRecord> {
  const record = await u.db("t_plugin").where({ userId, pluginId }).first();
  if (!record) throw new Error("插件未安装");
  const now = Date.now();
  await u.db("t_plugin").where({ userId, pluginId }).update({
    enabled: enabled ? 1 : 0,
    status: enabled ? "installed" : "disabled",
    updatedAt: now,
  });
  const updated = await u.db("t_plugin").where({ userId, pluginId }).first();
  return updated as PluginRecord;
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

export interface PluginListItem {
  id: number;
  pluginId: string;
  name: string;
  version: string;
  author: string;
  description: string;
  enabled: boolean;
  status: string;
  installedAt: number | null;
  updatedAt: number | null;
  entry: string | null;
  backendEntry: string | null;
  manifest: PluginManifest | null;
  hasUpdateInfo?: boolean;
}

export async function listPlugins(userId: number): Promise<PluginListItem[]> {
  const rows = await u.db("t_plugin").where({ userId }).select("*");
  return rows.map((row: any) => {
    let manifest: PluginManifest | null = null;
    try {
      manifest = parseManifest(row.manifestJson || "{}", "");
    } catch {
      manifest = null;
    }
    return {
      id: row.id,
      pluginId: row.pluginId,
      name: String(row.name || row.pluginId),
      version: String(row.version || ""),
      author: String(row.author || ""),
      description: String(row.description || ""),
      enabled: Number(row.enabled) === 1,
      status: String(row.status || "installed"),
      installedAt: row.installedAt || null,
      updatedAt: row.updatedAt || null,
      entry: row.entry || null,
      backendEntry: row.backendEntry || null,
      manifest,
    };
  });
}

/** 取某用户已启用插件（后续游戏运行时挂载用） */
export async function listEnabledPlugins(userId: number): Promise<PluginListItem[]> {
  const all = await listPlugins(userId);
  return all.filter((p) => p.enabled && p.status === "installed");
}

/* ------------------------------------------------------------------ */
/* 静态资源                                                            */
/* ------------------------------------------------------------------ */

const MIME_MAP: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".py": "text/x-python; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * 读取插件内相对路径文件（安全）。
 * 仅允许该用户已安装插件目录内的文件；目录不存在/穿越时抛错。
 */
export async function readPluginAsset(userId: number, pluginId: string, relPath: string): Promise<{ data: Buffer; mime: string } | null> {
  const record = await u.db("t_plugin").where({ userId, pluginId }).first();
  if (!record) return null;
  const baseDir = getPluginDir(userId, record.dir || pluginId);
  const target = path.resolve(baseDir, "." + path.sep + relPath);
  // 路径穿越防护
  if (path.relative(baseDir, target).startsWith("..") || path.isAbsolute(path.relative(baseDir, target))) {
    return null;
  }
  try {
    const stat = await fsp.stat(target);
    if (!stat.isFile()) return null;
    const data = await fsp.readFile(target);
    const ext = path.extname(target).toLowerCase();
    return { data, mime: MIME_MAP[ext] || "application/octet-stream" };
  } catch {
    return null;
  }
}

/**
 * 供运行时直接读取插件 manifest（读文件版本，含最新改动）。
 */
export async function loadPluginManifestFromFile(userId: number, pluginId: string): Promise<PluginManifest | null> {
  const record = await u.db("t_plugin").where({ userId, pluginId }).first();
  if (!record) return null;
  const manifestPath = path.join(getPluginDir(userId, record.dir || pluginId), "manifest.json");
  try {
    const raw = await fsp.readFile(manifestPath, "utf8");
    return parseManifest(raw, path.dirname(manifestPath));
  } catch {
    return null;
  }
}

/* 消除未用变量告警 */
void pipeline;
void getCurrentUserId;