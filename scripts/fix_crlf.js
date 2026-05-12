const fs = require('fs');
const path = 'src/modules/game-runtime/engines/MiniGameController.ts';
let content = fs.readFileSync(path, 'utf8');
let count = 0;

const CRLF = '\r\n';
const LF = '\n';

function replace(oldStr, newStr, label) {
  // Try both line endings
  let searchStr = oldStr;
  if (!content.includes(oldStr)) {
    // Try with LF instead of CRLF
    searchStr = oldStr.replace(/\r\n/g, LF);
    if (!content.includes(searchStr)) {
      console.error('ERROR:', label, 'not found');
      return false;
    }
    oldStr = searchStr;
  }
  content = content.replace(oldStr, newStr);
  count++;
  console.log('OK:', label);
  return true;
}

// 1. fishingOptions - use CRLF
replace(
  'function fishingOptions(session: JsonRecord): MiniGameActionOption[] {' + CRLF +
  '  const phase = normalizePhase(session.phase, "prepare");' + CRLF +
  '  if (phase === "prepare") {' + CRLF +
  '    return [' + CRLF +
  '      { action_id: "cast", label: "抛竿", desc: "开始本次垂钓", aliases: ["开始钓鱼", "甩竿", "下钩"] },' + CRLF +
  '      { action_id: "finish", label: "#退出结束", desc: "输入 #退出 结束当前钓鱼", aliases: ["收摊", "结束钓鱼", "离开水边"] },' + CRLF +
  '    ];' + CRLF +
  '  }',
  'function fishingOptions(session: JsonRecord): MiniGameActionOption[] {' + CRLF +
  '  const phase = normalizePhase(session.phase, "prepare");' + CRLF +
  '  const publicState = asRecord(session.public_state);' + CRLF +
  '  const mentors = uniqueTexts(asArray<string>(publicState.available_mentors));' + CRLF +
  '  const mentorOptions = mentors.map((item) => ({' + CRLF +
  '    action_id: `mentor:${item}`,' + CRLF +
  '    label: item,' + CRLF +
  '    desc: `选择${item}协助钓鱼`,' + CRLF +
  '    aliases: [`选择${item}`, `${item}陪练`, `${item}协助`, `让${item}帮忙`, `请${item}帮忙`],' + CRLF +
  '  }));' + CRLF +
  '  if (phase === "prepare") {' + CRLF +
  '    return [' + CRLF +
  '      { action_id: "choose_mentor", label: "需要陪练", desc: "查看可选协助角色", aliases: ["需要陪练", "找陪练", "需要协助", "找人帮忙"] },' + CRLF +
  '      { action_id: "no_mentor", label: "不需要陪练", desc: "独自钓鱼", aliases: ["不用陪练", "不需要陪练", "自己钓", "独自钓鱼"] },' + CRLF +
  '      ...mentorOptions,' + CRLF +
  '      { action_id: "cast", label: "抛竿", desc: "开始本次垂钓", aliases: ["开始钓鱼", "甩竿", "下钩"] },' + CRLF +
  '      { action_id: "finish", label: "#退出结束", desc: "输入 #退出 结束当前钓鱼", aliases: ["收摊", "结束钓鱼", "离开水边"] },' + CRLF +
  '    ];' + CRLF +
  '  }',
  'fishingOptions'
);

