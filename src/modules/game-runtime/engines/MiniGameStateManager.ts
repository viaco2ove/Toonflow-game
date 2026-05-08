/**
 * 小游戏状态管理器
 *
 * 职责：
 * 1. 小游戏模式判断（是否在小游戏中）
 * 2. 小游戏阶段管理（当前处于哪个阶段）
 * 3. 小游戏配置管理（所有小游戏的定义）
 * 4. 小游戏台词管理（生成规则说明台词）
 * 打上log tag 输出 用户进入小游戏回合， 规则说明回合。用户回合，陪练回合,
 *   播报回合，敌方攻击回合，小游戏规程性退出回合，小游戏#退出回合。
 */

import { z } from "zod";

/** 小游戏回合日志标签 */
export const MINI_GAME_LOG_TAGS = {
  USER_ENTER: "[mini_game:user:enter]",      // 用户进入小游戏回合
  RULE_BOOK: "[mini_game:rule_book]",        // 规则说明回合
  USER_TURN: "[mini_game:user_turn]",        // 用户回合
  MENTOR_TURN: "[mini_game:mentor_turn]",    // 陪练回合
  NARRATION: "[mini_game:narration]",        // 播报回合
  ENEMY_TURN: "[mini_game:enemy_turn]",      // 敌方攻击回合
  SETTLING: "[mini_game:settling]",          // 规程性退出回合
  USER_ABORT: "[mini_game:user_abort]",      // 用户#退出回合
} as const;

/** 小游戏回合类型 */
export type MiniGameTurnType =
  | "user_enter"      // 用户进入小游戏回合
  | "rule_book"       // 规则说明回合
  | "user_turn"       // 用户回合
  | "mentor_turn"     // 陪练回合
  | "narration"       // 播报回合
  | "enemy_turn"      // 敌方攻击回合
  | "settling"        // 规程性退出回合
  | "user_abort";     // 用户#退出回合

/** 小游戏状态 */
export type MiniGameStatus = "idle" | "preparing" | "active" | "settling" | "finished" | "aborted" | "suspended";

/** 小游戏阶段事件类型 */
export const MINI_GAME_EVENT_TYPES = {
  MINI_GAME_START: "on_mini_game_start",     // 小游戏开场（规则说明）
  MINI_GAME: "on_mini_game",                  // 小游戏回合
  MINI_GAME_STATUS: "on_mini_game_status",   // 小游戏状态查询
  MINI_GAME_RULE: "on_mini_game_rule",       // 小游戏规则
  MINI_GAME_ABORT: "on_mini_game_abort",      // 小游戏退出
} as const;

/** 小游戏阶段配置 */
export interface MiniGamePhaseConfig {
  /** 阶段标识 */
  phase: string;
  /** 阶段名称 */
  name: string;
  /** 是否需要用户输入 */
  requiresUserInput: boolean;
  /** 是否触发台词生成 */
  triggersNarration: boolean;
}

/** 小游戏配置 */
export interface MiniGameConfig {
  /** 游戏类型唯一标识 */
  gameType: string;
  /** 显示名称 */
  displayName: string;
  /** 版本 */
  version: string;
  /** 游戏目标 */
  goal: string;
  /** 阶段顺序 */
  phaseOrder: string[];
  /** 触发标签（如 #挖矿） */
  triggerTags: string[];
  /** 被动触发模式 */
  passivePatterns: string[];
  /** 规则摘要 */
  ruleSummary: string;
  /** 完整规则说明 */
  rulebookNarration: string;
}

/** 小游戏状态信息 */
export interface MiniGameStateInfo {
  /** 是否在小游戏模式 */
  isActive: boolean;
  /** 游戏类型 */
  gameType: string | null;
  /** 显示名称 */
  displayName: string | null;
  /** 当前阶段 */
  phase: string | null;
  /** 阶段名称 */
  phaseName: string | null;
  /** 游戏状态 */
  status: MiniGameStatus;
  /** 是否有待处理的编排计划 */
  hasPendingPlan: boolean;
}

