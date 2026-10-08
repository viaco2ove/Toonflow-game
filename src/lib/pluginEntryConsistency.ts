import { spawn } from "child_process";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { clearEntryCache } from "./PluginExecutor";
import { getPluginDir } from "./pluginRegistry";

/**
 * 插件入口一致性强制保证（2026-10-08 优化方案）
 *
 * 三个入口（CLI 装 / 网页装 / vue 启动）都通过这个函数保证：
 *   1) 重新 esbuild entry.ts → entry.js（消除手编辑漂移）
 *   2) 清后端 entryModuleCache（否则改 entry.js 不重启不生效）
 *   3) 返回结果（编译状态、新 mtime、缓存清理结果）供调用方日志
 *
 * 设计要点：
 *   - esbuild 失败不抛异常——把状态写入结果对象，调用方决定是警告还是阻断
 *   - 找不到 entry.ts 静默返回（某些插件可能只用 entry.js）
 *   - 找不到 esbuild 走 fallback：调用 toonflow-game-app/node_modules/.bin/esbuild.cmd
 */

export interface ConsistencyResult {
  ok: boolean;                  // 总体是否成功
  entryJs: string | null;       // 实际写入/确认的 entry.js 路径
  entryTs: string | null;       // entry.ts 路径
  rebuilt: boolean;             // 是否真的跑过 esbuild
  rebuildError: string | null;  // esbuild 错误信息
  cacheCleared: boolean;        // 是否清过 entryModuleCache
  cacheClearError: string | null;
  reason: string;
}

interface EsbuildRunner {
  bin: string;  // 绝对路径到 esbuild 可执行入口
  cwd: string;  // 工作目录
}

function findEsbuild(): EsbuildRunner | null {
  // 1) 显式环境变量
  if (process.env.ESBUILD_BIN && fs.existsSync(process.env.ESBUILD_BIN)) {
    return { bin: process.env.ESBUILD_BIN, cwd: process.cwd() };
  }
  // 2) 当前进程的 node_modules/.bin/esbuild（toonflow-game-app 已装）
  const candidates = [
    path.resolve(process.cwd(), "node_modules", ".bin", "esbuild.cmd"),    // Windows
    path.resolve(process.cwd(), "node_modules", ".bin", "esbuild"),       // *nix
    path.resolve(process.cwd(), "node_modules", "esbuild", "bin", "esbuild"),  // 直接调用
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return { bin: c, cwd: process.cwd() };
  }
  return null;
}

function runEsbuild(bin: string, cwd: string, entryTs: string, entryJs: string): Promise<{ ok: boolean; err: string | null }> {
  return new Promise((resolve) => {
    const args = [
      entryTs,
      "--outfile=" + entryJs,
      "--bundle=false",
      "--format=esm",
      "--target=es2020",
      "--log-level=warning",
    ];
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => resolve({ ok: false, err: `spawn failed: ${e.message}` }));
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true, err: null });
      else resolve({ ok: false, err: stderr.trim() || `exit code ${code}` });
    });
  });
}

/**
 * 对指定 user/plugin 入口做一致性保证。
 *
 * 策略：
 *   - entry.ts 存在 → 跑 esbuild 写 entry.js（覆盖）
 *   - entry.ts 不存在但 entry.js 存在 → 视为"只用手写 js"插件，保留不编
 *   - 两者都不存在 → 跳过（不是代码类插件）
 *   - esbuild 不可用 → 警告但仍清缓存（让用户重启后端前最起码用旧版）
 *   - 编译失败 → 返回 ok=false 但仍清缓存（避免坏代码卡 cache）
 */
export async function ensureEntryConsistency(
  userId: number,
  pluginId: string,
  opts?: { reason?: string; skipCacheClear?: boolean }
): Promise<ConsistencyResult> {
  const reason = opts?.reason ?? "ensureEntryConsistency";
  const pluginDir = getPluginDir(userId, pluginId);
  const entryTs = path.join(pluginDir, "entry.ts");
  const entryJs = path.join(pluginDir, "entry.js");

  const result: ConsistencyResult = {
    ok: true,
    entryJs: null,
    entryTs: null,
    rebuilt: false,
    rebuildError: null,
    cacheCleared: false,
    cacheClearError: null,
    reason,
  };

  // 1) 检测源文件
  const hasTs = fs.existsSync(entryTs);
  const hasJs = fs.existsSync(entryJs);
  if (!hasTs && !hasJs) {
    result.ok = true; // 非代码插件（只资源/数据），跳过
    return result;
  }
  result.entryTs = hasTs ? entryTs : null;
  result.entryJs = hasJs ? entryJs : null;

  // 2) esbuild 现编（仅在有 entry.ts 时）
  if (hasTs) {
    const runner = findEsbuild();
    if (!runner) {
      result.ok = false;
      result.rebuildError = "esbuild 未安装（npm i esbuild 或设 ESBUILD_BIN 环境变量）";
    } else {
      const r = await runEsbuild(runner.bin, runner.cwd, entryTs, entryJs);
      result.rebuilt = r.ok;
      result.rebuildError = r.err;
      if (!r.ok) result.ok = false;
    }
  }

  // 3) 清后端 entryModuleCache
  if (!opts?.skipCacheClear) {
    try {
      clearEntryCache(pluginDir);
      result.cacheCleared = true;
    } catch (e: any) {
      result.cacheClearError = e?.message ?? String(e);
      result.ok = false;
    }
  }

  return result;
}
