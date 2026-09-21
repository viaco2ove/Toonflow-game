/**
 * 迁移：新建 t_plugin_session_data 插件会话数据表
 *
 * 用途：插件运行时数据的独立存储（不塞进故事的动态数据 stateJson）。
 * - 「哪个插件 × 哪个故事会话 × 哪个用户」维度的键值数据；
 * - 典型例子：field-survival 生成的地图数据、游戏实时状态 plugin_state；
 * - 独立表的核心收益：编排流程复写 session.stateJson（clobber 竞态）不再影响
 *   插件进行中的游戏状态——插件数据与故事动态数据彻底解耦。
 *
 * schema（按 req.md）：
 *   (id, sessionId, pluginName, pluginId, dataKey, dataValue)
 * 同一 (userId, sessionId, pluginId, dataKey) 唯一，set 为 upsert。
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable("t_plugin_session_data")) return;

  await knex.schema.createTable("t_plugin_session_data", function (table) {
    table.increments("id").primary();
    table.integer("userId").notNullable();              // 用户隔离
    table.text("sessionId").notNullable();              // 故事会话 id（gs_xxx）
    table.text("pluginName");                           // 插件展示名（冗余，便于排查）
    table.text("pluginId").notNullable();               // com.toonflow.minigame-field-survival
    table.text("dataKey").notNullable();                // 数据键：plugin_state / map_data / ...
    table.text("dataValue").notNullable().defaultTo(""); // JSON 字符串
    table.bigInteger("createdAt").defaultTo(0);
    table.bigInteger("updatedAt").defaultTo(0);
  });

  await knex.schema.raw(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_session_data_key ON t_plugin_session_data (userId, sessionId, pluginId, dataKey)"
  );
  await knex.schema.raw(
    "CREATE INDEX IF NOT EXISTS idx_plugin_session_data_session ON t_plugin_session_data (userId, sessionId)"
  );

  console.log("[migration] created table t_plugin_session_data + indexes");
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable("t_plugin_session_data")) {
    await knex.schema.dropTable("t_plugin_session_data");
  }
};
