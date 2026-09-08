import express from "express";
import { success, error } from "@/lib/responseFormat";
import { getEmbedInstallStatus, installEmbed, cancelInstall, resetInstallState } from "@/lib/localEmbed";
import { DebugLogUtil } from "@/utils/debugLogUtil";

const router = express.Router();

router.post("/status", async (_req, res) => {
  try {
    const status = await getEmbedInstallStatus();
    res.status(200).send(success(status));
  } catch (err) {
    res.status(500).send(error((err as Error)?.message || "获取安装状态失败"));
  }
});

router.post("/install", async (req, res) => {
  try {
    if (DebugLogUtil.isDebugLogEnabled()) {
      console.log("[m3e-small] install start");
    }
    const status = await getEmbedInstallStatus();
    const reinstall = String(req.body?.reinstall || req.query?.reinstall || "").trim() === "true";
    if (status.status === "installed" && !reinstall) {
      res.status(200).send(success({ ...status, message: "已安装，无需重复安装" }));
      return;
    }
    if (status.status === "installing" && !reinstall) {
      res.status(200).send(success({ ...status, message: "正在安装中..." }));
      return;
    }
    installEmbed((msg) => {
      if (DebugLogUtil.isDebugLogEnabled()) {
        console.log("[m3e-small-install]", msg);
      }
    }).catch(async (err) => {
      console.error("[m3e-small-install] async install failed:", err);
    });
    res.status(200).send(success({ ...status, status: "installing", message: "正在安装 m3e-small，请稍候..." }));
  } catch (err) {
    res.status(500).send(error((err as Error)?.message || "安装失败"));
  }
});

router.post("/stop", async (_req, res) => {
  try {
    await cancelInstall();
    const status = await getEmbedInstallStatus();
    res.status(200).send(success({ ...status, message: "已停止安装" }));
  } catch (err) {
    res.status(500).send(error((err as Error)?.message || "停止安装失败"));
  }
});

router.post("/reset", async (_req, res) => {
  try {
    await resetInstallState();
    const status = await getEmbedInstallStatus();
    res.status(200).send(success({ ...status, message: "安装状态已清除" }));
  } catch (err) {
    res.status(500).send(error((err as Error)?.message || "重置状态失败"));
  }
});

export default router;