/** 小游戏回合信息 */
export interface MiniGameTurnInfo {
  /** 用户输入 */
  userInput: string;
  /** 当前事件类型 */
  eventType: string;
  /** 当前回合阶段 */
  phase: string;
  /** 是否在小游戏模式 */
  isMiniGameMode: boolean;
}

/** 小游戏编排结果 */
export interface MiniGameOrchestrationResult {
  /** 是否拦截了消息 */
  intercepted: boolean;
  /** 事件类型 */
  eventType: string;
  /** 台词内容 */
  narration: string;
  /** 是否是小游戏开场 */
  isStart: boolean;
  /** 是否是小游戏结束 */
  isEnd: boolean;
  /** 是否需要用户输入 */
  awaitUser: boolean;
  /** 下一个小游戏阶段 */
  nextPhase: string | null;
}

/** 小游戏台词生成结果 */
export interface MiniGameNarrationResult {
  /** 旁白内容 */
  content: string;
  /** 事件类型 */
  eventType: string;
  /** 角色 */
  role: string;
  /** 角色类型 */
  roleType: string;
}

/**
 * 小游戏状态管理器
 */
export class MiniGameStateManager {
  private static instance: MiniGameStateManager;

  /** 所有小游戏配置 */
  private configs: Map<string, MiniGameConfig> = new Map();

  private constructor() {
    this.registerDefaultConfigs();
  }

  /** 获取单例实例 */
  static getInstance(): MiniGameStateManager {
    if (!MiniGameStateManager.instance) {
      MiniGameStateManager.instance = new MiniGameStateManager();
    }
    return MiniGameStateManager.instance;
  }

