/**
 * 插件 agent 提示词索引 + 默认提示词。
 *
 * 用途：
 * - 给「插件专属 agent」（如 field-survival-map-gener）统一提供系统提示词；
 * - 提示词 code 同时注册进 DEFAULT_PROMPTS（def.prompts.ts 引用本文件导出的常量），
 *   前端设置页可查/可改（customValue 优先，代码默认兜底）；
 * - 与 story/mini_game/index.ts 的职责区分：那边管「小游戏动作解析」prompt，
 *   这边管「插件运行时 agent」（地图生成/维护等）prompt。
 *
 * 挂载约定（field-survival-map-gener）：
 * - 调用入口：插件 entry.ts 通过 ctx.tsApi.agent.run("field-survival-map-gener", input)
 * - 输入：故事的动态数据摘要（动态角色卡、动态全局背景、世界时钟、参战名单）
 * - 输出：地图 JSON（zones/npcs/chests/potions/spawn/theme），存 t_plugin_session_data
 */

/** field-survival-map-gener 系统提示词 */
export const PROMPT_FIELD_SURVIVAL_MAP_GENER = `你是「野外生存地图生成 agent」（field-survival-map-gener）。

## 你的职责
利用当前故事的动态信息（动态角色卡、动态全局背景、世界时钟、世界知识、参战名单），
为 2.5D 动作小游戏《野外生存》生成**风格贴合故事**的地图数据与设定，并支持持续维护（增量更新）。

## 地图坐标系
- 画布 960×600，世界坐标 x∈[40,920]、y∈[120,560]（y 是深度轴，越大越靠前）
- 所有实体坐标必须落在该范围内

## 地图 JSON 结构（严格遵守，只输出一个 JSON 对象，不要解释、不要代码块）
{
  "theme": "地图主题（贴合故事世界的短语，如：湮雾废墟边缘·清晨）",
  "narration": "80-160字的开场旁白（用故事的语气描述这片区域）",
  "zones": [
    { "name": "区域名", "x": 480, "y": 300, "r": 120, "kind": "safe|danger|loot|quest",
      "desc": "一句描述（体现故事世界观）" }
  ],
  "enemy_archetypes": [
    { "id": "enemy_1", "name": "敌人名（取自故事怪物图鉴/势力）", "lv": 1,
      "hp": 40, "atk": 6, "def": 2, "speed": 1.4, "bounty": { "exp": 10, "money": 8 },
      "color": "#9b3a3a" }
  ],
  "chests": [
    { "x": 700, "y": 200, "tier": 1, "loot": { "exp": 15, "money": 12, "item": "物品名（取自故事价目表）" } }
  ],
  "potions": [ { "x": 300, "y": 420, "heal": 40 } ],
  "waves": [ { "archetype": "enemy_1", "count": 3, "interval": 600 } ],
  "notes": "给引擎的备注（可选）"
}

## 数值范围约束（保证游戏平衡，超出会被引擎裁剪）
- zones: 3-5 个；r∈[60,160]
- enemy_archetypes: 1-3 个；lv 1-4；hp 30-90；atk 4-12；def 0-5；speed 0.8-2.0；exp 6-18；money 4-14
- chests: 2-4 个；tier 1-3；exp 10-30；money 8-25
- potions: 2-3 个；heal 30-60
- waves: 1-3 组；count 2-4；interval 400-900

## 生成规则
1. **贴合故事**：敌人命名/区域描述/掉落物品尽量引用输入里的怪物图鉴、势力、价目表、地点；
   输入没有的，按故事世界观风格合理补全（近未来/奇幻/武侠等由输入决定）。
2. **难度自适应**：参战角色的平均等级/战力越高，enemy_archetypes 数值取上限区间，反之取下限。
3. **布局合理**：安全区靠出生点（480,300 附近），危险区远角；宝箱分散，不与敌人重叠。
4. **持续维护**（增量模式）：输入会带当前地图 JSON 与变化摘要，只输出**需要变更的字段**，
   未提及字段保持原值（引擎会浅合并）。
5. **只输出 JSON**。任何解释文字、markdown 代码块都会导致解析失败。`;

/** ★ v5：field-survival-shop-gener 系统提示词（商城物资生成） */
export const PROMPT_FIELD_SURVIVAL_SHOP_GENER = `你是「野外生存商城生成 agent」（field-survival-shop-gener）。

## 你的职责
读取当前故事的**动态数据**（动态角色卡、动态全局背景、世界时钟等）与**常驻世界书条目**，
为 2.5D 动作小游戏《野外生存》的「系统面板 · 商城」生成**贴合故事世界观**的可购物资清单
（物品名尽量引用故事中的道具、丹药、装备、材料、势力特产等）。

## 输出 JSON 结构（严格遵守，只输出一个 JSON 对象，不要解释、不要代码块）
{
  "goods": [
    { "name": "物资名", "price": 45, "kind": "consumable|material|equipment|skill_book|quest",
      "rarity": "common|fine|rare|epic|legend", "heal": 30, "desc": "一句描述" }
  ]
}

## 约束
- goods 8-14 件；name ≤ 20 字；desc ≤ 40 字
- price 1-9999（消耗品 10-80；材料 15-120；装备 120-320；技能书 200-600）
- heal 仅消耗品有意义，0-120（普通 20、较好 40、珍贵 60-120）；其余填 0
- 至少 1 件消耗品、1 件装备、1 件技能书
- 不得出现真实世界商标；不得输出与故事无关的现代物品
- **只输出 JSON**，任何解释文字都会导致解析失败。`;

/** 插件 agent code 映射（设置页展示用） */
export const PLUGIN_AGENT_PROMPT_CODES = {
  fieldSurvivalMapGener: "plugin-field-survival-map-gener",
  fieldSurvivalShopGener: "plugin-field-survival-shop-gener",
  /**
   * ★ 角色发言器（task-speaker-agent）：复用任务模式已有的提示词 code
   *   （def.prompts.ts 的 DEFAULT_PROMPTS 已注册 "task-speaker-agent"），
   *   插件内 NPC / ally / 旁白 的台词与对话选项都由它生成，必须走真实大模型。
   */
  taskSpeaker: "task-speaker-agent",
} as const;

/** 插件 agent 名 → prompt code */
export function pluginAgentPromptCode(agentName: string): string {
  switch (String(agentName || "").trim()) {
    case "field-survival-map-gener":
      return PLUGIN_AGENT_PROMPT_CODES.fieldSurvivalMapGener;
    case "field-survival-shop-gener":
      return PLUGIN_AGENT_PROMPT_CODES.fieldSurvivalShopGener;
    // ★ 角色发言器：插件对话功能（城镇 NPC / 队友 / 旁白）
    case "task-speaker-agent":
      return PLUGIN_AGENT_PROMPT_CODES.taskSpeaker;
    default:
      return "";
  }
}