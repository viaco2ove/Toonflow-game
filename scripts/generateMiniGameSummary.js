const fs = require("fs");
const path = require("path");

/**
 * 小游戏配置（与 MiniGameStateManager.ts 保持一致）
 */
const MINI_GAME_CONFIGS = {
  mining: {
    gameType: "mining",
    displayName: "挖矿",
    triggerTags: ["#挖矿"],
    phaseOrder: ["survey", "excavate", "risk_check", "haul", "settling"],
    phaseNames: {
      survey: "勘察阶段",
      excavate: "挖掘阶段",
      risk_check: "风险检查",
      haul: "搬运阶段",
      settling: "结算阶段",
    },
    rulebookNarration: "挖矿规则：首次进入默认折叠面板，旁白询问目标矿物与是否需要陪练。挖矿获得目标矿物，并有概率获得宝物。输入 #挖矿 即可开始挖矿，输入 #退出 可以强制退出小游戏。",
  },
  fishing: {
    gameType: "fishing",
    displayName: "钓鱼",
    triggerTags: ["#钓鱼"],
    phaseOrder: ["prepare", "waiting", "result", "settling"],
    phaseNames: {
      prepare: "准备阶段",
      waiting: "等待阶段",
      result: "结果阶段",
      settling: "结算阶段",
    },
    rulebookNarration: "钓鱼规则：直接输入「抛竿」「收杆」「继续钓鱼」等动作。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。输入 #钓鱼 即可开始钓鱼，输入 #退出 可以强制退出小游戏。",
  },
  alchemy: {
    gameType: "alchemy",
    displayName: "炼药",
    triggerTags: ["#炼药"],
    phaseOrder: ["await_input", "result", "settling"],
    phaseNames: {
      await_input: "等待输入",
      result: "炼药结果",
      settling: "结算阶段",
    },
    rulebookNarration: "炼药规则：用户默认拥有回复丹药方（lv1）与药草提纯术（lv1）。只能炼制不高于自身等级的丹药，每次炼药消耗1金币。输入 #炼药 即可开始炼药，输入 #退出 可以强制退出小游戏。",
  },
  battle: {
    gameType: "battle",
    displayName: "战斗",
    triggerTags: ["#战斗", "#对战"],
    phaseOrder: ["encounter", "settling"],
    phaseNames: {
      encounter: "遭遇战斗",
      settling: "战斗结算",
    },
    rulebookNarration: "战斗规则：通过文字输入攻击、技能、防御和回气推进战斗。系统会实时更新敌我血量与法力；击败全部敌人后会结算战利品，金钱、升级概率，并在战后恢复用户血量与法力。输入 #战斗 目标 进入战斗，输入 #退出 可以强制退出小游戏。",
  },
  cultivation: {
    gameType: "cultivation",
    displayName: "修炼",
    triggerTags: ["#修炼"],
    phaseOrder: ["gather_qi", "circulate", "breakthrough", "settling"],
    phaseNames: {
      gather_qi: "聚气阶段",
      circulate: "运转阶段",
      breakthrough: "突破阶段",
      settling: "结算阶段",
    },
    rulebookNarration: "修炼规则：围绕灵气、感悟、稳定与疲劳做管理。贸然冲关会提高偏差风险。输入 #修炼 即可开始修炼，输入 #退出 可以强制退出小游戏。",
  },
  research_skill: {
    gameType: "research_skill",
    displayName: "研发技能",
    triggerTags: ["#研发技能"],
    phaseOrder: ["await_input", "result", "settling"],
    phaseNames: {
      await_input: "等待研发方案",
      result: "研发结果",
      settling: "结算阶段",
    },
    rulebookNarration: "研发技能规则：首次进入默认折叠面板，旁白询问研发技能与是否需要陪练。每次消耗5金币；与已有技能/物品关联越强，成功率越高。输入 #研发技能 即可开始研发，输入 #退出 可以强制退出小游戏。",
  },
  upgrade_equipment: {
    gameType: "upgrade_equipment",
    displayName: "升级装备",
    triggerTags: ["#升级装备"],
    phaseOrder: ["await_input", "result", "settling"],
    phaseNames: {
      await_input: "等待升级方案",
      result: "升级结果",
      settling: "结算阶段",
    },
    rulebookNarration: "升级装备规则：首次进入默认折叠面板，旁白询问要升级的装备和是否需要协助。装备升级需要矿石/强化石和1金币，等级不能超过用户等级和装备强化术等级；技能升级消耗20金币。输入 #升级装备 即可开始升级，输入 #退出 可以强制退出小游戏。",
  },
  werewolf: {
    gameType: "werewolf",
    displayName: "狼人杀",
    triggerTags: ["#狼人杀"],
    phaseOrder: ["setup", "night_wolf", "night_seer", "night_witch", "day_announce", "day_discussion", "day_vote", "settling"],
    phaseNames: {
      setup: "游戏设置",
      night_wolf: "狼人夜晚",
      night_seer: "预言家夜晚",
      night_witch: "女巫夜晚",
      day_announce: "白天宣布",
      day_discussion: "白天讨论",
      day_vote: "白天投票",
      settling: "结算阶段",
    },
    rulebookNarration: "狼人杀规则：5人标准局。夜间按身份行动，白天讨论投票。所有狼人出局则村民胜；狼人数量大于等于其他存活人数则狼人胜。输入 #狼人杀 即可开始游戏，输入 #退出 可以强制退出小游戏。",
  },
};

