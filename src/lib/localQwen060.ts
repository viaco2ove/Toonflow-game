/**
 * Qwen3-0.6B 本地模型管理（node-llama-cpp）
 *
 * 流程：
 * 1. 安装：npm install node-llama-cpp + 下载 GGUF 模型
 * 2. 调用：动态 import('node-llama-cpp')，懒加载模型
 *
 * 参考：意图分析师.md L43 — node-llama-cpp 方式
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { getLocalToolRootDir } from "@/lib/runtimePaths";
import { DebugLogUtil } from "@/utils/debugLogUtil";

const ROOT_DIR = getLocalToolRootDir();
const QWEN060_ROOT = path.join(ROOT_DIR, "qwen3-0.6b");
const STATE_FILE = path.join(QWEN060_ROOT, "install-state.json");
const MODEL_DIR = path.join(QWEN060_ROOT, "models");

// GGUF 模型文件（Q8_0 量化版本，约 610MB）
// 注：Qwen 官方仓库只提供 Q8_0，huggingface 与 modelscope 都是同一份
const MODEL_FILE_NAME = "Qwen3-0.6B-Q8_0.gguf";
// ModelScope（国内首选，速度快）
const MODEL_MODELSCOPE_URL = "https://www.modelscope.cn/models/Qwen/Qwen3-0.6B-GGUF/resolve/master/Qwen3-0.6B-Q8_0.gguf";
// HuggingFace 镜像（国内可访问）
const MODEL_MIRROR_URL = "https://hf-mirror.com/Qwen/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf";
// HuggingFace 官方
const MODEL_DOWNLOAD_URL = "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf";

type Qwen060StatusKind = "not_installed" | "installing" | "installed" | "failed";

interface InstallState {
  status: Qwen060StatusKind;
  message?: string;
  version?: string;
  startedAt?: number;
  lastError?: string;
  progressPercent?: number;
}

let cachedState: InstallState | null = null;
let installAbortFlag = false;
let activeInstallPromise: Promise<void> | null = null;

function dlog(...args: unknown[]): void {
  if (DebugLogUtil.isDebugLogEnabled()) {
    console.log("[qwen3-0.6b]", ...args);
  }
}

async function fileLog(...args: unknown[]): Promise<void> {
  try {
    const logPath = path.join(QWEN060_ROOT, "install-debug.log");
    await fsp.mkdir(QWEN060_ROOT, { recursive: true });
    const line = `[${new Date().toISOString()}] ` + args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ") + "\n";
    await fsp.appendFile(logPath, line, "utf8");
  } catch { /* noop */ }
}

async function readState(): Promise<InstallState | null> {
  if (cachedState) return cachedState;
  try {
    const content = await fsp.readFile(STATE_FILE, "utf8");
    cachedState = JSON.parse(content) as InstallState;
    return cachedState;
  } catch {
    return null;
  }
}

async function writeState(state: InstallState): Promise<void> {
  cachedState = state;
  await fsp.mkdir(QWEN060_ROOT, { recursive: true });
  await fsp.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

async function fileExists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true; } catch { return false; }
}

// ============================================================================
// 安装流程
// ============================================================================

export function getModelFilePath(): string {
  return path.join(MODEL_DIR, MODEL_FILE_NAME);
}