// 2. fishingStep
replace(
  'function fishingStep(session: JsonRecord, actionId: string, ctx: MiniGameControllerInput): MiniGameStepResult {' + CRLF +
  '  const publicState = asRecord(session.public_state);' + CRLF +
  '  const hidden = asRecord(session.hidden_state);' + CRLF +
  '  const narratorName = scalarText(ctx?.world?.narratorRole?.name) || "旁白";' + CRLF +
  '  const playerName = scalarText(ctx?.world?.playerRole?.name) || "用户";' + CRLF +
  '  const currentPhase = normalizePhase(session.phase, "prepare");' + CRLF +
  '  const siteName = scalarText(publicState.site_name) || "水面";' + CRLF +
  '  if (actionId === "finish") {',
  'function fishingStep(session: JsonRecord, actionId: string, ctx: MiniGameControllerInput): MiniGameStepResult {' + CRLF +
  '  const publicState = asRecord(session.public_state);' + CRLF +
  '  const hidden = asRecord(session.hidden_state);' + CRLF +
  '  const narratorName = scalarText(ctx?.world?.narratorRole?.name) || "旁白";' + CRLF +
  '  const playerName = scalarText(ctx?.world?.playerRole?.name) || "用户";' + CRLF +
  '  const currentPhase = normalizePhase(session.phase, "prepare");' + CRLF +
  '  const siteName = scalarText(publicState.site_name) || "水面";' + CRLF +
  '  const mentors = uniqueTexts(asArray<string>(publicState.available_mentors));' + CRLF +
  '  // 处理陪练选择' + CRLF +
  '  if (currentPhase === "prepare") {' + CRLF +
  '    if (actionId === "choose_mentor") {' + CRLF +
  '      const mentorList = mentors.length > 0 ? `可选陪练：${mentors.join("、")}。` : "当前没有可选陪练。";' + CRLF +
  '      return {' + CRLF +
  '        narration: `${mentorList}直接输入陪练角色名字选择协助，或输入"不需要陪练"独自开始。`,' + CRLF +
  '        resultTags: ["choose_mentor"],' + CRLF +
  '      };' + CRLF +
  '    }' + CRLF +
  '    if (actionId === "no_mentor") {' + CRLF +
  '      publicState.mentor = "无";' + CRLF +
  '      return {' + CRLF +
  '        narration: "你决定独自钓鱼。准备好了就输入"抛竿"开始吧。",' + CRLF +
  '        resultTags: ["no_mentor"],' + CRLF +
  '      };' + CRLF +
  '    }' + CRLF +
  '    if (actionId.startsWith("mentor:")) {' + CRLF +
  '      const mentorName = actionId.replace("mentor:", "");' + CRLF +
  '      publicState.mentor = mentorName;' + CRLF +
  '      return {' + CRLF +
  '        narration: `你邀请了 ${mentorName} 协助钓鱼。准备好了就输入"抛竿"开始吧。`,' + CRLF +
  '        resultTags: ["mentor_selected", `mentor:${mentorName}`],' + CRLF +
  '      };' + CRLF +
  '    }' + CRLF +
  '  }' + CRLF +
  '  if (actionId === "finish") {',
  'fishingStep'
);

// 3. resolveFishingRound 签名
replace(
  'function resolveFishingRound(session: JsonRecord, siteName: string): MiniGameStepResult {',
  'function resolveFishingRound(session: JsonRecord, siteName: string, ctx?: MiniGameControllerInput): MiniGameStepResult {',
  'resolveFishingRound signature'
);

// 4. resolveFishingRound mentor 逻辑
replace(
  '  const roll = Number(hidden.encounter_roll || takeRng(session, 1, 100));' + CRLF +
  '  const fishingExpGain = Math.max(10, Number(publicState.exp_reward || 0));' + CRLF +
  '  session.phase = "result";',
  '  const roll = Number(hidden.encounter_roll || takeRng(session, 1, 100));' + CRLF +
  '  const fishingExpGain = Math.max(10, Number(publicState.exp_reward || 0));' + CRLF +
  '  const currentMentor = () => {' + CRLF +
  '    const mentor = scalarText(publicState.mentor);' + CRLF +
  '    return mentor && mentor !== "无" ? mentor : "";' + CRLF +
  '  };' + CRLF +
  '  const mentor = currentMentor();' + CRLF +
  '  session.phase = "result";',
  'resolveFishingRound mentor logic'
);

// 5. resolveFishingRound 空竿 mentorSpeech
replace(
  '      memorySummary: "钓鱼空竿一次",' + CRLF +
  '    };' + CRLF +
  '  }' + CRLF +
  '  const reward = resolveFishingReward(session);',
  '      memorySummary: "钓鱼空竿一次",' + CRLF +
  '      mentorSpeech: mentor ? buildMentorMiniGameSpeechRequest(mentor, "fishing", siteName, "空竿了") : undefined,' + CRLF +
  '    };' + CRLF +
  '  }' + CRLF +
  '  const reward = resolveFishingReward(session);',
  'resolveFishingRound empty_hook mentorSpeech'
);

// 6. resolveFishingRound 成功 mentorSpeech
replace(
  '    memorySummary: `钓鱼成功，收获 ${reward.name}`,' + CRLF +
  '  };' + CRLF +
  '}' + CRLF +
  'function fishingStep',
  '    memorySummary: `钓鱼成功，收获 ${reward.name}`,' + CRLF +
  '    mentorSpeech: mentor ? buildMentorMiniGameSpeechRequest(mentor, "fishing", reward.name, publicState.last_result || "") : undefined,' + CRLF +
  '  };' + CRLF +
  '}' + CRLF +
  'function fishingStep',
  'resolveFishingRound success mentorSpeech'
);

