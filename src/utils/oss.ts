import isPathInside from "is-path-inside";
import fs from "node:fs/promises";
import path from "node:path";
import axios from "axios";
import FormData from "form-data";
import { getUploadRootDir } from "@/lib/runtimePaths";

// 规范化路径：去除前导斜杠，并将路径分隔符统一转换为系统分隔符
function normalizeUserPath(userPath: string): string {
  // 去除前导的 / 或 \
  const trimmedPath = userPath.replace(/^[/\\]+/, "");
  // 将所有 / 替换为系统路径分隔符（path.sep）
  // 这样在 Windows 上会转为 \，在 Unix 上保持 /
  return trimmedPath.split("/").join(path.sep);
}

// 校验路径
function resolveSafeLocalPath(userPath: string, rootDir: string): string {
  const safePath = normalizeUserPath(userPath);
  const absPath = path.join(rootDir, safePath);
  if (!isPathInside(absPath, rootDir)) {
    throw new Error(`${userPath} 不在 OSS 根目录内`);
  }
  return absPath;
}

class OSS {
  private rootDir: string;
  private initPromise: Promise<void>;
  private tempUrlCache = new Map<string, string>();

  constructor() {
    this.rootDir = getUploadRootDir();
    // 初始化时自动创建根目录
    this.initPromise = fs.mkdir(this.rootDir, { recursive: true }).then(() => {});
  }

  /**
   * 等待根目录初始化完成。用于保证所有文件操作在目录已创建后执行。
   * @private
   */
  private async ensureInit() {
    await this.initPromise;
  }

  /**
   * 获取指定相对路径文件的访问 URL。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns 文件的 http 链接（本地服务地址）
   */
  async getFileUrl(userRelPath: string): Promise<string> {
    await this.ensureInit();
    if (/^https?:\/\//i.test(userRelPath)) {
      return userRelPath;
    }
    const safePath = normalizeUserPath(userRelPath);
    // URL 始终使用 /，所以这里需要将系统分隔符转回 /
    const url = (process.env.OSSURL || "").trim() || `http://127.0.0.1:${process.env.PORT || "60002"}/`;
    return `${url}${safePath.split(path.sep).join("/")}`;
  }

  /**
   * 获取可对外访问的临时URL（当配置 TEMP_OSS 时）。
   * 未配置或上传失败时回退到本地服务 URL。
   */
  async getExternalUrl(userRelPath: string): Promise<string> {
    await this.ensureInit();
    if (/^https?:\/\//i.test(userRelPath)) {
      return userRelPath;
    }
    const provider = (process.env.TEMP_OSS || "").trim().toLowerCase();
    if (!provider) {
      return this.getFileUrl(userRelPath);
    }

    const cached = this.tempUrlCache.get(userRelPath);
    if (cached) return cached;

    const buffer = await this.getFile(userRelPath);
    const filename = path.basename(userRelPath);
    const tempUrl = await this.uploadToTempOss(provider, buffer, filename);
    if (tempUrl) {
      this.tempUrlCache.set(userRelPath, tempUrl);
      return tempUrl;
    }
    return this.getFileUrl(userRelPath);
  }

  /**
   * 将 Buffer 上传到临时文件服务，返回公网 URL（若未配置 TEMP_OSS 则返回 null）
   */
  async uploadTemp(buffer: Buffer, filename: string): Promise<string | null> {
    const provider = (process.env.TEMP_OSS || "").trim().toLowerCase();
    if (!provider) return null;
    return this.uploadToTempOss(provider, buffer, filename);
  }

