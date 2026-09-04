/**
 * 迁移：t_worldBook.agentList 列
 *
 * 迁移背景：
 * 老库中 t_worldBook 建表语句已包含 agentList 列，但老部署的 fixDB 不会
 * 自动补列（ensureTable 只建表，不添加新列），导致保存世界书时
 * SQLite 报错：SQLITE_ERROR: no such column: agentList
 *
 * 此迁移正式记录该列的添加，后续新部署和升级部署都会执行。
 */
import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("t_worldBook"))) return;
  if (!(await knex.schema.hasColumn("t_worldBook", "agentList"))) {
    await knex.schema.alterTable("t_worldBook", (table) => {
      table.text("agentList").nullable();
    });
    console.log("[migration] added t_worldBook.agentList column");
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("t_worldBook"))) return;
  if (await knex.schema.hasColumn("t_worldBook", "agentList")) {
    await knex.schema.alterTable("t_worldBook", (table) => {
      table.dropColumn("agentList");
    });
  }
}
