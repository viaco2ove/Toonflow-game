/**
 * 迁移：为 t_gameSession 表添加查询优化索引
 *
 * 问题背景：
 *   listWorlds 接口查询 session 数量时使用：
 *     COUNT(DISTINCT userId) WHERE worldId IN (...)
 *   当 t_gameSession 缺少 (worldId) 索引时，IN 子句触发全表扫描，
 *   造成 30 秒级别的响应时间。
 *
 * 此迁移添加：
 *   idx_gameSession_worldId: (worldId)          — 支持 worldId IN (...) GROUP BY worldId
 *   idx_gameSession_worldId_userId: (worldId, userId) — 支持 COUNT(DISTINCT userId)
 */

async function indexExists(knex, tableName, indexName) {
  const result = await knex.raw(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND name=?",
    [tableName, indexName],
  );
  return result.length > 0;
}

exports.up = async function up(knex) {
  // worldId 单列索引（主索引）
  if (!(await indexExists(knex, "t_gameSession", "idx_gameSession_worldId"))) {
    await knex.schema.raw(
      "CREATE INDEX idx_gameSession_worldId ON t_gameSession (worldId)",
    );
    console.log("[migration] created index idx_gameSession_worldId on t_gameSession(worldId)");
  }

  // (worldId, userId) 复合索引（COUNT DISTINCT 优化）
  if (!(await indexExists(knex, "t_gameSession", "idx_gameSession_worldId_userId"))) {
    await knex.schema.raw(
      "CREATE INDEX idx_gameSession_worldId_userId ON t_gameSession (worldId, userId)",
    );
    console.log("[migration] created index idx_gameSession_worldId_userId on t_gameSession(worldId, userId)");
  }
};

exports.down = async function down(knex) {
  if (await indexExists(knex, "t_gameSession", "idx_gameSession_worldId")) {
    await knex.schema.raw("DROP INDEX idx_gameSession_worldId");
  }
  if (await indexExists(knex, "t_gameSession", "idx_gameSession_worldId_userId")) {
    await knex.schema.raw("DROP INDEX idx_gameSession_worldId_userId");
  }
};
