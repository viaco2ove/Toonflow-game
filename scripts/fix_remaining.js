const fs = require('fs');
const path = 'src/modules/game-runtime/engines/MiniGameController.ts';
let content = fs.readFileSync(path, 'utf8');
let count = 0;

const CRLF = '\r\n';

// Helper to replace exact lines
function replaceExact(oldContent, newContent, label) {
  if (content.includes(oldContent)) {
    content = content.replace(oldContent, newContent);
    count++;
    console.log('OK:', label);
    return true;
  }
  console.error('ERROR:', label, 'not found');
  return false;
}

// 6. resolveFishingRound 成功 mentorSpeech
const successOld = '    memorySummary: `钓鱼成功，收获 ${reward.name}`,' + CRLF +
  '  };' + CRLF +
  '}' + CRLF +
  'function fishingStep';
const successNew = '    memorySummary: `钓鱼成功，收获 ${reward.name}`,' + CRLF +
  '    mentorSpeech: mentor ? buildMentorMiniGameSpeechRequest(mentor, "fishing", reward.name, publicState.last_result || "") : undefined,' + CRLF +
  '  };' + CRLF +
  '}' + CRLF +
  'function fishingStep';
replaceExact(successOld, successNew, 'resolveFishingRound success mentorSpeech');

// 9. ruleSummary
replaceExact(
  'ruleSummary: "直接输入"抛竿""收杆""继续钓鱼"等动作。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。",',
  'ruleSummary: "首次进入默认折叠面板，旁白询问目标水域与是否需要陪练。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。",' + CRLF +
  '    rulebookNarration: "钓鱼规则：首次进入默认折叠面板，旁白询问目标水域与是否需要陪练。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。输入 #钓鱼 即可开始钓鱼，输入 #退出 可以强制退出小游戏。",',
  'ruleSummary + rulebookNarration'
);

// 15. buildStartNarration
const buildStartOld = '  if (rulebook.gameType === "fishing") {' + CRLF +
  '    return `你来到 ${scalarText(publicState.site_name) || "水边"}，准备开始钓鱼。现在可以直接输入"抛竿""收杆"或"继续钓鱼"。`;' + CRLF +
  '  }';
const buildStartNew = '  if (rulebook.gameType === "fishing") {' + CRLF +
  '    const mentors = asArray<string>(publicState.available_mentors).join("、");' + CRLF +
  '    return [' + CRLF +
  '      `你来到 ${scalarText(publicState.site_name) || "水边"}，准备开始钓鱼。是否需要陪练或角色协助？`,' + CRLF +
  '      mentors ? `可选陪练：${mentors}。` : "当前没有可选陪练，也可以独自钓鱼。",' + CRLF +
  '      "可以先输入陪练角色名字（如"小医仙"）选择协助，或输入"不需要陪练"独自开始，然后输入"抛竿"开始钓鱼。",' + CRLF +
  '    ].join("");' + CRLF +
  '  }';
replaceExact(buildStartOld, buildStartNew, 'buildStartNarration');

// 16. buildStatusNarration
const buildStatusOld = '  if (rulebook.gameType === "fishing") {' + CRLF +
  '    const reward = scalarText(publicState.last_reward);' + CRLF +
  '    return [' + CRLF +
  '      `钓鱼状态：${scalarText(publicState.current_status) || "准备抛竿"}。`,' + CRLF +
  '      scalarText(publicState.last_result) ? `本轮结果：${scalarText(publicState.last_result)}。` : "",' + CRLF +
  '      reward ? `最近收获：${reward}。` : "",' + CRLF +
  '      "可直接输入"抛竿""收杆"或"继续钓鱼"。",' + CRLF +
  '    ].filter(Boolean).join("");' + CRLF +
  '  }';
const buildStatusNew = '  if (rulebook.gameType === "fishing") {' + CRLF +
  '    const reward = scalarText(publicState.last_reward);' + CRLF +
  '    const mentor = scalarText(publicState.mentor);' + CRLF +
  '    return [' + CRLF +
  '      `钓鱼状态：${scalarText(publicState.current_status) || "准备抛竿"}${mentor && mentor !== "无" ? `（陪练：${mentor}）` : "（无陪练）"}。`,' + CRLF +
  '      scalarText(publicState.last_result) ? `本轮结果：${scalarText(publicState.last_result)}。` : "",' + CRLF +
  '      reward ? `最近收获：${reward}。` : "",' + CRLF +
  '      "可直接输入陪练角色名、"抛竿"、"收杆"或"继续钓鱼"。",' + CRLF +
  '    ].filter(Boolean).join("");' + CRLF +
  '  }';
replaceExact(buildStatusOld, buildStatusNew, 'buildStatusNarration');

// 17. buildRuleNarration
replaceExact(
  '  if (rulebook.gameType === "fishing") {' + CRLF +
  '    return "钓鱼规则：通过聊天框直接输入"抛竿""收杆""继续钓鱼"等动作推进。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。";' + CRLF +
  '  }',
  '  if (rulebook.gameType === "fishing") {' + CRLF +
  '    return "钓鱼规则：通过聊天框先选择陪练角色或独自钓鱼，然后输入"抛竿""收杆""继续钓鱼"等动作推进。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。";' + CRLF +
  '  }',
  'buildRuleNarration'
);

// 18. buildInputHint
replaceExact(
  '  if (rulebook.gameType === "fishing") {' + CRLF +
  '    return "直接输入动作，例如"抛竿""收杆""继续钓鱼"，#退出 可强制退出小游戏";' + CRLF +
  '  }',
  '  if (rulebook.gameType === "fishing") {' + CRLF +
  '    return "直接输入陪练角色名、"抛竿"、"收杆"或"继续钓鱼"，#退出 可强制退出小游戏";' + CRLF +
  '  }',
  'buildInputHint'
);

fs.writeFileSync(path, content, 'utf8');
console.log('\nTotal additional replacements:', count);
