#!/usr/bin/env node
/**
 * Apply all fishing modifications to MiniGameController.ts
 * Uses binary-level string manipulation to handle Chinese quotes correctly
 */
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

function applyMulti(patterns, desc) {
  for (const [oldStr, newStr] of patterns) {
    if (content.includes(oldStr)) {
      content = content.replace(oldStr, newStr);
      modifications.push(desc);
      return true;
    }
  }
  console.log(`No pattern matched for: ${desc}`);
  return false;
}

// 1. Add rulebookNarration to MiniGameRulebook interface
apply(
  '  ruleSummary: string;\n  setup:',
  '  ruleSummary: string;\n  rulebookNarration?: string;\n  setup:',
  "Added rulebookNarration to interface"
);

// 2. Add resolveMentorSpeechDirection for fishing
apply(
  'if (gameType === "cultivation") return `以陪练或护法身份指导用户继续修炼${targetText}，可提醒节奏、气息或风险。`;',
  'if (gameType === "fishing") return `以协助者身份提醒用户关注${targetText}的水情、鱼类动向或收竿时机。`;\n  if (gameType === "cultivation") return `以陪练或护法身份指导用户继续修炼${targetText}，可提醒节奏、气息或风险。`;',
  "Added resolveMentorSpeechDirection for fishing"
);

// 3. Modify fishingOptions to add mentor options
const oldFishingOptions = `function fishingOptions(session: JsonRecord): MiniGameActionOption[] {
  const phase = normalizePhase(session.phase, "prepare");
  if (phase === "prepare") {
    return [
      { action_id: "cast", label: "抛竿", desc: "开始本次垂钓", aliases: ["开始钓鱼", "甩竿", "下钩"] },
      { action_id: "finish", label: "#退出结束", desc: "输入 #退出 结束当前钓鱼", aliases: ["收摊", "结束钓鱼", "离开水边"] },
    ];
  }`;

const newFishingOptions = `function fishingOptions(session: JsonRecord): MiniGameActionOption[] {
  const phase = normalizePhase(session.phase, "prepare");
  const publicState = asRecord(session.public_state);
  const mentors = uniqueTexts(asArray<string>(publicState.available_mentors));
  const mentorOptions = mentors.map((item) => ({
    action_id: \`mentor:\${item}\`,
    label: item,
    desc: \`选择\${item}协助钓鱼\`,
    aliases: [\`选择\${item}\`, \`\${item}陪练\`, \`\${item}协助\`, \`让\${item}帮忙\`, \`请\${item}帮忙\`],
  }));
  if (phase === "prepare") {
    return [
      { action_id: "choose_mentor", label: "需要陪练", desc: "查看可选协助角色", aliases: ["需要陪练", "找陪练", "需要协助", "找人帮忙"] },
      { action_id: "no_mentor", label: "不需要陪练", desc: "独自钓鱼", aliases: ["不用陪练", "不需要陪练", "自己钓", "独自钓鱼"] },
      ...mentorOptions,
      { action_id: "cast", label: "抛竿", desc: "开始本次垂钓", aliases: ["开始钓鱼", "甩竿", "下钩"] },
      { action_id: "finish", label: "#退出结束", desc: "输入 #退出 结束当前钓鱼", aliases: ["收摊", "结束钓鱼", "离开水边"] },
    ];
  }`;

apply(oldFishingOptions, newFishingOptions, "Added mentor options to fishingOptions");

// 4. Modify resolveFishingRound signature
apply(
  'function resolveFishingRound(session: JsonRecord, siteName: string): MiniGameStepResult {',
  'function resolveFishingRound(session: JsonRecord, siteName: string, ctx?: MiniGameControllerInput): MiniGameStepResult {',
  "Modified resolveFishingRound signature"
);

