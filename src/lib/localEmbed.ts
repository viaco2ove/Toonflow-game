/**
 * m3e-small 本地向量模型管理（sentence-transformers / Python subprocess）
 *
 * 流程：
 * 1. 安装：pip install sentence-transformers + 下载模型
 * 2. 调用：启动 Python subprocess，发送 encode 请求，解析返回的向量
 *
 * 参考：localQwen060.ts 的管理模式
 */

import fsp from "node:fs/promises";
import path from "path";
import { spawn, type ChildProcess } from "node:child_process";
import { getLocalToolRootDir } from "@/lib/runtimePaths";
import { DebugLogUtil } from "@/utils/debugLogUtil";

const ROOT_DIR = getLocalToolRootDir();
const EMBED_ROOT = path.join(ROOT_DIR, "m3e-small");
const STATE_FILE = path.join(EMBED_ROOT, "install-state.json");
const MODELS_DIR = path.join(EMBED_ROOT, "models");

// 模型标识
const MODEL_NAME = "moka-ai/m3e-small";
// HuggingFace 镜像（国内可访问）
const MODEL_MIRROR_URL = "https://hf-mirror.com/moka-ai/m3e-small";

// 6 类意图 exemplar（与 litter_llama/__main__.py:223-270 一致）
const INTENT_EXEMPLARS: Array<{ intent: string; exemplars: string[] }> = [
  { intent: "create_task", exemplars: ["任务为：找到舍友", "接受任务：去探索地图", "我来帮你做这个任务", "没问题，我去做", "开启任务：收集材料", "开任务：打boss"] },
  { intent: "exit_task", exemplars: ["算了不做了", "退出任务", "放弃这个任务", "不做了", "取消任务"] },
  { intent: "query_progress", exemplars: ["任务进度怎么样了", "完成了多少", "还差什么", "任务进展如何", "现在什么进展"] },
  { intent: "game_action", exemplars: ["攻击怪物", "打开背包", "使用道具", "和NPC对话", "查看装备"] },
  { intent: "memory_update", exemplars: ["把物品放入物品栏", "记录在记忆中", "加入背包", "装备上这把剑", "学会了技能", "升级到10级", "获得物品：钥匙"] },
  { intent: "normal_dialog", exemplars: ["老板你好", "今天天气真好", "你好啊", "早上好", "最近怎么样", "嗨"] },
];

type EmbedStatusKind = "not_installed" | "installing" | "installed" | "failed";

interface InstallState {
  status: EmbedStatusKind;
  message?: string;
  version?: string;
  startedAt?: number;
  lastError?: string;
  progressPercent?: number;
}

let cachedState: InstallState | null = null;
let pythonProc: ChildProcess | null = null;
let exemplarVectors: number[][] | null = null;
let exemplarIntentMap: string[] = [];
let embeddingReady = false;

function dlog(...args: unknown[]): void {
  if (DebugLogUtil.isDebugLogEnabled()) {
    console.log("[m3e-small]", ...args);
  }
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
  await fsp.mkdir(EMBED_ROOT, { recursive: true });
  await fsp.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

async function fileExists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true; } catch { return false; }
}

// ============================================================================
// 状态查询
// ============================================================================

export async function getEmbedInstallStatus(): Promise<{
  status: EmbedStatusKind;
  installed: boolean;
  canInstall: boolean;
  message: string;
  model: string;
  progressPercent?: number;
}> {
  const state = await readState();
  const modelDir = await findModelDir();

  if (state?.status === "installing") {
    const elapsed = state.startedAt ? Date.now() - state.startedAt : 0;
    return {
      status: "installing",
      installed: false,
      canInstall: false,
      message: state.message || `正在安装中...（已进行 ${Math.floor(elapsed / 1000)} 秒）`,
      model: MODEL_NAME,
      progressPercent: state.progressPercent,
    };
  }

  if (state?.status === "failed") {
    return {
      status: "failed",
      installed: false,
      canInstall: true,
      message: state.lastError || state.message || "安装失败，请重试",
      model: MODEL_NAME,
    };
  }

  if (state?.status === "installed" && modelDir) {
    return {
      status: "installed",
      installed: true,
      canInstall: true,
      message: "m3e-small 已安装，可以使用",
      model: MODEL_NAME,
    };
  }

  return {
    status: "not_installed",
    installed: false,
    canInstall: true,
    message: "m3e-small 尚未安装，点击安装（sentence-transformers + 向量模型，约 400MB）",
    model: MODEL_NAME,
  };
}

