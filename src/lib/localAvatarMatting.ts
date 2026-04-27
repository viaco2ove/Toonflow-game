import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import axios from "axios";
import { getLocalToolRootDir } from "@/lib/runtimePaths";

export const LOCAL_BIREFNET_MANUFACTURER = "local_birefnet";
export const LOCAL_MODNET_MANUFACTURER = "local_modnet";
export const LOCAL_BIREFNET_DEFAULT_MODEL = "birefnet-portrait";
export const LOCAL_MODNET_DEFAULT_MODEL = "modnet-photographic-portrait";

const LOCAL_BIREFNET_SUPPORTED_MODELS = new Set([
  "birefnet-portrait",
  "birefnet-general",
  "birefnet-general-lite",
]);
const LOCAL_MODNET_SUPPORTED_MODELS = new Set([
  LOCAL_MODNET_DEFAULT_MODEL,
]);
const LOCAL_BIREFNET_INSTALL_VERSION = 2;
const LOCAL_BIREFNET_REMBG_VERSION = "2.0.67";
const LOCAL_BIREFNET_ONNXRUNTIME_VERSION = "1.22.1";
const LOCAL_MODNET_HUGGINGFACE_DOWNLOAD_URL = "https://huggingface.co/DavG25/modnet-pretrained-models/resolve/main/models/modnet_photographic_portrait_matting.onnx";
const LOCAL_MODNET_ONNX_DOWNLOAD_URL = "https://drive.google.com/uc?id=1cgycTQlYXpTh26gB9FTnthE7AvruV8hd&export=download";
const LOCAL_MODNET_ONNX_FILE_NAME = "modnet_photographic_portrait_matting.onnx";

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
  manufacturer: typeof LOCAL_BIREFNET_MANUFACTURER | typeof LOCAL_MODNET_MANUFACTURER;
  model: string;
  status: LocalInstallStatusKind;
  installed: boolean;
  canInstall: boolean;
  message: string;
};

let activeBiRefNetInstallPromise: Promise<LocalAvatarMattingStatus> | null = null;
let activeBiRefNetInstallMessage = "";

/**
 * 判断当前模型是否属于 MODNet 家族。
 * 这里额外兼容下划线和旧命名，避免已有配置因为模型名格式不同而失效。
 */
function isLocalModNetModelName(input?: string | null): boolean {
  const normalized = String(input || "").trim().toLowerCase();
  return normalized === LOCAL_MODNET_DEFAULT_MODEL
    || normalized === "modnet_photographic_portrait_matting"
    || normalized === LOCAL_MODNET_ONNX_FILE_NAME.replace(/\.onnx$/i, "");
}

/**
 * 统一输出本地头像分离模型的人类可读名称，方便安装状态和错误提示直接复用。
 */
function localAvatarMattingModelLabel(model?: string | null): string {
  return isLocalModNetModelName(model) ? "MODNet" : "BiRefNet";
}

/**
 * 统一归一化本地头像分离厂商 key。
 * 旧数据仍可能继续传 local_birefnet；新增的 local_modnet 只用于选择独立的 MODNet 入口。
 */
function resolveLocalAvatarMattingManufacturer(input?: string | null): string {
  const normalized = String(input || "").trim().toLowerCase();
  if (normalized === LOCAL_MODNET_MANUFACTURER) return LOCAL_MODNET_MANUFACTURER;
  return LOCAL_BIREFNET_MANUFACTURER;
}

function getBiRefNetRootDir(): string {
  return path.join(getLocalToolRootDir(), "avatar-matting", "birefnet");
}

function getBiRefNetVenvDir(): string {
  return path.join(getBiRefNetRootDir(), "venv");
}

function getBiRefNetRunnerScriptPath(): string {
  return path.join(getBiRefNetRootDir(), "run_birefnet.py");
}

/**
 * 获取 MODNet 的本地推理脚本路径。
 * 该脚本使用 onnxruntime 直接执行官方 ONNX 模型，不依赖 rembg 的模型注册表。
 */