export async function getQwen060InstallStatus(): Promise<{
  status: Qwen060StatusKind;
  installed: boolean;
  canInstall: boolean;
  message: string;
  manufacturer: string;
  model: string;
  progressPercent?: number;
}> {
  const state = await readState();
  const nodeModulesPath = path.join(QWEN060_ROOT, "node_modules", "node-llama-cpp");
  const nodeLlamaCppExists = await fileExists(nodeModulesPath);
  const modelFilePath = getModelFilePath();
  const modelExists = await fileExists(modelFilePath);

  // 检测 node-llama-cpp 版本是否支持 Qwen3 (需要 >= 3.10)
  let nodeLlamaCppOk = false;
  if (nodeLlamaCppExists) {
    try {
      const pkgRaw = await fsp.readFile(path.join(nodeModulesPath, "package.json"), "utf8");
      const pkg = JSON.parse(pkgRaw);
      const version = String(pkg.version || "0.0.0");
      const major = Number(version.split(".")[0] || 0);
      const minor = Number(version.split(".")[1] || 0);
      nodeLlamaCppOk = major >= 3 && minor >= 10;
    } catch {
      nodeLlamaCppOk = false;
    }
  }

  if (state?.status === "installing") {
    const elapsed = state.startedAt ? Date.now() - state.startedAt : 0;
    return {
      status: "installing",
      installed: false,
      canInstall: false,
      message: state.message || `正在安装中...（已进行 ${Math.floor(elapsed / 1000)} 秒）`,
      manufacturer: "qwen060",
      model: "qwen3-0.6b",
      progressPercent: state.progressPercent,
    };
  }

  if (state?.status === "failed") {
    return {
      status: "failed",
      installed: false,
      canInstall: true,
      message: state.lastError || state.message || "安装失败，请重试",
      manufacturer: "qwen060",
      model: "qwen3-0.6b",
    };
  }

  // 同时检查 node-llama-cpp（且版本支持 Qwen3） + GGUF 模型文件
  if (state?.status === "installed" && nodeLlamaCppOk && modelExists) {
    return {
      status: "installed",
      installed: true,
      canInstall: true,
      message: "Qwen3-0.6B 已安装，可以使用",
      manufacturer: "qwen060",
      model: "qwen3-0.6b",
    };
  }

  // 部分安装：node-llama-cpp 版本太旧
  if (state?.status === "installed" && nodeLlamaCppExists && !nodeLlamaCppOk) {
    return {
      status: "not_installed",
      installed: false,
      canInstall: true,
      message: "node-llama-cpp 版本过旧（不支持 Qwen3），请重新安装",
      manufacturer: "qwen060",
      model: "qwen3-0.6b",
    };
  }

  // 部分安装：node-llama-cpp 已装，但模型文件缺失
  if (state?.status === "installed" && nodeLlamaCppOk && !modelExists) {
    return {
      status: "not_installed",
      installed: false,
      canInstall: true,
      message: "node-llama-cpp 已安装，但 GGUF 模型文件缺失，请重新安装",
      manufacturer: "qwen060",
      model: "qwen3-0.6b",
    };
  }

  return {
    status: "not_installed",
    installed: false,
    canInstall: true,
    message: "Qwen3-0.6B 尚未安装，点击安装（包含 node-llama-cpp + GGUF 模型，约 610MB）",
    manufacturer: "qwen060",
    model: "qwen3-0.6b",
  };
}

export async function cancelInstall(): Promise<void> {
  installAbortFlag = true;
  try {
    await writeState({
      status: "failed",
      message: "安装已中止",
      lastError: "用户取消安装",
    });
  } catch { /* noop */ }
  await fileLog("[cancelInstall] 中止标志已设置");
  dlog("[qwen3-0.6b] 中止标志已设置");
}

export async function resetInstallState(): Promise<void> {
  installAbortFlag = false;
  cachedState = null;
  activeInstallPromise = null;
  try {
    await fsp.unlink(STATE_FILE);
  } catch { /* ignore */ }
  await fileLog("[resetInstallState] 安装状态已重置");
  dlog("[qwen3-0.6b] 安装状态已重置");
}

function checkAbort(): void {
  if (installAbortFlag) {
    throw new Error("INSTALL_ABORTED");
  }
}

// ============================================================================
// 安装步骤
// ============================================================================

/**
 * 步骤1: 安装 node-llama-cpp npm 包
 *
 * 必须 v3.10+ 才支持 Qwen3 架构
 */