// 5. Add mentor logic after fishingExpGain
apply(
  `  const fishingExpGain = Math.max(10, Number(publicState.exp_reward || 0));
  session.phase = "result";`,
  `  const fishingExpGain = Math.max(10, Number(publicState.exp_reward || 0));
  const currentMentor = () => {
    const mentor = scalarText(publicState.mentor);
    return mentor && mentor !== "无" ? mentor : "";
  };
  const mentor = currentMentor();
  session.phase = "result";`,
  "Added mentor logic to resolveFishingRound"
);

// 6. Add mentorSpeech to empty_hook result
apply(
  `      resultTags: ["cast", "empty_hook"],
      memorySummary: "钓鱼空竿一次",
    };
  }
  const reward = resolveFishingReward(session);`,
  `      resultTags: ["cast", "empty_hook"],
      memorySummary: "钓鱼空竿一次",
      mentorSpeech: mentor ? buildMentorMiniGameSpeechRequest(mentor, "fishing", siteName, "空竿了") : undefined,
    };
  }
  const reward = resolveFishingReward(session);`,
  "Added mentorSpeech to empty_hook result"
);

// 7. Add mentorSpeech to success result
apply(
  `    memorySummary: \`钓鱼成功，收获 \${reward.name}\`,
  };
}

function fishingStep`,
  `    memorySummary: \`钓鱼成功，收获 \${reward.name}\`,
    mentorSpeech: mentor ? buildMentorMiniGameSpeechRequest(mentor, "fishing", siteName, \`钓到 \${reward.name}\`) : undefined,
  };
}

function fishingStep`,
  "Added mentorSpeech to success result"
);

// 8. Update resolveFishingRound calls
apply(
  'const fishRound = resolveFishingRound(session, siteName);',
  'const fishRound = resolveFishingRound(session, siteName, ctx);',
  "Updated resolveFishingRound calls to pass ctx"
);

// 9. Add mentor selection handling to fishingStep
apply(
  `function fishingStep(session: JsonRecord, actionId: string, ctx: MiniGameControllerInput): MiniGameStepResult {
  const publicState = asRecord(session.public_state);
  const hidden = asRecord(session.hidden_state);
  const narratorName = scalarText(ctx?.world?.narratorRole?.name) || "旁白";
  const playerName = scalarText(ctx?.world?.playerRole?.name) || "用户";
  const currentPhase = normalizePhase(session.phase, "prepare");
  const siteName = scalarText(publicState.site_name) || "水面";
  if (actionId === "finish") {`,
  `function fishingStep(session: JsonRecord, actionId: string, ctx: MiniGameControllerInput): MiniGameStepResult {
  const publicState = asRecord(session.public_state);
  const hidden = asRecord(session.hidden_state);
  const narratorName = scalarText(ctx?.world?.narratorRole?.name) || "旁白";
  const playerName = scalarText(ctx?.world?.playerRole?.name) || "用户";
  const currentPhase = normalizePhase(session.phase, "prepare");
  const siteName = scalarText(publicState.site_name) || "水面";
  const mentors = uniqueTexts(asArray<string>(publicState.available_mentors));
  // 处理陪练选择
  if (currentPhase === "prepare") {
    if (actionId === "choose_mentor") {
      const mentorList = mentors.length > 0 ? \`可选陪练：\${mentors.join("、")}。\` : "当前没有可选陪练。";
      return {
        narration: \`\${mentorList}直接输入陪练角色名字选择协助，或输入"不需要陪练"独自开始。\`,
        resultTags: ["choose_mentor"],
      };
    }
    if (actionId === "no_mentor") {
      publicState.mentor = "无";
      return {
        narration: \`你决定独自钓鱼。准备好了就输入"抛竿"开始吧。\`,
        resultTags: ["no_mentor"],
      };
    }
    if (actionId.startsWith("mentor:")) {
      const mentorName = actionId.replace("mentor:", "");
      publicState.mentor = mentorName;
      return {
        narration: \`你邀请了 \${mentorName} 协助钓鱼。准备好了就输入"抛竿"开始吧。\`,
        resultTags: ["mentor_selected", \`mentor:\${mentorName}\`],
      };
    }
  }
  if (actionId === "finish") {`,
  "Added mentor selection handling to fishingStep"
);

