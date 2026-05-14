const fs = require('fs');
const path = 'src/modules/game-runtime/engines/MiniGameController.ts';
let content = fs.readFileSync(path, 'utf8');

const modifications = [];

function apply(oldStr, newStr, desc) {
  if (content.includes(oldStr)) {
    content = content.replace(oldStr, newStr);
    modifications.push(desc);
    return true;
  }
  console.log(`Pattern not found for: ${desc}`);
  return false;
}

// 1. Update fishingOptions to add mentor options
const oldFishingOptions = `function fishingOptions(session: JsonRecord): MiniGameActionOption[] {\r\n  const phase = normalizePhase(session.phase, "prepare");\r\n  if (phase === "prepare") {\r\n    return [\r\n      { action_id: "cast", label: "抛竿", desc: "开始本次垂钓", aliases: ["开始钓鱼", "甩竿", "下钩"] },\r\n      { action_id: "finish", label: "#退出结束", desc: "输入 #退出 结束当前钓鱼", aliases: ["收摊", "结束钓鱼", "离开水边"] },\r\n    ];\r\n  }`;

const newFishingOptions = `function fishingOptions(session: JsonRecord): MiniGameActionOption[] {\r\n  const phase = normalizePhase(session.phase, "prepare");\r\n  const publicState = asRecord(session.public_state);\r\n  const mentors = uniqueTexts(asArray<string>(publicState.available_mentors));\r\n  const mentorOptions = mentors.map((item) => ({\r\n    action_id: \`mentor:\${item}\`,\r\n    label: item,\r\n    desc: \`选择\${item}协助钓鱼\`,\r\n    aliases: [\`选择\${item}\`, \`\${item}陪练\`, \`\${item}协助\`, \`让\${item}帮忙\`, \`请\${item}帮忙\`],\r\n  }));\r\n  if (phase === "prepare") {\r\n    return [\r\n      { action_id: "choose_mentor", label: "需要陪练", desc: "查看可选协助角色", aliases: ["需要陪练", "找陪练", "需要协助", "找人帮忙"] },\r\n      { action_id: "no_mentor", label: "不需要陪练", desc: "独自钓鱼", aliases: ["不用陪练", "不需要陪练", "自己钓", "独自钓鱼"] },\r\n      ...mentorOptions,\r\n      { action_id: "cast", label: "抛竿", desc: "开始本次垂钓", aliases: ["开始钓鱼", "甩竿", "下钩"] },\r\n      { action_id: "finish", label: "#退出结束", desc: "输入 #退出 结束当前钓鱼", aliases: ["收摊", "结束钓鱼", "离开水边"] },\r\n    ];\r\n  }`;

apply(oldFishingOptions, newFishingOptions, "Added mentor options to fishingOptions");

// 2. Add mentor selection handling to fishingStep
const oldFishingStep = `function fishingStep(session: JsonRecord, actionId: string, ctx: MiniGameControllerInput): MiniGameStepResult {\r\n  const publicState = asRecord(session.public_state);\r\n  const hidden = asRecord(session.hidden_state);\r\n  const narratorName = scalarText(ctx?.world?.narratorRole?.name) || "旁白";\r\n  const playerName = scalarText(ctx?.world?.playerRole?.name) || "用户";\r\n  const currentPhase = normalizePhase(session.phase, "prepare");\r\n  const siteName = scalarText(publicState.site_name) || "水面";\r\n  if (actionId === "finish") {`;

