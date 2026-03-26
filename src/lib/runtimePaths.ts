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

function resolveConfiguredPath(rawValue: string | undefined, fallback: string): string {
  const value = (rawValue || "").trim().replace(/^['"]|['"]$/g, "");
  if (!value) return fallback;
  if (path.isAbsolute(value) || isWindowsAbsolutePath(value)) {
    return value;
  }
  return path.resolve(process.cwd(), value);
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

export function getVoicePresetSeedDir(): string {
  const baseDir = isPackagedElectron()
    ? process.resourcesPath
    : process.cwd();
  return path.join(baseDir, "res", "voice-presets");
}
