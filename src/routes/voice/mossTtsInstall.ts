import express from "express";
import fsp from "node:fs/promises";
import path from "node:path";
import { success, error } from "@/lib/responseFormat";
import { getMossTtsInstallStatus, installMossTts, cancelInstall, resetInstallState } from "@/lib/localMossTts";
import { DebugLogUtil } from "@/utils/debugLogUtil";

async function routeFileLog(...args: unknown[]): Promise<void> {
  try {
    const logPath = path.join(process.cwd(), "Toonflow-game/tools/moss-tts-nano/install-debug.log");
    const logDir = path.dirname(logPath);
    await fsp.mkdir(logDir, { recursive: true });
    const line = `[${new Date().toISOString()}] ` + args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ") + "\n";
    await fsp.appendFile(logPath, line, "utf8");
  } catch { /* noop */ }
}

const router = express.Router();

// 获取安装状态
router.post("/status", async (_req, res) => {
  try {
    const status = await getMossTtsInstallStatus();
    return res.status(200).send(success(status));
  } catch (err) {
    return res.status(500).send(error((err as Error)?.message || "获取安装状态失败"));
  }
});

// 触发安装
router.post("/install", async (req, res) => {
  try {
    await routeFileLog("[route] install 请求到达");
    if (DebugLogUtil.isDebugLogEnabled()) {
      console.log("[moss-tts] install start");
    }

    const status = await getMossTtsInstallStatus();
    await routeFileLog("[route] install status:", JSON.stringify(status));
    if (DebugLogUtil.isDebugLogEnabled()) {
      console.log("[moss-tts] install status", JSON.stringify(status));
    }
    if (status.status === "installed") {
      return res.status(200).send(success({ ...status, message: "已安装，无需重复安装" }));
    }
    if (status.status === "installing") {
      return res.status(200).send(success({ ...status, message: "正在安装中..." }));
    }
    // 启动异步安装
    installMossTts((msg) => {
      // onProgress 回调暂时通过轮询 /status 接口获取
      routeFileLog(`[moss-tts-install] progress: ${msg}`);
      if (DebugLogUtil.isDebugLogEnabled()) {
        console.log(`[moss-tts-install] ${msg}`);
      }
    }).catch(async (err) => {
      await routeFileLog("[route] installMossTts 抛出异常:", err instanceof Error ? err.message : String(err), err?.stack || "");
      console.error("[moss-tts-install] async install failed:", err);
    });
    await routeFileLog("[route] installMossTts 已调用，返回 installing");
    return res.status(200).send(success({
      ...status,
      status: "installing",
      message: "正在安装 MOSS-TTS-Nano，请稍候...",
    }));
  } catch (err) {
    await routeFileLog("[route] install 路由 catch:", err instanceof Error ? err.message : String(err));
    return res.status(500).send(error((err as Error)?.message || "安装失败"));
  }
});

// 停止安装
router.post("/stop", async (_req, res) => {
  try {
    await routeFileLog("[route] stop 请求到达");
    await cancelInstall();
    const status = await getMossTtsInstallStatus();
    await routeFileLog("[route] stop 完成, status:", JSON.stringify(status));
    return res.status(200).send(success({ ...status, message: "已停止安装" }));
  } catch (err) {
    await routeFileLog("[route] stop 路由 catch:", err instanceof Error ? err.message : String(err));
    return res.status(500).send(error((err as Error)?.message || "停止安装失败"));
  }
});

// 清除安装状态
router.post("/reset", async (_req, res) => {
  try {
    await routeFileLog("[route] reset 请求到达");
    await resetInstallState();
    const status = await getMossTtsInstallStatus();
    await routeFileLog("[route] reset 完成, status:", JSON.stringify(status));
    return res.status(200).send(success({ ...status, message: "安装状态已清除" }));
  } catch (err) {
    await routeFileLog("[route] reset 路由 catch:", err instanceof Error ? err.message : String(err));
    return res.status(500).send(error((err as Error)?.message || "清除安装状态失败"));
  }
});

export default router;