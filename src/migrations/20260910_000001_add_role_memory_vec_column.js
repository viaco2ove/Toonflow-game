/**
 * 迁移：给 t_role_memory 补 vec 列（P2 向量召回）
 *
 * m3e-small 512d float32 → 512 * 4 = 2048 bytes，VARBINARY(2048) 够存。
 * 建列时默认 NULL（老数据可继续用 SQL 排序）；写入侧 vectorize 后补值。
 * 索引已在 P1 迁移中建好，无需再增。
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasColumn("t_role_memory", "vec")) return;

  // VARBINARY(2048) = 512 float32 * 4 bytes
  await knex.schema.raw(
    "ALTER TABLE t_role_memory ADD COLUMN vec VARBINARY(2048) DEFAULT NULL"
  );

  console.log("[migration] added column t_role_memory.vec");
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn("t_role_memory", "vec")) {
    await knex.schema.raw("ALTER TABLE t_role_memory DROP COLUMN vec");
  }
};
