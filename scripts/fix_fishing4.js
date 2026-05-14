const fs = require('fs');
const path = 'src/modules/game-runtime/engines/MiniGameController.ts';
let content = fs.readFileSync(path, 'utf8');

function replace(oldStr, newStr, label) {
  if (content.includes(oldStr)) {
    content = content.replace(oldStr, newStr);
    console.log('OK: ' + label);
    return true;
  } else {
    console.error('ERROR: ' + label + ' not found');
    return false;
  }
}

// 1. fishingOptions - 使用普通字符串，不用模板字符串
const fishingOptionsOld = [
  'function fishingOptions(session: JsonRecord): MiniGameActionOption[] {',
  '  const phase = normalizePhase(session.phase, "prepare");',
  '  if (phase === "prepare") {',
  '    return [',
  '      { action_id: "cast", label: "抛竿", desc: "开始本次垂钓", aliases: ["开始钓鱼", "甩竿", "下钩"] },',
  '      { action_id: "finish", label: "#退出结束", desc: "输入 #退出 结束当前钓鱼", aliases: ["收摊", "结束钓鱼", "离开水边"] },',
  '    ];',
  '  }',
].join('\n');

const fishingOptionsNew = [
  'function fishingOptions(session: JsonRecord): MiniGameActionOption[] {',
  '  const phase = normalizePhase(session.phase, "prepare");',
  '  const publicState = asRecord(session.public_state);',
  '  const mentors = uniqueTexts(asArray<string>(publicState.available_mentors));',
  '  const mentorOptions = mentors.map((item) => ({',
  '    action_id: `mentor:${item}`,',
  '    label: item,',
  '    desc: `选择${item}协助钓鱼`,',
  '    aliases: [`选择${item}`, `${item}陪练`, `${item}协助`, `让${item}帮忙`, `请${item}帮忙`],',
  '  }));',
  '  if (phase === "prepare") {',
  '    return [',
  '      { action_id: "choose_mentor", label: "需要陪练", desc: "查看可选协助角色", aliases: ["需要陪练", "找陪练", "需要协助", "找人帮忙"] },',
  '      { action_id: "no_mentor", label: "不需要陪练", desc: "独自钓鱼", aliases: ["不用陪练", "不需要陪练", "自己钓", "独自钓鱼"] },',
  '      ...mentorOptions,',
  '      { action_id: "cast", label: "抛竿", desc: "开始本次垂钓", aliases: ["开始钓鱼", "甩竿", "下钩"] },',
  '      { action_id: "finish", label: "#退出结束", desc: "输入 #退出 结束当前钓鱼", aliases: ["收摊", "结束钓鱼", "离开水边"] },',
  '    ];',
  '  }',
].join('\n');

replace(fishingOptionsOld, fishingOptionsNew, 'fishingOptions');

// 2. fishingStep - 找捕收选择逻辑的开头部分
const fishingStepOld = [
  'function fishingStep(session: JsonRecord, actionId: string, ctx: MiniGameControllerInput): MiniGameStepResult {',
  '  const publicState = asRecord(session.public_state);',
  '  const hidden = asRecord(session.hidden_state);',
  '  const narratorName = scalarText(ctx?.world?.narratorRole?.name) || "旁白";',
  '  const playerName = scalarText(ctx?.world?.playerRole?.name) || "用户";',
  '  const currentPhase = normalizePhase(session.phase, "prepare");',
  '  const siteName = scalarText(publicState.site_name) || "水面";',
  '  if (actionId === "finish") {',
].join('\n');

const fishingStepNew = [
  'function fishingStep(session: JsonRecord, actionId: string, ctx: MiniGameControllerInput): MiniGameStepResult {',
  '  const publicState = asRecord(session.public_state);',
  '  const hidden = asRecord(session.hidden_state);',
  '  const narratorName = scalarText(ctx?.world?.narratorRole?.name) || "旁白";',
  '  const playerName = scalarText(ctx?.world?.playerRole?.name) || "用户";',
  '  const currentPhase = normalizePhase(session.phase, "prepare");',
  '  const siteName = scalarText(publicState.site_name) || "水面";',
  '  const mentors = uniqueTexts(asArray<string>(publicState.available_mentors));',
  '  // 处理陪练选择',
  '  if (currentPhase === "prepare") {',
  '    if (actionId === "choose_mentor") {',
  '      const mentorList = mentors.length > 0 ? `可选陪练：${mentors.join("、")}。` : "当前没有可选陪练。";',
  '      return {',
  '        narration: `${mentorList}直接输入陪练角色名字选择协助，或输入"不需要陪练"独自开始。`,',
  '        resultTags: ["choose_mentor"],',
  '      };',
  '    }',
  '    if (actionId === "no_mentor") {',
  '      publicState.mentor = "无";',
  '      return {',
  '        narration: "你决定独自钓鱼。准备好了就输入"抛竿"开始吧。",',
  '        resultTags: ["no_mentor"],',
  '      };',
  '    }',
  '    if (actionId.startsWith("mentor:")) {',
  '      const mentorName = actionId.replace("mentor:", "");',
  '      publicState.mentor = mentorName;',
  '      return {',
  '        narration: `你邀请了 ${mentorName} 协助钓鱼。准备好了就输入"抛竿"开始吧。`,',
  '        resultTags: ["mentor_selected", `mentor:${mentorName}`],',
  '      };',
  '    }',
  '  }',
  '  if (actionId === "finish") {',
].join('\n');