/** 查找模型目录（支持子目录结构） */
async function findModelDir(): Promise<string | null> {
  if (await fileExists(MODELS_DIR)) {
    // 优先在 models/ 下找含 pytorch_model.bin / model.safetensors 的子目录
    // sentence-transformers 的 snapshot_download 会创建 1_Pooling 子目录，
    // 其 config.json 不含 model_type，会导致模型加载失败
    const subs = await fsp.readdir(MODELS_DIR);
    for (const sub of subs) {
      const subPath = path.join(MODELS_DIR, sub);
      const stat = await fsp.stat(subPath).catch(() => null);
      if (!stat?.isDirectory()) continue;
      const subFiles = await fsp.readdir(subPath).catch(() => []);
      if (
        subFiles.some(f => f === "pytorch_model.bin" || f === "model.safetensors" || f === "modules.json")
        && subFiles.includes("config.json")
      ) {
        return subPath;
      }
    }
    // models/ 下直接是模型文件
    if (subs.some(f => f.endsWith(".bin") || f.endsWith(".safetensors"))) {
      return MODELS_DIR;
    }
  }
  // 根目录 fallback
  if (await fileExists(EMBED_ROOT)) {
    const files = await fsp.readdir(EMBED_ROOT);
    if (files.some(f => f.endsWith(".bin") || f.endsWith(".safetensors"))) {
      return EMBED_ROOT;
    }
  }
  return null;
}

// ============================================================================
// Python subprocess 管理
// ============================================================================

function getPythonCmd(): string {
  // 优先用 conda 的 python（环境里通常有 sentence-transformers）
  const condaPy = "D:\\ProgramData\\miniconda3\\python.exe";
  try {
    require("node:fs").accessSync(condaPy);
    return condaPy;
  } catch { /* fallback to PATH */ }
  if (process.platform === "win32") {
    return "python";
  }
  return "python3";
}

function getPipCmd(): string {
  const condaPip = "D:\\ProgramData\\miniconda3\\Scripts\\pip.exe";
  try {
    require("node:fs").accessSync(condaPip);
    return condaPip;
  } catch { /* fallback */ }
  if (process.platform === "win32") {
    return "pip";
  }
  return "pip3";
}

let requestId = 0;
const pendingRequests = new Map<number, { resolve: (v: number[][]) => void; reject: (e: Error) => void }>();

