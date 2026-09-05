/**
 * Base Migration — 记录「initDB 已完成」的基准版本。
 *
 * 不执行任何 DDL 操作，因为：
 *   - 新库：initDB 已在 bootstrap 中完成建表
 *   - 老库：initDB 检测表已存在而跳过
 * 本 migration 唯一作用是写入 knex_migrations 记录，
 * 让后续 migrate.latest() 跳过它，只执行 src/migrations/ 下新增的迁移。
 *
 * 文件格式：纯 CommonJS JavaScript（无 import/export）。
 * 这样 esbuild 打包时可直接复制到 build 产物，
 * Node CJS require 不需要任何编译就能加载。
 *
 * knex 函数的参数由 Knex 运行时提供，无需在文件里 import 类型。
 */

exports.up = async function up() {
  // 幂等：base 只记录，不实际操作
};

exports.down = async function down() {
  // N/A
};