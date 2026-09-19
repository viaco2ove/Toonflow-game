import { readFile, writeFile } from "fs/promises";
import u from "@/utils";
import fs from "fs";
import path from "path";
import knex from "knex";
import type { DB } from "@/types/database";
import crypto from "crypto";
import { getDbPath } from "@/lib/runtimePaths";

type TableName = keyof DB & string;
type RowType<TName extends TableName> = DB[TName];

const dbPath = getDbPath();
console.log("Database path:", dbPath);

/**
 * 探测 Knex 迁移目录。
 *
 * 开发模式（tsx 跑源码）：cwd = 项目根，迁移在 src/migrations/
 * 打包模式（build/app.js）：cwd = APP_DIR（如 /opt/toonflow/toonflow-game-app），
 *   迁移在 build/src/migrations/（由 scripts/build.js 复制）
 *
 * 不能依赖 __dirname，因为 esbuild bundle 后 __dirname 指向输出文件目录，
 * 在不同打包目标下路径会变。
 */
function resolveMigrationsDir(): string {
  const candidates = [
    path.resolve(process.cwd(), "src", "migrations"),     // dev
    path.resolve(process.cwd(), "build", "src", "migrations"), // prod
    path.resolve(__dirname, "..", "migrations"),           // dev 老路径兜底
  ];
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // 目录不存在则继续尝试
    }
  }
  // 全部都不存在时仍返回 dev 路径，让 Knex 给出明确的 ENOENT 错误提示
  return path.resolve(process.cwd(), "src", "migrations");
}
if (process.platform === "win32" && /^\\\\wsl\\$/i.test(dbPath)) {
  console.warn("[db] DB path is on \\\\wsl$ share. On Windows this may trigger SQLITE_BUSY due to file-lock semantics.");
}
const dbDir = path.dirname(dbPath);

// 确保数据库目录存在
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// 创建空数据库文件
if (!fs.existsSync(dbPath)) {
  fs.writeFileSync(dbPath, "");
}

function getPositiveIntEnv(name: string, fallback: number): number {
  const raw = (process.env[name] || "").trim();
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const SQLITE_BUSY_TIMEOUT_MS = getPositiveIntEnv("DB_BUSY_TIMEOUT_MS", 15000);
const SQLITE_BUSY_RETRY_TIMES = getPositiveIntEnv("DB_BUSY_RETRY_TIMES", 8);
const SQLITE_BUSY_RETRY_DELAY_MS = getPositiveIntEnv("DB_BUSY_RETRY_DELAY_MS", 500);

const db = knex({
  client: "sqlite3",
  connection: {
    filename: dbPath,
  },
  acquireConnectionTimeout: SQLITE_BUSY_TIMEOUT_MS + 5000,
  pool: {
    min: 1,
    max: 1,
  },
  useNullAsDefault: true,
  // 迁移文件统一为 CommonJS .js（不能用 .ts：esbuild 打包后 require 不识别 .ts）。
  // directory 通过 fs 探测，避免 esbuild 把 __dirname 静态内联为错误路径。
  migrations: {
    directory: resolveMigrationsDir(),
    tableName: "knex_migrations",
    extension: "js",
    loadExtensions: [".js"],
  },
});

const isTypeGenerationRuntime = ["dev", "local"].includes((process.env.NODE_ENV || "").toLowerCase())
  && !__filename.replace(/\\/g, "/").endsWith("/build/app.js")
  && !__filename.replace(/\\/g, "/").endsWith("/build/main.js");

export const dbBootstrapReady = (async () => {
  await withSqliteBusyRetry("configureSqlite", () => configureSqlite(db));

  // Knex Migrations 完全取代旧的 initDB/fixDB 流程：
  //   - base migration (20260901_000000_base.js) 建所有基表（幂等）
  //   - 后续 migration（含 20260901_000002_seed_initial_data.js）填初始数据
  // 老库已有表时，migrate.latest() 检测 knex_migrations 状态，只跑尚未记录的新迁移。
  // 注意：之前 fakeBaseMigration 的逻辑已删除 —— base migration 现在会真正建表。
  //   老库（initDB 已建过表的）需要先一次性跑 base，但 base 内部用 hasTable 幂等检查，
  //   所以即使表已存在，迁移也能"成功但 no-op"。
  await withSqliteBusyRetry("pruneOrphanMigrations", () => pruneOrphanMigrations(db));
  await withSqliteBusyRetry("migrate", async () => {
    const { error, results } = await db.migrate.latest();
    if (error) throw error;
    if (results?.length) {
      console.log(`[db] migrations applied: ${results.map((r: any) => r.name).join(", ")}`);
    }
  });

  if (isTypeGenerationRuntime) {
    await withSqliteBusyRetry("initKnexType", () => initKnexType(db));
  }
})();

/**
 * 清理 knex_migrations 表里的孤儿记录：
 * 任何 knex_migrations 表里登记的 name，在当前 migrations directory
 * （按 Knex loadExtensions 过滤后）找不到对应文件的，都删掉。
 *
 * 触发场景：
 * - 重命名了 .ts 迁移文件为 .js，旧的 `.ts` 记录留在表里会触发
 *   "The migration directory is corrupt, the following files are missing"
 */
async function pruneOrphanMigrations(knexDb: any): Promise<void> {
  const migrationsDir = resolveMigrationsDir();
  const tableExists = await knexDb.schema.hasTable("knex_migrations");
  if (!tableExists) return;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(migrationsDir);
  } catch {
    // directory 不存在时啥都不做
    return;
  }
  // 真实存在的迁移文件名集合（仅匹配 loadExtensions .js）
  const existingFiles = new Set(entries.filter((f) => f.endsWith(".js")));
  const rows = (await knexDb("knex_migrations").select("name").catch(() => [])) as Array<{ name: string }>;
  const orphans = rows.filter((r) => !existingFiles.has(r.name)).map((r) => r.name);
  if (!orphans.length) return;
  await knexDb("knex_migrations").whereIn("name", orphans).delete();
  console.log(`[db] pruneOrphanMigrations: removed ${orphans.length} orphan record(s): ${orphans.join(", ")}`);
}

