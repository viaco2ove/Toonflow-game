import fsp from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getLocalToolRootDir } from "@/lib/runtimePaths";
import { DebugLogUtil } from "@/utils/debugLogUtil";

// ============================================================================
// MOSS-TTS-Nano Serve 常驻进程管理
// ============================================================================

const SERVE_PORT = 18084; // 避开默认 18083
const SERVE_MAX_STARTUP_MS = 60000; // 模型加载最多等 60 秒

export function isMossTtsServeEnabled(): boolean {
  return String(process.env.MOSS_TTS_SERVE || "").trim().toLowerCase() === "true";
}

interface ServeProcess {
  port: number;
  baseUrl: string;
  process: ReturnType<typeof spawn>;
}

let serveProcess: ServeProcess | null = null;

async function waitForServeHealth(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 5000);
      await fetch(`${baseUrl}/health`, { signal: controller.signal as any }).catch(() => null);
      clearTimeout(id);
      const resp = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) } as any);
      if (resp.ok) {
        dlog(`[serve] 健康检查通过: ${baseUrl}`);
        return true;
      }
    } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

async function fileExists(p: string): Promise<boolean> {
  try { await fsp.access(p, fsConstants.F_OK); return true; } catch { return false; }
}

async function ensureDir(p: string): Promise<void> {
  try { await fsp.mkdir(p, { recursive: true }); } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "EEXIST") throw err;
  }
}

export async function startMossTtsServe(): Promise<ServeProcess> {
  if (serveProcess) return serveProcess;
  const baseUrl = `http://127.0.0.1:${SERVE_PORT}`;

  // 先检测 serve 是否已经在跑
  try {
    const resp = await fetch(`${baseUrl}/v1/tts`, { method: "HEAD", signal: AbortSignal.timeout(3000) as any });
    if (resp.ok || resp.status === 404 || resp.status === 422) {
      // 任何有响应的状态码都说明 serve 在跑（422=参数不对，404=路由存在但缺参数）
      dlog("[serve] 检测到已有进程运行在:", baseUrl, "status:", resp.status);
      serveProcess = { port: SERVE_PORT, baseUrl, process: null as any };
      return serveProcess;
    }
  } catch (e) {
    dlog("[serve] 端口检测失败，继续尝试启动:", e instanceof Error ? e.message : String(e));
  }

  // 检查安装状态
  const status = await getMossTtsInstallStatus();
  console.error("[moss-tts] [serve] installStatus:", JSON.stringify(status));
  if (status.status !== "installed") {
    throw new Error(`MOSS-TTS-Nano 尚未安装（状态: ${status.status}），无法启动 serve`);
  }

  await fileLog("[serve] 启动常驻服务...");
  dlog("[serve] 启动常驻服务...");

  const venvDir = getMossTtsVenvDir();
  const venvBinDir = process.platform === "win32"
    ? path.join(venvDir, "Scripts")
    : path.join(venvDir, "bin");
  const venvPath = { PATH: `${venvBinDir}${path.delimiter}${process.env.PATH || ""}` };
  // Conda 环境：Windows 在 venv/python.exe，Linux 在 venv/bin/python3
  const pythonBin = process.platform === "win32"
    ? path.join(venvDir, "python.exe")
    : path.join(venvDir, "bin", "python3");
  const gitRepoDir = path.join(getMossTtsRootDir(), "MOSS-TTS-Nano");
  const onnxModelDir = path.join(getMossTtsRootDir(), "MOSS-TTS-Nano-100M-ONNX");
  console.error("[moss-tts] [serve] venvDir:", venvDir);
  console.error("[moss-tts] [serve] pythonBin:", pythonBin);
  console.error("[moss-tts] [serve] onnxModelDir:", onnxModelDir);
  console.error("[moss-tts] [serve] gitRepoDir:", gitRepoDir);
  const logPath = path.join(getMossTtsRootDir(), "serve-stdout.log");
  const logStream = await fsp.open(logPath, "a");
  console.error("[moss-tts] [serve] logPath:", logPath);

  const cliName = process.platform === "win32"
    ? path.join(venvBinDir, "moss-tts-nano.exe")
    : path.join(venvBinDir, "moss-tts-nano");
  console.error("[moss-tts] [serve] cliName:", cliName);

  const child = spawn(cliName, [
    "serve",
    "--backend", "onnx",
    "--onnx-model-dir", onnxModelDir,
    "--host", "127.0.0.1",
    "--port", String(SERVE_PORT),
    "--execution-provider", "cpu",
  ], {
    cwd: gitRepoDir,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout?.on("data", (c: Buffer) => {
    logStream.write(c).catch(() => {});
    process.stderr.write(`[moss-serve-stdout] ${c}`); // 临时 stderr 看启动日志
  });
  child.stderr?.on("data", (c: Buffer) => {
    logStream.write(c).catch(() => {});
  });
  child.on("error", (err) => {
    fileLog("[serve] 启动失败:", String(err?.message || err));
    serveProcess = null;
  });

  const healthy = await waitForServeHealth(baseUrl, SERVE_MAX_STARTUP_MS);
  if (!healthy) {
    // 超时时先把日志 flush 出来
    await logStream.flush();
    await logStream.close();
    const logContent = await fsp.readFile(logPath, "utf8").catch(() => "");
    const tail = logContent.slice(-3000);
    dlog("[serve] 启动日志（末尾3KB）:\n", tail);
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], { windowsHide: true });
    } else {
      child.kill("SIGTERM");
    }
    throw new Error(`MOSS-TTS-Nano serve 启动超时（${SERVE_MAX_STARTUP_MS}ms 内无法健康检查通过）\n日志:\n${tail}`);
  }

  serveProcess = { port: SERVE_PORT, baseUrl, process: child };
  logStream.close();
  await fileLog("[serve] 启动成功:", baseUrl);
  dlog("[serve] 启动成功:", baseUrl);
  return serveProcess;
}