  private async uploadToTempOss(provider: string, buffer: Buffer, filename: string): Promise<string | null> {
    try {
      if (provider.includes("tmpfiles")) {
        const form = new FormData();
        form.append("file", buffer, { filename });
        const res = await axios.post("https://tmpfiles.org/api/v1/upload", form, { headers: form.getHeaders() });
        const url = res.data?.data?.url || res.data?.data?.link || res.data?.url || res.data?.link;
        if (typeof url === "string" && url.trim()) {
          return url.trim();
        }
      }

      if (provider.includes("file.io")) {
        const form = new FormData();
        form.append("file", buffer, { filename });
        const res = await axios.post("https://file.io", form, { headers: form.getHeaders() });
        const url = res.data?.link || res.data?.url;
        if (typeof url === "string" && url.trim()) {
          return url.trim();
        }
      }

      if (provider.includes("transfer.sh")) {
        const base = provider.startsWith("http") ? provider : "https://transfer.sh";
        const endpoint = `${base.replace(/\/+$/, "")}/${encodeURIComponent(filename)}`;
        const res = await axios.put(endpoint, buffer, { headers: { "Content-Type": "application/octet-stream" } });
        if (typeof res.data === "string" && res.data.trim()) {
          return res.data.trim();
        }
      }
    } catch (err) {
      console.warn("[TEMP_OSS] upload failed:", err instanceof Error ? err.message : String(err));
    }

    return null;
  }

  /**
   * 读取指定路径的文件内容为 Buffer。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns 文件内容的 Buffer
   * @throws 路径不在 OSS 根目录内、文件不存在等错误
   */
  async getFile(userRelPath: string): Promise<Buffer> {
    await this.ensureInit();
    return fs.readFile(resolveSafeLocalPath(userRelPath, this.rootDir));
  }

  /**
   * 读取图片文件并转换为 base64 编码的 Data URL。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns base64 编码的 Data URL (例如: data:image/png;base64,iVBORw0KGgo...)
   * @throws 路径不在 OSS 根目录内、文件不存在、不是图片文件等错误
   */
  async getImageBase64(userRelPath: string): Promise<string> {
    await this.ensureInit();
    const absPath = resolveSafeLocalPath(userRelPath, this.rootDir);

    // 检查文件是否存在且为文件
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) {
      throw new Error(`${userRelPath} 不是文件`);
    }

    // 获取文件扩展名并确定 MIME 类型
    const ext = path.extname(userRelPath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".tiff": "image/tiff",
      ".tif": "image/tiff",
    };

    const mimeType = mimeTypes[ext];
    if (!mimeType) {
      throw new Error(`不支持的图片格式: ${ext}。支持的格式: ${Object.keys(mimeTypes).join(", ")}`);
    }

    // 读取文件并转换为 base64
    const data = await fs.readFile(absPath);
    const base64 = data.toString("base64");

    // 返回完整的 Data URL
    return `data:${mimeType};base64,${base64}`;
  }
  /**
   * 删除指定路径的文件。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @throws 路径不在 OSS 根目录内、文件不存在等错误
   */
  async deleteFile(userRelPath: string): Promise<void> {
    await this.ensureInit();
    if (/^https?:\/\//i.test(userRelPath)) {
      return;
    }
    await fs.unlink(resolveSafeLocalPath(userRelPath, this.rootDir));
  }

  /**
   * 删除指定路径的文件夹及其所有内容。
   * @param userRelPath 用户传入的相对文件夹路径（使用 / 作为分隔符）
   * @throws 路径不在 OSS 根目录内、文件夹不存在、目标是文件而非文件夹等错误
   */
  async deleteDirectory(userRelPath: string): Promise<void> {
    await this.ensureInit();
    const absPath = resolveSafeLocalPath(userRelPath, this.rootDir);
    const stat = await fs.stat(absPath);
    if (!stat.isDirectory()) {
      throw new Error(`${userRelPath} 不是文件夹`);
    }
    await fs.rm(absPath, { recursive: true, force: true });
  }

  /**
   * 将数据写入指定路径的新文件或覆盖已有文件。
   * 写入前自动创建所需的父文件夹。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @param data 要写入的数据，可以为 Buffer 或字符串
   * @throws 路径不在 OSS 根目录内等错误
   */
  async writeFile(userRelPath: string, data: Buffer | string): Promise<void> {
    await this.ensureInit();
    const absPath = resolveSafeLocalPath(userRelPath, this.rootDir);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, data);
  }

  /**
   * 检查指定路径文件是否存在。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns 文件存在返回 true，否则 false
   */
  async fileExists(userRelPath: string): Promise<boolean> {
    await this.ensureInit();
    if (/^https?:\/\//i.test(userRelPath)) {
      return true;
    }
    try {
      const stat = await fs.stat(resolveSafeLocalPath(userRelPath, this.rootDir));
      return stat.isFile();
    } catch {
      return false;
    }
  }
}

export default new OSS();