/** 启动 Python subprocess（懒加载，按需启动） */
async function ensurePythonReady(): Promise<void> {
  if (pythonProc && embeddingReady) return;

  const modelDir = await findModelDir();
  if (!modelDir) {
    throw new Error(`m3e-small 模型未安装，请先安装`);
  }

  if (pythonProc) {
    // 已启动但未就绪，等待
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (embeddingReady) { clearInterval(check); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(check); resolve(); }, 5000);
    });
    return;
  }

  // 构建 Python 脚本
  const scriptContent = `
import sys
import json
import threading
try:
    from sentence_transformers import SentenceTransformer
    import numpy as np
except ImportError as e:
    print(json.dumps({"type": "error", "msg": str(e)}), flush=True)
    sys.exit(1)

model = None
model_dir = sys.argv[1] if len(sys.argv) > 1 else "."
model_lock = threading.Lock()

def cosine_similarity(a, b):
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))

def handle_request(data):
    req_id = data.get("id", 0)
    action = data.get("action", "")
    try:
        if action == "encode":
            texts = data.get("texts", [])
            with model_lock:
                vectors = model.encode(texts, show_progress_bar=False).tolist()
            print(json.dumps({"type": "result", "id": req_id, "vectors": vectors}), flush=True)
        elif action == "warmup":
            with model_lock:
                _ = model.encode(["warmup"], show_progress_bar=False)
            print(json.dumps({"type": "result", "id": req_id, "vectors": []}), flush=True)
        elif action == "ready":
            print(json.dumps({"type": "result", "id": req_id, "vectors": []}), flush=True)
    except Exception as e:
        print(json.dumps({"type": "error", "id": req_id, "msg": str(e)}), flush=True, file=sys.stderr)

# 加载模型
try:
    print(json.dumps({"type": "status", "msg": "loading"}), flush=True)
    model = SentenceTransformer(model_dir, device="cpu")
    print(json.dumps({"type": "ready", "msg": "loaded"}), flush=True)
except Exception as e:
    print(json.dumps({"type": "error", "msg": f"load failed: {e}"}), flush=True)
    sys.exit(1)

# 逐行读取请求
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        data = json.loads(line)
        handle_request(data)
    except json.JSONDecodeError:
        continue
`;

  const scriptPath = path.join(EMBED_ROOT, "_encode_server.py");
  await fsp.mkdir(EMBED_ROOT, { recursive: true });
  await fsp.writeFile(scriptPath, scriptContent, "utf8");

  dlog("[m3e-small] 启动 Python subprocess...");
  pythonProc = spawn(getPythonCmd(), [scriptPath, modelDir], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let initDone = false;
  const initPromise = new Promise<void>((resolve, reject) => {
    pythonProc!.stdout!.on("data", (chunk: Buffer) => {
      const lines = chunk.toString("utf8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "ready") {
            initDone = true;
            embeddingReady = true;
            resolve();
          } else if (msg.type === "error") {
            console.error("[m3e-small] Python 进程错误:", msg.msg);
            if (!initDone) reject(new Error(msg.msg));
          }
        } catch {
          // non-JSON 输出（debug）
        }
      }
    });
    pythonProc!.stderr!.on("data", (chunk: Buffer) => {
      const txt = chunk.toString("utf8").trim();
      if (txt) dlog("[m3e-small][stderr]", txt);
    });
    pythonProc!.on("error", (err) => {
      console.error("[m3e-small] subprocess error:", err.message);
      if (!initDone) reject(err);
    });
    pythonProc!.on("close", (code) => {
      console.log(`[m3e-small] subprocess exited with code ${code}`);
      pythonProc = null;
      embeddingReady = false;
    });
  });

  // 20s 启动超时：超过 20s 说明 sentence-transformers 没装好 / 模型路径不对
  await Promise.race([
    initPromise,
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error("Python subprocess 启动超时（20s）")), 20000)),
  ]);
  dlog("[m3e-small] 模型已加载，向量引擎就绪");
}

/** 发送请求到 Python subprocess */
function pythonRequest(action: string, texts?: string[]): Promise<number[][]> {
  return new Promise((resolve, reject) => {
    if (!pythonProc || !pythonProc.stdin) {
      reject(new Error("Python 进程未启动"));
      return;
    }
    const id = ++requestId;
    pendingRequests.set(id, { resolve, reject });
    const payload = { id, action, texts: texts || [] };
    pythonProc.stdin.write(JSON.stringify(payload) + "\n", (err) => {
      if (err) {
        pendingRequests.delete(id);
        reject(err);
      }
    });
    // 超时 30s
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`请求 ${id} 超时`));
      }
    }, 30000);
  });
}

// ============================================================================
// 向量意图分析
// ============================================================================

/** 优先级映射（与 IntentClassifier.ts 一致：数字越小优先级越高） */
const INTENT_PRIORITY: Record<string, number> = {
  exit_task: 0,
  memory_update: 1,
  create_task: 2,
  query_progress: 3,
  game_action: 4,
  normal_dialog: 5,
};

/** cosine similarity */
function cosineScore(a: number[], b: number[]): number {
  const dot = a.reduce((s, v, i) => s + v * b[i], 0);
  const normA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  const normB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
  if (normA === 0 || normB === 0) return 0;
  return dot / (normA * normB);
}

/** 预缓存 exemplar 向量（每类取一条代表向量即可） */
async function ensureExemplarVectors(): Promise<void> {
  if (exemplarVectors !== null) return;

  // 预热 Python 进程
  await ensurePythonReady();

  // 每类取一条代表性 exemplar 做 encode
  const texts = INTENT_EXEMPLARS.map((g) => g.exemplars[0]);
  exemplarIntentMap = INTENT_EXEMPLARS.map((g) => g.intent);

  dlog("[m3e-small] 预计算 exemplar 向量...", texts);
  exemplarVectors = await pythonRequest("encode", texts);
  dlog(`[m3e-small] exemplar 向量预计算完成，shape=${exemplarVectors.length}x${exemplarVectors[0]?.length ?? 0}`);
}