export async function stopMossTtsServe(): Promise<void> {
  if (!serveProcess) return;
  dlog("[serve] 停止服务...");
  await fileLog("[serve] 停止服务...");
  const child = serveProcess.process;
  serveProcess = null;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], { windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
}

async function synthesizeViaServe(options: {
  text: string;
  outputPath: string;
  promptSpeech?: string;
  speed?: number;
  format?: string;
}): Promise<{ audioPath: string }> {
  const serve = await startMossTtsServe();
  const { default: FormData } = await import("form-data");
  const { request } = await import("node:http");
  const { getUploadRootDir } = await import("@/lib/runtimePaths");

  const form = new FormData();
  form.append("text", String(options.text || "").trim());
  if (options.promptSpeech) {
    // 声音克隆模式：上传参考音频，无需 demo_id
    const absPrompt = path.join(getUploadRootDir(), String(options.promptSpeech || "").replace(/^[/\\]+/, ""));
    const buffer = await fsp.readFile(absPrompt);
    form.append("prompt_audio", buffer, { filename: "ref.wav", contentType: "audio/wav" });
    form.append("voice_clone_max_text_tokens", "75");
  } else {
    // 纯文字合成模式：必须提供 demo_id 指定音色
    form.append("demo_id", "demo-1");
  }

  // 强制把 form 序列化成 buffer，手动通过 http.request 发送（避免 fetch + form-data 兼容问题）
  const bodyBuffer = form.getBuffer();
  const contentType = form.getHeaders()["content-type"] as string;
  const urlObj = new URL(`${serve.baseUrl}/api/generate`);
  const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const req = request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "Content-Length": bodyBuffer.length,
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => resolve({ statusCode: res.statusCode || 0, body: data }));
    });
    req.on("error", reject);
    req.write(bodyBuffer);
    req.end();
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const body = String(response.body || "");
    const logPath = path.join(getMossTtsRootDir(), "serve-stdout.log");
    let logTail = "";
    try { logTail = (await fsp.readFile(logPath, "utf8")).split("\n").slice(-15).join("\n"); } catch { /* ignore */ }
    await fileLog(`[serve] ${response.statusCode} 错误，响应体: ${body.slice(0, 600)}`);
    if (logTail) await fileLog(`[serve] 最近日志:\n${logTail}`);
    throw new Error(`serve ${response.statusCode}: ${body.slice(0, 500)}\n--- serve-log ---\n${logTail.slice(0, 500)}`);
  }
  const json = JSON.parse(response.body) as any;
  if (json.error) {
    throw new Error(`serve 推理错误: ${String(json.error).slice(0, 300)}`);
  }
  const b64: string = String(json.audio_base64 || "");
  if (!b64) throw new Error("serve 未返回音频数据");
  const buffer = Buffer.from(b64, "base64");
  // 写入 OSS 目录
  const relPath = String(options.outputPath || "").replace(/^[/\\]+/, "");
  const absPath = path.join(getUploadRootDir(), relPath);
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  await fsp.writeFile(absPath, buffer);
  dlog(`[serve] 完成: ${absPath} bytes=${buffer.length}`);
  return { audioPath: relPath };
}

