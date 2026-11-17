#!/usr/bin/env node
/**
 * h5app-Install 一键脚本
 *
 * 流程：构建 web 前端 → 同步 dist 到 Android assets → gradle 打 APK → adb 安装 → 启动应用
 *
 * 用法：
 *   node h5app-install.mjs                     # 完整流程（debug 包）
 *   node h5app-install.mjs --skip-build        # 跳过前端构建，直接用现有 dist
 *   node h5app-install.mjs --release           # 打 release 包
 *   node h5app-install.mjs --no-launch         # 安装后不自动启动
 *   node h5app-install.mjs --dry-run           # 只打印将要执行的命令，不实际执行
 *   node h5app-install.mjs --web <path> --h5 <path>   # 自定义项目路径
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";

const args = process.argv.slice(2);
/** 判断是否开启某个开关 */
const has = (flag) => args.includes(flag);
/** 读取 --key value 形式的参数 */
const opt = (key, fallback = null) => {
  const i = args.indexOf(key);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const DRY_RUN = has("--dry-run");
const SKIP_BUILD = has("--skip-build");
const RELEASE = has("--release");
const NO_LAUNCH = has("--no-launch");

const DEFAULT_ROOT = "D:\\Users\\viaco\\tools\\Toonflow-game";
const WEB_PROJECT = opt("--web", path.join(DEFAULT_ROOT, "Toonflow-game-web"));
const H5_PROJECT = opt("--h5", path.join(DEFAULT_ROOT, "Toonflow-game-android-h5"));
const PACKAGE_NAME = opt("--package", "com.toonflow.game");

/** 步骤计数，用于日志前缀 */
let step = 0;
/** 打印步骤标题 */
const logStep = (msg) => console.log(`\n[${++step}] ${msg}`);
/** 打印普通日志 */
const log = (msg) => console.log(`    ${msg}`);

/**
 * 执行一条命令。
 * @param {string} cmd 可执行命令
 * @param {string[]} cmdArgs 参数列表
 * @param {object} opts { cwd, allowFail }
 * @returns {boolean} 是否成功
 */
function run(cmd, cmdArgs, opts = {}) {
  const { cwd, allowFail = false } = opts;
  if (DRY_RUN) {
    log(`[dry-run] ${cmd} ${cmdArgs.join(" ")}`);
    return true;
  }
  log(`$ ${cmd} ${cmdArgs.join(" ")}`);
  const res = spawnSync(cmd, cmdArgs, {
    cwd,
    stdio: "inherit",
    shell: isWindows,
  });
  if (res.status !== 0) {
    if (allowFail) {
      log(`⚠️ 命令失败（已忽略），退出码 ${res.status}`);
      return false;
    }
    throw new Error(`命令失败：${cmd} ${cmdArgs.join(" ")}`);
  }
  return true;
}

/** 递归复制目录（Windows 用 robocopy 更快更稳，其它平台用 fs.cp） */
function copyDir(src, dest) {
  if (DRY_RUN) {
    log(`[dry-run] 复制 ${src} -> ${dest}`);
    return;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

/** 检查路径是否存在，不存在直接抛错中止 */
function requirePath(p, label) {
  if (!fs.existsSync(p)) {
    throw new Error(`${label} 不存在：${p}`);
  }
}

/**
 * 读取设备当前前台窗口焦点。
 * @returns {string} 含包名的焦点字符串，取不到返回空串
 */
function getForeground() {
  const res = spawnSync("adb", ["shell", "dumpsys", "window"], { encoding: "utf8" });
  const m = (res.stdout || "").match(/mCurrentFocus=.*?(\S+\/\S+)/);
  return m ? m[1] : "";
}

/**
 * 启动后校验前台焦点：若被其它应用抢占则自动重拉，最多重试 3 次。
 * 设备上常驻 VPN、输入法等自启应用，会在启动瞬间抢焦点。
 */
function launchAndVerify() {
  const maxRetry = 3;
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    // 等待 WebView 完成加载
    const waitMs = attempt === 1 ? 4000 : 2500;
    if (!DRY_RUN) spawnSync("node", ["-e", `setTimeout(()=>{},${waitMs})`]);
    const focus = getForeground();
    if (focus.includes(PACKAGE_NAME)) {
      log(`✅ 前台焦点正确：${focus}`);
      return true;
    }
    if (DRY_RUN) {
      log(`[dry-run] 焦点校验：当前 ${focus || "(未知)"}`);
      return true;
    }
    log(`⚠️ 前台被抢占（当前 ${focus || "未知"}），第 ${attempt} 次重拉`);
    run("adb", ["shell", "am", "start", "-n", `${PACKAGE_NAME}/.MainActivity`], { allowFail: true });
  }
  log("❌ 重试多次后仍未获得前台焦点，请手动检查设备");
  return false;
}

function main() {
  console.log("🚀 h5app-Install 开始");
  log(`web 项目：${WEB_PROJECT}`);
  log(`h5  项目：${H5_PROJECT}`);
  log(`包名：${PACKAGE_NAME}｜构建类型：${RELEASE ? "release" : "debug"}`);

  // ---- 1. 构建 web 前端 ----
  logStep("构建 web 前端");
  requirePath(WEB_PROJECT, "web 项目");
  if (SKIP_BUILD) {
    log("已指定 --skip-build，跳过构建");
  } else {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(WEB_PROJECT, "package.json"), "utf8"));
    const script = pkgJson.scripts?.build;
    if (!script) throw new Error("web 项目 package.json 里没有 build 脚本");
    const useYarn = fs.existsSync(path.join(WEB_PROJECT, "yarn.lock"));
    run(useYarn ? "yarn" : "npm", ["build"], { cwd: WEB_PROJECT });
  }
  const webDist = path.join(WEB_PROJECT, "dist");
  requirePath(webDist, "web 构建产物 dist");
  log(`dist 内容：${fs.readdirSync(webDist).join(", ")}`);

  // ---- 2. 同步到 Android assets ----
  logStep("同步 dist 到 Android assets");
  requirePath(H5_PROJECT, "h5 项目");
  const assetsDist = path.join(H5_PROJECT, "app", "src", "main", "assets", "dist");
  copyDir(webDist, assetsDist);
  log(`已写入 ${assetsDist}`);

  // ---- 3. 构建 APK ----
  logStep("构建 APK");
  const gradlew = isWindows ? "gradlew.bat" : "./gradlew";
  const task = RELEASE ? "assembleRelease" : "assembleDebug";
  run(gradlew, [task], { cwd: H5_PROJECT });
  const apkDir = path.join(H5_PROJECT, "app", "build", "outputs", "apk", RELEASE ? "release" : "debug");
  const apk = fs
    .readdirSync(apkDir)
    .filter(f => f.endsWith(".apk"))
    .map(f => path.join(apkDir, f))[0];
  if (!apk) throw new Error(`没找到 apk：${apkDir}`);
  log(`APK：${apk}`);

  // ---- 4. 安装到设备 ----
  logStep("安装到设备");
  const devices = spawnSync("adb", ["devices"], { encoding: "utf8" }).stdout || "";
  const deviceIds = devices
    .split("\n")
    .slice(1)
    .map(l => l.trim().split(/\s+/)[0])
    .filter(id => id && id !== "offline");
  if (!deviceIds.length) throw new Error("没有已连接的 adb 设备");
  if (deviceIds.length > 1) log(`检测到 ${deviceIds.length} 台设备：${deviceIds.join(", ")}，安装到第一台`);
  run("adb", ["install", "-r", apk]);

  // ---- 5. 启动应用 ----
  if (!NO_LAUNCH) {
    logStep("启动应用");
    // 用 am start 直启主 Activity，比 monkey 可靠：
    // monkey 随机派发事件，可能启动后焦点被其它应用（如 VPN 自启）抢走
    run("adb", ["shell", "am", "start", "-n", `${PACKAGE_NAME}/.MainActivity`]);
    launchAndVerify();
  } else {
    logStep("按要求跳过启动");
  }

  // ---- 6. 截图取证（可选） ----
  if (has("--shot")) {
    logStep("截图");
    const out = opt("--shot", path.join(os.tmpdir(), "h5app-shot.png"));
    if (DRY_RUN) {
      log(`[dry-run] 截图 -> ${out}`);
    } else {
      const res = spawnSync("adb", ["exec-out", "screencap", "-p"], { maxBuffer: 64 * 1024 * 1024 });
      if (res.status === 0 && res.stdout?.length) {
        fs.writeFileSync(out, res.stdout);
        log(`已保存：${out}`);
      } else {
        log("❌ 截图失败");
      }
    }
  }

  console.log("\n✅ h5app-Install 完成");
}

try {
  main();
} catch (err) {
  console.error(`\n❌ 失败：${err.message}`);
  process.exit(1);
}