replace(fishingStepOld, fishingStepNew, 'fishingStep');

// 3. resolveFishingRound 签名
replace(
  'function resolveFishingRound(session: JsonRecord, siteName: string): MiniGameStepResult {',
  'function resolveFishingRound(session: JsonRecord, siteName: string, ctx?: MiniGameControllerInput): MiniGameStepResult {',
  'resolveFishingRound signature'
);

// 4. resolveFishingRound mentor 逻辑
replace(
  '  const roll = Number(hidden.encounter_roll || takeRng(session, 1, 100));\n  const fishingExpGain = Math.max(10, Number(publicState.exp_reward || 0));\n  session.phase = "result";',
  '  const roll = Number(hidden.encounter_roll || takeRng(session, 1, 100));\n  const fishingExpGain = Math.max(10, Number(publicState.exp_reward || 0));\n  const currentMentor = () => {\n    const mentor = scalarText(publicState.mentor);\n    return mentor && mentor !== "无" ? mentor : "";\n  };\n  const mentor = currentMentor();\n  session.phase = "result";',
  'resolveFishingRound mentor logic'
);

// 5. resolveFishingRound 空竿 mentorSpeech
replace(
  '      memorySummary: "钓鱼空竿一次",\n    };\n  }\n  const reward = resolveFishingReward(session);',
  '      memorySummary: "钓鱼空竿一次",\n      mentorSpeech: mentor ? buildMentorMiniGameSpeechRequest(mentor, "fishing", siteName, "空竿了") : undefined,\n    };\n  }\n  const reward = resolveFishingReward(session);',
  'resolveFishingRound empty_hook mentorSpeech'
);

// 6. resolveFishingRound 成功 mentorSpeech
replace(
  '    memorySummary: `钓鱼成功，收获 ${reward.name}`,\n  };\n}\nfunction fishingStep',
  '    memorySummary: `钓鱼成功，收获 ${reward.name}`,\n    mentorSpeech: mentor ? buildMentorMiniGameSpeechRequest(mentor, "fishing", reward.name, publicState.last_result || "") : undefined,\n  };\n}\nfunction fishingStep',
  'resolveFishingRound success mentorSpeech'
);

// 7. resolveFishingRound 调用添加 ctx
let count = (content.match(/const fishRound = resolveFishingRound\(session, siteName\);/g) || []).length;
if (count > 0) {
  content = content.replace(/const fishRound = resolveFishingRound\(session, siteName\);/g, 'const fishRound = resolveFishingRound(session, siteName, ctx);');
  console.log('OK: resolveFishingRound calls updated (' + count + ' occurrences)');
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
  'ruleSummary: "首次进入默认折叠面板，旁白询问目标水域与是否需要陪练。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。",\n    rulebookNarration: "钓鱼规则：首次进入默认折叠面板，旁白询问目标水域与是否需要陪练。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。输入 #钓鱼 即可开始钓鱼，输入 #退出 可以强制退出小游戏。",',
  'ruleSummary + rulebookNarration'
);

// 10. setup (part 1)
replace(
  '    setup: (ctx, sessionId, entrySource) => ({\n      session_id: sessionId,\n      game_type: "fishing",',
  '    setup: (ctx, sessionId, entrySource) => {\n      const mentors = collectCultivationMentorNames(ctx);\n      return {\n        session_id: sessionId,\n        game_type: "fishing",',
  'RULEBOOKS setup (part 1)'
);

// 11. setup participants 和 public_state
replace(
  '      participants: buildParticipants(ctx, 1),\n      public_state: buildSimplePublicState({\n        site_name: "当前水域",\n        user_level: readMiniGamePlayerLevel(ctx.state),\n        exp_reward: 0,\n        current_status: "准备抛竿",\n        last_result: "",\n        last_reward: "",\n      }),',
  '      participants: buildParticipants(ctx, Math.max(1, Math.min(3, mentors.length + 1))),\n      public_state: buildSimplePublicState({\n        site_name: "当前水域",\n        user_level: readMiniGamePlayerLevel(ctx.state),\n        exp_reward: 0,\n        current_status: "准备抛竿",\n        last_result: "",\n        last_reward: "",\n        available_mentors: mentors,\n      }),',
  'RULEBOOKS setup (part 2)'
);