// ============================================================================
// CLI 模式（备用）
// ============================================================================
function dlog(...args: any[]) {
  if (DebugLogUtil.isDebugLogEnabled()) {
    console.log("[moss-tts]", ...args);
  }
}

async function fileLog(...args: unknown[]): Promise<void> {
  try {
    dlog("[fileLog]", ...args);
    const logPath = path.join(getMossTtsRootDir(), "install-debug.log");
    const logDir = path.dirname(logPath);
    await fsp.mkdir(logDir, { recursive: true });
    const line = `[${new Date().toISOString()}] ` + args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ") + "\n";
    await fsp.appendFile(logPath, line, "utf8");
  } catch { /* noop */ }
}

export const LOCAL_MOSS_TTS_MANUFACTURER = "moss_tts_nano";
export const LOCAL_MOSS_TTS_DEFAULT_MODEL = "moss-tts-nano-100m";

type LocalMossTtsStatusKind = "not_installed" | "installing" | "installed" | "failed";

type InstallStateFile = {
  status: Exclude<LocalMossTtsStatusKind, "not_installed">;
  message: string;
  updatedAt: number;
  installedAt?: number;
  version?: number;
  pythonLauncher?: string;
  lastError?: string;
};

type RunCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export type LocalMossTtsStatus = {
  manufacturer: typeof LOCAL_MOSS_TTS_MANUFACTURER;
  model: string;
  status: LocalMossTtsStatusKind;
  installed: boolean;
  canInstall: boolean;
  message: string;
};

let activeInstallPromise: Promise<LocalMossTtsStatus> | null = null;
let installAbortFlag = false;

function getMossTtsRootDir(): string {
  return path.join(getLocalToolRootDir(), "moss-tts-nano");
}

function getMossTtsVenvDir(): string {
  return path.join(getMossTtsRootDir(), "venv");
}

function getMossTtsStateFilePath(): string {
  return path.join(getMossTtsRootDir(), "install-state.json");
}

function getMossTtsPythonPath(): string {
  // Conda 环境：Windows 在 venv/python.exe，Linux 在 venv/bin/python3
  return process.platform === "win32"
    ? path.join(getMossTtsVenvDir(), "python.exe")
    : path.join(getMossTtsVenvDir(), "bin", "python3");
}