/**
 * 根据触发标签检测游戏类型
 */
function detectGameType(userInput) {
  const trimmed = userInput.trim();
  for (const [gameType, config] of Object.entries(MINI_GAME_CONFIGS)) {
    if (config.triggerTags.some(tag => trimmed.includes(tag))) {
      return gameType;
    }
  }
  return null;
}

/**
 * 获取事件类型的友好名称
 */
function getEventTypeName(eventType) {
  const map = {
    "on_message": "用户输入",
    "on_mini_game": "小游戏回合",
    "on_mini_game_start": "小游戏开场(规则说明)",
    "on_mini_game_abort": "小游戏退出",
    "on_mini_game_result": "小游戏结果",
    "on_mini_game_status": "小游戏状态",
    "on_mini_game_rule": "小游戏规则",
  };
  return map[eventType] || eventType;
}

/**
 * 解析命令行参数
 */
function parseCliArgs(argv) {
  const inputArg = argv.find((item) => item.startsWith("--input=")) || argv.find((item) => !item.startsWith("--"));
  const outputArg = argv.find((item) => item.startsWith("--output="));
  const inputPath = inputArg?.startsWith("--input=") ? inputArg.slice("--input=".length) : inputArg;
  if (!inputPath) {
    throw new Error("缺少日志文件路径，示例：node scripts/generateMiniGameSummary.js logs/app-2026-04-16.log");
  }
  const normalizedInputPath = path.resolve(inputPath);
  const defaultOutputPath = path.resolve(
    "logs/event_log",
    `${path.basename(inputPath, path.extname(inputPath))}.mini_game.summary.md`,
  );
  const outputPath = outputArg
    ? path.resolve(outputArg.startsWith("--output=") ? outputArg.slice("--output=".length) : outputArg)
    : defaultOutputPath;
  return { inputPath: normalizedInputPath, outputPath };
}

/**
 * 提取 sessionId
 */