/** 向量意图分析主入口（~100ms） */
export async function classifyIntentByEmbedding(text: string): Promise<{
  intent: string;
  confidence: number;
  reasoning: string;
} | null> {
  try {
    await ensureExemplarVectors();
    if (!exemplarVectors || exemplarVectors.length === 0) return null;

    const t0 = Date.now();
    // encode 用户消息
    const userVectors = await pythonRequest("encode", [text]);
    const encodeMs = Date.now() - t0;
    if (!userVectors || userVectors.length === 0) return null;

    const userVec = userVectors[0];

    // cosine similarity：每类取最高分
    const bestPerIntent: Record<string, number> = {};
    for (const g of INTENT_EXEMPLARS) bestPerIntent[g.intent] = 0;

    for (let i = 0; i < exemplarVectors.length; i++) {
      const score = cosineScore(userVec, exemplarVectors[i]);
      const intent = exemplarIntentMap[i];
      if (score > bestPerIntent[intent]) bestPerIntent[intent] = score;
    }

    // 按优先级排序
    const sorted = Object.entries(bestPerIntent)
      .sort(([a, kA], [b, kB]) => {
        const pA = INTENT_PRIORITY[a] ?? 99;
        const pB = INTENT_PRIORITY[b] ?? 99;
        if (pA !== pB) return pA - pB;
        return kB - kA; // 同优先级取高分
      });

    const [topIntent, topScore] = sorted[0];

    dlog(`[m3e-small] 分类结果 intent=${topIntent} score=${topScore.toFixed(4)} encode_ms=${encodeMs}`);

    return {
      intent: topIntent,
      confidence: Math.round(topScore * 10000) / 10000,
      reasoning: `向量相似度最高（${topScore.toFixed(3)}）`,
    };
  } catch (err) {
    console.warn("[m3e-small] 向量意图分析失败:", (err as Error).message);
    return null;
  }
}

// ============================================================================
// 安装流程
// ============================================================================

let installAbortFlag = false;
let activeInstallPromise: Promise<void> | null = null;

export async function cancelInstall(): Promise<void> {
  installAbortFlag = true;
}

export async function resetInstallState(): Promise<void> {
  installAbortFlag = false;
  cachedState = null;
  activeInstallPromise = null;
  try {
    await fsp.unlink(STATE_FILE);
  } catch { /* ignore */ }
}

/** 安装 m3e-small（sentence-transformers + 模型文件） */
export async function installEmbed(onProgress: (msg: string, percent?: number) => void): Promise<void> {
  if (activeInstallPromise) return activeInstallPromise;
  activeInstallPromise = _installEmbed(onProgress);
  return activeInstallPromise;
}