async function installNodeLlamaCpp(onProgress: (msg: string, percent?: number) => void): Promise<void> {
  const nodeModulesPath = path.join(QWEN060_ROOT, "node_modules", "node-llama-cpp");
  const installedPkgPath = path.join(nodeModulesPath, "package.json");

  // 检测已安装版本
  if (await fileExists(installedPkgPath)) {
    try {
      const pkgRaw = await fsp.readFile(installedPkgPath, "utf8");
      const pkg = JSON.parse(pkgRaw);
      const version = String(pkg.version || "0.0.0");
      const major = Number(version.split(".")[0] || 0);
      const minor = Number(version.split(".")[1] || 0);
      if (major >= 3 && minor >= 10) {
        onProgress(`node-llama-cpp v${version} 已安装（支持 Qwen3）`);
        return;
      }
      onProgress(`检测到旧版本 node-llama-cpp v${version}（不支持 Qwen3），将升级到 v3.18+`);
      // 删除旧版本，让 npm install 重新安装
      try {
        await fsp.rm(path.join(QWEN060_ROOT, "node_modules"), { recursive: true, force: true });
        await fsp.unlink(path.join(QWEN060_ROOT, "package-lock.json"));
      } catch { /* ignore */ }
    } catch {
      // 解析失败，继续安装
    }
  }

  // 创建 package.json
  const packageJsonPath = path.join(QWEN060_ROOT, "package.json");
  await fsp.writeFile(
    packageJsonPath,
    JSON.stringify({
      name: "qwen3-0.6b-local",
      version: "1.0.0",
      type: "module",
      private: true,
    }, null, 2),
    "utf8",
  );

  onProgress("正在安装 node-llama-cpp（首次需下载预编译二进制，约 1-3 分钟）...");

  await new Promise<void>((resolve, reject) => {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const proc: ChildProcess = spawn(
      npmCmd,
      ["install", "node-llama-cpp@^3.18.0", "--no-audit", "--no-fund"],
      {
        cwd: QWEN060_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
        shell: process.platform === "win32",
      },
    );

    let stderr = "";
    proc.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      fileLog("[npm]", text.trim());
      // 提取进度信息
      if (text.includes("downloading") || text.includes("extracting")) {
        onProgress("正在下载 node-llama-cpp 依赖...");
      }
    });
    proc.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      fileLog("[npm:err]", text.trim());
    });

    proc.on("close", (code) => {
      if (installAbortFlag) {
        reject(new Error("INSTALL_ABORTED"));
        return;
      }
      if (code === 0) {
        onProgress("node-llama-cpp 安装完成");
        resolve();
      } else {
        reject(new Error(`npm install 失败，code=${code}\n${stderr.slice(-500)}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`npm install 出错: ${err.message}`));
    });
  });
}

/**
 * 步骤2: 下载 GGUF 模型文件
 */
async function downloadModel(onProgress: (msg: string, percent?: number) => void): Promise<void> {
  await fsp.mkdir(MODEL_DIR, { recursive: true });
  const modelFilePath = getModelFilePath();

  if (await fileExists(modelFilePath)) {
    onProgress("GGUF 模型文件已存在，跳过下载");
    return;
  }

  onProgress("正在下载 Qwen3-0.6B GGUF 模型（约 610MB）...");

  // 优先级：ModelScope（国内最稳定）→ hf-mirror（国内镜像）→ huggingface（官方）
  const sources: Array<{ name: string; url: string }> = [
    { name: "ModelScope（国内）", url: MODEL_MODELSCOPE_URL },
    { name: "HuggingFace 镜像", url: MODEL_MIRROR_URL },
    { name: "HuggingFace 官方", url: MODEL_DOWNLOAD_URL },
  ];

  let lastError: Error | null = null;

  for (const src of sources) {
    if (installAbortFlag) throw new Error("INSTALL_ABORTED");
    try {
      onProgress(`从 ${src.name} 下载...`);
      await fileLog("[download] 尝试源:", src.name, src.url);
      await downloadFile(src.url, modelFilePath, onProgress);
      onProgress(`模型文件下载完成（来源：${src.name}）`);
      return;
    } catch (err) {
      lastError = err as Error;
      const msg = lastError.message || "未知错误";
      await fileLog("[download] 源失败:", src.name, msg);
      onProgress(`${src.name} 下载失败：${msg.slice(0, 80)}，尝试下一个源...`);
      // 删除部分下载的文件
      try { await fsp.unlink(modelFilePath); } catch { /* ignore */ }
      if (msg === "INSTALL_ABORTED" || installAbortFlag) throw err;
    }
  }

  throw new Error(
    `所有下载源均失败。最后错误：${lastError?.message || "未知错误"}\n` +
    `请检查网络连接，或手动下载模型文件到：\n${modelFilePath}\n` +
    `下载地址（任选其一）：\n` +
    sources.map(s => `- ${s.name}: ${s.url}`).join("\n"),
  );
}

async function downloadFile(
  url: string,
  destPath: string,
  onProgress: (msg: string, percent?: number) => void,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": "Toonflow-Game/1.0" },
    });
  } catch (err) {
    const msg = (err as any)?.cause?.message || (err as Error)?.message || String(err);
    throw new Error(`网络连接失败: ${msg}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const totalSize = Number(response.headers.get("content-length") || 0);
  if (!response.body) {
    throw new Error("响应体为空");
  }

  const writer = await fsp.open(destPath, "w");
  let downloadedSize = 0;
  let lastReportTime = Date.now();

  try {
    const reader = response.body.getReader();
    while (true) {
      checkAbort();
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      await writer.write(value);
      downloadedSize += value.byteLength;

      // 每秒报告一次进度
      const now = Date.now();
      if (now - lastReportTime > 1000) {
        const mb = (downloadedSize / 1024 / 1024).toFixed(1);
        const totalMb = (totalSize / 1024 / 1024).toFixed(1);
        const percent = totalSize ? Math.floor((downloadedSize / totalSize) * 100) : 0;
        onProgress(`下载中... ${mb}MB / ${totalMb}MB (${percent}%)`, percent);
        lastReportTime = now;
      }
    }
  } finally {
    await writer.close();
  }
}

// ============================================================================
// 安装入口
// ============================================================================

export async function installQwen060(
  onProgress?: (msg: string) => void,
): Promise<void> {
  if (activeInstallPromise) return activeInstallPromise;

  const progress = (msg: string, percent?: number) => {
    dlog("[qwen3-0.6b:install]", msg);
    onProgress?.(msg);
    // 异步更新状态文件
    writeState({
      status: "installing",
      message: msg,
      startedAt: cachedState?.startedAt || Date.now(),
      progressPercent: percent,
    }).catch(() => { /* noop */ });
  };

  installAbortFlag = false;
  await fileLog("[install] 开始安装 Qwen3-0.6B");

  activeInstallPromise = (async () => {
    try {
      await fsp.mkdir(QWEN060_ROOT, { recursive: true });
      await writeState({ status: "installing", message: "开始安装...", startedAt: Date.now() });

      // 步骤1: 安装 node-llama-cpp
      progress("步骤 1/2: 安装 node-llama-cpp");
      await installNodeLlamaCpp(progress);
      checkAbort();

      // 步骤2: 下载 GGUF 模型
      progress("步骤 2/2: 下载 GGUF 模型");
      await downloadModel(progress);
      checkAbort();

      // 完成
      await fileLog("[install] 安装完成");
      onProgress?.("Qwen3-0.6B 安装完成！");
      // 必须最后写入 installed 状态，避免被 progress() 覆盖
      await writeState({
        status: "installed",
        message: "Qwen3-0.6B 已安装",
        version: "Qwen3-0.6B-Q8_0",
        startedAt: cachedState?.startedAt || Date.now(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAborted = msg === "INSTALL_ABORTED";
      await writeState({
        status: isAborted ? "failed" : "failed",
        message: isAborted ? "用户取消了安装" : "安装失败",
        lastError: msg,
        startedAt: Date.now(),
      });
      await fileLog("[install] 安装失败:", msg);
      throw err;
    } finally {
      activeInstallPromise = null;
    }
  })();

  return activeInstallPromise;
}

// ============================================================================
// 推理调用（懒加载 node-llama-cpp）
// ============================================================================

let llamaInstance: any = null;
let llamaModel: any = null;
let llamaContext: any = null;

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Qwen060ChatOptions {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** 是否启用 Qwen3 的思考模式，默认 true */
  enableThinking?: boolean;
}

export interface Qwen060ChatResult {
  text: string;
  tokensUsed?: number;
}

/**
 * 懒加载 node-llama-cpp 并初始化模型
 */
async function ensureModelLoaded(): Promise<void> {
  if (llamaModel && llamaContext) return;

  const status = await getQwen060InstallStatus();
  if (status.status !== "installed") {
    throw new Error(`Qwen3-0.6B 未安装：${status.message}`);
  }

  const modelFilePath = getModelFilePath();
  if (!(await fileExists(modelFilePath))) {
    throw new Error(`GGUF 模型文件不存在: ${modelFilePath}`);
  }

  dlog("[inference] 懒加载 node-llama-cpp");

  // 动态 import 本地安装的 node-llama-cpp
  const nodeLlamaCppPath = path.join(QWEN060_ROOT, "node_modules", "node-llama-cpp", "dist", "index.js");
  // file:// URL 在 Windows 必须前缀
  const importUrl = process.platform === "win32"
    ? `file:///${nodeLlamaCppPath.replace(/\\/g, "/")}`
    : nodeLlamaCppPath;

  const llamaModule: any = await import(importUrl);

  if (!llamaInstance) {
    const getLlama = llamaModule.getLlama;
    if (typeof getLlama !== "function") {
      throw new Error("node-llama-cpp 版本不兼容（getLlama 不存在）");
    }
    llamaInstance = await getLlama();
    dlog("[inference] llama 实例创建完成");
  }

  if (!llamaModel) {
    llamaModel = await llamaInstance.loadModel({ modelPath: modelFilePath });
    dlog("[inference] 模型加载完成");
  }

  if (!llamaContext) {
    const nCtx = parseInt(process.env.LOCAL_CHAT_N_CTX || "4096", 10);
    const nThreads = parseInt(process.env.LOCAL_CHAT_N_THREADS || "2", 10);
    llamaContext = await llamaModel.createContext({ contextSize: nCtx, nThreads });
    dlog("[inference] context 创建完成");
  }
}

/**
 * 调用 Qwen3-0.6B 进行 chat completion
 */
export async function chatWithQwen060(opts: Qwen060ChatOptions): Promise<Qwen060ChatResult> {
  await ensureModelLoaded();

  const nodeLlamaCppPath = path.join(QWEN060_ROOT, "node_modules", "node-llama-cpp", "dist", "index.js");
  const importUrl = process.platform === "win32"
    ? `file:///${nodeLlamaCppPath.replace(/\\/g, "/")}`
    : nodeLlamaCppPath;
  const llamaModule: any = await import(importUrl);
  const LlamaChatSession = llamaModule.LlamaChatSession;

  const sequence = llamaContext.getSequence();
  const session = new LlamaChatSession({
    contextSequence: sequence,
    systemPrompt: opts.messages.find(m => m.role === "system")?.content || undefined,
  });

  // 取最后一条 user message
  const userMsg = [...opts.messages].reverse().find(m => m.role === "user");
  if (!userMsg) throw new Error("缺少 user 消息");

  // Qwen3 是 thinking model，会输出 <think>...</think>，需要给足 token 让其完成思考+回答
  // 通过在 prompt 后加 /no_think 可以禁用思考模式（仅 Qwen3 支持）
  const enableThinking = opts.enableThinking !== false;
  const userContent = enableThinking
    ? userMsg.content
    : `${userMsg.content} /no_think`;

  const startedAt = Date.now();
  const rawText = await session.prompt(userContent, {
    maxTokens: opts.maxTokens || parseInt(process.env.LOCAL_CHAT_MAX_TOKENS || "1024", 10),
    temperature: opts.temperature ?? 0.3,
  });
  const cost = Date.now() - startedAt;

  // 提取 <think>...</think> 之外的实际回复
  // Qwen3 输出格式：<think>思考过程...</think>\n实际回复
  let cleanText = String(rawText || "").trim();
  const thinkMatch = cleanText.match(/<think>[\s\S]*?<\/think>\s*([\s\S]*)$/);
  if (thinkMatch) {
    cleanText = thinkMatch[1].trim();
  }
  // 兼容：仅有 <think> 开头但未闭合（被 maxTokens 截断）→ 取闭合标签后的内容；如全在思考中，回退到原文
  const partialThink = cleanText.match(/<\/think>\s*([\s\S]*)$/);
  if (partialThink && !thinkMatch) {
    cleanText = partialThink[1].trim();
  }

  dlog(`[inference] 推理完成，耗时 ${cost}ms，原始长度 ${rawText.length}, 清洗后 ${cleanText.length}`);
  dlog(`[inference] 原始输出预览:`, String(rawText).slice(0, 200));
  dlog(`[inference] 清洗后:`, cleanText.slice(0, 200));

  // 释放 sequence
  try {
    sequence.dispose();
  } catch { /* ignore */ }

  return { text: cleanText };
}

/**
 * 卸载模型（释放内存）
 */
export async function unloadQwen060(): Promise<void> {
  try {
    if (llamaContext) {
      await llamaContext.dispose();
      llamaContext = null;
    }
    if (llamaModel) {
      await llamaModel.dispose();
      llamaModel = null;
    }
    dlog("[inference] 模型已卸载");
  } catch (err) {
    dlog("[inference] 卸载失败:", err);
  }
}

// ============================================================================
// 启动时自动安装并加载本地模型
// ============================================================================

/**
 * 是否启用"程序启动时自动安装+加载本地大模型"
 * 通过环境变量 LOCAL_CHAT_MODEL_RUN_START=true 开启
 */
export function isQwen060BootEnabled(): boolean {
  return String(process.env.LOCAL_CHAT_MODEL_RUN_START || "").trim().toLowerCase() === "true";
}

/**
 * 程序启动时尝试：
 * 1. 如果未安装 → 触发安装（异步、不阻塞主进程启动）
 * 2. 如果已安装 → 预热加载模型到内存（首次推理可立即响应）
 *
 * 失败不抛错，只打日志，避免影响主程序启动。
 */
export async function startQwen060OnBoot(): Promise<void> {
  try {
    const status = await getQwen060InstallStatus();
    console.log("[qwen3-0.6b][boot] 启动检查", {
      status: status.status,
      installed: status.installed,
    });

    if (!status.installed) {
      // 未安装 → 触发安装（异步）
      console.log("[qwen3-0.6b][boot] 检测到未安装，自动开始安装（异步进行，不阻塞服务启动）");
      // 不 await，让安装在后台进行
      installQwen060((msg) => {
        console.log(`[qwen3-0.6b][boot] ${msg}`);
      })
        .then(() => {
          console.log("[qwen3-0.6b][boot] 安装完成，预热加载模型...");
          return ensureModelLoaded();
        })
        .then(() => {
          console.log("[qwen3-0.6b][boot] 模型已加载到内存，可立即推理");
        })
        .catch((err) => {
          console.error("[qwen3-0.6b][boot] 安装/加载失败:", err instanceof Error ? err.message : String(err));
        });
      return;
    }

    // 已安装 → 直接预热
    console.log("[qwen3-0.6b][boot] 已安装，预热加载模型到内存...");
    ensureModelLoaded()
      .then(() => {
        console.log("[qwen3-0.6b][boot] 模型已加载到内存，可立即推理");
      })
      .catch((err) => {
        console.error("[qwen3-0.6b][boot] 模型预热失败:", err instanceof Error ? err.message : String(err));
      });
  } catch (err) {
    console.error("[qwen3-0.6b][boot] 启动检查异常:", err instanceof Error ? err.message : String(err));
  }
}