  /**
   * 注册默认的小游戏配置
   */
  private registerDefaultConfigs(): void {
    const defaultConfigs: MiniGameConfig[] = [
      {
        gameType: "mining",
        displayName: "挖矿",
        version: "1.0",
        goal: "在风险可控的前提下尽量带走矿石与稀有产物",
        phaseOrder: ["survey", "excavate", "risk_check", "haul", "settling"],
        triggerTags: ["#挖矿"],
        passivePatterns: ["挖矿", "采矿", "下矿"],
        ruleSummary: "首次进入默认折叠面板，旁白询问目标矿物与是否需要陪练。挖矿获得目标矿物，并有概率获得宝物。",
        rulebookNarration: "挖矿规则：首次进入默认折叠面板，旁白询问目标矿物与是否需要陪练。挖矿获得目标矿物，并有概率获得宝物。输入 #挖矿 即可开始挖矿，输入 #退出 可以强制退出小游戏。",
      },
      {
        gameType: "fishing",
        displayName: "钓鱼",
        version: "1.0",
        goal: "抛竿后立即结算，看看能否钓到鱼或宝物",
        phaseOrder: ["prepare", "waiting", "result", "settling"],
        triggerTags: ["#钓鱼"],
        passivePatterns: ["钓鱼", "去钓鱼", "开始钓鱼", "抛竿"],
        ruleSummary: "直接输入\"抛竿\"\"收杆\"\"继续钓鱼\"等动作。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。",
        rulebookNarration: "钓鱼规则：直接输入\"抛竿\"\"收杆\"\"继续钓鱼\"等动作。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。输入 #钓鱼 即可开始钓鱼，输入 #退出 可以强制退出小游戏。",
      },
      {
        gameType: "alchemy",
        displayName: "炼药",
        version: "1.0",
        goal: "输入炼药方案，由系统判断是否成丹并写回物品与参数卡",
        phaseOrder: ["await_input", "result", "settling"],
        triggerTags: ["#炼药"],
        passivePatterns: ["炼药", "炼丹", "开炉炼药"],
        ruleSummary: "用户默认拥有回复丹药方（lv1）与药草提纯术（lv1）。只能炼制不高于自身等级的丹药，每次炼药消耗1金币。",
        rulebookNarration: "炼药规则：用户默认拥有回复丹药方（lv1）与药草提纯术（lv1）。只能炼制不高于自身等级的丹药，每次炼药消耗1金币。输入 #炼药 即可开始炼药，输入 #退出 可以强制退出小游戏。",
      },
      {
        gameType: "battle",
        displayName: "战斗",
        version: "1.0",
        goal: "击败当前全部敌人，并结算战利品、金钱与升级收益",
        phaseOrder: ["encounter", "settling"],
        triggerTags: ["#战斗", "#对战"],
        passivePatterns: ["对战", "战斗", "迎战", "开打", "交手"],
        ruleSummary: "输入 #战斗 目标 进入战斗。战斗开始后只通过文字输入动作推进，不再使用按钮式面板操作。",
        rulebookNarration: "战斗规则：通过文字输入攻击、技能、防御和回气推进战斗。系统会实时更新敌我血量与法力；击败全部敌人后会结算战利品、金钱、升级概率，并在战后恢复用户血量与法力。输入 #战斗 目标 进入战斗，输入 #退出 可以强制退出小游戏。",
      },
      {
        gameType: "cultivation",
        displayName: "修炼",
        version: "1.0",
        goal: "通过灵气、感悟与稳定度管理完成突破或平稳收功",
        phaseOrder: ["gather_qi", "circulate", "breakthrough", "settling"],
        triggerTags: ["#修炼"],
        passivePatterns: ["修炼", "开始修炼", "闭关", "冲关"],
        ruleSummary: "围绕灵气、感悟、稳定与疲劳做管理。贸然冲关会提高偏差风险。",
        rulebookNarration: "修炼规则：围绕灵气、感悟、稳定与疲劳做管理。贸然冲关会提高偏差风险。输入 #修炼 即可开始修炼，输入 #退出 可以强制退出小游戏。",
      },
      {
        gameType: "research_skill",
        displayName: "研发技能",
        version: "1.0",
        goal: "输入技能研发方案，由系统判断是否成功并写回角色参数",
        phaseOrder: ["await_input", "result", "settling"],
        triggerTags: ["#研发技能"],
        passivePatterns: ["研发技能", "研发技能", "自创招式", "开发技能"],
        ruleSummary: "首次进入默认折叠面板，旁白询问研发技能与是否需要陪练。每次消耗5金币；与已有技能/物品关联越强，成功率越高。",
        rulebookNarration: "研发技能规则：首次进入默认折叠面板，旁白询问研发技能与是否需要陪练。每次消耗5金币；与已有技能/物品关联越强，成功率越高。输入 #研发技能 即可开始研发，输入 #退出 可以强制退出小游戏。",
      },
      {
        gameType: "upgrade_equipment",
        displayName: "升级装备",
        version: "1.0",
        goal: "输入装备强化方案，由系统判断升级结果并写回装备参数",
        phaseOrder: ["await_input", "result", "settling"],
        triggerTags: ["#升级装备"],
        passivePatterns: ["升级装备", "强化装备", "锻造装备"],
        ruleSummary: "首次进入默认折叠面板，旁白询问要升级的装备与是否需要协助。装备升级消耗矿石/强化石和1金币；技能升级消耗20金币。",
        rulebookNarration: "升级装备规则：首次进入默认折叠面板，旁白询问要升级的装备和是否需要协助。装备升级需要矿石/强化石和1金币，等级不能超过用户等级和装备强化术等级；技能升级消耗20金币。输入 #升级装备 即可开始升级，输入 #退出 可以强制退出小游戏。",
      },
      {
        gameType: "werewolf",
        displayName: "狼人杀",
        version: "1.0",
        goal: "完成一局 5 人标准狼人杀",
        phaseOrder: ["setup", "night_wolf", "night_seer", "night_witch", "day_announce", "day_discussion", "day_vote", "settling"],
        triggerTags: ["#狼人杀"],
        passivePatterns: ["狼人杀", "来一局狼人杀", "玩狼人杀", "提议狼人杀"],
        ruleSummary: "5人标准局。夜间按身份行动，白天讨论投票。所有狼人出局则村民胜；狼人数量大于等于其他存活人数则狼人胜。",
        rulebookNarration: "狼人杀规则：5人标准局。夜间按身份行动，白天讨论投票。所有狼人出局则村民胜；狼人数量大于等于其他存活人数则狼人胜。输入 #狼人杀 即可开始游戏，输入 #退出 可以强制退出小游戏。",
      },
    ];

    for (const config of defaultConfigs) {
      this.configs.set(config.gameType, config);
    }
  }

