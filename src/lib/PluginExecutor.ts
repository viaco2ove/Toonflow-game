/**
 * PluginExecutor — 插件小游戏运行时
 *
 * 后端插件通过 entry.ts 提供 handle_action(userId, action, params, state) 函数。
 * 本模块负责：
 * 1. 动态 import entry.ts 模块
 * 2. 调用 handle_action 并管理状态持久化
 * 3. 提供状态快照供 iframe postMessage 使用
 */

import path from "path";
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

/** 已加载的 entry.ts 模块缓存 */
const entryModuleCache = new Map<string, { handle_action: Function }>();

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
  if (entryModuleCache.has(pluginDir)) {
    return entryModuleCache.get(pluginDir)!;
  }

  // 优先 .js（编译后的），其次 .ts（需要运行时支持）
  const jsPath = path.join(pluginDir, "entry.js");
  const tsPath = path.join(pluginDir, "entry.ts");

  // Node.js ESM 加载绝对路径需要 file:// URL（Windows 路径含冒号/反斜杠）
  const fileUrl = (p: string) =>
    p.startsWith("file://") ? p : `file:///${p.replace(/\\/g, "/").replace(/^\//, "")}`;

  for (const candidate of [jsPath, tsPath]) {
    try {
      const url = fileUrl(candidate);
      const mod = await import(/* @vite-ignore */ url);
      if (mod.handle_action) {
        entryModuleCache.set(pluginDir, { handle_action: mod.handle_action });
        return mod as { handle_action: Function };
      }
    } catch {
      // 继续尝试下一个
    }
  }
  console.error(`[PluginExecutor] 加载 entry 失败: 试过 ${jsPath} 与 ${tsPath}`);
  return { handle_action: () => ({ code: 1, message: "entry 模块加载失败", state: {} }) };
}
