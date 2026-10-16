/**
 * PluginExecutor — 插件小游戏运行时
 *
 * 后端插件通过 entry.ts 提供 handle_action(userId, action, params, state) 函数。
 * 本模块负责：
 * 1. 动态 import entry.ts 模块
 * 2. 调用 handle_action 并管理状态持久化
 * 3. 提供状态快照供 iframe postMessage 使用
 */

import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import type { PluginManifest } from "./pluginRegistry";
import { getPluginDir, listEnabledPlugins } from "./pluginRegistry";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface PluginGameState {
  // 来自 entry.ts handle_action 返回的 state
  [key: string]: unknown;
}

export interface PluginGameContext {
  pluginId: string;
  pluginDir: string;
  manifest: PluginManifest;
  /** 运行上下文（/plugin/tick 与 MiniGameController 均会带上） */
  userId?: number;
  sessionId?: string;
  /** 会话内可选角色清单（参展/观战/敌对候选），由 rulebook setup 写入 */
  roles?: Array<Record<string, unknown>>;
  /** 用户参数卡快照（技能/物品/金钱/经验/生命），供插件读取技能与物品 */
  playerCard?: Record<string, unknown>;
  /** ★ v5：当前世界「常驻世界书条目」摘要（供插件 agent 生成商城物资） */
  worldBookDigest?: string;
  /** ★ v6：当前世界 id（故事绑定视觉地图模板；由 /plugin/tick 与 MiniGameController 注入） */
  worldId?: number;
  /** ★ v6：当前世界/故事名（entry 按它读 map_visual:<worldName> 模板并注入本会话） */
  worldName?: string;
  /** 后端插件 API（toonflowTsApi：pluginData + agent），按 ctx 维度自动注入 */
  tsApi?: import("./plugins/toonflowTsApi").ToonflowTsApi;
}

export interface HandleActionParams {
  [key: string]: unknown;
}

export interface HandleActionResult {
  code: number; // 0=成功，非0=失败
  message: string;
  state: PluginGameState;
  response?: string; // 人类可读回复
  actions?: string[]; // 可用动作列表（供前端渲染）
  assets?: string[]; // 资产路径列表
}

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

/** 已加载的 entry 模块缓存：key=pluginDir, value={module, sourcePath, mtimeMs}
 *  ★ 优化方案 2026-10-08：加 mtime 失效——文件被 esbuild 重建后自动重 import。
 *  ★ 修复 2026-10-16：光靠 mtime 失效**不够**（见 importEntryModule 注释），
 *  必须配合「影子模块」换 URL 才能真正拿到新代码。 */
const entryModuleCache = new Map<string, { handle_action: Function; sourcePath: string; mtimeMs: number }>();

/** 影子模块目录：把 entry.js 按 mtime 复制成唯一文件名的 .mjs 再 import，
 *  以此绕过 Node ESM 模块注册表「同 URL 只求值一次」的缓存。 */
const SHADOW_DIR = path.join(os.tmpdir(), "toonflow-plugin-entry");

/** entry 源码是否「自包含单文件」（无任何 import / import.meta）。
 *  只有自包含时才能安全地复制到别处加载（否则相对 import 会解析失败）。 */