// 7. resolveFishingRound 调用
const callCount = (content.match(/const fishRound = resolveFishingRound\(session, siteName\);/g) || []).length;
if (callCount > 0) {
  content = content.replace(/const fishRound = resolveFishingRound\(session, siteName\);/g, 'const fishRound = resolveFishingRound(session, siteName, ctx);');
  console.log('OK: resolveFishingRound calls updated (' + callCount + ' occurrences)');
}

// 8. passivePatterns
replace(
  'passivePatterns: [/钓鱼/, /去钓鱼/, /开始钓鱼/, /抛竿/],',
  'passivePatterns: [/钓鱼/, /去钓鱼/, /开始钓鱼/],',
  'passivePatterns'
);

// 9. ruleSummary
replace(
  'ruleSummary: "直接输入"抛竿""收杆""继续钓鱼"等动作。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。",',
  'ruleSummary: "首次进入默认折叠面板，旁白询问目标水域与是否需要陪练。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。",' + CRLF +
  '    rulebookNarration: "钓鱼规则：首次进入默认折叠面板，旁白询问目标水域与是否需要陪练。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。输入 #钓鱼 即可开始钓鱼，输入 #退出 可以强制退出小游戏。",',
  'ruleSummary + rulebookNarration'
);

// 10. setup (part 1)
replace(
  '    setup: (ctx, sessionId, entrySource) => ({' + CRLF +
  '      session_id: sessionId,' + CRLF +
  '      game_type: "fishing",',
  '    setup: (ctx, sessionId, entrySource) => {' + CRLF +
  '      const mentors = collectCultivationMentorNames(ctx);' + CRLF +
  '      return {' + CRLF +
  '        session_id: sessionId,' + CRLF +
  '        game_type: "fishing",',
  'RULEBOOKS setup (part 1)'
);

// 11. setup participants
replace(
  '      participants: buildParticipants(ctx, 1),' + CRLF +
  '      public_state: buildSimplePublicState({' + CRLF +
  '        site_name: "当前水域",' + CRLF +
  '        user_level: readMiniGamePlayerLevel(ctx.state),' + CRLF +
  '        exp_reward: 0,' + CRLF +
  '        current_status: "准备抛竿",' + CRLF +
  '        last_result: "",' + CRLF +
  '        last_reward: "",' + CRLF +
  '      }),',
  '      participants: buildParticipants(ctx, Math.max(1, Math.min(3, mentors.length + 1))),' + CRLF +
  '      public_state: buildSimplePublicState({' + CRLF +
  '        site_name: "当前水域",' + CRLF +
  '        user_level: readMiniGamePlayerLevel(ctx.state),' + CRLF +
  '        exp_reward: 0,' + CRLF +
  '        current_status: "准备抛竿",' + CRLF +
  '        last_result: "",' + CRLF +
  '        last_reward: "",' + CRLF +
  '        available_mentors: mentors,' + CRLF +
  '      }),',
  'RULEBOOKS setup (part 2)'
);

// 12. setup 结尾
replace(
  '      action_log_ids: [], result: "ongoing", finish_reason: "", reward_preview: {}, writeback_whitelist: ["player_state.parameter_card", "player_state.inventory", "memory_state.mid_term"], can_suspend: true, can_quit: true, resume_token: `resume_${sessionId}`,' + CRLF +
  '    }),',
  '        action_log_ids: [], result: "ongoing", finish_reason: "", reward_preview: {}, writeback_whitelist: ["player_state.parameter_card", "player_state.inventory", "memory_state.mid_term"], can_suspend: true, can_quit: true, resume_token: `resume_${sessionId}`,' + CRLF +
  '      };' + CRLF +
  '    },',
  'RULEBOOKS setup (part 3)'
);

// 13. resolveMentorSpeechDirection
replace(
  '  if (gameType === "mining") return `以协助者身份提醒用户处理${targetText}相关的矿道风险、开采节奏或撤离判断。`;',
  '  if (gameType === "mining") return `以协助者身份提醒用户处理${targetText}相关的矿道风险、开采节奏或撤离判断。`;' + CRLF +
  '  if (gameType === "fishing") return `以协助者身份提醒用户关注${targetText}的水情、鱼类动向或收竿时机。`;',
  'resolveMentorSpeechDirection'
);

