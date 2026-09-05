import { readFile, writeFile } from "fs/promises";
import u from "@/utils";
import fs from "fs";
import path from "path";
import knex from "knex";
import initDB from "@/lib/initDB";
import fixDB from "@/lib/fixDB";
import type { DB } from "@/types/database";
import crypto from "crypto";
import { getDbPath } from "@/lib/runtimePaths";

type TableName = keyof DB & string;
type RowType<TName extends TableName> = DB[TName];

const dbPath = getDbPath();
console.log("Database path:", dbPath);
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
  // 迁移目录：用 __dirname 解析（开发 src/utils/db.ts → ../migrations，
  // 打包 build/utils/db.js → ../migrations），不依赖 cwd，避免 Node ESM/CJS 互操作错误。
  // 迁移文件统一为 CommonJS .js（不能用 .ts：esbuild 打包后 require 不识别 .ts），
  // loadExtensions 只取 .js 即可。
  migrations: {
    directory: path.resolve(__dirname, "..", "migrations"),
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
  await withSqliteBusyRetry("initDB", () => initDB(db));

  // Knex Migrations：先清理 knex_migrations 里与 directory 不匹配的孤儿记录，
  // 再伪造 base 版本已执行（让 migrate.latest() 跳过 base）
  await withSqliteBusyRetry("pruneOrphanMigrations", () => pruneOrphanMigrations(db));
  await withSqliteBusyRetry("fakeBaseMigration", () => fakeBaseMigration(db));

  // 执行 src/migrations/ 中新增的迁移（base 会被跳过）
  await withSqliteBusyRetry("migrate", async () => {
    const { error, results } = await db.migrate.latest();
    if (error) throw error;
    if (results?.length) {
      console.log(`[db] migrations applied: ${results.map((r: any) => r.name).join(", ")}`);
    }
  });

  await withSqliteBusyRetry("fixDB", () => fixDB(db));
  if (isTypeGenerationRuntime) {
    await withSqliteBusyRetry("initKnexType", () => initKnexType(db));
  }
})();

async function fakeBaseMigration(knexDb: any): Promise<void> {
  // knex_migrations 表可能尚不存在（migrate.latest 首次运行时会自动建），
  // 所以先检查存在性，不存在就跳过——首次 migrate.latest() 会建表并执行迁移。
  const tableExists = await knexDb.schema.hasTable("knex_migrations");
  if (!tableExists) return;

  const hasBase = await knexDb("knex_migrations")
    .where("name", "20260901_000000_base.js")
    .first()
    .catch(() => null);
  if (hasBase) return;

  // 插入伪造的 base 记录
  const now = new Date();
  const maxIdRow = (await knexDb("knex_migrations").max("id as maxId").first()) as { maxId?: number } | undefined;
  const nextId = (maxIdRow?.maxId ?? 0) + 1;
  await knexDb("knex_migrations").insert({
    id: nextId,
    name: "20260901_000000_base.js",
    batch: 1,
    migration_time: now,
  });
  console.log("[db] fakeBaseMigration: recorded 20260901_000000_base.js");
}

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
  const migrationsDir = path.resolve(__dirname, "..", "migrations");
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
