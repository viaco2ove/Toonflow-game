const fs = require('fs');
const path = 'src/modules/game-runtime/engines/MiniGameController.ts';
let content = fs.readFileSync(path, 'utf8');

function replace(oldStr, newStr, label) {
  if (content.includes(oldStr)) {
    content = content.replace(oldStr, newStr);
    console.log(`OK: ${label}`);
    return true;
  } else {
    console.error(`ERROR: ${label} not found`);
    return false;
  }
}

// 1. fishingOptions
replace(
  `function fishingOptions(session: JsonRecord): MiniGameActionOption[] {
  const phase = normalizePhase(session.phase, "prepare");
  if (phase === "prepare") {
    return [
      { action_id: "cast", label: "抛竿", desc: "开始本次垂钓", aliases: ["开始钓鱼", "甩竿", "下钩"] },
      { action_id: "finish", label: "#退出结束", desc: "输入 #退出 结束当前钓鱼", aliases: ["收摊", "结束钓鱼", "离开水边"] },
    ];
  }`,
  `function fishingOptions(session: JsonRecord): MiniGameActionOption[] {
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
  }`,
  'fishingOptions'
);

// 2. fishingStep 添加陪练选择逻辑
replace(
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
        narration: "你决定独自钓鱼。准备好了就输入"抛竿"开始吧。",
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
  'fishingStep mentor logic'
);

// 3. resolveFishingRound 签名
replace(
  `function resolveFishingRound(session: JsonRecord, siteName: string): MiniGameStepResult {`,
  `function resolveFishingRound(session: JsonRecord, siteName: string, ctx?: MiniGameControllerInput): MiniGameStepResult {`,
  'resolveFishingRound signature'
);

// 4. resolveFishingRound 添加 mentor 逻辑
replace(
  `  const roll = Number(hidden.encounter_roll || takeRng(session, 1, 100));
  const fishingExpGain = Math.max(10, Number(publicState.exp_reward || 0));
  session.phase = "result";`,
  `  const roll = Number(hidden.encounter_roll || takeRng(session, 1, 100));
  const fishingExpGain = Math.max(10, Number(publicState.exp_reward || 0));
  const currentMentor = () => {
    const mentor = scalarText(publicState.mentor);
    return mentor && mentor !== "无" ? mentor : "";
  };
  const mentor = currentMentor();
  session.phase = "result";`,
  'resolveFishingRound mentor logic'
);

// 5. resolveFishingRound 空竿返回值添加 mentorSpeech
replace(
  `      narration: \`你把鱼钩抛进 \${siteName}，片刻后水面恢复了平静，这一竿没有鱼也没有宝物。你可以继续钓鱼，或输入 #退出 结束当前钓鱼。\`,
      resultTags: ["cast", "empty_hook"],
      memorySummary: "钓鱼空竿一次",
    };
  }
  const reward = resolveFishingReward(session);`,
  `      narration: \`你把鱼钩抛进 \${siteName}，片刻后水面恢复了平静，这一竿没有鱼也没有宝物。你可以继续钓鱼，或输入 #退出 结束当前钓鱼。\`,
      resultTags: ["cast", "empty_hook"],
      memorySummary: "钓鱼空竿一次",
      mentorSpeech: mentor ? buildMentorMiniGameSpeechRequest(mentor, "fishing", siteName, "空竿了") : undefined,
    };
  }
  const reward = resolveFishingReward(session);`,
  'resolveFishingRound empty_hook mentorSpeech'
);

// 6. resolveFishingRound 成功返回值添加 mentorSpeech
replace(
  `    memorySummary: \`钓鱼成功，收获 \${reward.name}\`,
  };
}
function fishingStep`,
  `    memorySummary: \`钓鱼成功，收获 \${reward.name}\`,
    mentorSpeech: mentor ? buildMentorMiniGameSpeechRequest(mentor, "fishing", reward.name, publicState.last_result || "") : undefined,
  };
}
function fishingStep`,
  'resolveFishingRound success mentorSpeech'
);

// 7. fishingStep 中调用 resolveFishingRound 添加 ctx 参数
let count = (content.match(/const fishRound = resolveFishingRound\(session, siteName\);/g) || []).length;
if (count > 0) {
  content = content.replace(/const fishRound = resolveFishingRound\(session, siteName\);/g, 'const fishRound = resolveFishingRound(session, siteName, ctx);');
  console.log(`OK: resolveFishingRound calls updated (${count} occurrences)`);
} else {
  console.error('ERROR: resolveFishingRound calls not found');
}