// 10. Update passivePatterns
apply(
  'passivePatterns: [/钓鱼/, /去钓鱼/, /开始钓鱼/, /抛竿/],',
  'passivePatterns: [/钓鱼/, /去钓鱼/, /开始钓鱼/],',
  "Updated passivePatterns to remove /抛竿/"
);

// 11. Update RULEBOOKS.fishing setup - need to change from arrow function returning object to block function with mentors
// This is complex - let's do it carefully

// First, let's find the fishing rulebook
const fishingStart = content.indexOf('fishing: {');
if (fishingStart > 0) {
  // Find the ruleSummary line
  const rsStart = content.indexOf('ruleSummary:', fishingStart);
  const rsEnd = content.indexOf(',', rsStart);

  // Check if rulebookNarration already added
  const afterRs = content.slice(rsEnd, rsEnd + 50);
  if (!afterRs.includes('rulebookNarration')) {
    // Insert rulebookNarration after ruleSummary
    const ruleSummaryLine = content.slice(rsStart, rsEnd + 1);
    const rulebookNarration = `\n    rulebookNarration: \`你来到 \${scalarText(publicState.site_name) || "水边"}，准备开始钓鱼。\${mentors && mentors.length > 0 ? \`可选陪练：\${mentors.join("、")}。\` : "当前没有可选陪练。"}准备好后直接输入"抛竿"开始。\`,`;

    content = content.slice(0, rsEnd + 1) + rulebookNarration + content.slice(rsEnd + 1);
    modifications.push("Added rulebookNarration to fishing rulebook");
  }

  // Find setup line and change it
  const setupIdx = content.indexOf('setup: (ctx, sessionId, entrySource) => ({', fishingStart);
  if (setupIdx > 0 && setupIdx < fishingStart + 2000) {
    // Change from arrow function returning object to block function
    content = content.replace(
      'setup: (ctx, sessionId, entrySource) => ({',
      'setup: (ctx, sessionId, entrySource) => {\n      const mentors = collectCultivationMentorNames(ctx);\n      return {'
    );
    modifications.push("Changed fishing setup to block function with mentors");

    // Fix the closing - change '}),' to '}; },'
    const resumeIdx = content.indexOf('resume_token: `resume_${sessionId}`,');
    if (resumeIdx > fishingStart && resumeIdx < fishingStart + 5000) {
      // The next characters after resume_token line should be }), and we need to change to };
      const afterResume = content.slice(resumeIdx, resumeIdx + 30);
      if (afterResume.includes('}),')) {
        content = content.replace('resume_token: `resume_${sessionId}`,\n    }),', 'resume_token: `resume_${sessionId}`,\n      };\n    },');
        modifications.push("Fixed setup function closing");
      }
    }
  }

  // Update public_state to include available_mentors
  apply(
    `public_state: buildSimplePublicState({
        site_name: "当前水域",
        user_level: readMiniGamePlayerLevel(ctx.state),
        exp_reward: 0,
        current_status: "准备抛竿",
        last_result: "",
        last_reward: "",
      }),`,
    `public_state: buildSimplePublicState({
        site_name: "当前水域",
        user_level: readMiniGamePlayerLevel(ctx.state),
        exp_reward: 0,
        current_status: "准备抛竿",
        last_result: "",
        last_reward: "",
        available_mentors: mentors,
      }),`,
    "Added available_mentors to fishing public_state"
  );

  // Update participants count
  apply(
    'participants: buildParticipants(ctx, 1),',
    'participants: buildParticipants(ctx, Math.max(1, Math.min(3, mentors.length + 1))),',
    "Updated participants count in fishing setup"
  );
}

fs.writeFileSync(path, content, 'utf8');

console.log('Modifications applied:');
for (const m of modifications) {
  console.log(`  - ${m}`);
}
if (modifications.length === 0) {
  console.log('  (none applied - patterns may not match)');
}