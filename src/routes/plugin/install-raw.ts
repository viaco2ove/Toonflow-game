import express from "express";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";
import {
  getPluginPackageMaxBytes,
  getPluginsRootDir,
  installPluginPackageFromFile,
} from "@/lib/pluginRegistry";

const router = express.Router();

/** 清洗上传文件名：只取 basename，禁止路径分隔符 / 盘符 / . / .. */
function sanitizeFileName(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  // 统一分隔符后取最后一段，杜绝 ../ 、绝对路径与盘符
  const base = (value.replace(/\\/g, "/").split("/").pop() || "").trim();
  if (!base || base === "." || base === "..") return null;
  if (/[\\/]/.test(base) || /^[a-zA-Z]:/.test(base)) return null;
  return base;
}

/**
 * 流式安装插件：请求体为 application/octet-stream 的原始 zip。
 *
 * 说明：
 * - express.json / urlencoded 不会消费 octet-stream 请求体，这里直接读原始流，
 *   不要为该路由挂 JSON / urlencoded 解析中间件；
 * - 边写边累计字节数，超过上限立即停止写入，返回 413 并删除半成品；
 * - 完成后交给 installPluginPackageFromFile 走统一安装逻辑。
 */
export default router.post("/", async (req, res) => {
  let tmpZipPath: string | null = null;
  let clientGone = false;
  req.on("aborted", () => {
    clientGone = true;
  });

  const cleanupTmp = async () => {
    if (!tmpZipPath) return;
    const target = tmpZipPath;
    tmpZipPath = null;
    await fsp.rm(target, { force: true }).catch(() => undefined);
  };

  try {
    const userId = Number((req as any)?.user?.id || 0);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).send(error("用户未登录"));
    }

    const maxBytes = getPluginPackageMaxBytes();
    const maxMb = Math.floor(maxBytes / (1024 * 1024));

    // 客户端已声明 Content-Length 且超限：无需接收请求体，直接拦截
    const declaredLength = Number(req.headers["content-length"] || 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return res.status(413).send(error(`插件包超过 ${maxMb}MB 限制`));
    }

    const fileName = sanitizeFileName(req.headers["x-plugin-file-name"]);

    const tmpDir = path.join(getPluginsRootDir(), ".tmp");
    await fsp.mkdir(tmpDir, { recursive: true });
    tmpZipPath = path.join(tmpDir, `raw-${Date.now()}-${randomUUID().slice(0, 8)}.zip`);

    const writeStream = fs.createWriteStream(tmpZipPath);
    let writeError: unknown = null;
    writeStream.on("error", (e) => {
      writeError = e;
    });

    let received = 0;
    let overflow = false;
    for await (const chunk of req) {
      if (clientGone) break;
      const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any);
      if (overflow) continue; // 已超限：继续读但丢弃，保证连接可正常收尾
      received += buf.length;
      if (received > maxBytes) {
        overflow = true;
        continue;
      }
      if (!writeStream.write(buf)) {
        await new Promise<void>((resolve) => {
          writeStream.once("drain", () => resolve());
          writeStream.once("error", () => resolve()); // 出错时同样解除等待，交由下方 writeError 判定
        });
      }
    }
    await new Promise<void>((resolve) => writeStream.end(() => resolve()));

    if (clientGone) {
      await cleanupTmp();
      return;
    }
    if (writeError) throw writeError;
    if (overflow) {
      await cleanupTmp();
      return res.status(413).send(error(`插件包超过 ${maxMb}MB 限制`));
    }
    if (received === 0) {
      await cleanupTmp();
      return res.status(400).send(error("插件包内容为空"));
    }

    const result = await installPluginPackageFromFile(userId, tmpZipPath as string, fileName);
    return res.status(200).send(success(result));
  } catch (err) {
    return res.status(400).send(error(u.error(err).message));
  } finally {
    await cleanupTmp();
  }
});
