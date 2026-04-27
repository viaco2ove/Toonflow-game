import isPathInside from "is-path-inside";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
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

/**
 * 把临时文件服务返回的页面地址修正成原始文件直链。
 * 阿里 clone 拉取参考音频时必须拿到真实音频二进制，不能是网页落地页。
 */
function normalizeTempOssPublicUrl(provider: string, rawUrl: string): string {
  const url = String(rawUrl || "").trim();
  if (!url) return "";

  // tmpfiles 有两种常见返回：
  // 1. http://tmpfiles.org/<id>/<name>
  // 2. https://tmpfiles.org/<id>/<name>
  // 这两种都是展示页，不是原始音频直链。这里统一强制改成 https + /dl/ 版本，
  // 避免阿里云拉取到 HTML 页面后报 Audio.DecoderError。
  if (provider.includes("tmpfiles")) {
    return url.replace(/^https?:\/\/tmpfiles\.org\/(?!dl\/)/i, "https://tmpfiles.org/dl/");
  }

  return url;
}

/**
 * 解析 TEMP_OSS 配置里的临时上传提供商列表。
 *
 * 用途：
 * - 允许通过 `tmpfiles.org,file.io,transfer.sh` 这种形式配置多提供商；
 * - 当前一个提供商失败时，可以自动回退到下一个，减少语音复刻对单点公网服务的依赖。
 */
function parseTempOssProviders(raw: string): string[] {
  return Array.from(new Set(
    String(raw || "")
      .split(/[,\s;|]+/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  ));
}

/**
 * 判断 TEMP_OSS provider 是否指向阿里云 OSS。
 *
 * 用途：
 * - 允许环境变量里使用更自然的别名，例如 `aliyun`、`aliyun_oss`、`aliyun-oss`；
 * - 避免因为 provider 名字写法不同，明明已经配了 OSS 却走不到上传逻辑。
 */
function isAliyunTempOssProvider(provider: string): boolean {
  const normalized = String(provider || "").trim().toLowerCase();
  return normalized === "aliyun"
    || normalized === "aliyunoss"
    || normalized === "aliyun_oss"
    || normalized === "aliyun-oss";
}

interface AliyunTempOssConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
  prefix: string;
  publicBaseUrl: string;
  uploadHost: string;
  signedUrlExpiresSeconds: number;
}

/**
 * 读取阿里云 OSS 临时上传配置。
 *
 * 用途：
 * - 当 TEMP_OSS 选择 aliyun_oss 时，直接把临时文件传到用户自己的 OSS；
 * - 参考音频随后通过公网 URL 或签名 URL 暴露给阿里云语音复刻接口拉取。
 */