  /**
   * 注册新的小游戏配置
   */
  registerConfig(config: MiniGameConfig): void {
    this.configs.set(config.gameType, config);
  }

  /**
   * 获取小游戏配置
   */
  getConfig(gameType: string): MiniGameConfig | undefined {
    return this.configs.get(gameType);
  }

  /**
   * 获取所有小游戏配置
   */
  getAllConfigs(): MiniGameConfig[] {
    return Array.from(this.configs.values());
  }

  /**
   * 根据触发标签获取小游戏配置
   */
  getConfigByTriggerTag(tag: string): MiniGameConfig | undefined {
    for (const config of this.configs.values()) {
      if (config.triggerTags.includes(tag)) {
        return config;
      }
    }
    return undefined;
  }

  /**
   * 检测用户输入触发了哪个小游戏
   * 只匹配作为独立命令出现的 #标签，禁止普通对话中的嵌入文本误触发
   */
  detectGameType(userInput: string): string | null {
    const trimmed = userInput.trim();
    /** 判断 tag 是否作为独立命令出现（前面是起始或空白） */
    const isStandaloneTag = (tag: string): boolean => {
      const idx = trimmed.indexOf(tag);
      if (idx < 0) return false;
      const charBefore = idx > 0 ? trimmed[idx - 1] : "";
      if (charBefore && !/\s/.test(charBefore)) return false;
      return true;
    };
    for (const config of this.configs.values()) {
      if (config.triggerTags.some(isStandaloneTag)) {
        return config.gameType;
      }
    }
    return null;
  }

  /**
   * 判断是否为小游戏模式（基于 pendingNarrativePlan）
   */
  isMiniGameMode(state: Record<string, any>): boolean {
    const pendingPlan = state?.pendingNarrativePlan;
    if (!pendingPlan || typeof pendingPlan !== "object") {
      return false;
    }
    const eventType = String(pendingPlan.eventType || "");
    return [MINI_GAME_EVENT_TYPES.MINI_GAME_START, MINI_GAME_EVENT_TYPES.MINI_GAME, MINI_GAME_EVENT_TYPES.MINI_GAME_STATUS, MINI_GAME_EVENT_TYPES.MINI_GAME_RULE].includes(eventType as any);
  }

  /**
   * 从 state.miniGame 获取小游戏状态信息
   */
  getMiniGameStateInfo(state: Record<string, any>): MiniGameStateInfo {
    const root = state?.miniGame;
    const rulebook = root?.rulebook;
    const session = root?.session;
    const pendingPlan = state?.pendingNarrativePlan;

    const gameType = rulebook?.gameType || null;
    const config = gameType ? this.getConfig(gameType) : null;
    const phase = session?.phase || null;

    return {
      isActive: Boolean(rulebook && Object.keys(rulebook).length > 0),
      gameType,
      displayName: config?.displayName || rulebook?.displayName || null,
      phase,
      phaseName: phase ? this.getPhaseName(gameType, phase) : null,
      status: (session?.status as MiniGameStatus) || "idle",
      hasPendingPlan: Boolean(pendingPlan && Object.keys(pendingPlan).length > 0),
    };
  }

