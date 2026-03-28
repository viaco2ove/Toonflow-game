import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getLocalToolRootDir } from "@/lib/runtimePaths";

export const LOCAL_BIREFNET_MANUFACTURER = "local_birefnet";
export const LOCAL_BIREFNET_DEFAULT_MODEL = "birefnet-portrait";

const LOCAL_BIREFNET_SUPPORTED_MODELS = new Set([
  "birefnet-portrait",
  "birefnet-general",
  "birefnet-general-lite",
]);
const LOCAL_BIREFNET_INSTALL_VERSION = 1;
const LOCAL_BIREFNET_REMBG_VERSION = "2.0.67";
const LOCAL_BIREFNET_ONNXRUNTIME_VERSION = "1.22.1";

type LocalInstallStatusKind = "not_installed" | "installing" | "installed" | "failed";

type InstallStateFile = {
  status: Exclude<LocalInstallStatusKind, "not_installed">;
  message: string;
  updatedAt: number;
  installedAt?: number;
  version?: number;
  model?: string;
  pythonLauncher?: string;
  lastError?: string;
};

type PythonLauncher = {
  command: string;
  baseArgs: string[];
  label: string;
};

type RunCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export type LocalAvatarMattingStatus = {
  manufacturer: typeof LOCAL_BIREFNET_MANUFACTURER;
  model: string;
  status: LocalInstallStatusKind;
  installed: boolean;
  canInstall: boolean;
  message: string;
};

let activeBiRefNetInstallPromise: Promise<LocalAvatarMattingStatus> | null = null;
let activeBiRefNetInstallMessage = "";

function getBiRefNetRootDir(): string {
  return path.join(getLocalToolRootDir(), "avatar-matting", "birefnet");
}

function getBiRefNetVenvDir(): string {
  return path.join(getBiRefNetRootDir(), "venv");
}

function getBiRefNetRunnerScriptPath(): string {
  return path.join(getBiRefNetRootDir(), "run_birefnet.py");
}

function getBiRefNetStateFilePath(): string {
  return path.join(getBiRefNetRootDir(), "install-state.json");
}

function getBiRefNetCacheDir(): string {
  return path.join(getBiRefNetRootDir(), "model-cache");
}

function getBiRefNetWorkDir(): string {
  return path.join(getBiRefNetRootDir(), "work");
}

function getManagedBiRefNetPythonPath(): string {
  return process.platform === "win32"
    ? path.join(getBiRefNetVenvDir(), "Scripts", "python.exe")
    : path.join(getBiRefNetVenvDir(), "bin", "python");
}

function buildBiRefNetEnv(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONUTF8: "1",
    U2NET_HOME: getBiRefNetCacheDir(),
    ...extraEnv,
  };
}

function resolveLocalBiRefNetModelName(input?: string | null): string {
  const normalized = String(input || "").trim().toLowerCase();
  if (!normalized) return LOCAL_BIREFNET_DEFAULT_MODEL;
  if (LOCAL_BIREFNET_SUPPORTED_MODELS.has(normalized)) return normalized;
  if (normalized.startsWith("birefnet-")) return normalized;
  return LOCAL_BIREFNET_DEFAULT_MODEL;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readInstallState(): Promise<InstallStateFile | null> {
  try {
    const raw = await fs.readFile(getBiRefNetStateFilePath(), "utf8");
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
      model: String(parsed.model || "").trim() || undefined,
      pythonLauncher: String(parsed.pythonLauncher || "").trim() || undefined,
      lastError: String(parsed.lastError || "").trim() || undefined,
    };
  } catch {
    return null;
  }
}

async function writeInstallState(state: InstallStateFile): Promise<void> {
  await ensureDir(getBiRefNetRootDir());
  await fs.writeFile(getBiRefNetStateFilePath(), JSON.stringify(state, null, 2), "utf8");
}

function formatCommandError(command: string, args: string[], stdout: string, stderr: string): string {
  const joined = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n").trim();
  return joined || `命令执行失败: ${command} ${args.join(" ")}`.trim();
}

async function runCommand(command: string, args: string[], options: RunCommandOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
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
        child.kill("SIGKILL");
        finishReject(`命令执行超时: ${command} ${args.join(" ")}`.trim());
      }, options.timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk || "");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });
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
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(formatCommandError(command, args, stdout, stderr)));
    });
  });
}

async function resolveSystemPythonLauncher(): Promise<PythonLauncher | null> {
  const candidates: PythonLauncher[] = process.platform === "win32"
    ? [
      { command: "python", baseArgs: [], label: "python" },
      { command: "py", baseArgs: ["-3"], label: "py -3" },
      { command: "python3", baseArgs: [], label: "python3" },
    ]
    : [
      { command: "python3", baseArgs: [], label: "python3" },
      { command: "python", baseArgs: [], label: "python" },
    ];
  for (const candidate of candidates) {
    try {
      await runCommand(candidate.command, [...candidate.baseArgs, "--version"], {
        timeoutMs: 10000,
      });
      return candidate;
    } catch {
      // noop
    }
  }
  return null;
}

