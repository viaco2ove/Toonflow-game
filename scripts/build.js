const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

// 打包默认使用 prod 环境变量。
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "prod";
}

// 自动创建 env 目录和环境变量文件，避免首次构建时缺少配置文件。
const envDir = path.resolve("env");
const envFile = path.join(envDir, `.env.${process.env.NODE_ENV}`);
if (!fs.existsSync(envDir)) {
  fs.mkdirSync(envDir, { recursive: true });
}
if (!fs.existsSync(envFile)) {
  const defaultEnv =
    process.env.NODE_ENV === "prod"
      ? "NODE_ENV=prod\nPREFER_PROCESS_ENV=1\nPORT=60002\nOSSURL=http://127.0.0.1:60002/\nDB_PATH=\nUPLOAD_DIR=\nLOG_PATH=\n"
      : `NODE_ENV=${process.env.NODE_ENV}\nPORT=60002\nOSSURL=http://127.0.0.1:60002/\n`;
  fs.writeFileSync(envFile, defaultEnv, "utf8");
  console.log(`已自动创建环境变量文件: ${envFile}`);
}

const external = ["electron", "sqlite3", "better-sqlite3", "mysql", "mysql2", "pg", "pg-query-stream", "oracledb", "tedious", "mssql"];

/**
 * 构建后端服务入口。
 * 这里输出运行时需要的 Node 端 bundle。
 */
const appBuildConfig = {
  entryPoints: ["src/app.ts"],
  bundle: true,
  minify: false,
  format: "cjs",
  allowOverwrite: true,
  outfile: "build/app.js",
  platform: "node",
  target: "esnext",
  tsconfig: "./tsconfig.json",
  alias: {
    "@": "./src",
  },
  sourcemap: false,
  external,
};

/**
 * 构建 Electron 主进程入口。
 * 桌面版发布仍然依赖这个输出文件。
 */
const mainBuildConfig = {
  entryPoints: ["scripts/main.ts"],
  bundle: true,
  minify: false,
  format: "cjs",
  outfile: "build/main.js",
  allowOverwrite: true,
  platform: "node",
  target: "esnext",
  tsconfig: "./tsconfig.json",
  alias: {
    "@": "./src",
  },
  sourcemap: false,
  external,
};

async function buildAll() {
  try {
    console.log("开始构建...\n");

    // 顺序构建更稳，避免低资源服务器上 esbuild 子进程异常退出。
    await esbuild.build(appBuildConfig);
    await esbuild.build(mainBuildConfig);

    console.log("后端服务构建完成: build/app.js");
    console.log("Electron主进程构建完成: build/main.js");
    console.log("\n所有构建任务完成\n");
  } catch (error) {
    console.error("构建失败:", error);
    process.exit(1);
  }
}

buildAll();