// 12. setup 结尾
replace(
  '      action_log_ids: [], result: "ongoing", finish_reason: "", reward_preview: {}, writeback_whitelist: ["player_state.parameter_card", "player_state.inventory", "memory_state.mid_term"], can_suspend: true, can_quit: true, resume_token: `resume_${sessionId}`,\n    }),',
  '        action_log_ids: [], result: "ongoing", finish_reason: "", reward_preview: {}, writeback_whitelist: ["player_state.parameter_card", "player_state.inventory", "memory_state.mid_term"], can_suspend: true, can_quit: true, resume_token: `resume_${sessionId}`,\n      };\n    },',
  'RULEBOOKS setup (part 3)'
);

// 13. resolveMentorSpeechDirection
replace(
  '  if (gameType === "mining") return `以协助者身份提醒用户处理${targetText}相关的矿道风险、开采节奏或撤离判断。`;',
  '  if (gameType === "mining") return `以协助者身份提醒用户处理${targetText}相关的矿道风险、开采节奏或撤离判断。`;\n  if (gameType === "fishing") return `以协助者身份提醒用户关注${targetText}的水情、鱼类动向或收竿时机。`;',
  'resolveMentorSpeechDirection'
);

// 14. MiniGameRulebook 接口
replace(
  '  ruleSummary: string;\n  setup: (ctx: MiniGameControllerInput, sessionId: string, entrySource: string) => JsonRecord;',
  '  ruleSummary: string;\n  rulebookNarration?: string;\n  setup: (ctx: MiniGameControllerInput, sessionId: string, entrySource: string) => JsonRecord;',
  'MiniGameRulebook interface'
);

// 15. buildStartNarration
replace(
  '  if (rulebook.gameType === "fishing") {\n    return `你来到 ${scalarText(publicState.site_name) || "水边"}，准备开始钓鱼。现在可以直接输入"抛竿""收杆"或"继续钓鱼"。`;\n  }',
  '  if (rulebook.gameType === "fishing") {\n    const mentors = asArray<string>(publicState.available_mentors).join("、");\n    return [\n      `你来到 ${scalarText(publicState.site_name) || "水边"}，准备开始钓鱼。是否需要陪练或角色协助？`,\n      mentors ? `可选陪练：${mentors}。` : "当前没有可选陪练，也可以独自钓鱼。",\n      "可以先输入陪练角色名字（如"小医仙"）选择协助，或输入"不需要陪练"独自开始，然后输入"抛竿"开始钓鱼。",\n    ].join("");\n  }',
  'buildStartNarration'
);

// 16. buildStatusNarration
replace(
  '  if (rulebook.gameType === "fishing") {\n    const reward = scalarText(publicState.last_reward);\n    return [\n      `钓鱼状态：${scalarText(publicState.current_status) || "准备抛竿"}。`,\n      scalarText(publicState.last_result) ? `本轮结果：${scalarText(publicState.last_result)}。` : "",\n      reward ? `最近收获：${reward}。` : "",\n      "可直接输入"抛竿""收杆"或"继续钓鱼"。",\n    ].filter(Boolean).join("");\n  }',
  '  if (rulebook.gameType === "fishing") {\n    const reward = scalarText(publicState.last_reward);\n    const mentor = scalarText(publicState.mentor);\n    return [\n      `钓鱼状态：${scalarText(publicState.current_status) || "准备抛竿"}${mentor && mentor !== "无" ? `（陪练：${mentor}）` : "（无陪练）"}。`,\n      scalarText(publicState.last_result) ? `本轮结果：${scalarText(publicState.last_result)}。` : "",\n      reward ? `最近收获：${reward}。` : "",\n      "可直接输入陪练角色名、"抛竿"、"收杆"或"继续钓鱼"。",\n    ].filter(Boolean).join("");\n  }',
  'buildStatusNarration'
);

// 17. buildRuleNarration
replace(
  '  if (rulebook.gameType === "fishing") {\n    return "钓鱼规则：通过聊天框直接输入"抛竿""收杆""继续钓鱼"等动作推进。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。";\n  }',
  '  if (rulebook.gameType === "fishing") {\n    return "钓鱼规则：通过聊天框先选择陪练角色或独自钓鱼，然后输入"抛竿""收杆""继续钓鱼"等动作推进。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。";\n  }',
  'buildRuleNarration'
);

// 18. buildInputHint
replace(
  '  if (rulebook.gameType === "fishing") {\n    return "直接输入动作，例如"抛竿""收杆""继续钓鱼"，#退出 可强制退出小游戏";\n  }',
  '  if (rulebook.gameType === "fishing") {\n    return "直接输入陪练角色名、"抛竿"、"收杆"或"继续钓鱼"，#退出 可强制退出小游戏";\n  }',
  'buildInputHint'
);

fs.writeFileSync(path, content, 'utf8');
console.log('\nAll replacements done!');
