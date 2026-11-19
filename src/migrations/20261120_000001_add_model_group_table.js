/**
 * 迁移：新建 t_modelGroup 模型组表
 *
 * 用途：设置页「模型配置」的保存/切换（用户级隔离）。
 * - 每条记录 = 某用户保存的一个模型组（一组模型槽位配置的快照）
 * - languageModelJson 存 t_setting.languageModel 的完整 JSON 快照
 *   （结构：{ 槽位key: configId, ..., __storyRuntimeSettings: { 运行模式 } }）
 * - 保存 = 快照当前 languageModel；应用 = 校验后整体覆写回 t_setting.languageModel
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable("t_modelGroup")) return;

  await knex.schema.createTable("t_modelGroup", function (table) {
    table.increments("id").primary();
    table.integer("userId").notNullable();              // 所属用户（用户隔离）
    table.text("name").notNullable();                   // 模型组名称（同用户内唯一）
    table.text("remark");                               // 备注（可空）
    table.text("languageModelJson").notNullable();      // t_setting.languageModel 的 JSON 快照
    table.bigInteger("createTime");                     // 创建时间 ms
    table.bigInteger("updateTime");                     // 更新时间 ms
  });

  // 同一用户内模型组名称唯一，避免保存/切换时产生歧义
  await knex.schema.raw(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_modelGroup_user_name ON t_modelGroup (userId, name)"
  );
  await knex.schema.raw(
    "CREATE INDEX IF NOT EXISTS idx_modelGroup_user ON t_modelGroup (userId)"
  );

  console.log("[migration] created table t_modelGroup + indexes");
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable("t_modelGroup")) {
    await knex.schema.dropTable("t_modelGroup");
  }
};