async function ensureBiRefNetRunnerScript(): Promise<void> {
  const script = [
    "import argparse",
    "import json",
    "from pathlib import Path",
    "",
    "def main():",
    "    parser = argparse.ArgumentParser()",
    "    parser.add_argument('--model', default='birefnet-portrait')",
    "    parser.add_argument('--input', default='')",
    "    parser.add_argument('--output', default='')",
    "    parser.add_argument('--warmup', action='store_true')",
    "    args = parser.parse_args()",
    "",
    "    from rembg import new_session, remove",
    "",
    "    session = new_session(args.model)",
    "    if args.warmup:",
    "        print(json.dumps({'ok': True, 'model': args.model}))",
    "        return",
    "",
    "    input_path = Path(args.input)",
    "    output_path = Path(args.output)",
    "    if not input_path.exists():",
    "        raise FileNotFoundError(str(input_path))",
    "",
    "    result = remove(input_path.read_bytes(), session=session, force_return_bytes=True)",
    "    output_path.parent.mkdir(parents=True, exist_ok=True)",
    "    output_path.write_bytes(result)",
    "    print(json.dumps({'ok': True, 'output': str(output_path)}))",
    "",
    "if __name__ == '__main__':",
    "    main()",
    "",
  ].join("\n");
  await ensureDir(getBiRefNetRootDir());
  await fs.writeFile(getBiRefNetRunnerScriptPath(), script, "utf8");
}

async function isBiRefNetInstalled(): Promise<boolean> {
  const state = await readInstallState();
  if (state?.status !== "installed") return false;
  if (state.version !== LOCAL_BIREFNET_INSTALL_VERSION) return false;
  return await fileExists(getManagedBiRefNetPythonPath()) && await fileExists(getBiRefNetRunnerScriptPath());
}

function buildStatus(
  model: string,
  status: LocalInstallStatusKind,
  message: string,
  canInstall: boolean,
): LocalAvatarMattingStatus {
  return {
    manufacturer: LOCAL_BIREFNET_MANUFACTURER,
    model,
    status,
    installed: status === "installed",
    canInstall,
    message,
  };
}

export async function getLocalAvatarMattingStatus(input?: {
  manufacturer?: string | null;
  model?: string | null;
}): Promise<LocalAvatarMattingStatus> {
  const manufacturer = String(input?.manufacturer || LOCAL_BIREFNET_MANUFACTURER).trim().toLowerCase();
  if (manufacturer !== LOCAL_BIREFNET_MANUFACTURER) {
    throw new Error("当前仅支持本地 BiRefNet 安装状态查询");
  }
  const model = resolveLocalBiRefNetModelName(input?.model);
  const launcher = await resolveSystemPythonLauncher();
  const canInstall = !!launcher;

  if (activeBiRefNetInstallPromise) {
    return buildStatus(model, "installing", activeBiRefNetInstallMessage || "本地 BiRefNet 安装中", canInstall);
  }
  if (await isBiRefNetInstalled()) {
    return buildStatus(model, "installed", "本地 BiRefNet 已安装，可直接使用", canInstall);
  }

  const state = await readInstallState();
  if (state?.status === "failed") {
    return buildStatus(model, "failed", state.message || state.lastError || "本地 BiRefNet 安装失败，请重试", canInstall);
  }
  if (!canInstall) {
    return buildStatus(model, "not_installed", "未检测到可用 Python 3，无法安装本地 BiRefNet", false);
  }
  if (state?.status === "installing") {
    return buildStatus(model, "installing", state.message || "本地 BiRefNet 安装中", true);
  }
  return buildStatus(model, "not_installed", "首次使用需要安装 Python 依赖和 BiRefNet 模型文件", true);
}

async function runManagedBiRefNetPython(args: string[], options: RunCommandOptions = {}): Promise<{ stdout: string; stderr: string }> {
  if (!await fileExists(getManagedBiRefNetPythonPath())) {
    throw new Error("本地 BiRefNet 尚未安装，请先完成安装");
  }
  return await runCommand(getManagedBiRefNetPythonPath(), args, {
    ...options,
    env: buildBiRefNetEnv(options.env),
  });
}

