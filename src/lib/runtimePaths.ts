import path from "path";

function isElectronRuntime(): boolean {
  return typeof process.versions?.electron !== "undefined";
}

function getUserDataDir(): string {
  if (!isElectronRuntime()) return process.cwd();
  const { app } = require("electron");
  return app.getPath("userData");
}

function isPackagedElectron(): boolean {
  if (!isElectronRuntime()) return false;
  const { app } = require("electron");
  return Boolean(app?.isPackaged);
}

function isWindowsAbsolutePath(input: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(input) || /^\\\\/.test(input);
}

function normalizeCrossPlatformPath(input: string): string {
  if (!isWindowsAbsolutePath(input) || process.platform === "win32") return input;
  const isWsl = process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP || process.env.WSLENV);
  if (!isWsl) return input;
  const normalized = input.replace(/\\/g, "/");
  const driveMatch = normalized.match(/^([a-zA-Z]):\/(.*)$/);
  if (!driveMatch) return input;
  return `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2]}`;
}

function resolveConfiguredPath(rawValue: string | undefined, fallback: string): string {
  const value = (rawValue || "").trim().replace(/^['"]|['"]$/g, "");
  if (!value) return fallback;
  const normalized = normalizeCrossPlatformPath(value);
  if (path.isAbsolute(normalized) || isWindowsAbsolutePath(normalized)) {
    return normalized;
  }
  return path.resolve(process.cwd(), normalized);
}

export function getDbPath(): string {
  const fallback = isElectronRuntime()
    ? path.join(getUserDataDir(), "Toonflow-game/db.sqlite")
    : path.join(process.cwd(), "Toonflow-game/db.sqlite");
  return resolveConfiguredPath(process.env.DB_PATH, fallback);
}

export function getUploadRootDir(): string {
  const fallback = isElectronRuntime()
    ? path.join(getUserDataDir(), "Toonflow-game/uploads")
    : path.join(process.cwd(), "Toonflow-game/uploads");
  return resolveConfiguredPath(process.env.UPLOAD_DIR, fallback);
}

export function getLocalToolRootDir(): string {
  const fallback = isElectronRuntime()
    ? path.join(getUserDataDir(), "Toonflow-game/tools")
    : path.join(process.cwd(), "Toonflow-game/tools");
  return resolveConfiguredPath(process.env.LOCAL_TOOL_DIR, fallback);
}

export function getVoicePresetSeedDir(): string {
  const baseDir = isPackagedElectron()
    ? process.resourcesPath
    : process.cwd();
  return path.join(baseDir, "res", "voice-presets");
}

export function getTmpDebugRevisitDir(): string {
  const fallback = isElectronRuntime()
    ? path.join(getUserDataDir(), "Toonflow-game/tmp/debug-revisit")
    : path.join(process.cwd(), "Toonflow-game/tmp/debug-revisit");
  return fallback;
}