  /**
   * 获取阶段名称
   */
  getPhaseName(gameType: string | null, phase: string): string {
    if (!gameType) return phase;

    const phaseNames: Record<string, Record<string, string>> = {
      mining: {
        survey: "勘察阶段",
        excavate: "挖掘阶段",
        risk_check: "风险检查",
        haul: "搬运阶段",
        settling: "结算阶段",
      },
      fishing: {
        prepare: "准备阶段",
        waiting: "等待阶段",
        result: "结果阶段",
        settling: "结算阶段",
      },
      alchemy: {
        await_input: "等待输入",
        result: "炼药结果",
        settling: "结算阶段",
      },
      battle: {
        encounter: "遭遇战斗",
        settling: "战斗结算",
      },
      cultivation: {
        gather_qi: "聚气阶段",
        circulate: "运转阶段",
        breakthrough: "突破阶段",
        settling: "结算阶段",
      },
      research_skill: {
        await_input: "等待研发方案",
        result: "研发结果",
        settling: "结算阶段",
      },
      upgrade_equipment: {
        await_input: "等待升级方案",
        result: "升级结果",
        settling: "结算阶段",
      },
      werewolf: {
        setup: "游戏设置",
        night_wolf: "狼人夜晚",
        night_seer: "预言家夜晚",
        night_witch: "女巫夜晚",
        day_announce: "白天宣布",
        day_discussion: "白天讨论",
        day_vote: "白天投票",
        settling: "结算阶段",
      },
    };

    return phaseNames[gameType]?.[phase] || phase;
  }

  /**
   * 获取小游戏开场台词（规则说明）
   */
  getRulebookNarration(gameType: string): string {
    const config = this.getConfig(gameType);
    if (config) {
      return config.rulebookNarration;
    }
    return `${gameType}规则：输入对应命令开始小游戏，输入 #退出 可以强制退出。`;
  }

  /**
   * 获取小游戏回合台词
   */
  getTurnNarration(gameType: string, phase: string, context: Record<string, any>): string {
    const config = this.getConfig(gameType);
    if (!config) {
      return "小游戏进行中...";
    }

    // 根据不同游戏类型和阶段生成不同台词
    switch (gameType) {
      case "mining":
        return this.getMiningTurnNarration(phase, context);
      case "fishing":
        return this.getFishingTurnNarration(phase, context);
      case "battle":
        return this.getBattleTurnNarration(phase, context);
      default:
        return `当前阶段：${this.getPhaseName(gameType, phase)}`;
    }
  }

  /**
   * 挖矿回合台词
   */
  private getMiningTurnNarration(phase: string, context: Record<string, any>): string {
    const narrations: Record<string, string> = {
      survey: "你仔细观察矿脉，评估矿石分布情况...",
      excavate: "你挥动矿镐，开始挖掘...",
      risk_check: "矿洞传来低沉的震动，需要小心...",
      haul: "你将开采的矿石装入背包...",
      settling: "本次挖矿结束，正在结算收获...",
    };
    return narrations[phase] || "挖矿进行中...";
  }

  /**
   * 钓鱼回合台词
   */
  private getFishingTurnNarration(phase: string, context: Record<string, any>): string {
    const narrations: Record<string, string> = {
      prepare: "你整理渔具，准备抛竿...",
      waiting: "鱼漂静静漂浮在水面上...",
      result: "你收竿查看收获...",
      settling: "钓鱼结束，正在结算...",
    };
    return narrations[phase] || "钓鱼进行中...";
  }

  /**
   * 战斗回合台词
   */
  private getBattleTurnNarration(phase: string, context: Record<string, any>): string {
    const narrations: Record<string, string> = {
      encounter: "遭遇敌人，战斗开始！",
      settling: "战斗结束，正在结算战利品...",
    };
    return narrations[phase] || "战斗进行中...";
  }

  /**
   * 判断是否应该触发开场事件
   */
  shouldTriggerStartEvent(state: Record<string, any>, userInput: string): boolean {
    const gameType = this.detectGameType(userInput);
    if (!gameType) return false;

    // 检查是否已经在小游戏中
    const currentInfo = this.getMiniGameStateInfo(state);
    if (currentInfo.isActive) {
      return false;
    }

    return true;
  }

