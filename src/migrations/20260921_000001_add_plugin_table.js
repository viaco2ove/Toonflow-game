/**
 * 迁移：新建 t_plugin 插件注册表
 *
 * 用途：插件的安装/卸载/启用/禁用（用户级隔离）。
 * - 每条记录 = 某用户安装的某个插件
 * - dir 存插件解压后的相对目录（相对插件根目录）
 * - manifestJson 存完整 manifest，前端列表展示直接读它，不再扫磁盘
 * - enabled: 1 启用 / 0 禁用（禁用不删目录，可随时重新启用）
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable("t_plugin")) return;

  await knex.schema.createTable("t_plugin", function (table) {
    table.increments("id").primary();
    table.integer("userId").notNullable();              // 安装者（用户隔离）
    table.text("pluginId").notNullable();               // manifest.id，如 com.toonflow.minigame-field-survival
    table.text("name");                                 // 展示名（fallback 文案）
    table.text("version");                              // semver
    table.text("author");
    table.text("description");
    table.text("dir").notNullable();                    // 插件文件目录（相对插件根目录）
    table.text("entry");                                // 前端入口 entry.js 相对路径
    table.text("backendEntry");                         // 后端入口 entry.py 相对路径（可空）
    table.text("manifestJson").notNullable();           // 完整 manifest 快照
    table.integer("enabled").defaultTo(1);              // 1 启用 / 0 禁用
    table.text("status").defaultTo("installed");        // installed | disabled | error
    table.bigInteger("installedAt");                    // 安装时间 ms
    table.bigInteger("updatedAt");                      // 更新时间 ms
  });

  await knex.schema.raw(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_user_plugin ON t_plugin (userId, pluginId)"
  );
  await knex.schema.raw(
    "CREATE INDEX IF NOT EXISTS idx_plugin_user ON t_plugin (userId)"
  );

  console.log("[migration] created table t_plugin + indexes");
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable("t_plugin")) {
    await knex.schema.dropTable("t_plugin");
  }
};