function getModNetRunnerScriptPath(): string {
  return path.join(getBiRefNetRootDir(), "run_modnet.py");
}

function getBiRefNetStateFilePath(): string {
  return path.join(getBiRefNetRootDir(), "install-state.json");
}

function getBiRefNetCacheDir(): string {
  return path.join(getBiRefNetRootDir(), "model-cache");
}

/**
 * 获取本地 MODNet 模型文件路径。
 * 当前固定使用官方 photographic portrait matting ONNX 权重。
 */
function getModNetModelPath(): string {
  return path.join(getBiRefNetCacheDir(), LOCAL_MODNET_ONNX_FILE_NAME);
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
  if (LOCAL_MODNET_SUPPORTED_MODELS.has(normalized) || normalized.startsWith("modnet")) return LOCAL_MODNET_DEFAULT_MODEL;
  if (normalized.startsWith("birefnet-")) return normalized;
  return LOCAL_BIREFNET_DEFAULT_MODEL;
}

/**
 * 根据厂商自动补足默认模型，避免拆成两个厂商后还要用户手输模型名。
 */
function resolveLocalAvatarMattingModelByManufacturer(manufacturer: string, input?: string | null): string {
  const normalized = String(input || "").trim().toLowerCase();
  if (resolveLocalAvatarMattingManufacturer(manufacturer) === LOCAL_MODNET_MANUFACTURER) {
    return isLocalModNetModelName(normalized) ? LOCAL_MODNET_DEFAULT_MODEL : LOCAL_MODNET_DEFAULT_MODEL;
  }
  return resolveLocalBiRefNetModelName(normalized);
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

/**
 * 通过 Node 侧直连下载模型文件。
 * 这里优先使用公开直链，避免把安装流程绑死在 gdown / Google Drive 上。
 */
async function downloadFileFromUrl(url: string, targetPath: string): Promise<void> {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 300000,
    maxRedirects: 5,
  });
  await fs.writeFile(targetPath, Buffer.from(response.data));
}

/**
 * 下载 MODNet 模型文件，并按顺序尝试多个镜像源。
 * 只要某个源可达就直接落盘，避免单一源超时导致整个安装失败。
 */