  /** 判断是否应该触发退出（仅 #退出 / #exit 命令，不带 # 前缀的"退出"不触发） */
  shouldTriggerAbort(userInput: string, state: Record<string, any>): boolean {
    const trimmed = userInput.trim().toLowerCase();
    if (trimmed === "#退出" || trimmed === "#exit") {
      return true;
    }
    return false;
  }

  /**
   * 构建小游戏状态摘要
   */
  buildMiniGameStateSummary(state: Record<string, any>): string {
    const info = this.getMiniGameStateInfo(state);
    if (!info.isActive) {
      return "当前不在小游戏中";
    }

    const parts: string[] = [];
    parts.push(`游戏：${info.displayName || info.gameType}`);

    if (info.phaseName) {
      parts.push(`阶段：${info.phaseName}`);
    }

    if (info.status) {
      parts.push(`状态：${info.status}`);
    }

    return parts.join(" | ");
  }

  /**
   * 小游戏编排入口
   *
   * 职责：
   * 1. 检测用户输入是否触发小游戏
   * 2. 判断小游戏状态（开场/进行中/结束）
   * 3. 生成对应的 pendingNarrativePlan
   */
  orchestrateMiniGame(
    state: Record<string, any>,
    userInput: string,
    miniGameResult: { pendingPlan?: any; isEnd?: boolean; messages?: any[] } | null,
  ): MiniGameOrchestrationResult | null {
    // 检测是否触发小游戏
    const gameType = this.detectGameType(userInput);
    const stateInfo = this.getMiniGameStateInfo(state);

    // 判断是否退出
    if (this.shouldTriggerAbort(userInput, state)) {
      const result = this.buildAbortNarration();
      this.logMiniGameTurn("user_abort", {
        gameType: stateInfo.gameType,
        displayName: stateInfo.displayName,
        userInput,
      });
      return result;
    }

    // 如果有小游戏结果（来自 MiniGameController）
    if (miniGameResult?.pendingPlan) {
      const result = this.buildNarrationFromPlan(miniGameResult.pendingPlan);
      const turnType = this.detectTurnType(state, userInput, result);
      this.logMiniGameTurn(turnType, {
        gameType: stateInfo.gameType,
        displayName: stateInfo.displayName,
        phase: stateInfo.phase,
        userInput,
        eventType: result.eventType,
      });
      return result;
    }

    // 如果触发了新小游戏
    if (gameType && !stateInfo.isActive) {
      const result = this.buildStartNarration(gameType);
      const config = this.getConfig(gameType);
      // 用户进入 + 规则说明
      this.logMiniGameTurn("user_enter", {
        gameType,
        displayName: config?.displayName,
      });
      this.logMiniGameTurn("rule_book", {
        gameType,
        displayName: config?.displayName,
      });
      return result;
    }

    return null;
  }

  /**
   * 构建小游戏开场编排
   */
  private buildStartNarration(gameType: string): MiniGameOrchestrationResult {
    const config = this.getConfig(gameType);
    const rulebookNarration = config?.rulebookNarration || this.getRulebookNarration(gameType);

    return {
      intercepted: true,
      eventType: MINI_GAME_EVENT_TYPES.MINI_GAME_START,
      narration: rulebookNarration,
      isStart: true,
      isEnd: false,
      awaitUser: true,
      nextPhase: config?.phaseOrder?.[0] || null,
    };
  }

  /**
   * 构建小游戏退出编排
   */
  private buildAbortNarration(): MiniGameOrchestrationResult {
    return {
      intercepted: true,
      eventType: MINI_GAME_EVENT_TYPES.MINI_GAME_ABORT,
      narration: "你已强制退出小游戏，当前可继续回到主线剧情。",
      isStart: false,
      isEnd: true,
      awaitUser: false,
      nextPhase: null,
    };
  }