// 8. RULEBOOKS fishing passivePatterns
replace(
  `passivePatterns: [/钓鱼/, /去钓鱼/, /开始钓鱼/, /抛竿/],`,
  `passivePatterns: [/钓鱼/, /去钓鱼/, /开始钓鱼/],`,
  'passivePatterns'
);

// 9. RULEBOOKS fishing ruleSummary
replace(
  `ruleSummary: "直接输入"抛竿""收杆""继续钓鱼"等动作。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。",`,
  `ruleSummary: "首次进入默认折叠面板，旁白询问目标水域与是否需要陪练。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。",
    rulebookNarration: "钓鱼规则：首次进入默认折叠面板，旁白询问目标水域与是否需要陪练。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。输入 #钓鱼 即可开始钓鱼，输入 #退出 可以强制退出小游戏。",`,
  'ruleSummary + rulebookNarration'
);

// 10. RULEBOOKS fishing setup (part 1)
replace(
  `    setup: (ctx, sessionId, entrySource) => ({
      session_id: sessionId,
      game_type: "fishing",
      rulebook_version: "1.0",
      status: "active",
      phase: "prepare",
      round: 1,
      sub_turn: 0,
      entry_source: entrySource,
      chapter_id: Number(ctx.chapter?.id || 0) || null,
      scene_id: scalarText(ctx.chapter?.title) || "river_bank",
      participants: buildParticipants(ctx, 1),
      public_state: buildSimplePublicState({
        site_name: "当前水域",
        user_level: readMiniGamePlayerLevel(ctx.state),
        exp_reward: 0,
        current_status: "准备抛竿",
        last_result: "",
        last_reward: "",
      }),`,
  `    setup: (ctx, sessionId, entrySource) => {
      const mentors = collectCultivationMentorNames(ctx);
      return {
        session_id: sessionId,
        game_type: "fishing",
        rulebook_version: "1.0",
        status: "active",
        phase: "prepare",
        round: 1,
        sub_turn: 0,
        entry_source: entrySource,
        chapter_id: Number(ctx.chapter?.id || 0) || null,
        scene_id: scalarText(ctx.chapter?.title) || "river_bank",
        participants: buildParticipants(ctx, Math.max(1, Math.min(3, mentors.length + 1))),
        public_state: buildSimplePublicState({
          site_name: "当前水域",
          user_level: readMiniGamePlayerLevel(ctx.state),
          exp_reward: 0,
          current_status: "准备抛竿",
          last_result: "",
          last_reward: "",
          available_mentors: mentors,
        }),`,
  'RULEBOOKS fishing setup (part 1)'
);

// 11. RULEBOOKS fishing setup (part 2 - closing)
replace(
  `      hidden_state: { target_fish_name: "", encounter_roll: 0, fish_rarity: "", reward_kind: "" },
      resource_state: {},
      rng_state: { seed: \`\${ctx.world?.id || 0}:\${ctx.chapter?.id || 0}:fishing:\${sessionId}\`, cursor: 0, queue: buildRngQueue(\`\${ctx.world?.id || 0}:\${ctx.chapter?.id || 0}:fishing:\${sessionId}\`) },
      action_log_ids: [], result: "ongoing", finish_reason: "", reward_preview: {}, writeback_whitelist: ["player_state.parameter_card", "player_state.inventory", "memory_state.mid_term"], can_suspend: true, can_quit: true, resume_token: \`resume_\${sessionId}\`,
    }),`,
  `        hidden_state: { target_fish_name: "", encounter_roll: 0, fish_rarity: "", reward_kind: "" },
        resource_state: {},
        rng_state: { seed: \`\${ctx.world?.id || 0}:\${ctx.chapter?.id || 0}:fishing:\${sessionId}\`, cursor: 0, queue: buildRngQueue(\`\${ctx.world?.id || 0}:\${ctx.chapter?.id || 0}:fishing:\${sessionId}\`) },
        action_log_ids: [], result: "ongoing", finish_reason: "", reward_preview: {}, writeback_whitelist: ["player_state.parameter_card", "player_state.inventory", "memory_state.mid_term"], can_suspend: true, can_quit: true, resume_token: \`resume_\${sessionId}\`,
      };
    },`,
  'RULEBOOKS fishing setup (part 2)'
);

