/**
 * 迁移：t_config 表增加语音合成「分段」配置字段
 *
 * 用途：TTS 模型配置支持显式配置待合成文本的切分方式：
 * - segmentMode：分段模式。"punctuation"=按标点符号（每句单独合成，默认）；
 *   "chars"=按字数（流式播放时攒批到 segmentChars 字再合成一次）
 * - segmentChars：按字数模式下的字数上限（默认 100，前端兜底）
 *
 * 两个字段均可空：为空时前端按默认值（punctuation / 100）处理，存量配置行为不变。
 * 仅对 type="voice" 且 modelType="tts" 的配置行有意义，其他类型写入也会被忽略。
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn("t_config", "segmentMode"))) {
    await knex.schema.alterTable("t_config", (table) => {
      table.text("segmentMode"); // 分段模式：punctuation=按标点符号 / chars=按字数
    });
    console.log("[migration] added column t_config.segmentMode");
  }
  if (!(await knex.schema.hasColumn("t_config", "segmentChars"))) {
    await knex.schema.alterTable("t_config", (table) => {
      table.integer("segmentChars"); // 按字数模式的字数上限（默认 100）
    });
    console.log("[migration] added column t_config.segmentChars");
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn("t_config", "segmentMode")) {
    await knex.schema.alterTable("t_config", (table) => {
      table.dropColumn("segmentMode");
    });
  }
  if (await knex.schema.hasColumn("t_config", "segmentChars")) {
    await knex.schema.alterTable("t_config", (table) => {
      table.dropColumn("segmentChars");
    });
  }
};