export async function installLocalBiRefNet(input?: {
  manufacturer?: string | null;
  model?: string | null;
}): Promise<LocalAvatarMattingStatus> {
  const manufacturer = String(input?.manufacturer || LOCAL_BIREFNET_MANUFACTURER).trim().toLowerCase();
  if (manufacturer !== LOCAL_BIREFNET_MANUFACTURER) {
    throw new Error("当前仅支持安装本地 BiRefNet");
  }
  const model = resolveLocalBiRefNetModelName(input?.model);

  if (activeBiRefNetInstallPromise) {
    return await activeBiRefNetInstallPromise;
  }
  if (await isBiRefNetInstalled()) {
    return buildStatus(model, "installed", "本地 BiRefNet 已安装，可直接使用", true);
  }

  activeBiRefNetInstallPromise = (async () => {
    const launcher = await resolveSystemPythonLauncher();
    if (!launcher) {
      throw new Error("未检测到可用 Python 3，无法安装本地 BiRefNet");
    }

    activeBiRefNetInstallMessage = "正在准备本地 BiRefNet 环境";
    await writeInstallState({
      status: "installing",
      message: activeBiRefNetInstallMessage,
      updatedAt: Date.now(),
      model,
      pythonLauncher: launcher.label,
      version: LOCAL_BIREFNET_INSTALL_VERSION,
    });

    try {
      await ensureDir(getBiRefNetRootDir());
      await ensureDir(getBiRefNetCacheDir());
      await ensureDir(getBiRefNetWorkDir());

      activeBiRefNetInstallMessage = "正在创建本地 Python 环境";
      await writeInstallState({
        status: "installing",
        message: activeBiRefNetInstallMessage,
        updatedAt: Date.now(),
        model,
        pythonLauncher: launcher.label,
        version: LOCAL_BIREFNET_INSTALL_VERSION,
      });
      await runCommand(launcher.command, [...launcher.baseArgs, "-m", "venv", getBiRefNetVenvDir()], {
        timeoutMs: 300000,
      });

      await ensureBiRefNetRunnerScript();

      activeBiRefNetInstallMessage = "正在安装本地 BiRefNet 依赖";
      await writeInstallState({
        status: "installing",
        message: activeBiRefNetInstallMessage,
        updatedAt: Date.now(),
        model,
        pythonLauncher: launcher.label,
        version: LOCAL_BIREFNET_INSTALL_VERSION,
      });
      await runManagedBiRefNetPython(["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"], {
        timeoutMs: 900000,
      });
      await runManagedBiRefNetPython([
        "-m",
        "pip",
        "install",
        `rembg==${LOCAL_BIREFNET_REMBG_VERSION}`,
        `onnxruntime==${LOCAL_BIREFNET_ONNXRUNTIME_VERSION}`,
        "pillow",
      ], {
        timeoutMs: 1800000,
      });

      activeBiRefNetInstallMessage = `正在预下载 ${model} 模型文件`;
      await writeInstallState({
        status: "installing",
        message: activeBiRefNetInstallMessage,
        updatedAt: Date.now(),
        model,
        pythonLauncher: launcher.label,
        version: LOCAL_BIREFNET_INSTALL_VERSION,
      });
      await runManagedBiRefNetPython([getBiRefNetRunnerScriptPath(), "--warmup", "--model", model], {
        timeoutMs: 900000,
      });

      const status = buildStatus(model, "installed", "本地 BiRefNet 已安装，可直接使用", true);
      await writeInstallState({
        status: "installed",
        message: status.message,
        updatedAt: Date.now(),
        installedAt: Date.now(),
        model,
        pythonLauncher: launcher.label,
        version: LOCAL_BIREFNET_INSTALL_VERSION,
      });
      return status;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || "本地 BiRefNet 安装失败");
      await writeInstallState({
        status: "failed",
        message,
        updatedAt: Date.now(),
        model,
        pythonLauncher: launcher.label,
        version: LOCAL_BIREFNET_INSTALL_VERSION,
        lastError: message,
      });
      throw new Error(message);
    } finally {
      activeBiRefNetInstallMessage = "";
      activeBiRefNetInstallPromise = null;
    }
  })();

  return await activeBiRefNetInstallPromise;
}

export async function runLocalBiRefNetMatting(input: Buffer, model?: string | null): Promise<Buffer> {
  const resolvedModel = resolveLocalBiRefNetModelName(model);
  const status = await getLocalAvatarMattingStatus({
    manufacturer: LOCAL_BIREFNET_MANUFACTURER,
    model: resolvedModel,
  });
  if (status.status !== "installed") {
    throw new Error(status.message || "本地 BiRefNet 尚未安装");
  }

  await ensureDir(getBiRefNetWorkDir());
  const workToken = randomUUID();
  const inputPath = path.join(getBiRefNetWorkDir(), `${workToken}_input.png`);
  const outputPath = path.join(getBiRefNetWorkDir(), `${workToken}_output.png`);
  try {
    await fs.writeFile(inputPath, input);
    await runManagedBiRefNetPython([
      getBiRefNetRunnerScriptPath(),
      "--model",
      resolvedModel,
      "--input",
      inputPath,
      "--output",
      outputPath,
    ], {
      timeoutMs: 900000,
    });
    return await fs.readFile(outputPath);
  } finally {
    await Promise.allSettled([
      fs.rm(inputPath, { force: true }),
      fs.rm(outputPath, { force: true }),
    ]);
  }
}