  /**
   * 从 pendingPlan 构建编排结果
   */
  private buildNarrationFromPlan(pendingPlan: any): MiniGameOrchestrationResult {
    const eventType = pendingPlan.eventType || MINI_GAME_EVENT_TYPES.MINI_GAME;

    return {
      intercepted: true,
      eventType,
      narration: pendingPlan.presetContent || pendingPlan.motive || "",
      isStart: eventType === MINI_GAME_EVENT_TYPES.MINI_GAME_START,
      isEnd: eventType === MINI_GAME_EVENT_TYPES.MINI_GAME_ABORT,
      awaitUser: pendingPlan.awaitUser ?? true,
      nextPhase: null,
    };
  }

  /**
   * 生成小游戏台词
   *
   * 职责：
   * 1. 根据当前阶段生成合适的旁白台词
   * 2. 包含规则说明播报
   * 3. 回合结果播报
   */
  generateMiniGameNarration(
    state: Record<string, any>,
    orchestration: MiniGameOrchestrationResult,
  ): MiniGameNarrationResult {
    const info = this.getMiniGameStateInfo(state);

    return {
      content: orchestration.narration,
      eventType: orchestration.eventType,
      role: "旁白",
      roleType: "narrator",
    };
  }

  /**
   * 构建小游戏的 pendingNarrativePlan
   * 用于存入 state.pendingNarrativePlan
   */
  buildPendingNarrativePlan(orchestration: MiniGameOrchestrationResult): Record<string, any> {
    return {
      role: "旁白",
      roleType: "narrator",
      motive: orchestration.narration,
      presetContent: orchestration.narration,
      awaitUser: orchestration.awaitUser,
      eventType: orchestration.eventType,
      source: "mini_game",
    };
  }

  /**
   * 获取当前小游戏阶段的下一个小游戏阶段
   */
  getNextPhase(gameType: string, currentPhase: string): string | null {
    const config = this.getConfig(gameType);
    if (!config) return null;

    const phases = config.phaseOrder;
    const currentIndex = phases.indexOf(currentPhase);
    if (currentIndex === -1 || currentIndex >= phases.length - 1) {
      return null;
    }

    return phases[currentIndex + 1];
  }

  /**
   * 判断小游戏是否结束
   */
  isMiniGameEnded(gameType: string, phase: string): boolean {
    const config = this.getConfig(gameType);
    if (!config) return true;

    // settling 是结算阶段，表示小游戏结束
    return phase === "settling";
  }

  /**
   * 根据编排结果判断回合类型
   */
  detectTurnType(
    state: Record<string, any>,
    userInput: string,
    orchestration: MiniGameOrchestrationResult | null,
  ): MiniGameTurnType {
    // 用户输入 #退出
    if (this.shouldTriggerAbort(userInput, state)) {
      return "user_abort";
    }

    // 新触发小游戏 → 用户进入 + 规则说明
    if (orchestration?.isStart) {
      return "rule_book";
    }

    // 结算阶段
    if (orchestration?.eventType === MINI_GAME_EVENT_TYPES.MINI_GAME_ABORT) {
      return "settling";
    }

    // 从 pendingPlan 获取详细信息
    const pendingPlan = state?.pendingNarrativePlan;
    const eventType = pendingPlan?.eventType || "";
    const currentPhase = state?.miniGame?.session?.phase || "";

    // 播报回合（战斗敌方攻击等系统回合）
    if (eventType === "battle_enemy_turn" || eventType === "enemy_turn") {
      return "enemy_turn";
    }

    // 陪练回合（mentor 介入）
    if (eventType === "mentor_turn" || pendingPlan?.mentorTurn) {
      return "mentor_turn";
    }

    // 播报回合（正常回合结果播报）
    if (eventType === MINI_GAME_EVENT_TYPES.MINI_GAME || eventType === "on_mini_game") {
      // 检查是否是战斗遭遇阶段
      if (currentPhase === "encounter" || currentPhase === "result") {
        return "narration";
      }
      // 挖掘、风险检查、搬运等阶段都是播报回合
      if (["excavate", "risk_check", "haul", "survey"].includes(currentPhase)) {
        return "narration";
      }
      return "narration";
    }

    // 用户回合（等待用户输入）
    if (orchestration?.awaitUser && !orchestration?.isStart) {
      return "user_turn";
    }

    // 默认：用户回合
    return "user_turn";
  }

