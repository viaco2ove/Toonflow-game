/**
 * 迁移：为 t_storyWorld.projectId 添加索引
 *
 * listWorlds 查询用户世界列表时使用：
 *   SELECT w.* FROM t_storyWorld w
 *   LEFT JOIN t_project p ON w.projectId = p.id
 *   WHERE p.userId = ?
 *   ORDER BY w.updateTime DESC, w.id DESC
 *
 * 缺少 (projectId) 索引时 JOIN + WHERE 要全表扫描 14 行也要 6 秒。
 */

async function indexExists(knex, tableName, indexName) {
  const result = await knex.raw(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND name=?",
    [tableName, indexName],
  );
  return result.length > 0;
}

exports.up = async function up(knex) {
  if (!(await indexExists(knex, "t_storyWorld", "idx_storyWorld_projectId"))) {
    await knex.schema.raw(
      "CREATE INDEX idx_storyWorld_projectId ON t_storyWorld (projectId)",
    );
    console.log("[migration] created index idx_storyWorld_projectId on t_storyWorld(projectId)");
  }
};

exports.down = async function down(knex) {
  if (await indexExists(knex, "t_storyWorld", "idx_storyWorld_projectId")) {
    await knex.schema.raw("DROP INDEX idx_storyWorld_projectId");
  }
};
