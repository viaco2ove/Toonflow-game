import type { Knex } from "knex";
import { getDbPath } from "./src/lib/runtimePaths";

const dbPath = getDbPath();

const config: Knex.Config = {
  client: "sqlite3",
  connection: {
    filename: dbPath,
  },
  pool: {
    min: 1,
    max: 1,
  },
  useNullAsDefault: true,
  migrations: {
    directory: "./src/migrations",
    tableName: "knex_migrations",
    extension: "ts",
    loadExtensions: [".ts"],
  },
};

export default config;
