/**
 * 迁移：为 t_sessionMessage 添加 (sessionId) 索引
 *
 * 问题背景：
 *   /game/listSession 用关联子查询取每个会话的最后一条消息：
 *     SELECT ... FROM t_sessionMessage m1
 *     WHERE m1.sessionId IN (...) AND m1.id = (
 *       SELECT MAX(m2.id) FROM t_sessionMessage m2 WHERE m2.sessionId = m1.sessionId
 *     )
 *   t_sessionMessage 上没有任何 sessionId 索引 → 内层子查询对每行都做全表扫描。
 *   实测（2026-11-16）：2019 行消息、60 个会话 → 该查询单独耗时 913ms，
 *   导致 listSession 接口整体 1.3s。
 *
 * 此迁移添加：
 *   idx_sessionMessage_sessionId: (sessionId)      — 支持 sessionId IN (...) 过滤
 *   idx_sessionMessage_sessionId_id: (sessionId, id) — 支持 MAX(id) 的每会话最新消息定位
 */

async function indexExists(knex, tableName, indexName) {
  const result = await knex.raw(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND name=?",
    [tableName, indexName],
  );
  return result.length > 0;
}

exports.up = async function up(knex) {
  if (!(await indexExists(knex, "t_sessionMessage", "idx_sessionMessage_sessionId"))) {
    await knex.schema.raw(
      "CREATE INDEX IF NOT EXISTS idx_sessionMessage_sessionId ON t_sessionMessage (sessionId)",
    );
    console.log("[migration] created index idx_sessionMessage_sessionId on t_sessionMessage(sessionId)");
  }

  if (!(await indexExists(knex, "t_sessionMessage", "idx_sessionMessage_sessionId_id"))) {
    await knex.schema.raw(
      "CREATE INDEX IF NOT EXISTS idx_sessionMessage_sessionId_id ON t_sessionMessage (sessionId, id)",
    );
    console.log("[migration] created index idx_sessionMessage_sessionId_id on t_sessionMessage(sessionId, id)");
  }
};

exports.down = async function down(knex) {
  if (await indexExists(knex, "t_sessionMessage", "idx_sessionMessage_sessionId_id")) {
    await knex.schema.raw("DROP INDEX idx_sessionMessage_sessionId_id");
  }
  if (await indexExists(knex, "t_sessionMessage", "idx_sessionMessage_sessionId")) {
    await knex.schema.raw("DROP INDEX idx_sessionMessage_sessionId");
  }
};