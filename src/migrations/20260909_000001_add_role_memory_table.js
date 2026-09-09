/**
 * 迁移：新建 t_role_memory 角色专属记忆表（P1）
 *
 * 用途：角色发言（NpcSpeaker）时按角色过滤注入「角色专属记忆」。
 * 数据来源：SessionMemoryWorker / scheduleSessionMemoryRefresh 凝练出的事实句，
 *          写入时带 subjectId（发言人角色 id / 'user' / '' 全局），查询时按
 *          storyId + subjectId 过滤，解决 memoryFacts 12 条硬截断 + 全员共享的失忆问题。
 *
 * P2 扩展预留：vec 列暂不建（m3e-small 512d float32 BLOB），等向量召回落地时再
 * 通过 alterTable 补列，避免提前引入无人读取的空列。
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable("t_role_memory")) return;

  await knex.schema.createTable("t_role_memory", function (table) {
    table.increments("id").primary();
    table.text("sessionId").notNullable();          // 产生该记忆的会话
    table.text("storyId").notNullable();            // 世界/故事 id，跨会话共享
    table.text("chapterId");                        // 章节 id，跨章节查询用（可空）
    table.text("subjectType");                      // npc_self | user | world | relation
    table.text("subjectId");                        // 角色 id / 'user' / ''(全局)
    table.text("content").notNullable();            // 凝练事实句，≤80 字
    table.integer("importance").defaultTo(3);       // 1-5，查询排序权重
    table.integer("sourceTurn");                    // 来源轮次（eventIndex）
    table.bigInteger("createdAt");                  // 写入时间 ms
    table.bigInteger("lastHitAt");                  // 最近一次被发言器命中的时间
    table.integer("hitCount").defaultTo(0);         // 累计命中次数
  });

  await knex.schema.raw(
    "CREATE INDEX IF NOT EXISTS idx_role_memory_scope ON t_role_memory (storyId, subjectId)"
  );
  await knex.schema.raw(
    "CREATE INDEX IF NOT EXISTS idx_role_memory_session ON t_role_memory (sessionId)"
  );

  console.log("[migration] created table t_role_memory + indexes");
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable("t_role_memory")) {
    await knex.schema.dropTable("t_role_memory");
  }
};