void dbBootstrapReady.catch((err) => {
  console.error("[db] bootstrap failed:", err);
});

const dbClient = Object.assign(<TName extends TableName>(table: TName) => db<RowType<TName>, RowType<TName>[]>(table), db) as typeof db & (<TName extends TableName>(table: TName) => ReturnType<typeof db>);
dbClient.schema = db.schema;
// 默认导出是包装后的可调用对象，需要显式补上 knex 实例方法。
dbClient.raw = db.raw.bind(db);
dbClient.transaction = db.transaction.bind(db);
export default dbClient;

export { db };

async function configureSqlite(knexDb: any) {
  await knexDb.raw(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  try {
    await knexDb.raw("PRAGMA journal_mode = WAL");
  } catch (err: any) {
    console.warn("[db] PRAGMA journal_mode=WAL failed, fallback to default:", err?.message || String(err));
  }
  await knexDb.raw("PRAGMA synchronous = NORMAL");
  await knexDb.raw("PRAGMA temp_store = MEMORY");
}

function isSqliteBusyError(err: any): boolean {
  const msg = String(err?.message || "");
  return err?.code === "SQLITE_BUSY" || msg.includes("SQLITE_BUSY");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withSqliteBusyRetry<T>(actionName: string, fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      if (!isSqliteBusyError(err) || attempt >= SQLITE_BUSY_RETRY_TIMES) {
        throw err;
      }
      attempt += 1;
      const waitMs = SQLITE_BUSY_RETRY_DELAY_MS * attempt;
      console.warn(
        `[db] SQLITE_BUSY during ${actionName}, retry ${attempt}/${SQLITE_BUSY_RETRY_TIMES} after ${waitMs}ms`,
      );
      await sleep(waitMs);
    }
  }
}

async function initKnexType(knexDb: any) {
  const { Client } = await import("@rmp135/sql-ts");
  const outFile = "src/types/database.d.ts";
  const dbClient = Client.fromConfig({
    interfaceNameFormat: "${table}",
    typeMap: {
      number: ["bigint"],
      string: ["text", "varchar", "char"],
    },
  }).fetchDatabase(knexDb);
  const declarations = await dbClient.toTypescript();
  const dbObject = await dbClient.toObject();
  const customHeader = `//该文件由脚本自动生成，请勿手动修改`;
  // 清除上次的注释头
  let declBody = declarations.replace(/^\/\*[\s\S]*?\*\/\s*/, "");
  declBody = declBody.replace(/(\n\s*)\/\*([^*][\s\S]*?)\*\//g, "$1/**$2*/");
  const tableInterfaces = dbObject.schemas.flatMap((schema) => schema.tables.map((table) => table.interfaceName));
  const aggregateTypes = `
export interface DB {
${tableInterfaces.map((name) => `  ${JSON.stringify(name)}: ${name};`).join("\n")}
}
`;
  // 哈希仅基于结构化信息，header和空格不算
  const hashSource = JSON.stringify({
    tableInterfaces,
    declBody,
  });
  const hash = crypto.createHash("md5").update(hashSource).digest("hex");
  // 文件内容
  const content = `// @db-hash ${hash}\n${customHeader}\n\n` + declBody + aggregateTypes;
  let needWrite = true;
  try {
    const current = await readFile(outFile, "utf8");
    // 文件头已存在相同 hash，不需要写
    const match = current.match(/^\/\/\s*@db-hash\s*([a-zA-Z0-9]+)\n/);
    const currentHash = match ? match[1] : null;
    if (currentHash === hash) {
      needWrite = false;
    }
  } catch (err) {
    needWrite = true;
  }
  if (needWrite) await writeFile(outFile, content, "utf8");
}
