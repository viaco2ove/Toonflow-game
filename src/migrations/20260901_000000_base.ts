/**
 * Base Migration — 记录「initDB 已完成」的基准版本。
 *
 * 不执行任何 DDL 操作，因为：
 *   - 新库：initDB 已在 bootstrap 中完成建表
 *   - 老库：initDB 检测表已存在而跳过
 * 本 migration 唯一作用是写入 knex_migrations 记录，
 * 让后续 migrate.latest() 跳过它，只执行 src/migrations/ 下新增的迁移。
 */
import { Knex } from "knex";

export async function up(_knex: Knex): Promise<void> {
  // 幂等：base 只记录，不实际操作
}

export async function down(_knex: Knex): Promise<void> {
  // N/A
}