function readAliyunTempOssConfig(): AliyunTempOssConfig {
  const bucket = String(process.env.ALIYUN_TEMP_OSS_BUCKET || "").trim();
  const region = String(process.env.ALIYUN_TEMP_OSS_REGION || "").trim();
  const accessKeyId = String(process.env.ALIYUN_TEMP_OSS_ACCESS_KEY_ID || "").trim();
  const accessKeySecret = String(process.env.ALIYUN_TEMP_OSS_ACCESS_KEY_SECRET || "").trim();
  const securityToken = String(process.env.ALIYUN_TEMP_OSS_SECURITY_TOKEN || "").trim();
  const prefix = String(process.env.ALIYUN_TEMP_OSS_PREFIX || "temp/voice-clone").trim().replace(/^\/+|\/+$/g, "");
  const publicBaseUrl = String(process.env.ALIYUN_TEMP_OSS_PUBLIC_BASE_URL || "").trim().replace(/\/+$/g, "");
  const endpointRaw = String(process.env.ALIYUN_TEMP_OSS_ENDPOINT || "").trim().replace(/\/+$/g, "");
  const expiresRaw = Number(process.env.ALIYUN_TEMP_OSS_EXPIRES_SECONDS || 900);

  if (!bucket || !region || !accessKeyId || !accessKeySecret) {
    throw new Error("阿里云 TEMP_OSS 缺少必要配置：ALIYUN_TEMP_OSS_BUCKET / REGION / ACCESS_KEY_ID / ACCESS_KEY_SECRET");
  }

  const endpointHost = endpointRaw
    ? endpointRaw.replace(/^https?:\/\//i, "")
    : `oss-${region}.aliyuncs.com`;
  const uploadHost = endpointHost.startsWith(`${bucket}.`)
    ? `https://${endpointHost}`
    : `https://${bucket}.${endpointHost}`;

  return {
    bucket,
    region,
    accessKeyId,
    accessKeySecret,
    securityToken,
    prefix,
    publicBaseUrl,
    uploadHost,
    signedUrlExpiresSeconds: Number.isFinite(expiresRaw) && expiresRaw > 30 ? Math.floor(expiresRaw) : 900,
  };
}

/**
 * 将对象 key 规范成 URL 路径。
 *
 * 用途：
 * - 生成公网 URL 和签名 URL 时，路径中的每一段都需要单独编码；
 * - 避免中文、空格或特殊字符导致 OSS 直链无法访问。
 */
function encodeOssObjectKey(objectKey: string): string {
  return objectKey
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * 为阿里云 OSS 生成临时可访问的签名下载 URL。
 *
 * 用途：
 * - 即使 Bucket 本身是私有，也能为阿里云声音复刻提供一个短时公网可拉取地址；
 * - 这样不需要把整个 Bucket 改成公开读。
 */
function buildAliyunSignedGetUrl(config: AliyunTempOssConfig, objectKey: string): string {
  const expires = Math.floor(Date.now() / 1000) + config.signedUrlExpiresSeconds;
  const canonicalResource = `/${config.bucket}/${objectKey}`;
  const stringToSign = `GET\n\n\n${expires}\n${canonicalResource}`;
  const signature = crypto
    .createHmac("sha1", config.accessKeySecret)
    .update(stringToSign)
    .digest("base64");
  const url = new URL(`${config.uploadHost}/${encodeOssObjectKey(objectKey)}`);
  url.searchParams.set("OSSAccessKeyId", config.accessKeyId);
  url.searchParams.set("Expires", String(expires));
  url.searchParams.set("Signature", signature);
  if (config.securityToken) {
    url.searchParams.set("security-token", config.securityToken);
  }
  return url.toString();
}

/**
 * 把文件上传到阿里云 OSS。
 *
 * 用途：
 * - TEMP_OSS 使用用户自己的 OSS 时，不再依赖 tmpfiles/file.io 之类第三方临时站；
 * - 先通过 PostObject 表单直传，再按公开域名或签名 URL 返回可外部访问的地址。
 */
async function uploadToAliyunTempOss(buffer: Buffer, filename: string): Promise<string | null> {
  const config = readAliyunTempOssConfig();
  const objectKey = `${config.prefix}/${Date.now()}-${filename}`.replace(/^\/+/, "");
  const expiration = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const policy = {
    expiration,
    conditions: [
      { bucket: config.bucket },
      { key: objectKey },
      ["content-length-range", 1, Math.max(buffer.length, 1) + 1024],
      ["eq", "$success_action_status", "200"],
    ],
  };
  const policyBase64 = Buffer.from(JSON.stringify(policy)).toString("base64");
  const signature = crypto
    .createHmac("sha1", config.accessKeySecret)
    .update(policyBase64)
    .digest("base64");

  const form = new FormData();
  form.append("key", objectKey);
  form.append("policy", policyBase64);
  form.append("OSSAccessKeyId", config.accessKeyId);
  form.append("Signature", signature);
  form.append("success_action_status", "200");
  if (config.securityToken) {
    form.append("x-oss-security-token", config.securityToken);
  }
  form.append("file", buffer, { filename });

  await axios.post(config.uploadHost, form, {
    headers: form.getHeaders(),
    timeout: 120000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: (status) => status >= 200 && status < 300,
  });

  if (config.publicBaseUrl) {
    return `${config.publicBaseUrl}/${encodeOssObjectKey(objectKey)}`;
  }
  return buildAliyunSignedGetUrl(config, objectKey);
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
    const providers = parseTempOssProviders(process.env.TEMP_OSS || "");
    if (!providers.length) {
      return this.getFileUrl(userRelPath);
    }

    const cached = this.tempUrlCache.get(userRelPath);
    if (cached) return cached;

    const buffer = await this.getFile(userRelPath);
    const filename = path.basename(userRelPath);
    const tempUrl = await this.uploadToTempOss(providers, buffer, filename);
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
    const providers = parseTempOssProviders(process.env.TEMP_OSS || "");
    if (!providers.length) return null;
    return this.uploadToTempOss(providers, buffer, filename);
  }

  /**
   * 依次尝试多个临时上传提供商，直到拿到公网 URL。
   *
   * 用途：
   * - 阿里云官方 clone 必须拿到公网参考音频；
   * - tmpfiles.org 这类临时服务在国内网络下并不稳定，失败后需要自动切换备用源。
   */
  private async uploadToTempOss(providers: string[], buffer: Buffer, filename: string): Promise<string | null> {
    for (const provider of providers) {
      const uploaded = await this.uploadToSingleTempOss(provider, buffer, filename);
      if (uploaded) {
        return uploaded;
      }
    }
    return null;
  }

  /**
   * 向单个临时上传提供商发起上传。
   *
   * 用途：
   * - 把每家服务的调用细节隔离开；
   * - 失败时单独打印 provider，方便定位到底是 tmpfiles、file.io 还是 transfer.sh 出问题。
   */
  private async uploadToSingleTempOss(provider: string, buffer: Buffer, filename: string): Promise<string | null> {
    try {
      if (isAliyunTempOssProvider(provider)) {
        return uploadToAliyunTempOss(buffer, filename);
      }

      if (provider.includes("tmpfiles")) {
        const form = new FormData();
        form.append("file", buffer, { filename });
        const res = await axios.post("https://tmpfiles.org/api/v1/upload", form, {
          headers: form.getHeaders(),
          timeout: 120000,
        });
        const url = res.data?.data?.url || res.data?.data?.link || res.data?.url || res.data?.link;
        if (typeof url === "string" && url.trim()) {
          return normalizeTempOssPublicUrl(provider, url);
        }
      }

      if (provider.includes("file.io")) {
        const form = new FormData();
        form.append("file", buffer, { filename });
        const res = await axios.post("https://file.io", form, {
          headers: form.getHeaders(),
          timeout: 120000,
        });
        const url = res.data?.link || res.data?.url;
        if (typeof url === "string" && url.trim()) {
          return normalizeTempOssPublicUrl(provider, url);
        }
      }

      if (provider.includes("transfer.sh")) {
        const base = provider.startsWith("http") ? provider : "https://transfer.sh";
        const endpoint = `${base.replace(/\/+$/, "")}/${encodeURIComponent(filename)}`;
        const res = await axios.put(endpoint, buffer, {
          headers: { "Content-Type": "application/octet-stream" },
          timeout: 120000,
        });
        if (typeof res.data === "string" && res.data.trim()) {
          return normalizeTempOssPublicUrl(provider, res.data);
        }
      }
    } catch (err) {
      console.warn(`[TEMP_OSS] upload failed (${provider}):`, err instanceof Error ? err.message : String(err));
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
