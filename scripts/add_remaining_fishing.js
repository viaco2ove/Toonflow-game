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

// 2. Add mentor selection handling to fishingStep
const oldFishingStep = `function fishingStep(session: JsonRecord, actionId: string, ctx: MiniGameControllerInput): MiniGameStepResult {
  const publicState = asRecord(session.public_state);
  const hidden = asRecord(session.hidden_state);
  const narratorName = scalarText(ctx?.world?.narratorRole?.name) || "旁白";
  const playerName = scalarText(ctx?.world?.playerRole?.name) || "用户";
  const currentPhase = normalizePhase(session.phase, "prepare");
  const siteName = scalarText(publicState.site_name) || "水面";
  if (actionId === "finish") {`;

const newFishingStep = `function fishingStep(session: JsonRecord, actionId: string, ctx: MiniGameControllerInput): MiniGameStepResult {
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
  if (actionId === "finish") {`;

apply(oldFishingStep, newFishingStep, "Added mentor selection handling to fishingStep");

// 3. Add mentor variable and mentorSpeech to resolveFishingRound
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

// 4. Add mentorSpeech to empty_hook result
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

// 5. Add mentorSpeech to success result
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

// 6. Update resolveFishingRound calls to pass ctx
apply(
  'const fishRound = resolveFishingRound(session, siteName);',
  'const fishRound = resolveFishingRound(session, siteName, ctx);',
  "Updated resolveFishingRound calls to pass ctx"
);

// 7. Add available_mentors to fishing public_state in setup
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

fs.writeFileSync(path, content, 'utf8');

console.log('Modifications applied:');
for (const m of modifications) {
  console.log(`  - ${m}`);
}
if (modifications.length === 0) {
  console.log('  (none applied - patterns may not match)');
}