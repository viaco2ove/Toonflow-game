import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import path from "path";

// 默认环境变量（当 env 文件不存在时自动创建）
const defaultEnvValues: Record<string, string> = {
  dev: `NODE_ENV=dev\nPORT=60002\nOSSURL=http://127.0.0.1:60002/\nDB_PATH=\nUPLOAD_DIR=\nAI_VIDEO_DEBUG=0\nAI_VIDEO_POLL_MAX_ATTEMPTS=500\nAI_VIDEO_POLL_INTERVAL_MS=2000\nLOG_LEVEL=INFO\nTEST_MODEL_TIMEOUT_MS=180000\nDEBUG_AI_TEXT=0\nDEBUG_AI_TEXT_VERBOSE=0\nAI_TEXT_DEBUG_HTTP=0\nAI_TEXT_DEBUG_HTTP_AUTO=1\nAI_TEXT_DEBUG_HTTP_VERBOSE=0`,
  local: `NODE_ENV=local\nPORT=60002\nOSSURL=http://127.0.0.1:60002/\nDB_PATH=\nUPLOAD_DIR=\nAI_VIDEO_DEBUG=0\nAI_VIDEO_POLL_MAX_ATTEMPTS=500\nAI_VIDEO_POLL_INTERVAL_MS=2000\nLOG_LEVEL=INFO\nTEST_MODEL_TIMEOUT_MS=180000\nDEBUG_AI_TEXT=0\nDEBUG_AI_TEXT_VERBOSE=0\nAI_TEXT_DEBUG_HTTP=0\nAI_TEXT_DEBUG_HTTP_AUTO=1\nAI_TEXT_DEBUG_HTTP_VERBOSE=0`,
  prod: `NODE_ENV=prod\nPORT=60002\nOSSURL=http://127.0.0.1:60002/\nDB_PATH=\nUPLOAD_DIR=\nAI_VIDEO_DEBUG=0\nAI_VIDEO_POLL_MAX_ATTEMPTS=500\nAI_VIDEO_POLL_INTERVAL_MS=2000\nLOG_LEVEL=INFO\nTEST_MODEL_TIMEOUT_MS=180000\nDEBUG_AI_TEXT=0\nDEBUG_AI_TEXT_VERBOSE=0\nAI_TEXT_DEBUG_HTTP=0\nAI_TEXT_DEBUG_HTTP_AUTO=1\nAI_TEXT_DEBUG_HTTP_VERBOSE=0`,
};

// 判断是否为打包后的 Electron 环境
const isElectron = typeof process.versions?.electron !== "undefined";
let isPackaged = false;
if (isElectron) {
  const { app } = require("electron");
  isPackaged = app.isPackaged;
}

function resolveEnvDir(currentEnv: string): string {
  const projectEnvDir = path.resolve("env");
  if (!isElectron) return projectEnvDir;

  const { app } = require("electron");
  const userDataEnvDir = path.join(app.getPath("userData"), "env");
  if (isPackaged) return userDataEnvDir;

  // 本地开发（含 local）优先使用项目根目录 env，若不存在再回退到 userData/env
  const projectEnvFile = path.join(projectEnvDir, `.env.${currentEnv}`);
  const userDataEnvFile = path.join(userDataEnvDir, `.env.${currentEnv}`);
  if (existsSync(projectEnvFile)) return projectEnvDir;
  if (existsSync(userDataEnvFile)) return userDataEnvDir;
  return projectEnvDir;
}

function resolveDefaultNodeEnv(): string {
  if (isPackaged) return "prod";
  const entryFile = String(process.argv[1] || "").trim();
  if (!entryFile) return "dev";
  const normalizedEntry = entryFile.replace(/\\/g, "/");
  if (normalizedEntry.endsWith("/build/app.js") || normalizedEntry.endsWith("/build/main.js")) {
    return "prod";
  }
  return "dev";
}

//加载环境变量（打包环境默认使用 prod）
const env = process.env.NODE_ENV ?? resolveDefaultNodeEnv();
if (!env) {
  console.log("[env] empty NODE_ENV");
  process.exit(1);
} else {
  const envDir = resolveEnvDir(env);
  const envFilePath = path.join(envDir, `.env.${env}`);

  // 自动创建 env 目录和文件（.gitignore 可能忽略了这些文件）
  if (!existsSync(envDir)) {
    mkdirSync(envDir, { recursive: true });
  }
  if (!existsSync(envFilePath)) {
    const content = defaultEnvValues[env] ?? defaultEnvValues.prod;
    writeFileSync(envFilePath, content, "utf8");
    console.log(`[env] created ${envFilePath}`);
  }

  let text = readFileSync(envFilePath, "utf8");

  // 历史配置文件补齐新字段（保持向后兼容）
  const requiredKeys: Array<{ key: string; value: string }> = [
    { key: "PORT", value: "60002" },
    { key: "OSSURL", value: "http://127.0.0.1:60002/" },
    { key: "DB_PATH", value: "" },
    { key: "UPLOAD_DIR", value: "" },
    { key: "AI_VIDEO_DEBUG", value: "0" },
    { key: "AI_VIDEO_POLL_MAX_ATTEMPTS", value: "500" },
    { key: "AI_VIDEO_POLL_INTERVAL_MS", value: "2000" },
    { key: "LOG_LEVEL", value: "INFO" },
    { key: "TEST_MODEL_TIMEOUT_MS", value: "180000" },
    { key: "DEBUG_AI_TEXT", value: "0" },
    { key: "DEBUG_AI_TEXT_VERBOSE", value: "0" },
    { key: "AI_TEXT_DEBUG_HTTP", value: "0" },
    { key: "AI_TEXT_DEBUG_HTTP_AUTO", value: "1" },
    { key: "AI_TEXT_DEBUG_HTTP_VERBOSE", value: "0" },
  ];
  const missing = requiredKeys.filter((item) => !new RegExp(`^\\s*${item.key}=`, "m").test(text));
  if (missing.length > 0) {
    const suffix = missing.map((item) => `${item.key}=${item.value}`).join("\n");
    text = `${text.trimEnd()}\n${suffix}\n`;
    writeFileSync(envFilePath, text, "utf8");
  }

  for (const line of text.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      const current = process.env[key];
      // 默认以 env 文件为准；仅当显式开启 PREFER_PROCESS_ENV=1 时，保留外部注入值
      const preserveProcessEnv = (process.env.PREFER_PROCESS_ENV || "").trim() === "1";
      if (!preserveProcessEnv || typeof current === "undefined" || current === "") {
        process.env[key] = value;
      }
    }
  }
  console.log(`[env] ${env}`);
  console.log(`[env] file ${envFilePath}`);
}