function extractSessionId(line) {
  const match = line.match(/sessionId[":\s]+([\w_]+)/);
  return match ? match[1] : null;
}

/**
 * 从日志行中提取新增对话数组
 */
function extractDialogueFromLogLine(line) {
  const match = line.match(/\|\s*新增对话\s*\|\s*(\[[\s\S]*?\])\s*\|/);
  if (!match) return null;

  let jsonStr = match[1];
  jsonStr = jsonStr.replace(/↩/g, " ").replace(/\s+/g, " ").trim();

  try {
    const dialogues = JSON.parse(jsonStr);
    if (Array.isArray(dialogues) && dialogues.length > 0) {
      return dialogues;
    }
  } catch (e) {}

  return null;
}

/**
 * 从日志行中提取小游戏 log tag
 * 支持的 tag：[mini_game:user:enter]、[mini_game:rule_book]、[mini_game:user_turn]、
 *           [mini_game:mentor_turn]、[mini_game:narration]、[mini_game:enemy_turn]、
 *           [mini_game:settling]、[mini_game:user_abort]
 */
function extractMiniGameLogTags(line) {
  const tags = [];
  const tagPatterns = [
    "mini_game:user:enter",
    "mini_game:rule_book",
    "mini_game:user_turn",
    "mini_game:mentor_turn",
    "mini_game:narration",
    "mini_game:enemy_turn",
    "mini_game:settling",
    "mini_game:user_abort",
  ];
  for (const tag of tagPatterns) {
    // 支持 [tag] 或 [tag args] 格式
    if (line.includes(`[${tag}]`)) {
      tags.push(tag);
    }
  }
  return tags;
}

/**
 * 从 rulebook 日志提取游戏配置
 */
function extractRulebookInfo(line) {
  try {
    // 尝试匹配 "rulebook": {...} 格式
    let fullMatch = line.match(/"rulebook"\s*:\s*(\{[\s\S]*?\}),?\s*"session"/);
    if (fullMatch) {
      const rulebook = JSON.parse(fullMatch[1]);
      return {
        gameType: rulebook.gameType,
        displayName: rulebook.displayName,
        phase: rulebook.phase,
        status: rulebook.status,
      };
    }

    // 尝试匹配 "识别到小游戏 {...}" 格式
    fullMatch = line.match(/识别到小游戏\s*(\{[\s\S]*?\})/);
    if (fullMatch) {
      const rulebook = JSON.parse(fullMatch[1]);
      return {
        gameType: rulebook.gameType,
        displayName: rulebook.displayName,
        phase: rulebook.phase,
        status: rulebook.status,
      };
    }
  } catch (e) {
    // console.error("extractRulebookInfo error:", e);
  }

  return null;
}

/**
 * 回合类型名称映射
 */
const MINI_GAME_TURN_TYPES = {
  USER_ENTER: "用户进入小游戏回合",
  RULE_BOOK: "规则说明回合",
  USER_TURN: "用户回合",
  MENTOR_TURN: "陪练回合",
  NARRATION: "播报回合",
  ENEMY_TURN: "敌方攻击回合",
  SETTLING: "规程性退出回合",
  USER_ABORT: "用户#退出回合",
};

/**
 * 检测回合类型
 */
function detectTurnType(dialogues, currentPhase) {
  if (!dialogues || dialogues.length === 0) return null;

  const lastDialogue = dialogues[dialogues.length - 1];
  const secondLastDialogue = dialogues.length >= 2 ? dialogues[dialogues.length - 2] : null;

  // 用户 #退出
  if (lastDialogue.eventType === "on_mini_game_abort") {
    return MINI_GAME_TURN_TYPES.USER_ABORT;
  }

  // 规则说明回合
  if (lastDialogue.eventType === "on_mini_game_start") {
    return MINI_GAME_TURN_TYPES.RULE_BOOK;
  }

  // 用户刚输入小游戏命令（第二条是 on_mini_game_start）
  if (lastDialogue.eventType === "on_message" && secondLastDialogue?.eventType === "on_mini_game_start") {
    return MINI_GAME_TURN_TYPES.USER_ENTER;
  }

  // 播报回合（系统回合结果）
  if (lastDialogue.eventType === "on_mini_game") {
    // 根据阶段判断具体类型
    const phase = currentPhase?.phase;
    if (phase === "encounter" || phase === "risk_check" || phase === "haul") {
      return MINI_GAME_TURN_TYPES.NARRATION;
    }
    if (phase === "excavate" || phase === "survey") {
      return MINI_GAME_TURN_TYPES.NARRATION;
    }
    if (phase === "night_wolf" || phase === "night_seer" || phase === "night_witch") {
      return MINI_GAME_TURN_TYPES.ENEMY_TURN;
    }
    return MINI_GAME_TURN_TYPES.NARRATION;
  }

  // 用户回合（等待用户输入）
  if (lastDialogue.eventType === "on_message" && lastDialogue.role === "用户") {
    const gameType = detectGameType(lastDialogue.content || "");
    if (gameType) {
      return MINI_GAME_TURN_TYPES.USER_TURN;
    }
  }

  // 陪练回合（mentor/NPC 介入，roleType 为 npc 或 mentor）
  if (lastDialogue.roleType === "npc" || lastDialogue.role === "陪练" || lastDialogue.roleType === "mentor") {
    return MINI_GAME_TURN_TYPES.MENTOR_TURN;
  }

  return null;
}

/**
 * 检测小游戏状态
 */
function detectMiniGameState(dialogues, currentPhase) {
  if (!dialogues || dialogues.length === 0) {
    return { isActive: false, gameType: null, phase: null, hasRulebook: false, turnType: null };
  }

  const hasMiniGameStart = dialogues.some(d => d.eventType === "on_mini_game_start");
  const hasMiniGameAbort = dialogues.some(d => d.eventType === "on_mini_game_abort");
  const hasMiniGame = dialogues.some(d => d.eventType === "on_mini_game");

  const lastDialogue = dialogues[dialogues.length - 1];

  // 检测回合类型
  const turnType = detectTurnType(dialogues, currentPhase);

  // 如果最后是退出，刚退出
  if (lastDialogue.eventType === "on_mini_game_abort") {
    return { isActive: false, gameType: null, phase: "已退出", hasRulebook: false, turnType: MINI_GAME_TURN_TYPES.USER_ABORT };
  }

  // 如果最后是 on_mini_game_start，规则说明阶段
  if (lastDialogue.eventType === "on_mini_game_start") {
    const gameType = detectGameType(lastDialogue.content || "") || currentPhase?.gameType;
    return { isActive: true, gameType, phase: "小游戏开场(规则说明)", hasRulebook: true, turnType: MINI_GAME_TURN_TYPES.RULE_BOOK };
  }

  // 如果最后是 on_mini_game，播报回合
  if (lastDialogue.eventType === "on_mini_game") {
    const gameType = currentPhase?.gameType || detectGameType(dialogues.map(d => d.content).join(""));
    if (!hasMiniGameStart) {
      return { isActive: true, gameType, phase: "播报回合 ⚠️未触发开场事件", hasRulebook: false, turnType: MINI_GAME_TURN_TYPES.NARRATION };
    }
    return { isActive: true, gameType, phase: "播报回合", hasRulebook: true, turnType: turnType || MINI_GAME_TURN_TYPES.NARRATION };
  }

  // 如果最后是用户输入，检查是否是小游戏命令
  if (lastDialogue.eventType === "on_message" && lastDialogue.content) {
    const gameType = detectGameType(lastDialogue.content);
    if (gameType) {
      // 刚输入小游戏命令，检查上一条是否是 on_mini_game
      if (dialogues.length >= 2) {
        const prevDialogue = dialogues[dialogues.length - 2];
        if (prevDialogue.eventType === "on_mini_game") {
          if (!hasMiniGameStart) {
            return { isActive: true, gameType, phase: "播报回合 ⚠️未触发开场事件", hasRulebook: false, turnType: MINI_GAME_TURN_TYPES.NARRATION };
          }
          return { isActive: true, gameType, phase: "播报回合", hasRulebook: true, turnType: turnType || MINI_GAME_TURN_TYPES.USER_TURN };
        }
      }
      return { isActive: true, gameType, phase: "等待用户操作", hasRulebook: hasMiniGameStart, turnType: turnType || MINI_GAME_TURN_TYPES.USER_TURN };
    }
  }

  // 如果之前有小游戏开始事件且没有结束事件，说明小游戏仍在进行中
  // 用户在小游戏中输入普通文本（如"炼炎决"）不代表退出小游戏
  if (hasMiniGameStart && !hasMiniGameAbort) {
    const hasFinish = dialogues.some(d => d.eventType === "on_mini_game_finish");
    if (!hasFinish) {
      const gameType = currentPhase?.gameType || detectGameType(dialogues.map(d => d.content).join(""));
      return { isActive: true, gameType, phase: "等待用户操作", hasRulebook: true, turnType: turnType || MINI_GAME_TURN_TYPES.USER_TURN };
    }
  }

  return { isActive: false, gameType: null, phase: null, hasRulebook: false, turnType: null };
}

/**
 * 生成小游戏完整日志摘要
 */
function generateMiniGameSummaryMarkdown(logFilePath, outputMarkdownPath) {
  const rawLog = fs.readFileSync(logFilePath, "utf8");
  const lines = rawLog.split(/\r?\n/);

  // 收集所有会话的对话数据
  const sessionDialogues = new Map();
  let currentSession = null;
  let sessionDialogueList = [];
  let currentMiniGameState = { isActive: false, gameType: null, phase: null, hasRulebook: false };
  let currentTimestamp = "";
  let currentPhase = null;
  let sessionLogTags = [];  // 当前会话收集到的 log tags

  for (const line of lines) {
    // 提取时间戳
    const tsMatch = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]/);
    if (tsMatch) {
      currentTimestamp = tsMatch[1];
    }

    // 提取 sessionId
    const sid = extractSessionId(line);
    if (sid && sid !== currentSession) {
      currentSession = sid;
      sessionLogTags = [];  // 换会话时重置
      sessionDialogueList = [];  // 换会话时清空对话列表
    } else if (sid) {
      currentSession = sid;
    }

    // 提取 rulebook 信息
    const rulebookInfo = extractRulebookInfo(line);
    if (rulebookInfo) {
      currentPhase = rulebookInfo;
    }

    // 提取小游戏 log tag（打在 [mini_game:xxx] 的行）
    const logTags = extractMiniGameLogTags(line);
    if (logTags.length > 0) {
      sessionLogTags.push(...logTags);
    }

    // 从新增对话提取对话列表
    const dialogues = extractDialogueFromLogLine(line);
    if (dialogues && dialogues.length > 0) {
      // 更新小游戏状态
      const detected = detectMiniGameState(dialogues, currentPhase);
      currentMiniGameState = detected;

      // 追加对话到当前会话（而非覆盖）
      sessionDialogueList.push(...dialogues);

      // 保存到 sessionDialogues
      if (currentSession) {
        sessionDialogues.set(currentSession, {
          dialogues: [...sessionDialogueList],
          miniGameState: { ...currentMiniGameState },
          timestamp: currentTimestamp,
          phaseInfo: currentPhase,
          logTags: [...sessionLogTags],  // 带上本次收集到的 log tags
        });
      }
    }
  }

  // 生成 markdown
  const markdownLines = [
    "# 小游戏完整日志摘要",
    "",
    `生成时间: ${new Date().toISOString()}`,
    `日志文件: ${logFilePath}`,
    "",
    "## 支持的小游戏",
    "",
  ];

  // 输出所有支持的小游戏配置
  for (const [gameType, config] of Object.entries(MINI_GAME_CONFIGS)) {
    markdownLines.push(`### ${config.displayName}`);
    markdownLines.push(`- 触发命令: ${config.triggerTags.join(", ")}`);
    markdownLines.push(`- 阶段: ${config.phaseOrder.map(p => config.phaseNames[p] || p).join(" → ")}`);
    markdownLines.push("");
  }

  markdownLines.push("---");
  markdownLines.push("");

  for (const [sessionId, data] of sessionDialogues) {
    const { dialogues, miniGameState, phaseInfo } = data;
    const config = miniGameState.gameType ? MINI_GAME_CONFIGS[miniGameState.gameType] : null;

    markdownLines.push(`## 会话: ${sessionId}`);
    markdownLines.push("");

    // 小游戏状态
    if (miniGameState.isActive) {
      const gameName = config?.displayName || miniGameState.gameType || "未知";
      const phaseName = config?.phaseNames[miniGameState.phase] || miniGameState.phase || "";
      const rulebookNote = miniGameState.hasRulebook === false ? " ⚠️无规则说明" : "";
      const turnTypeName = miniGameState.turnType || "";
      markdownLines.push(`**状态: 在小游戏中** - ${gameName} | ${phaseName}${rulebookNote}`);
      if (turnTypeName) {
        markdownLines.push(`**回合类型: ${turnTypeName}**`);
      }

      // 如果有规则，显示规则说明
      if (miniGameState.hasRulebook && config) {
        markdownLines.push("");
        markdownLines.push(`> ${config.rulebookNarration}`);
      }
    } else {
      markdownLines.push(`**状态: 不在小游戏模式**`);
    }
    markdownLines.push("");

    // 按顺序显示对话
    markdownLines.push("### 对话流程");
    markdownLines.push("");

    for (let i = 0; i < dialogues.length; i++) {
      const d = dialogues[i];
      const role = d.role === "用户" ? "【用户】" : "【旁白】";
      const content = d.content || "";
      const eventName = getEventTypeName(d.eventType);

      // 判断当前对话的回合类型
      let turnTypeName = "";
      const nextD = i < dialogues.length - 1 ? dialogues[i + 1] : null;

      if (d.eventType === "on_mini_game_abort") {
        turnTypeName = MINI_GAME_TURN_TYPES.USER_ABORT;
      } else if (d.eventType === "on_mini_game_start") {
        turnTypeName = MINI_GAME_TURN_TYPES.RULE_BOOK;
      } else if (d.eventType === "on_mini_game") {
        turnTypeName = MINI_GAME_TURN_TYPES.NARRATION;
      } else if (d.eventType === "on_mini_game" && d.roleType === "npc") {
        // 陪练回合（NPC 角色，如云韵、萧薰儿等）
        turnTypeName = MINI_GAME_TURN_TYPES.MENTOR_TURN;
      } else if (d.eventType === "on_message" && d.role === "用户") {
        const gameType = detectGameType(content);
        if (gameType) {
          // 检查下一条是否是 on_mini_game_start
          if (nextD?.eventType === "on_mini_game_start") {
            turnTypeName = MINI_GAME_TURN_TYPES.USER_ENTER;
          } else {
            turnTypeName = MINI_GAME_TURN_TYPES.USER_TURN;
          }
        } else {
          turnTypeName = MINI_GAME_TURN_TYPES.USER_TURN;
        }
      }

      if (d.role === "用户") {
        // 检测用户输入是否是小游戏命令
        const gameType = detectGameType(content);
        if (gameType) {
          const gameConfig = MINI_GAME_CONFIGS[gameType];
          markdownLines.push(`- [用户输入] ${content}`);
          markdownLines.push(`  - 🕹️ 触发小游戏: ${gameConfig?.displayName || gameType}`);
        } else {
          markdownLines.push(`- [用户输入] ${content}`);
        }
      } else {
        markdownLines.push(`- 【${d.role}】 ${content}`);
        markdownLines.push(`  - 事件: ${eventName}`);
      }

      // 添加回合类型
      if (turnTypeName) {
        markdownLines.push(`  - 回合类型：${turnTypeName}`);
      }
    }

    // 显示收集到的 log tags
    if (data.logTags && data.logTags.length > 0) {
      markdownLines.push("");
      markdownLines.push("### Log Tags");
      const uniqueTags = [...new Set(data.logTags)];
      markdownLines.push(`\`${uniqueTags.join(", ")}\``);
    }

    markdownLines.push("");
  }

  fs.mkdirSync(path.dirname(outputMarkdownPath), { recursive: true });
  fs.writeFileSync(outputMarkdownPath, markdownLines.join("\n").trim() + "\n", "utf8");
  return { outputPath: outputMarkdownPath, sessionCount: sessionDialogues.size };
}

function main() {
  const { inputPath, outputPath } = parseCliArgs(process.argv.slice(2));
  const result = generateMiniGameSummaryMarkdown(inputPath, outputPath);
  console.log(`[debug:mini-game] output=${result.outputPath} sessions=${result.sessionCount}`);
}

try {
  main();
} catch (error) {
  console.error(`[debug:mini-game] failed: ${(error && error.message) || error}`);
  process.exit(1);
}
