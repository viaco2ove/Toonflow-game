import express from "express";
import fsp from "node:fs/promises";
import path from "node:path";
import { success, error } from "@/lib/responseFormat";
import { getQwen060InstallStatus, installQwen060, cancelInstall, resetInstallState } from "@/lib/localQwen060";
import { DebugLogUtil } from "@/utils/debugLogUtil";

const ROOT = path.join(process.cwd(), "Toonflow-game/tools/qwen3-0.6b");

async function routeFileLog(...args: unknown[]): Promise<void> {
  try {
    const logPath = path.join(ROOT, "install-debug.log");
    await fsp.mkdir(path.dirname(logPath), { recursive: true });
    const line = `[${new Date().toISOString()}] ` + args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ") + "\n";
    await fsp.appendFile(logPath, line, "utf8");
  } catch { /* noop */ }
}

const router = express.Router();

router.post("/status", async (_req, res) => {
  try {
    const status = await getQwen060InstallStatus();
    res.status(200).send(success(status));
  } catch (err) {
    res.status(500).send(error((err as Error)?.message || "获取安装状态失败"));
  }
});

router.post("/install", async (req, res) => {
  try {
    await routeFileLog("[route] install 请求到达");
    if (DebugLogUtil.isDebugLogEnabled()) {
      console.log("[qwen3-0.6b] install start");
    }
    const status = await getQwen060InstallStatus();
    await routeFileLog("[route] install status:", JSON.stringify(status));
    const reinstall = String(req.body?.reinstall || req.query?.reinstall || "").trim() === "true";
    if (status.status === "installed" && !reinstall) {
      res.status(200).send(success({ ...status, message: "已安装，无需重复安装" }));
      return;
    }
    if (status.status === "installing" && !reinstall) {
      res.status(200).send(success({ ...status, message: "正在安装中..." }));
      return;
    }
    installQwen060((msg) => {
      routeFileLog("[qwen3-0.6b-install] progress:", msg);
      if (DebugLogUtil.isDebugLogEnabled()) {
        console.log("[qwen3-0.6b-install]", msg);
      }
    }).catch(async (err) => {
      await routeFileLog("[route] install 异常:", err instanceof Error ? err.message : String(err));
      console.error("[qwen3-0.6b-install] async install failed:", err);
    });
    res.status(200).send(success({ ...status, status: "installing", message: "正在安装 Qwen3-0.6B，请稍候..." }));
  } catch (err) {
    await routeFileLog("[route] install catch:", err instanceof Error ? err.message : String(err));
    res.status(500).send(error((err as Error)?.message || "安装失败"));
  }
});

router.post("/stop", async (_req, res) => {
  try {
    await routeFileLog("[route] stop 请求到达");
    await cancelInstall();
    const status = await getQwen060InstallStatus();
    res.status(200).send(success({ ...status, message: "已停止安装" }));
  } catch (err) {
    res.status(500).send(error((err as Error)?.message || "停止安装失败"));
  }
});

router.post("/reset", async (_req, res) => {
  try {
    await routeFileLog("[route] reset 请求到达");
    await resetInstallState();
    const status = await getQwen060InstallStatus();
    res.status(200).send(success({ ...status, message: "安装状态已清除" }));
  } catch (err) {
    res.status(500).send(error((err as Error)?.message || "清除安装状态失败"));
  }
});

export default router;