// 14. MiniGameRulebook 接口
replace(
  '  ruleSummary: string;' + CRLF +
  '  setup: (ctx: MiniGameControllerInput, sessionId: string, entrySource: string) => JsonRecord;',
  '  ruleSummary: string;' + CRLF +
  '  rulebookNarration?: string;' + CRLF +
  '  setup: (ctx: MiniGameControllerInput, sessionId: string, entrySource: string) => JsonRecord;',
  'MiniGameRulebook interface'
);

// 15. buildStartNarration
replace(
  '  if (rulebook.gameType === "fishing") {' + CRLF +
  '    return `你来到 ${scalarText(publicState.site_name) || "水边"}，准备开始钓鱼。现在可以直接输入"抛竿""收杆"或"继续钓鱼"。`;' + CRLF +
  '  }',
  '  if (rulebook.gameType === "fishing") {' + CRLF +
  '    const mentors = asArray<string>(publicState.available_mentors).join("、");' + CRLF +
  '    return [' + CRLF +
  '      `你来到 ${scalarText(publicState.site_name) || "水边"}，准备开始钓鱼。是否需要陪练或角色协助？`,' + CRLF +
  '      mentors ? `可选陪练：${mentors}。` : "当前没有可选陪练，也可以独自钓鱼。",' + CRLF +
  '      "可以先输入陪练角色名字（如"小医仙"）选择协助，或输入"不需要陪练"独自开始，然后输入"抛竿"开始钓鱼。",' + CRLF +
  '    ].join("");' + CRLF +
  '  }',
  'buildStartNarration'
);

// 16. buildStatusNarration
replace(
  '  if (rulebook.gameType === "fishing") {' + CRLF +
  '    const reward = scalarText(publicState.last_reward);' + CRLF +
  '    return [' + CRLF +
  '      `钓鱼状态：${scalarText(publicState.current_status) || "准备抛竿"}。`,' + CRLF +
  '      scalarText(publicState.last_result) ? `本轮结果：${scalarText(publicState.last_result)}。` : "",' + CRLF +
  '      reward ? `最近收获：${reward}。` : "",' + CRLF +
  '      "可直接输入"抛竿""收杆"或"继续钓鱼"。",' + CRLF +
  '    ].filter(Boolean).join("");' + CRLF +
  '  }',
  '  if (rulebook.gameType === "fishing") {' + CRLF +
  '    const reward = scalarText(publicState.last_reward);' + CRLF +
  '    const mentor = scalarText(publicState.mentor);' + CRLF +
  '    return [' + CRLF +
  '      `钓鱼状态：${scalarText(publicState.current_status) || "准备抛竿"}${mentor && mentor !== "无" ? `（陪练：${mentor}）` : "（无陪练）"}。`,' + CRLF +
  '      scalarText(publicState.last_result) ? `本轮结果：${scalarText(publicState.last_result)}。` : "",' + CRLF +
  '      reward ? `最近收获：${reward}。` : "",' + CRLF +
  '      "可直接输入陪练角色名、"抛竿"、"收杆"或"继续钓鱼"。",' + CRLF +
  '    ].filter(Boolean).join("");' + CRLF +
  '  }',
  'buildStatusNarration'
);

// 17. buildRuleNarration
replace(
  '  if (rulebook.gameType === "fishing") {' + CRLF +
  '    return "钓鱼规则：通过聊天框直接输入"抛竿""收杆""继续钓鱼"等动作推进。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。";' + CRLF +
  '  }',
  '  if (rulebook.gameType === "fishing") {' + CRLF +
  '    return "钓鱼规则：通过聊天框先选择陪练角色或独自钓鱼，然后输入"抛竿""收杆""继续钓鱼"等动作推进。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。";' + CRLF +
  '  }',
  'buildRuleNarration'
);

// 18. buildInputHint
replace(
  '  if (rulebook.gameType === "fishing") {' + CRLF +
  '    return "直接输入动作，例如"抛竿""收杆""继续钓鱼"，#退出 可强制退出小游戏";' + CRLF +
  '  }',
  '  if (rulebook.gameType === "fishing") {' + CRLF +
  '    return "直接输入陪练角色名、"抛竿"、"收杆"或"继续钓鱼"，#退出 可强制退出小游戏";' + CRLF +
  '  }',
  'buildInputHint'
);

fs.writeFileSync(path, content, 'utf8');
console.log('\nTotal replacements:', count);