async function readInstallState(): Promise<InstallStateFile | null> {
  try {
   if (DebugLogUtil.isDebugLogEnabled()) {
      console.log("[moss-tts] install status by file:",getMossTtsStateFilePath());
      console.log("[moss-tts] reset status need delete this file and install again:",getMossTtsStateFilePath());
    }
    const raw = await fsp.readFile(getMossTtsStateFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const status = String(parsed.status || "").trim();
    if (status !== "installing" && status !== "installed" && status !== "failed") {
      return null;
    }
    return {
      status,
      message: String(parsed.message || "").trim(),
      updatedAt: Number(parsed.updatedAt || 0) || Date.now(),
      installedAt: Number(parsed.installedAt || 0) || undefined,
      version: Number(parsed.version || 0) || undefined,
      pythonLauncher: String(parsed.pythonLauncher || "").trim() || undefined,
      lastError: String(parsed.lastError || "").trim() || undefined,
    };
  } catch {
    return null;
  }
}

async function writeInstallState(state: InstallStateFile): Promise<void> {
  try {
    await ensureDir(getMossTtsRootDir());
    await fsp.writeFile(getMossTtsStateFilePath(), JSON.stringify(state, null, 2), "utf8");
    await fileLog("[writeInstallState] 写入成功:", JSON.stringify(state));
  } catch (err) {
    await fileLog("[writeInstallState] 写入失败:", err instanceof Error ? err.message : String(err));
    throw err;
  }
}

function formatCommandError(command: string, args: string[], stdout: string, stderr: string, exitCode?: number | null): string {
  const stderrTail = stderr.trim().split(/\r?\n/).slice(-12).join("\n").trim();
  const stdoutTail = stdout.trim().split(/\r?\n/).slice(-12).join("\n").trim();
  const detail = [
    exitCode === null || exitCode === undefined ? "" : `退出码: ${exitCode}`,
    stderrTail ? `stderr:\n${stderrTail}` : "",
    stdoutTail ? `stdout:\n${stdoutTail}` : "",
  ].filter(Boolean).join("\n").trim();
  const commandText = `命令执行失败: ${command} ${args.join(" ")}`.trim();
  return detail ? `${commandText}\n${detail}` : commandText;
}

async function runCommand(command: string, args: string[], options: RunCommandOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timeout: NodeJS.Timeout | null = null;
    let settled = false;

    const finishReject = (message: string) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(new Error(message));
    };

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], { windowsHide: true });
        } else {
          child.kill("SIGKILL");
        }
        finishReject(`命令执行超时: ${command} ${args.join(" ")}`.trim());
      }, options.timeoutMs);
    }

    child.stdout.on("data", (chunk) => { stdout += String(chunk || ""); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk || ""); });
    child.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        finishReject(`命令不存在: ${command}`);
        return;
      }
      finishReject(String(err?.message || err || `命令启动失败: ${command}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      dlog(`[runCommand] 完成: ${command} ${args.join(" ")} 退出码=${code}`);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(formatCommandError(command, args, stdout, stderr, code)));
    });
  });
}

async function resolveSystemPythonLauncher(): Promise<{ command: string; baseArgs: string[]; label: string } | null> {
  await fileLog("[Python 探测] 开始搜索 Python...");
  dlog("[Python 探测] 开始搜索 Python...");
  const winCandidates = [
    { command: "python", baseArgs: [], label: "python" },
    { command: "py", baseArgs: ["-3"], label: "py -3" },
    { command: "python3", baseArgs: [], label: "python3" },
  ];
  const nixCandidates = [
    { command: "python3", baseArgs: [], label: "python3" },
    { command: "python", baseArgs: [], label: "python" },
  ];
  const candidates = process.platform === "win32" ? winCandidates : nixCandidates;
  for (const candidate of candidates) {
    try {
      await fileLog(`[Python 探测] ${candidate.label}...`);
      dlog(`[Python 探测] ${candidate.label}...`);
      const { stdout } = await runCommand(candidate.command, [...candidate.baseArgs, "--version"], { timeoutMs: 10000 });
      dlog(`[Python 探测] ${candidate.label} -> ${stdout.trim()}`);
      if (/python 3\.\d+/i.test(stdout)) {
        dlog(`[Python 选中] ${candidate.label}`);
        return candidate;
      }
    } catch (e) {
      dlog(`[Python 探测] ${candidate.label} 失败:`, e instanceof Error ? e.message : String(e));
    }
  }
  return null;
}

/**
 * 检测当前 MOSS-TTS-Nano 安装状态。
 */
export async function getMossTtsInstallStatus(): Promise<LocalMossTtsStatus> {
  const state = await readInstallState();
  if (state?.status === "installing") {
    return {
      manufacturer: LOCAL_MOSS_TTS_MANUFACTURER,
      model: LOCAL_MOSS_TTS_DEFAULT_MODEL,
      status: "installing",
      installed: false,
      canInstall: true,
      message: state.message || "正在安装中...",
    };
  }
  if (state?.status === "installed") {
    const pythonPath = getMossTtsPythonPath();
    const venvExists = await fileExists(pythonPath);
    if (!venvExists) {
      return {
        manufacturer: LOCAL_MOSS_TTS_MANUFACTURER,
        model: LOCAL_MOSS_TTS_DEFAULT_MODEL,
        status: "not_installed",
        installed: false,
        canInstall: true,
        message: "MOSS-TTS-Nano 未安装（venv 目录丢失）",
      };
    }
    return {
      manufacturer: LOCAL_MOSS_TTS_MANUFACTURER,
      model: LOCAL_MOSS_TTS_DEFAULT_MODEL,
      status: "installed",
      installed: true,
      canInstall: true,
      message: `已安装（${state.message || ""}）`,
    };
  }
  if (state?.status === "failed") {
    return {
      manufacturer: LOCAL_MOSS_TTS_MANUFACTURER,
      model: LOCAL_MOSS_TTS_DEFAULT_MODEL,
      status: "failed",
      installed: false,
      canInstall: true,
      message: `安装失败: ${state.lastError || state.message || "未知错误"}`,
    };
  }
  return {
    manufacturer: LOCAL_MOSS_TTS_MANUFACTURER,
    model: LOCAL_MOSS_TTS_DEFAULT_MODEL,
    status: "not_installed",
    installed: false,
    canInstall: true,
    message: "MOSS-TTS-Nano 未安装，点击安装",
  };
}

export async function cancelInstall(): Promise<void> {
  installAbortFlag = true;
  // 立刻把状态文件改掉，这样 /status 不会再返回 "installing"
  try {
    await writeInstallState({
      status: "failed",
      message: "安装已中止",
      updatedAt: Date.now(),
    });
  } catch { /* noop */ }
  await fileLog("[cancelInstall] 中止标志已设置，状态已重置为 failed");
  dlog("[cancelInstall] 中止标志已设置，状态已重置为 failed");
}

/**
 * 清除安装状态文件（恢复到未安装）。
 */
export async function resetInstallState(): Promise<void> {
  try {
    await fileLog("[resetInstallState] 删除状态文件:", getMossTtsStateFilePath());
    dlog("[resetInstallState] 删除状态文件:", getMossTtsStateFilePath());
    await fsp.unlink(getMossTtsStateFilePath());
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      await fileLog("[resetInstallState] 删除失败:", err instanceof Error ? err.message : String(err));
      dlog("[resetInstallState] 删除失败:", err instanceof Error ? err.message : String(err));
    }
  }
  installAbortFlag = false;
  activeInstallPromise = null;
  await fileLog("[resetInstallState] 完成");
  dlog("[resetInstallState] 完成");
}

function checkAbort(): void {
  if (installAbortFlag) {
    throw new Error("INSTALL_ABORTED");
  }
}

/**
 * 安装 MOSS-TTS-Nano（venv + git clone + pip install -e）。
 * 首次调用时自动下载模型权重。
 */
export async function installMossTts(
  onProgress?: (msg: string) => void,
): Promise<LocalMossTtsStatus> {
  await fileLog("[install] installMossTts 开始, abortFlag=", installAbortFlag);
  dlog("[install] installMossTts 开始, abortFlag=", installAbortFlag);

  // 重装场景：清掉旧状态文件，确保走完整安装流程
  if (!activeInstallPromise) {
    try {
      await fsp.unlink(getMossTtsStateFilePath());
      await fileLog("[install] 已清除旧状态文件，从头安装");
      dlog("[install] 已清除旧状态文件，从头安装");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code && code !== "ENOENT") {
        await fileLog("[install] 清除旧状态文件失败:", err instanceof Error ? err.message : String(err));
      }
    }
  }

  if (activeInstallPromise) {
    await fileLog("[install] 已有安装进程，返回现有 promise");
    dlog("[install] 已有安装进程，返回现有 promise");
    return activeInstallPromise;
  }

  activeInstallPromise = (async () => {
    try {
      checkAbort();
      await fileLog("[install] IIFE 开始");
      dlog("[install] 开始安装...");
      await writeInstallState({
        status: "installing",
        message: "正在准备安装环境...",
        updatedAt: Date.now(),
      });

      checkAbort();
      const pythonLauncher = await resolveSystemPythonLauncher();
      if (!pythonLauncher) {
        await fileLog("[install] 未找到 Python 3 环境");
        throw new Error("未找到 Python 3 环境，请先安装 Python 3");
      }

      const rootDir = getMossTtsRootDir();
      const venvDir = getMossTtsVenvDir();
      await fileLog(`[install] rootDir=${rootDir} venvDir=${venvDir}`);
      dlog(`[install] rootDir=${rootDir} venvDir=${venvDir}`);
      await ensureDir(rootDir);

      checkAbort();
      if (await fileExists(venvDir)) {
        await fileLog("[install] venv 已存在，跳过创建");
        dlog("[install] venv 已存在，跳过创建");
        onProgress?.("虚拟环境已存在，跳过创建");
      } else {
        await fileLog("[install] 创建 venv...");
        dlog("[install] 创建 venv...");
        onProgress?.("创建 Python 虚拟环境...");
        await runCommand(pythonLauncher.command, ["-m", "venv", venvDir], { timeoutMs: 120000 });
        await fileLog("[install] venv 创建完成");
        dlog("[install] venv 创建完成");
      }

      checkAbort();
      const pythonBin = getMossTtsPythonPath();
      await fileLog(`[install] pythonBin=${pythonBin}`);
      dlog(`[install] pythonBin=${pythonBin}`);

      onProgress?.("升级 pip...");
      try {
        await runCommand(pythonBin, ["-m", "pip", "install", "--upgrade", "pip"], { timeoutMs: 120000 });
      } catch {
        await fileLog("[install] pip 升级失败（可选）");
        dlog("[install] pip 升级失败（可选）");
      }

      // 从 GitHub 克隆仓库（PyPI 上没有 moss-tts-nano 包）
      const gitDir = path.join(rootDir, "MOSS-TTS-Nano");
      const hasRepo = await fileExists(path.join(gitDir, "pyproject.toml"))
        || await fileExists(path.join(gitDir, "setup.py"))
        || await fileExists(path.join(gitDir, "setup.cfg"));
      if (!hasRepo) {
        checkAbort();
        await fileLog("[install] 从 GitHub 克隆仓库...");
        dlog("[install] 从 GitHub 克隆仓库...");
        onProgress?.("从 GitHub 克隆 MOSS-TTS-Nano 仓库...");
        await runCommand("git", ["clone", "--depth","1", "https://github.com/OpenMOSS/MOSS-TTS-Nano.git", gitDir], { timeoutMs: 120000 });
        await fileLog("[install] Git clone 完成");
        dlog("[install] Git clone 完成");
      } else {
        await fileLog("[install] 仓库已存在，跳过 clone");
        dlog("[install] 仓库已存在，跳过 clone");
        onProgress?.("仓库已存在，跳过克隆");
      }

      checkAbort();
      await fileLog("[install] pip install -e ...");
      dlog("[install] pip install -e ...");
      onProgress?.("安装 Python 依赖...");
      await runCommand(pythonBin, ["-m", "pip", "install", "-e", gitDir], { timeoutMs: 600000 });
      await fileLog("[install] pip install -e 完成");
      dlog("[install] pip install -e 完成");

      checkAbort();
      onProgress?.("安装核心依赖 onnxruntime soundfile...");
      await runCommand(pythonBin, ["-m", "pip", "install", "onnxruntime", "soundfile", "modelscope"], { timeoutMs: 300000 });
      await fileLog("[install] 核心依赖安装完成");
      dlog("[install] 核心依赖安装完成");

      // 从 ModelScope 国内镜像下载 ONNX 模型（HuggingFace 国内访问受限，必须用镜像）
      const onnxModelDir = path.join(rootDir, "MOSS-TTS-Nano-100M-ONNX");
      const codecModelDir = path.join(rootDir, "MOSS-Audio-Tokenizer-Nano-ONNX");
      const manifestPath = path.join(onnxModelDir, "browser_poc_manifest.json");
      const codecManifestPath = path.join(codecModelDir, "codec_browser_onnx_meta.json");

      if (!(await fileExists(manifestPath)) || !(await fileExists(codecManifestPath))) {
        checkAbort();
        await fileLog("[install] 从 ModelScope 下载 ONNX 模型（~700MB）...");
        dlog("[install] 从 ModelScope 下载 ONNX 模型（~700MB）...");
        onProgress?.("下载模型文件（约 700MB，需等待）...");
        await ensureDir(onnxModelDir);
        await ensureDir(codecModelDir);
        if (!(await fileExists(manifestPath))) {
          await runCommand(pythonBin, [
            "-c",
            `from modelscope.hub.snapshot_download import snapshot_download; snapshot_download('OpenMOSS/MOSS-TTS-Nano-100M-ONNX', cache_dir=r"""${onnxModelDir}""", revision='master')`,
          ], { timeoutMs: 600000 });
          // modelscope 嵌套在 cache_dir/OpenMOSS/MOSS-TTS-Nano-100M-ONNX/，平铺到 onnxModelDir
          const nestedDir = path.join(onnxModelDir, "OpenMOSS", "MOSS-TTS-Nano-100M-ONNX");
          if (await fileExists(path.join(nestedDir, "browser_poc_manifest.json"))) {
            await fileLog("[install] 平铺 TTS 模型文件...");
            dlog("[install] 平铺 TTS 模型文件...");
            const files = await fsp.readdir(nestedDir);
            for (const file of files) {
              const src = path.join(nestedDir, file);
              const dst = path.join(onnxModelDir, file);
              try { await fsp.access(dst, fsConstants.F_OK); } catch { await fsp.copyFile(src, dst); }
            }
          }
        }
        if (!(await fileExists(codecManifestPath))) {
          await fileLog("[install] 下载 codec 模型...");
          dlog("[install] 下载 codec 模型...");
          await runCommand(pythonBin, [
            "-c",
            `from modelscope.hub.snapshot_download import snapshot_download; snapshot_download('OpenMOSS/MOSS-Audio-Tokenizer-Nano-ONNX', cache_dir=r"""${codecModelDir}""", revision='master')`,
          ], { timeoutMs: 600000 });
          const nestedCodec = path.join(codecModelDir, "OpenMOSS", "MOSS-Audio-Tokenizer-Nano-ONNX");
          if (await fileExists(path.join(nestedCodec, "codec_browser_onnx_meta.json"))) {
            await fileLog("[install] 平铺 codec 模型文件...");
            dlog("[install] 平铺 codec 模型文件...");
            const files = await fsp.readdir(nestedCodec);
            for (const file of files) {
              const src = path.join(nestedCodec, file);
              const dst = path.join(codecModelDir, file);
              try { await fsp.access(dst, fsConstants.F_OK); } catch { await fsp.copyFile(src, dst); }
            }
          }
        }
        await fileLog("[install] 所有模型下载完成");
        dlog("[install] 所有模型下载完成");
      } else {
        await fileLog("[install] 模型已存在，跳过下载");
        dlog("[install] 模型已存在，跳过下载");
      }

      // 用实际合成验证安装（--help 不加载模型，必须跑合成测试）
      // 安装后预热：跑一次合成把 ONNX 模型加载进 OS 缓存，后续合成启动更快
      checkAbort();
      onProgress?.("预热模型（首次较慢，后续加速）...");
      const venvBinDir = process.platform === "win32"
        ? path.join(venvDir, "Scripts")
        : path.join(venvDir, "bin");
      const venvPath = { PATH: `${venvBinDir}${path.delimiter}${process.env.PATH || ""}` };
      const cliName = process.platform === "win32" ? "moss-tts-nano.exe" : "moss-tts-nano";
      await fileLog(`[install] 预热合成: ${cliName} model=${onnxModelDir}`);
      dlog(`[install] 预热合成: ${cliName} model=${onnxModelDir}`);
      const warmupOut = path.join(rootDir, "warmup_output.wav");
      await runCommand(cliName, [
        "generate", "--backend", "onnx",
        "--onnx-model-dir", onnxModelDir,
        "--text", "预热",
        "--output", warmupOut,
      ], { env: venvPath, timeoutMs: 120000 });
      await fileLog("[install] 预热完成");
      dlog("[install] 预热完成");

      await writeInstallState({
        status: "installed",
        message: `已安装（${pythonLauncher.label}）`,
        updatedAt: Date.now(),
        installedAt: Date.now(),
        pythonLauncher: pythonLauncher.label,
      });
      dlog("[install] 安装完成！");

      return await getMossTtsInstallStatus();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await fileLog("[install] 安装失败:", errMsg);
      dlog("[install] 安装失败:", errMsg);

      // 被中止：清除状态文件，保持 not_installed
      if (errMsg === "INSTALL_ABORTED") {
        await fileLog("[install] 安装被中止，恢复 not_installed 状态");
        dlog("[install] 安装被中止，恢复 not_installed 状态");
        try {
          await fsp.unlink(getMossTtsStateFilePath());
        } catch { /* noop */ }
        installAbortFlag = false;
      } else {
        // 真正的失败：写入 failed 状态
        try {
          await writeInstallState({
            status: "failed",
            message: "安装失败",
            updatedAt: Date.now(),
            lastError: errMsg,
          });
        } catch {
          await fileLog("[install] writeInstallState(failed) 也失败");
        }
      }
      return await getMossTtsInstallStatus();
    } finally {
      activeInstallPromise = null;
    }
  })();

  return activeInstallPromise;
}

/**
 * 使用 MOSS-TTS-Nano 合成语音（未安装时自动触发安装）。
 */
export async function synthesizeMossTts(options: {
  text: string;
  outputPath: string;
  promptSpeech?: string;
  speed?: number;
  language?: string;
}): Promise<{ audioPath: string }> {
  if (isMossTtsServeEnabled()) {
    // serve 模式：模型常驻内存，推理只需 3-8 秒
    return synthesizeViaServe(options);
  }
  // CLI 模式（每次冷启动 ~15 秒）
  return synthesizeViaCLI(options);
}

async function synthesizeViaCLI(options: {
  text: string;
  outputPath: string;
  promptSpeech?: string;
  speed?: number;
  language?: string;
}): Promise<{ audioPath: string }> {
  const status = await getMossTtsInstallStatus();
  dlog(`[synthesize] status=${status.status}`);

  if (status.status === "not_installed" || status.status === "failed") {
    dlog("[synthesize] 未安装，触发自动安装...");
    await installMossTts();
    const newStatus = await getMossTtsInstallStatus();
    if (newStatus.status !== "installed") {
      throw new Error(`MOSS-TTS-Nano 自动安装失败: ${newStatus.message}`);
    }
  } else if (status.status === "installing") {
    dlog("[synthesize] 正在安装中，等待...");
    const start = Date.now();
    while (Date.now() - start < 600000) {
      await new Promise((r) => setTimeout(r, 5000));
      const s = await getMossTtsInstallStatus();
      if (s.status === "installed") break;
      if (s.status === "failed") {
        throw new Error(`MOSS-TTS-Nano 安装失败: ${s.message}`);
      }
    }
    const finalStatus = await getMossTtsInstallStatus();
    if (finalStatus.status !== "installed") {
      throw new Error("MOSS-TTS-Nano 安装超时");
    }
  }

  const venvDir = getMossTtsVenvDir();
  const venvBinDir = process.platform === "win32"
    ? path.join(venvDir, "Scripts")
    : path.join(venvDir, "bin");
  const venvPath = { PATH: `${venvBinDir}${path.delimiter}${process.env.PATH || ""}` };
  const cliName = process.platform === "win32" ? "moss-tts-nano.exe" : "moss-tts-nano";
  const onnxModelDir = path.join(getMossTtsRootDir(), "MOSS-TTS-Nano-100M-ONNX");

  dlog(`[synthesize] cli=${cliName} text=... output=${options.outputPath} model=${onnxModelDir}`);

  // CLI 必须用绝对路径（Windows 会把 "/user/..." 解读成 "D:\user\..."，写错位置）
  const { default: oss } = await import("@/utils/oss");
  const { getUploadRootDir } = await import("@/lib/runtimePaths");
  const relOutputPath = String(options.outputPath || "").replace(/^[/\\]+/, "");
  const absOutputPath = path.join(getUploadRootDir(), relOutputPath);
  await fsp.mkdir(path.dirname(absOutputPath), { recursive: true });
  await fsp.writeFile(absOutputPath, Buffer.alloc(0));
  await fsp.unlink(absOutputPath);

  dlog(`[synthesize] absOutputPath=${absOutputPath}`);

  const args: string[] = [
    "generate",
    "--backend", "onnx",
    "--onnx-model-dir", onnxModelDir,
    "--text", String(options.text || "").trim(),
    "--output", absOutputPath,
  ];
  if (options.promptSpeech) {
    args.push("--mode", "voice_clone");
    // promptSpeech 可能是 OSS 相对路径（如 /system/voice-presets/...），转成绝对路径
    const relPrompt = String(options.promptSpeech || "").replace(/^[/\\]+/, "");
    const absPrompt = path.join(getUploadRootDir(), relPrompt);
    args.push("--prompt-speech", absPrompt);
    dlog(`[synthesize] clone 模式: prompt=${absPrompt}`);
  }

  dlog(`[synthesize] 执行: ${cliName} ${args.join(" ")}`);
  const { stdout, stderr } = await runCommand(cliName, args, { env: venvPath, timeoutMs: 120000 });
  dlog(`[synthesize] stdout=${stdout.slice(0, 200)} stderr=${stderr.slice(0, 200)}`);
  const exists = await oss.fileExists(relOutputPath);
  dlog(`[synthesize] oss.fileExists=${exists}`);
  if (!exists) {
    throw new Error(`MOSS-TTS-Nano 合成失败: ${stderr || stdout}`.slice(0, 500));
  }

  dlog(`[synthesize] 完成: ${relOutputPath}`);
  return { audioPath: relOutputPath };
}