const newFishingStep = `function fishingStep(session: JsonRecord, actionId: string, ctx: MiniGameControllerInput): MiniGameStepResult {\r\n  const publicState = asRecord(session.public_state);\r\n  const hidden = asRecord(session.hidden_state);\r\n  const narratorName = scalarText(ctx?.world?.narratorRole?.name) || "旁白";\r\n  const playerName = scalarText(ctx?.world?.playerRole?.name) || "用户";\r\n  const currentPhase = normalizePhase(session.phase, "prepare");\r\n  const siteName = scalarText(publicState.site_name) || "水面";\r\n  const mentors = uniqueTexts(asArray<string>(publicState.available_mentors));\r\n  // 处理陪练选择\r\n  if (currentPhase === "prepare") {\r\n    if (actionId === "choose_mentor") {\r\n      const mentorList = mentors.length > 0 ? \`可选陪练：\${mentors.join("、")}。\` : "当前没有可选陪练。";\r\n      return {\r\n        narration: \`\${mentorList}直接输入陪练角色名字选择协助，或输入"不需要陪练"独自开始。\`,\r\n        resultTags: ["choose_mentor"],\r\n      };\r\n    }\r\n    if (actionId === "no_mentor") {\r\n      publicState.mentor = "无";\r\n      return {\r\n        narration: \`你决定独自钓鱼。准备好了就输入"抛竿"开始吧。\`,\r\n        resultTags: ["no_mentor"],\r\n      };\r\n    }\r\n    if (actionId.startsWith("mentor:")) {\r\n      const mentorName = actionId.replace("mentor:", "");\r\n      publicState.mentor = mentorName;\r\n      return {\r\n        narration: \`你邀请了 \${mentorName} 协助钓鱼。准备好了就输入"抛竿"开始吧。\`,\r\n        resultTags: ["mentor_selected", \`mentor:\${mentorName}\`],\r\n      };\r\n    }\r\n  }\r\n  if (actionId === "finish") {`;

apply(oldFishingStep, newFishingStep, "Added mentor selection handling to fishingStep");

// 3. Add mentor variable to resolveFishingRound
apply(
  `  const fishingExpGain = Math.max(10, Number(publicState.exp_reward || 0));\r\n  session.phase = "result";`,
  `  const fishingExpGain = Math.max(10, Number(publicState.exp_reward || 0));\r\n  const currentMentor = () => {\r\n    const mentor = scalarText(publicState.mentor);\r\n    return mentor && mentor !== "无" ? mentor : "";\r\n  };\r\n  const mentor = currentMentor();\r\n  session.phase = "result";`,
  "Added mentor logic to resolveFishingRound"
);

// 4. Add mentorSpeech to empty_hook result
apply(
  `      resultTags: ["cast", "empty_hook"],\r\n      memorySummary: "钓鱼空竿一次",\r\n    };\r\n  }\r\n  const reward = resolveFishingReward(session);`,
  `      resultTags: ["cast", "empty_hook"],\r\n      memorySummary: "钓鱼空竿一次",\r\n      mentorSpeech: mentor ? buildMentorMiniGameSpeechRequest(mentor, "fishing", siteName, "空竿了") : undefined,\r\n    };\r\n  }\r\n  const reward = resolveFishingReward(session);`,
  "Added mentorSpeech to empty_hook result"
);

// 5. Add mentorSpeech to success result
apply(
  `    memorySummary: \`钓鱼成功，收获 \${reward.name}\`,\r\n  };\r\n}\r\n\r\nfunction fishingStep`,
  `    memorySummary: \`钓鱼成功，收获 \${reward.name}\`,\r\n    mentorSpeech: mentor ? buildMentorMiniGameSpeechRequest(mentor, "fishing", siteName, \`钓到 \${reward.name}\`) : undefined,\r\n  };\r\n}\r\n\r\nfunction fishingStep`,
  "Added mentorSpeech to success result"
);

// 6. Add available_mentors to fishing public_state
apply(
  `public_state: buildSimplePublicState({\r\n        site_name: "当前水域",\r\n        user_level: readMiniGamePlayerLevel(ctx.state),\r\n        exp_reward: 0,\r\n        current_status: "准备抛竿",\r\n        last_result: "",\r\n        last_reward: "",\r\n      }),`,
  `public_state: buildSimplePublicState({\r\n        site_name: "当前水域",\r\n        user_level: readMiniGamePlayerLevel(ctx.state),\r\n        exp_reward: 0,\r\n        current_status: "准备抛竿",\r\n        last_result: "",\r\n        last_reward: "",\r\n        available_mentors: mentors,\r\n      }),`,
  "Added available_mentors to fishing public_state"
);

fs.writeFileSync(path, content, 'utf8');

console.log('Modifications applied:');
for (const m of modifications) {
  console.log(`  - ${m}`);
}
if (modifications.length === 0) {
  console.log('  (none applied - patterns may not match)');
}