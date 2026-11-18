/**
 * 迁移：t_worldBook.stickiness 列
 *
 * 迁移背景：
 * 世界书条目新增"粘性轮数"（stickiness）字段，serializeWorldBookEntry 在保存时
 * 会写入该列。但老库 t_worldBook 表没有这一列，导致保存条目时报错：
 *   SQLITE_ERROR: table t_worldBook has no column named stickiness
 *
 * 此迁移为已有库和新建库补上 stickiness 列，默认值 3
 * （与 gameEngine.ts 里的 WORLD_BOOK_STICKINESS_DEFAULT 保持一致）。
 *
 * 文件格式：纯 CommonJS JavaScript，避免 esbuild 打包 / Node CJS require 时
 * 因为 "knex" 没有 named export 而失败。
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable("t_worldBook"))) return;
  if (!(await knex.schema.hasColumn("t_worldBook", "stickiness"))) {
    await knex.schema.alterTable("t_worldBook", function (table) {
      table.integer("stickiness").notNullable().defaultTo(3);
    });
    console.log("[migration] added t_worldBook.stickiness column");
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable("t_worldBook"))) return;
  if (await knex.schema.hasColumn("t_worldBook", "stickiness")) {
    await knex.schema.alterTable("t_worldBook", function (table) {
      table.dropColumn("stickiness");
    });
  }
};