async function _installEmbed(onProgress: (msg: string, percent?: number) => void): Promise<void> {
  installAbortFlag = false;
  await writeState({ status: "installing", startedAt: Date.now(), message: "开始安装 m3e-small..." });
  onProgress("开始安装 m3e-small...", 0);

  try {
    // 步骤 1: 检查 sentence-transformers
    onProgress("检查 sentence-transformers...", 10);
    const stOk = await runPythonAsync(
      ["-c", "from sentence_transformers import SentenceTransformer; print('ok')"],
      15000,
    );
    if (installAbortFlag) throw new Error("INSTALL_ABORTED");

    if (!stOk) {
      onProgress("正在安装 sentence-transformers（首次需下载依赖，约 100MB）...", 20);
      const pipOk = await runCommandAsync(
        getPipCmd(),
        ["install", "sentence-transformers", "--quiet", "--no-cache-dir"],
        600000,
        onProgress,
      );
      if (!pipOk) throw new Error("pip install sentence-transformers 失败");
    }
    onProgress("sentence-transformers 已就绪", 40);

    // 步骤 2: 下载 m3e-small 模型
    await fsp.mkdir(MODELS_DIR, { recursive: true });
    onProgress("正在下载 m3e-small 模型（约 400MB）...", 50);

    const dlScript = `
import os
import sys
from huggingface_hub import snapshot_download

dest = r"${MODELS_DIR.replace(/\\/g, "\\\\")}"
os.makedirs(dest, exist_ok=True)

try:
    snapshot_download(
        repo_id="${MODEL_NAME}",
        local_dir=dest,
        local_dir_use_symlinks=False,
        allow_patterns=["*"],
    )
    print("DOWNLOAD_OK")
except Exception as e:
    print(f"DOWNLOAD_ERROR: {e}", file=sys.stderr)
    sys.exit(1)
`;
    const dlScriptPath = path.join(EMBED_ROOT, "_download.py");
    await fsp.writeFile(dlScriptPath, dlScript, "utf8");

    const dlOk = await runPythonAsync([dlScriptPath], 600000);
    if (installAbortFlag) throw new Error("INSTALL_ABORTED");
    if (!dlOk) {
      // 降级：用镜像源（HF_ENDPOINT）重试
      onProgress("主源下载失败，尝试镜像...", 60);
      const altScript = dlScript.replace(
        'local_dir=dest,',
        `cache_dir=dest,`,
      );
      await fsp.writeFile(dlScriptPath, altScript, "utf8");
      const altOk = await runPythonAsync([dlScriptPath], 600000);
      if (!altOk) throw new Error("模型下载失败，请检查网络或手动放置模型到 " + MODELS_DIR);
    }
    onProgress("模型下载完成", 80);

    // 验证模型
    const modelDir = await findModelDir();
    if (!modelDir) {
      throw new Error("模型文件未找到，下载可能不完整");
    }

    await writeState({ status: "installed", version: MODEL_NAME, message: "m3e-small 安装完成" });
    onProgress("安装完成！m3e-small 已就绪", 100);
    dlog("[m3e-small] 安装完成，模型目录:", modelDir);
  } catch (err) {
    const msg = (err as Error).message;
    await writeState({ status: "failed", lastError: msg, message: "安装失败" });
    console.error("[m3e-small] 安装失败:", msg);
    throw err;
  } finally {
    activeInstallPromise = null;
  }
}

/** 异步执行 python 命令（带超时），返回 exit code 是否为 0 */
function runPythonAsync(args: string[], timeoutMs: number): Promise<boolean> {
  return runCommandAsync(getPythonCmd(), args, timeoutMs);
}

/** 异步执行命令，收集 stdout/stderr 到日志，timeout 超时则 kill。 */
function runCommandAsync(
  cmd: string,
  args: string[],
  timeoutMs: number,
  onProgress?: (msg: string) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch (e) {
      console.error(`[m3e-small] 无法启动命令 ${cmd}:`, (e as Error).message);
      resolve(false);
      return;
    }

    let stderrBuf = "";
    let killed = false;

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (onProgress) onProgress(text.trim().slice(-200));
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrBuf += text;
      if (onProgress) onProgress(text.trim().slice(-200));
    });

    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill(); } catch { /* ignore */ }
      console.error(`[m3e-small] 命令超时 ${cmd}（${timeoutMs}ms）`);
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      console.error(`[m3e-small] 命令错误 ${cmd}: ${err.message}`);
      resolve(false);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) { resolve(false); return; }
      if (code === 0) { resolve(true); }
      else {
        console.error(`[m3e-small] 命令退出码 ${code}（${cmd}）: ${stderrBuf.slice(-500)}`);
        resolve(false);
      }
    });
  });
}

/** 卸载模型（释放内存） */
export async function unloadEmbed(): Promise<void> {
  if (pythonProc) {
    pythonProc.kill();
    pythonProc = null;
  }
  embeddingReady = false;
  exemplarVectors = null;
  dlog("[m3e-small] 模型已卸载");
}

/** 是否启用"程序启动时自动加载本地向量模型" */
export function isEmbedBootEnabled(): boolean {
  return String(process.env.LOCAL_EMBED_MODEL_RUN_START || "").trim().toLowerCase() === "true";
}

/** 程序启动时自动加载 */
export async function startEmbedOnBoot(): Promise<void> {
  const status = await getEmbedInstallStatus();
  if (!status.installed) {
    console.log("[m3e-small][boot] 未安装，跳过");
    return;
  }
  console.log("[m3e-small][boot] 启动预热...");
  try {
    await ensureExemplarVectors();
    console.log("[m3e-small][boot] 预热完成，向量引擎就绪");
  } catch (err) {
    console.warn("[m3e-small][boot] 预热失败:", (err as Error).message);
  }
}