  /**
   * 输出小游戏回合日志
   */
  logMiniGameTurn(
    turnType: MiniGameTurnType,
    context: {
      gameType?: string | null;
      displayName?: string | null;
      phase?: string | null;
      userInput?: string;
      eventType?: string;
    },
  ): void {
    const tags = MINI_GAME_LOG_TAGS;
    const { gameType, displayName, phase, userInput, eventType } = context;

    const gameInfo = displayName || gameType || "未知小游戏";
    const phaseInfo = phase || "";

    switch (turnType) {
      case "user_enter":
        console.log(`${tags.USER_ENTER} 用户进入小游戏: ${gameInfo} (${gameType})`);
        break;
      case "rule_book":
        console.log(`${tags.RULE_BOOK} 规则说明: ${gameInfo}`);
        break;
      case "user_turn":
        console.log(`${tags.USER_TURN} 用户回合: ${gameInfo} | ${phaseInfo} | 输入: ${userInput || ""}`);
        break;
      case "mentor_turn":
        console.log(`${tags.MENTOR_TURN} 陪练回合: ${gameInfo} | ${phaseInfo}`);
        break;
      case "narration":
        console.log(`${tags.NARRATION} 播报回合: ${gameInfo} | ${phaseInfo} | 事件: ${eventType || ""}`);
        break;
      case "enemy_turn":
        console.log(`${tags.ENEMY_TURN} 敌方攻击回合: ${gameInfo} | ${phaseInfo}`);
        break;
      case "settling":
        console.log(`${tags.SETTLING} 规程性退出回合: ${gameInfo}`);
        break;
      case "user_abort":
        console.log(`${tags.USER_ABORT} 用户#退出回合: ${gameInfo}`);
        break;
    }
  }
}

/** 导出单例 */
export const miniGameStateManager = MiniGameStateManager.getInstance();

/** 导出便捷函数 */
export const isMiniGameMode = (state: Record<string, any>) => miniGameStateManager.isMiniGameMode(state);
export const getMiniGameStateInfo = (state: Record<string, any>) => miniGameStateManager.getMiniGameStateInfo(state);
export const detectGameType = (userInput: string) => miniGameStateManager.detectGameType(userInput);
export const getRulebookNarration = (gameType: string) => miniGameStateManager.getRulebookNarration(gameType);
export const orchestrateMiniGame = (
  state: Record<string, any>,
  userInput: string,
  miniGameResult: { pendingPlan?: any; isEnd?: boolean; messages?: any[] } | null,
) => miniGameStateManager.orchestrateMiniGame(state, userInput, miniGameResult);
export const generateMiniGameNarration = (
  state: Record<string, any>,
  orchestration: MiniGameOrchestrationResult,
) => miniGameStateManager.generateMiniGameNarration(state, orchestration);
export const buildPendingNarrativePlan = (orchestration: MiniGameOrchestrationResult) =>
  miniGameStateManager.buildPendingNarrativePlan(orchestration);
export const logMiniGameTurn = (
  turnType: MiniGameTurnType,
  context: {
    gameType?: string | null;
    displayName?: string | null;
    phase?: string | null;
    userInput?: string;
    eventType?: string;
  },
) => miniGameStateManager.logMiniGameTurn(turnType, context);
export const detectMiniGameTurnType = (
  state: Record<string, any>,
  userInput: string,
  orchestration: MiniGameOrchestrationResult | null,
) => miniGameStateManager.detectTurnType(state, userInput, orchestration);