// 12. resolveMentorSpeechDirection
replace(
  `  if (gameType === "mining") return \`以协助者身份提醒用户处理\${targetText}相关的矿道风险、开采节奏或撤离判断。\`;`,
  `  if (gameType === "mining") return \`以协助者身份提醒用户处理\${targetText}相关的矿道风险、开采节奏或撤离判断。\`;
  if (gameType === "fishing") return \`以协助者身份提醒用户关注\${targetText}的水情、鱼类动向或收竿时机。\`;`,
  'resolveMentorSpeechDirection'
);

// 13. MiniGameRulebook 接口
replace(
  `  ruleSummary: string;
  setup: (ctx: MiniGameControllerInput, sessionId: string, entrySource: string) => JsonRecord;`,
  `  ruleSummary: string;
  rulebookNarration?: string;
  setup: (ctx: MiniGameControllerInput, sessionId: string, entrySource: string) => JsonRecord;`,
  'MiniGameRulebook interface'
);

// 14. buildStartNarration
replace(
  `  if (rulebook.gameType === "fishing") {
    return \`你来到 \${scalarText(publicState.site_name) || "水边"}，准备开始钓鱼。现在可以直接输入"抛竿""收杆"或"继续钓鱼"。\`;
  }`,
  `  if (rulebook.gameType === "fishing") {
    const mentors = asArray<string>(publicState.available_mentors).join("、");
    return [
      \`你来到 \${scalarText(publicState.site_name) || "水边"}，准备开始钓鱼。是否需要陪练或角色协助？\`,
      mentors ? \`可选陪练：\${mentors}。\` : "当前没有可选陪练，也可以独自钓鱼。",
      "可以先输入陪练角色名字（如"小医仙"）选择协助，或输入"不需要陪练"独自开始，然后输入"抛竿"开始钓鱼。",
    ].join("");
  }`,
  'buildStartNarration'
);

// 15. buildStatusNarration
replace(
  `  if (rulebook.gameType === "fishing") {
    const reward = scalarText(publicState.last_reward);
    return [
      \`钓鱼状态：\${scalarText(publicState.current_status) || "准备抛竿"}。\`,
      scalarText(publicState.last_result) ? \`本轮结果：\${scalarText(publicState.last_result)}。\` : "",
      reward ? \`最近收获：\${reward}。\` : "",
      "可直接输入"抛竿""收杆"或"继续钓鱼"。",
    ].filter(Boolean).join("");
  }`,
  `  if (rulebook.gameType === "fishing") {
    const reward = scalarText(publicState.last_reward);
    const mentor = scalarText(publicState.mentor);
    return [
      \`钓鱼状态：\${scalarText(publicState.current_status) || "准备抛竿"}\${mentor && mentor !== "无" ? \`（陪练：\${mentor}）\` : "（无陪练）"}。\`,
      scalarText(publicState.last_result) ? \`本轮结果：\${scalarText(publicState.last_result)}。\` : "",
      reward ? \`最近收获：\${reward}。\` : "",
      "可直接输入陪练角色名、"抛竿"、"收杆"或"继续钓鱼"。",
    ].filter(Boolean).join("");
  }`,
  'buildStatusNarration'
);

// 16. buildRuleNarration
replace(
  `  if (rulebook.gameType === "fishing") {
    return "钓鱼规则：通过聊天框直接输入"抛竿""收杆""继续钓鱼"等动作推进。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。";
  }`,
  `  if (rulebook.gameType === "fishing") {
    return "钓鱼规则：通过聊天框先选择陪练角色或独自钓鱼，然后输入"抛竿""收杆""继续钓鱼"等动作推进。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。";
  }`,
  'buildRuleNarration'
);

// 17. buildInputHint
replace(
  `  if (rulebook.gameType === "fishing") {
    return "直接输入动作，例如"抛竿""收杆""继续钓鱼"，#退出 可强制退出小游戏";
  }`,
  `  if (rulebook.gameType === "fishing") {
    return "直接输入陪练角色名、"抛竿"、"收杆"或"继续钓鱼"，#退出 可强制退出小游戏";
  }`,
  'buildInputHint'
);

fs.writeFileSync(path, content, 'utf8');
console.log('\nAll replacements done!');