function isSelfContainedEntry(src: string): boolean {
  if (/\bimport\s*\(/.test(src)) return false;             // 动态 import()
  if (/^\s*import[\s"'(]/m.test(src)) return false;         // 静态 import ... from / import "x"
  if (/\bimport\.meta\b/.test(src)) return false;           // import.meta.url
  return true;
}

/** 清理某插件遗留的旧影子文件（只保留当前 mtime 那份） */
function cleanStaleShadows(pluginKey: string, keep: string): void {
  try {
    for (const f of fs.readdirSync(SHADOW_DIR)) {
      if (!f.startsWith(pluginKey + ".") || f === keep) continue;
      fs.rmSync(path.join(SHADOW_DIR, f), { force: true });
    }
  } catch { /* 清理失败不影响加载 */ }
}

/**
 * 加载 entry 模块（真正拿到「当前磁盘上的那份代码」）。
 *
 * ★ 为什么不能直接 `import(fileUrl)`（2026-10-16 修复）：
 *   Node 的 ESM 模块注册表按「解析后的 URL」缓存模块实例 —— 同一个
 *   `file:///…/entry.js` 第二次 `import()` 永远返回**第一次求值出的那个模块对象**，
 *   文件改了也不会重新求值。所以 2026-10-08 那版「mtime 失效」优化（只清了
 *   entryModuleCache 这张表、没换 URL）**实际不生效**：插件新功能已 esbuild 进
 *   entry.js，后端进程里跑的还是启动时那份旧模块。
 *   实测症状：野怪击杀掉宝箱的代码已在 entry.js 里，但「把整张图的怪杀光也不掉宝箱」。
 *
 *   `import(url + "?t=" + mtime)` 这种常见写法在**本项目不成立** —— 后端用 tsx 跑
 *   （`node --import tsx/loader src/app.ts`），tsx 的 load hook 会剥掉 query，
 *   实测同一进程内 `?t=1` / `?t=2` 仍返回同一个模块对象（原生 Node 则正常）。
 *
 *   因此改成：把 entry.js 复制成 `os.tmpdir()/toonflow-plugin-entry/<插件>.<mtime>.mjs`
 *   再 import —— URL 随 mtime 变化，tsx 与原生 Node 都能拿到新代码；
 *   用 .mjs 后缀显式声明 ESM（插件目录没有 package.json，.js 会被当 CJS）。
 *   非自包含（带 import）的 entry 退回直接 import，并提示需要重启后端。
 */
async function importEntryModule(sourcePath: string, mtimeMs: number): Promise<{ handle_action?: Function }> {
  const rawUrl = pathToFileURL(sourcePath).href;

  // .ts 源码只能交给 tsx 处理，不能影子复制成 .mjs（会因 TS 语法报错）
  if (!sourcePath.toLowerCase().endsWith(".js")) return import(/* @vite-ignore */ rawUrl);

  let src = "";
  try {
    src = fs.readFileSync(sourcePath, "utf-8");
  } catch {
    return import(/* @vite-ignore */ rawUrl);
  }

  if (!isSelfContainedEntry(src)) {
    console.warn(
      `[PluginExecutor] ${path.basename(sourcePath)} 含 import/import.meta，无法影子加载；` +
      `热更新不生效，改完 entry 请**重启后端**。`,
    );
    return import(/* @vite-ignore */ rawUrl);
  }

  try {
    fs.mkdirSync(SHADOW_DIR, { recursive: true });
    const pluginKey = path.basename(path.dirname(sourcePath));
    const shadowName = `${pluginKey}.${Math.round(mtimeMs)}.mjs`;
    const shadowPath = path.join(SHADOW_DIR, shadowName);
    if (!fs.existsSync(shadowPath)) fs.writeFileSync(shadowPath, src, "utf-8");
    cleanStaleShadows(pluginKey, shadowName);
    return await import(/* @vite-ignore */ pathToFileURL(shadowPath).href);
  } catch (err) {
    console.warn(`[PluginExecutor] 影子加载失败，退回直接 import（可能仍是旧代码）:`, err);
    return import(/* @vite-ignore */ rawUrl);
  }
}

/** 已扫描的插件命令映射: commandText -> PluginGameContext */
const pluginCommandMap = new Map<string, PluginGameContext>();

/** 已扫描的命令集合（用于 detectGameTrigger） */
let pluginCommandsScanned = false;

// ---------------------------------------------------------------------------
// 核心 API
// ---------------------------------------------------------------------------

/**
 * 执行插件的 handle_action。
 * @param ctx      插件上下文
 * @param action   动作名（init/start/apply/exit 等）
 * @param params   动作参数
 * @param state    当前游戏状态（entry.py 会更新它）
 */
export async function executePluginAction(
  ctx: PluginGameContext,
  action: string,
  params: HandleActionParams,
  state: PluginGameState
): Promise<HandleActionResult> {
  // ★ 注入 toonflowTsApi：插件 entry.ts 内用 ctx.tsApi.pluginData / ctx.tsApi.agent
  if (
    ctx &&
    Number.isFinite(Number(ctx.userId)) &&
    Number(ctx.userId) > 0 &&
    ctx.sessionId &&
    !ctx.tsApi
  ) {
    try {
      const { buildToonflowTsApi } = await import("./plugins/toonflowTsApi");
      ctx.tsApi = buildToonflowTsApi({
        userId: Number(ctx.userId),
        sessionId: String(ctx.sessionId),
        pluginId: ctx.pluginId,
      });
    } catch (err) {
      console.error("[PluginExecutor] 注入 toonflowTsApi 失败:", err);
    }
  }

  const mod = await loadEntryModule(ctx.pluginDir);
  if (!mod.handle_action) {
    return {
      code: 1,
      message: `插件 ${ctx.pluginId} 的 entry.ts 未导出 handle_action`,
      state,
    };
  }

  try {
    const result = await mod.handle_action(action, params, state, ctx);
    if (typeof result === "object" && result !== null) {
      return result as HandleActionResult;
    }
    // 简化返回值：直接返回 state
    return { code: 0, message: "ok", state: result as PluginGameState };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { code: 1, message: msg, state };
  }
}

/**
 * 扫描用户所有已启用插件，收集 contributes.sidebar[].command 命令。
 * 供 detectGameTrigger 使用。
 */
export async function scanPluginCommands(userId: number): Promise<void> {
  if (pluginCommandsScanned) return;
  pluginCommandsScanned = true;

  try {
    const plugins = await listEnabledPlugins(userId);
    for (const p of plugins) {
      if (!p.manifest?.contributes) continue;
      const contributes = p.manifest.contributes as any;
      const sidebar = contributes.sidebar as any[];
      if (!Array.isArray(sidebar)) continue;

      for (const item of sidebar) {
        if (item.command && typeof item.command === "string") {
          pluginCommandMap.set(item.command, {
            pluginId: p.pluginId,
            pluginDir: getPluginDir(userId, p.pluginId),
            manifest: p.manifest,
          });
        }
      }
    }
  } catch (err) {
    console.error("[PluginExecutor] scanPluginCommands 失败:", err);
  }
}

/**
 * 根据命令文本查找匹配的插件上下文。
 */
export function findPluginByCommand(command: string): PluginGameContext | null {
  return pluginCommandMap.get(command) ?? null;
}

/**
 * 获取所有已扫描的命令（供调试/命令面板使用）。
 */
export function getAllPluginCommands(): string[] {
  return Array.from(pluginCommandMap.keys());
}

// ---------------------------------------------------------------------------
// 私有
// ---------------------------------------------------------------------------

async function loadEntryModule(pluginDir: string): Promise<{ handle_action: Function }> {
  // 优先 .js（编译后的），其次 .ts（需要运行时支持）
  const jsPath = path.join(pluginDir, "entry.js");
  const tsPath = path.join(pluginDir, "entry.ts");

  // ① mtime 失效检查：源文件比缓存新就重 import（esbuild 重建或手工编辑后无需重启）
  const candidatePaths = [jsPath, tsPath].filter((p) => fs.existsSync(p));
  if (candidatePaths.length === 0) {
    console.error(`[PluginExecutor] 加载 entry 失败: 试过 ${jsPath} 与 ${tsPath}`);
    return { handle_action: () => ({ code: 1, message: "entry 模块加载失败", state: {} }) };
  }
  const sourcePath = candidatePaths[0];
  const stat = fs.statSync(sourcePath);
  const cached = entryModuleCache.get(pluginDir);
  if (cached && cached.sourcePath === sourcePath && cached.mtimeMs === stat.mtimeMs) {
    return { handle_action: cached.handle_action };
  }

  // ② 真 import
  //  ★ 2026-10-16 修复：必须走 importEntryModule()（影子模块换 URL），
  //    直接 `import(fileUrl)` 会命中 Node ESM 注册表缓存 → 永远拿到旧代码。
  //    详见 importEntryModule 注释。
  try {
    const mod = await importEntryModule(sourcePath, stat.mtimeMs);
    if (mod?.handle_action) {
      entryModuleCache.set(pluginDir, { handle_action: mod.handle_action as Function, sourcePath, mtimeMs: stat.mtimeMs });
      console.log(
        `[PluginExecutor] 已加载 entry：${sourcePath} (mtime=${Math.round(stat.mtimeMs)})` +
        (cached ? "（检测到 entry 变更，已热重载）" : ""),
      );
      return mod as { handle_action: Function };
    }
  } catch {
    // 试下一个候选
  }
  console.error(`[PluginExecutor] 加载 entry 失败: ${sourcePath} handle_action 未导出`);
  return { handle_action: () => ({ code: 1, message: "entry 模块加载失败", state: {} }) };
}

/**
 * 清空 entry 模块缓存（供三个一致性入口调用）。
 * @param pluginDir 不传则清全部
 */
export function clearEntryCache(pluginDir?: string): void {
  if (pluginDir) entryModuleCache.delete(pluginDir);
  else entryModuleCache.clear();
}