async function downloadModNetModelFile(): Promise<void> {
  const targetPath = getModNetModelPath();
  const sources = [
    {
      label: "Hugging Face",
      url: LOCAL_MODNET_HUGGINGFACE_DOWNLOAD_URL,
      fetch: async () => {
        await downloadFileFromUrl(LOCAL_MODNET_HUGGINGFACE_DOWNLOAD_URL, targetPath);
      },
    },
    {
      label: "Google Drive",
      url: LOCAL_MODNET_ONNX_DOWNLOAD_URL,
      fetch: async () => {
        await downloadFileFromUrl(LOCAL_MODNET_ONNX_DOWNLOAD_URL, targetPath);
      },
    },
  ] as const;
  const errors: string[] = [];
  for (const source of sources) {
    try {
      await source.fetch();
      return;
    } catch (err) {
      errors.push(`${source.label}: ${err instanceof Error ? err.message : String(err || "下载失败")}`);
    }
  }
  throw new Error(`MODNet 模型下载失败。\n${errors.join("\n")}`.trim());
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

/**
 * 格式化本地命令失败信息，保留退出码和最近的 stdout/stderr，便于排查 Python 子进程失败原因。
 */
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
      reject(new Error(formatCommandError(command, args, stdout, stderr, code)));
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

/**
 * 生成 MODNet 的本地推理脚本。
 * 这里沿用官方 ONNX demo 的预处理/后处理逻辑，并输出 alpha matte PNG，后续仍复用现有前景/背景层构建链路。
 */
async function ensureModNetRunnerScript(): Promise<void> {
  const script = [
    "import argparse",
    "import json",
    "from pathlib import Path",
    "",
    "import numpy as np",
    "from PIL import Image",
    "import onnxruntime",
    "",
    "REF_SIZE = 512",
    "",
    "def compute_scale(im_h, im_w, ref_size):",
    "    if max(im_h, im_w) < ref_size or min(im_h, im_w) > ref_size:",
    "        if im_w >= im_h:",
    "            im_rh = ref_size",
    "            im_rw = int(im_w / im_h * ref_size)",
    "        else:",
    "            im_rw = ref_size",
    "            im_rh = int(im_h / im_w * ref_size)",
    "    else:",
    "        im_rh = im_h",
    "        im_rw = im_w",
    "    im_rw = max(32, im_rw - im_rw % 32)",
    "    im_rh = max(32, im_rh - im_rh % 32)",
    "    return im_rw / im_w, im_rh / im_h",
    "",
    "def prepare_input(image_path):",
    "    image = Image.open(image_path).convert('RGB')",
    "    im = np.asarray(image).astype(np.float32)",
    "    im = (im - 127.5) / 127.5",
    "    im_h, im_w, _ = im.shape",
    "    x_scale, y_scale = compute_scale(im_h, im_w, REF_SIZE)",
    "    resized = Image.fromarray(np.clip((im * 127.5) + 127.5, 0, 255).astype(np.uint8)).resize((",
    "        max(32, int(round(im_w * x_scale / 32.0) * 32)),",
    "        max(32, int(round(im_h * y_scale / 32.0) * 32)),",
    "    ), Image.Resampling.BILINEAR)",
    "    normalized = (np.asarray(resized).astype(np.float32) - 127.5) / 127.5",
    "    tensor = np.transpose(normalized, (2, 0, 1))",
    "    tensor = np.expand_dims(tensor, axis=0).astype('float32')",
    "    return tensor, im_w, im_h",
    "",
    "def run_inference(session, tensor):",
    "    input_name = session.get_inputs()[0].name",
    "    output_name = session.get_outputs()[0].name",
    "    result = session.run([output_name], {input_name: tensor})",
    "    return np.squeeze(result[0])",
    "",
    "def save_matte(matte, output_path, width, height):",
    "    matte = np.clip(matte * 255.0, 0, 255).astype('uint8')",
    "    output = Image.fromarray(matte, mode='L').resize((width, height), Image.Resampling.BILINEAR)",
    "    output.save(output_path)",
    "",
    "def main():",
    "    parser = argparse.ArgumentParser()",
    "    parser.add_argument('--input', default='')",
    "    parser.add_argument('--output', default='')",
    "    parser.add_argument('--model-path', default='')",
    "    parser.add_argument('--warmup', action='store_true')",
    "    args = parser.parse_args()",
    "",
    "    model_path = Path(args.model_path)",
    "    if not model_path.exists():",
    "        raise FileNotFoundError(str(model_path))",
    "",
    "    session = onnxruntime.InferenceSession(str(model_path), None)",
    "    if args.warmup:",
    "        print(json.dumps({'ok': True, 'model_path': str(model_path)}))",
    "        return",
    "",
    "    input_path = Path(args.input)",
    "    output_path = Path(args.output)",
    "    if not input_path.exists():",
    "        raise FileNotFoundError(str(input_path))",
    "",
    "    tensor, width, height = prepare_input(input_path)",
    "    matte = run_inference(session, tensor)",
    "    output_path.parent.mkdir(parents=True, exist_ok=True)",
    "    save_matte(matte, output_path, width, height)",
    "    print(json.dumps({'ok': True, 'output': str(output_path)}))",
    "",
    "if __name__ == '__main__':",
    "    main()",
    "",
  ].join("\n");
  await ensureDir(getBiRefNetRootDir());
  await fs.writeFile(getModNetRunnerScriptPath(), script, "utf8");
}

/**
 * 判断旧的本地 BiRefNet 运行环境是否已经可用。
 * 这里必须兼容历史 version=1 安装态，避免“只想继续用 BiRefNet，却被新版本强制重装”的回归问题。
 */
async function hasLocalBiRefNetBaseRuntime(): Promise<boolean> {
  const state = await readInstallState();
  if (state?.status !== "installed") return false;
  const hasPython = await fileExists(getManagedBiRefNetPythonPath());
  const hasBiRefNetRunner = await fileExists(getBiRefNetRunnerScriptPath());
  return hasPython && hasBiRefNetRunner;
}

/**
 * 判断 MODNet 的额外运行资源是否齐全。
 * MODNet 在共享 Python 环境的基础上，还需要单独的 ONNX runner 和模型权重文件。
 */
async function hasLocalModNetRuntime(): Promise<boolean> {
  const hasBaseRuntime = await hasLocalBiRefNetBaseRuntime();
  if (!hasBaseRuntime) return false;
  const hasModNetRunner = await fileExists(getModNetRunnerScriptPath());
  const hasModNetModel = await fileExists(getModNetModelPath());
  return hasModNetRunner && hasModNetModel;
}

/**
 * 按具体模型判断本地头像分离能力是否可直接使用。
 * BiRefNet 和 MODNet 共用同一个厂商 key，但安装依赖不同，不能再粗暴共用一个“已安装”布尔值。
 */
async function isLocalAvatarMattingModelReady(model: string): Promise<boolean> {
  if (isLocalModNetModelName(model)) {
    return await hasLocalModNetRuntime();
  }
  return await hasLocalBiRefNetBaseRuntime();
}

function buildStatus(
  manufacturer: string,
  model: string,
  status: LocalInstallStatusKind,
  message: string,
  canInstall: boolean,
): LocalAvatarMattingStatus {
  return {
    manufacturer: resolveLocalAvatarMattingManufacturer(manufacturer) as typeof LOCAL_BIREFNET_MANUFACTURER | typeof LOCAL_MODNET_MANUFACTURER,
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
  const manufacturer = resolveLocalAvatarMattingManufacturer(input?.manufacturer);
  if (manufacturer !== LOCAL_BIREFNET_MANUFACTURER && manufacturer !== LOCAL_MODNET_MANUFACTURER) {
    throw new Error("当前仅支持本地头像分离模型安装状态查询");
  }
  const model = resolveLocalAvatarMattingModelByManufacturer(manufacturer, input?.model);
  const launcher = await resolveSystemPythonLauncher();
  const canInstall = !!launcher;
  const modelLabel = localAvatarMattingModelLabel(model);

  if (activeBiRefNetInstallPromise) {
    return buildStatus(manufacturer, model, "installing", activeBiRefNetInstallMessage || `本地 ${modelLabel} 安装中`, canInstall);
  }
  if (await isLocalAvatarMattingModelReady(model)) {
    return buildStatus(manufacturer, model, "installed", `本地 ${modelLabel} 已安装，可直接使用`, canInstall);
  }

  if (isLocalModNetModelName(model) && await hasLocalBiRefNetBaseRuntime()) {
    return buildStatus(manufacturer, model, "not_installed", "BiRefNet 本地环境已安装；如需使用 MODNet，请补装 MODNet 模型文件", canInstall);
  }

  const state = await readInstallState();
  if (state?.status === "failed") {
    return buildStatus(manufacturer, model, "failed", state.message || state.lastError || `本地 ${modelLabel} 安装失败，请重试`, canInstall);
  }
  if (!canInstall) {
    return buildStatus(manufacturer, model, "not_installed", `未检测到可用 Python 3，无法安装本地 ${modelLabel}`, false);
  }
  if (state?.status === "installing") {
    return buildStatus(manufacturer, model, "installing", state.message || `本地 ${modelLabel} 安装中`, true);
  }
  return buildStatus(manufacturer, model, "not_installed", `首次使用需要安装 Python 依赖和 ${modelLabel} 模型文件`, true);
}

async function runManagedBiRefNetPython(args: string[], options: RunCommandOptions = {}): Promise<{ stdout: string; stderr: string }> {
  if (!await fileExists(getManagedBiRefNetPythonPath())) {
    throw new Error("本地头像分离模型尚未安装，请先完成安装");
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
  const manufacturer = resolveLocalAvatarMattingManufacturer(input?.manufacturer);
  if (manufacturer !== LOCAL_BIREFNET_MANUFACTURER && manufacturer !== LOCAL_MODNET_MANUFACTURER) {
    throw new Error("当前仅支持安装本地头像分离模型");
  }
  const model = resolveLocalAvatarMattingModelByManufacturer(manufacturer, input?.model);
  const modelLabel = localAvatarMattingModelLabel(model);

  if (activeBiRefNetInstallPromise) {
    return await activeBiRefNetInstallPromise;
  }
  if (await isLocalAvatarMattingModelReady(model)) {
    return buildStatus(manufacturer, model, "installed", `本地 ${modelLabel} 已安装，可直接使用`, true);
  }

  activeBiRefNetInstallPromise = (async () => {
    const launcher = await resolveSystemPythonLauncher();
    if (!launcher) {
      throw new Error(`未检测到可用 Python 3，无法安装本地 ${modelLabel}`);
    }
    const hasBaseRuntime = await hasLocalBiRefNetBaseRuntime();

    activeBiRefNetInstallMessage = `正在准备本地 ${modelLabel} 环境`;
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

      if (!hasBaseRuntime) {
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
      }

      await ensureBiRefNetRunnerScript();
      await ensureModNetRunnerScript();

      if (!hasBaseRuntime || isLocalModNetModelName(model)) {
        activeBiRefNetInstallMessage = "正在安装本地头像分离依赖";
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
        "numpy",
      ], {
        timeoutMs: 1800000,
      });
      }

      if (isLocalModNetModelName(model)) {
        activeBiRefNetInstallMessage = "正在下载本地 MODNet 模型文件";
        await writeInstallState({
          status: "installing",
          message: activeBiRefNetInstallMessage,
          updatedAt: Date.now(),
          model,
          pythonLauncher: launcher.label,
          version: LOCAL_BIREFNET_INSTALL_VERSION,
        });
        await downloadModNetModelFile();
        activeBiRefNetInstallMessage = "正在预热本地 MODNet 模型";
        await writeInstallState({
          status: "installing",
          message: activeBiRefNetInstallMessage,
          updatedAt: Date.now(),
          model,
          pythonLauncher: launcher.label,
          version: LOCAL_BIREFNET_INSTALL_VERSION,
        });
        await runManagedBiRefNetPython([
          getModNetRunnerScriptPath(),
          "--warmup",
          "--model-path",
          getModNetModelPath(),
        ], {
          timeoutMs: 900000,
        });
      } else {
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
      }

      const status = buildStatus(manufacturer, model, "installed", `本地 ${modelLabel} 已安装，可直接使用`, true);
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
      const message = err instanceof Error ? err.message : String(err || `本地 ${modelLabel} 安装失败`);
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
    throw new Error(status.message || `本地 ${localAvatarMattingModelLabel(resolvedModel)} 尚未安装`);
  }

  await ensureDir(getBiRefNetWorkDir());
  const workToken = randomUUID();
  const inputPath = path.join(getBiRefNetWorkDir(), `${workToken}_input.png`);
  const outputPath = path.join(getBiRefNetWorkDir(), `${workToken}_output.png`);
  try {
    await fs.writeFile(inputPath, input);
    if (isLocalModNetModelName(resolvedModel)) {
      await runManagedBiRefNetPython([
        getModNetRunnerScriptPath(),
        "--model-path",
        getModNetModelPath(),
        "--input",
        inputPath,
        "--output",
        outputPath,
      ], {
        timeoutMs: 900000,
      });
    } else {
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
    }
    return await fs.readFile(outputPath);
  } finally {
    await Promise.allSettled([
      fs.rm(inputPath, { force: true }),
      fs.rm(outputPath, { force: true }),
    ]);
  }
}
