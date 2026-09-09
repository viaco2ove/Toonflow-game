/**
 * 迁移：t_role_memory 主体归属规范化 + 历史脏数据清理
 *
 * 背景（两个必须修的问题）：
 *
 * 1) 空串 subjectId 有广播歧义
 *    旧代码用 "" 表示"世界共享事实"，读取条件 whereIn("subjectId", [角色名, "user", ""])
 *    里空串对全体角色无条件放行。归属判定失败的漏网记录会自动广播给所有人，
 *    与"防串戏"初衷相悖。现统一改为显式占位符 "__world__"。
 *    —— 不迁移的话，所有历史世界事实会瞬间查不到。
 *
 * 2) 历史脏数据
 *    之前 @记忆管理 指令被代码侧穷举关键词硬解析成 `状态更新：「更新全部人的当前行为」`
 *    之类的句子写进了表。这不是叙事事实，是对系统的操作请求，
 *    角色读到完全无法利用，只会污染召回。准入阀只能拦新增，存量在这里一次性清掉。
 */

const WORLD_SUBJECT_ID = "__world__";

/** 元操作指令 / 结构垃圾 —— 与 RoleMemoryService.isWorthyRoleMemoryFact 保持一致 */
const JUNK_PATTERNS = [
  /@\s*记忆管理/,
  /更新\s*(全部|所有|全体)?\s*(人|角色|人员|NPC|npc)/,
  /刷新\s*(面板|状态|全部|所有|门窗|数据)?/,
  /重置\s*(面板|状态|记忆|数据)?/,
  /同步\s*(全部|所有|数据)?/,
  /重新\s*(计算|生成|统计|整理|汇总)/,
  /重算/,
  /清理\s*(记忆|缓存|数据)?/,
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable("t_role_memory"))) return;

  // 1) 删脏：元操作指令 + 旧版硬写的状态更新句 + 过短碎片
  const rows = await knex("t_role_memory").select("id", "content");
  const junkIds = rows
    .filter((row) => {
      const text = String(row.content || "").trim();
      if (!text || text.length < 6) return true;
      if (JUNK_PATTERNS.some((re) => re.test(text))) return true;
      // 旧版硬写格式：状态更新：「xxx」
      if (/^状态更新[：:]/.test(text)) return true;
      if (/[{}\[\]"]|playerCardPatch|player_card_patch|summary\s*[:：]|facts\s*[:：]/.test(text)) return true;
      return false;
    })
    .map((row) => Number(row.id))
    .filter(Boolean);

  if (junkIds.length) {
    await knex("t_role_memory").whereIn("id", junkIds).del();
    console.log(`[migration] removed ${junkIds.length} junk row(s) from t_role_memory`);
  }

  // 2) 归属迁移：空串 → __world__
  const affected = await knex("t_role_memory")
    .where((builder) => {
      builder.whereNull("subjectId").orWhere("subjectId", "");
    })
    .update({ subjectId: WORLD_SUBJECT_ID });

  if (affected) {
    console.log(`[migration] normalized ${affected} row(s) subjectId -> ${WORLD_SUBJECT_ID}`);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable("t_role_memory"))) return;
  // 回滚：__world__ 还原为空串（脏数据删了就恢复不回来了）
  await knex("t_role_memory").where("subjectId", WORLD_SUBJECT_ID).update({ subjectId: "" });
};
