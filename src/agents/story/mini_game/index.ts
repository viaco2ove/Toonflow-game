/**
 * 小游戏 Agent 提示词索引。
 *
 * 用途：
 * - 给设置页和运行时统一提供小游戏 prompt code 映射；
 * - 避免 Web、安卓、后端各自维护一份小游戏 prompt 名称，后续新增小游戏时更容易漏改。
 */
export const STORY_MINI_GAME_PROMPT_CODES = {
  router: "story-mini-game",
  battle: "story-mini-game-battle",
  fishing: "story-mini-game-fishing",
  werewolf: "story-mini-game-werewolf",
  cultivation: "story-mini-game-cultivation",
  mining: "story-mini-game-mining",
  researchSkill: "story-mini-game-research-skill",
  alchemy: "story-mini-game-alchemy",
  upgradeEquipment: "story-mini-game-upgrade-equipment",
} as const;

/**
 * 读取小游戏类型对应的专属提示词 code。
 *
 * 用途：
 * - 不同小游戏的自然语言理解重点不同；
 * - 这里统一负责从游戏类型映射到专属 prompt，未覆盖的类型回退到总路由 prompt。
 */
export function miniGamePromptCodeByType(gameType: string): string {
  switch (String(gameType || "").trim()) {
    case "battle":
      return STORY_MINI_GAME_PROMPT_CODES.battle;
    case "fishing":
      return STORY_MINI_GAME_PROMPT_CODES.fishing;
    case "werewolf":
      return STORY_MINI_GAME_PROMPT_CODES.werewolf;
    case "cultivation":
      return STORY_MINI_GAME_PROMPT_CODES.cultivation;
    case "mining":
      return STORY_MINI_GAME_PROMPT_CODES.mining;
    case "research_skill":
      return STORY_MINI_GAME_PROMPT_CODES.researchSkill;
    case "alchemy":
      return STORY_MINI_GAME_PROMPT_CODES.alchemy;
    case "upgrade_equipment":
      return STORY_MINI_GAME_PROMPT_CODES.upgradeEquipment;
    default:
      return STORY_MINI_GAME_PROMPT_CODES.router;
  }
}
