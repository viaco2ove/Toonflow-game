import * as fs from "fs";
import * as path from "path";

type LogLevel = "log" | "info" | "warn" | "error" | "debug";
type ConsoleMethod = (...args: unknown[]) => void;

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
  const value = String(rawValue || "").trim().replace(/^['"]|['"]$/g, "");
  if (!value) return fallback;
  const normalized = normalizeCrossPlatformPath(value);
  if (path.isAbsolute(normalized) || isWindowsAbsolutePath(normalized)) {
    return normalized;
  }
  return path.resolve(process.cwd(), normalized);
}

function getLogDir(): string {
  const configured = resolveConfiguredPath(process.env.LOG_PATH, "");
  if (configured) return configured;
  const isElectron = typeof process.versions?.electron !== "undefined";
  if (isElectron) {
    const { app } = require("electron");
    return path.join(app.getPath("userData"), "logs");
  }
  return path.join(process.cwd(), "logs");
}

const LOG_DIR = getLogDir();
const MAX_SIZE = 1000 * 1024 * 1024;
/** 轮转检查节流：最多每 5 秒做一次体积判定（避免每条日志都 stat）。 */
const ROTATE_CHECK_INTERVAL_MS = 5000;
/**
 * 分片后缀上限。轮转时不再动旧文件（Windows 上 rename/截断 GB 级文件都不可靠），
 * 而是换一个新的分片文件继续写：app-<date>.log → app-<date>.log.1 → .2 …
 */
const MAX_SHARD_INDEX = 99;
const LEVELS: LogLevel[] = ["log", "info", "warn", "error", "debug"];

function formatDateKey(date: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function resolveDailyLogFile(dateKey: string): string {
  return path.join(LOG_DIR, `app-${dateKey}.log`);
}

const LEGACY_LOG_FILE = path.join(LOG_DIR, "app.log");

class Logger {
  private stream: fs.WriteStream | null = null;
  private currentDateKey = "";
  private currentLogFile = "";
  /** 分片序号：0 = app-<date>.log，1 = app-<date>.log.1 …… */
  private shardIndex = 0;
  private originalConsole: Partial<Record<LogLevel, ConsoleMethod>> = {};
  private originalStdoutWrite: typeof process.stdout.write | null = null;
  private originalStderrWrite: typeof process.stderr.write | null = null;
  private isHijacked = false;

  init(): this {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    this.migrateLegacyAppLog();
    this.ensureStreamReady();
    this.hijack();
    return this;
  }

  private formatTime(): string {
    const d = new Date();
    const p = (n: number, l = 2) => String(n).padStart(l, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(
      d.getMilliseconds(),
      3,
    )}`;
  }

  private stringify(arg: unknown): string {
    if (arg == null) return String(arg);
    if (arg instanceof Error) return `${arg.message}\n${arg.stack || ""}`;
    if (typeof arg === "object") {
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  }

  private writing = false;
  private isIgnorableWriteError(err: unknown): boolean {
    const code = (err as any)?.code;
    return code === "EIO" || code === "EBADF" || code === "EPIPE";
  }

  private safeAppend(line: string): void {
    this.ensureStreamReady();
    if (!this.stream || this.stream.destroyed) return;
    try {
      this.stream.write(line);
    } catch (err) {
      if (!this.isIgnorableWriteError(err)) throw err;
      this.stream.destroy();
      this.stream = null;
    }
  }

  private safeOriginalWrite(
    writeFn: typeof process.stdout.write,
    chunk: any,
    rest: any[],
  ): ReturnType<typeof process.stdout.write> {
    try {
      return writeFn(chunk, ...rest);
    } catch (err) {
      if (this.isIgnorableWriteError(err)) {
        return true as ReturnType<typeof process.stdout.write>;
      }
      throw err;
    }
  }

  private write(level: LogLevel, args: unknown[]): void {
    const line = `[${this.formatTime()}] [${level.toUpperCase()}] ${args.map((a) => this.stringify(a)).join(" ")}\n`;
    this.safeAppend(line);
    this.checkRotate();
  }

  private writeRaw(chunk: any): void {
    if (this.writing) return;
    this.writing = true;
    try {
      let str = typeof chunk === "string" ? chunk : chunk?.toString?.("utf-8") ?? "";
      str = str.replace(/\x1B\[\d*m/g, ""); // 去除 ANSI 颜色码
      if (str.trim()) this.safeAppend(str.endsWith("\n") ? str : str + "\n");
    } finally {
      this.writing = false;
    }
    // ★ stdout 直写路径（morgan 等）同样要触发轮转判定，
    //   否则文件涨过阈值后永远不会被轮转。
    this.checkRotate();
  }

  /**
   * 日志轮转。
   *
   * ★ 2026-11-16 修复「所有接口整体慢 1 秒」：
   *   旧实现是「读整个日志文件 → 截半 → 写回」。当天日志涨到 MAX_SIZE(1GB) 之后，
   *   **每一条日志写入**都会触发一次 1GB 的同步读盘（readFileSync），
   *   直接把写日志的调用方（= 所有 HTTP 请求的 morgan 输出）阻塞 ~1s。
   *   实测：/other/version 空接口 1.3s；裸 node 服务器 11ms。
   *
   * 新实现：
   *   1) 轮转判定节流（ROTATE_CHECK_INTERVAL_MS 内最多检查一次）；
   *   2) 轮转动作改为「改名归档 + 新开文件」，不再读全文；
   *   3) 轮转在 setImmediate 里异步执行，不阻塞写入路径。
   */
  private lastRotateCheckAt = 0;
  private rotating = false;

  private checkRotate(): void {
    const now = Date.now();
    if (this.rotating) return;
    if (now - this.lastRotateCheckAt < ROTATE_CHECK_INTERVAL_MS) return;
    this.lastRotateCheckAt = now;
    try {
      this.ensureStreamReady();
      if (!this.currentLogFile || !fs.existsSync(this.currentLogFile)) return;
      if (fs.statSync(this.currentLogFile).size < MAX_SIZE) return;
    } catch {
      return;
    }
    // 异步执行真正的轮转，避免把读盘延迟算在请求关键路径上
    this.rotating = true;
    setImmediate(() => {
      void this.rotateNow()
        .catch(() => {
          /* 轮转失败不致命：继续往当前文件追加 */
        })
        .finally(() => {
          this.rotating = false;
        });
    });
  }

  /**
   * 轮转：换一个新的分片文件继续写，**完全不碰旧文件**。
   *
   * 为什么不用 rename/截断：Windows 上 GB 级文件被进程占用时 rename 会失败，
   * 截断则要读全文（就是原来 1 秒延迟的元凶）。改用「换新文件」后
   * 旧分片自然留在磁盘上（app-<date>.log.1/.2 …），无需任何大文件 IO。
   */
  private async rotateNow(): Promise<void> {
    if (!this.currentLogFile) return;
    const stream = this.stream;
    this.stream = null;
    if (stream && !stream.destroyed) {
      await new Promise<void>((resolve) => {
        stream.end(() => resolve());
        setTimeout(resolve, 2000);
      });
      if (!stream.destroyed) stream.destroy();
    }
    this.shardIndex += 1;
    if (this.shardIndex > MAX_SHARD_INDEX) {
      // 分片用尽：回到基础文件（允许它继续涨，后续再人工清理）
      this.shardIndex = 0;
    }
    this.currentLogFile = this.resolveCurrentLogFile();
    this.openStreamForCurrentDate();
  }

  /** 当前应当写入的分片文件路径。 */
  private resolveCurrentLogFile(): string {
    const base = resolveDailyLogFile(formatDateKey());
    return this.shardIndex > 0 ? `${base}.${this.shardIndex}` : base;
  }

  private migrateLegacyAppLog(): void {
    try {
      if (!fs.existsSync(LEGACY_LOG_FILE)) return;
      const stats = fs.statSync(LEGACY_LOG_FILE);
      if (!stats.size) {
        fs.unlinkSync(LEGACY_LOG_FILE);
        return;
      }
      const todayFile = resolveDailyLogFile(formatDateKey());
      const legacyContent = fs.readFileSync(LEGACY_LOG_FILE);
      if (fs.existsSync(todayFile)) {
        fs.appendFileSync(todayFile, legacyContent);
        fs.unlinkSync(LEGACY_LOG_FILE);
        return;
      }
      fs.renameSync(LEGACY_LOG_FILE, todayFile);
    } catch {}
  }

  private openStreamForCurrentDate(): void {
    const nextDateKey = formatDateKey();
    if (this.currentDateKey !== nextDateKey) {
      // 跨天：分片序号归零
      this.shardIndex = 0;
    }
    const nextLogFile = this.resolveCurrentLogFile();
    if (this.currentDateKey === nextDateKey && this.currentLogFile === nextLogFile && this.stream && !this.stream.destroyed) {
      return;
    }
    this.stream?.end();
    this.currentDateKey = nextDateKey;
    this.currentLogFile = nextLogFile;
    this.stream = fs.createWriteStream(this.currentLogFile, { flags: "a" });
    this.stream.on("error", () => {
      this.stream?.destroy();
      this.stream = null;
    });
  }

  private ensureStreamReady(): void {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const nextDateKey = formatDateKey();
    if (!this.stream || this.stream.destroyed || this.currentDateKey !== nextDateKey) {
      this.openStreamForCurrentDate();
    }
  }

  private hijack(): void {
    if (this.isHijacked) return;

    // 劫持 console 方法
    for (const level of LEVELS) {
      const original = console[level];
      if (typeof original !== "function") continue;
      this.originalConsole[level] = original.bind(console);
      (console as any)[level] = (...args: unknown[]) => {
        this.writing = true;
        try {
          this.write(level, args);
          this.originalConsole[level]!(...args);
        } finally {
          this.writing = false;
        }
      };
    }

    // 劫持 stdout/stderr（捕获 morgan 等直接写 stdout 的输出）
    this.originalStdoutWrite = process.stdout.write.bind(process.stdout);
    this.originalStderrWrite = process.stderr.write.bind(process.stderr);

    process.stdout.write = ((chunk: any, ...rest: any[]) => {
      this.writeRaw(chunk);
      return this.safeOriginalWrite(this.originalStdoutWrite!, chunk, rest);
    }) as typeof process.stdout.write;

    process.stderr.write = ((chunk: any, ...rest: any[]) => {
      this.writeRaw(chunk);
      return this.safeOriginalWrite(this.originalStderrWrite!, chunk, rest);
    }) as typeof process.stderr.write;

    this.isHijacked = true;
  }

  /** 导出日志内容 */
  exportLogs(): string {
    this.ensureStreamReady();
    if (!this.currentLogFile || !fs.existsSync(this.currentLogFile)) return "";
    return fs.readFileSync(this.currentLogFile, "utf-8");
  }

  /** 清空日志 */
  clear(): void {
    this.stream?.end();
    this.ensureStreamReady();
    if (this.currentLogFile && fs.existsSync(this.currentLogFile)) fs.unlinkSync(this.currentLogFile);
    this.openStreamForCurrentDate();
  }

  /** 关闭日志 */
  close(): void {
    if (this.isHijacked) {
      for (const level of LEVELS) {
        const original = this.originalConsole[level];
        if (original) (console as any)[level] = original;
      }
      this.originalConsole = {};
      if (this.originalStdoutWrite) process.stdout.write = this.originalStdoutWrite;
      if (this.originalStderrWrite) process.stderr.write = this.originalStderrWrite;
      this.originalStdoutWrite = null;
      this.originalStderrWrite = null;
      this.isHijacked = false;
    }
    this.stream?.end();
    this.stream = null;
  }
}

const logger = new Logger().init();
export default logger;
