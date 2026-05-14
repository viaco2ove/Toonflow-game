#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Apply all fishing modifications to MiniGameController.ts
Handles Chinese quotes (U+201C/U+201D) correctly
"""
import re

with open('src/modules/game-runtime/engines/MiniGameController.ts', 'r', encoding='utf-8') as f:
    content = f.read()

modifications = []

# Helper function to check and apply replacement
def apply_replace(old, new, desc):
    global content
    if old in content:
        content = content.replace(old, new)
        modifications.append(desc)
        return True
    return False

# 1. Add rulebookNarration to MiniGameRulebook interface
apply_replace(
    '  ruleSummary: string;\n  setup:',
    '  ruleSummary: string;\n  rulebookNarration?: string;\n  setup:',
    "Added rulebookNarration to interface"
)

# 2. Add resolveMentorSpeechDirection for fishing
apply_replace(
    'if (gameType === "cultivation") return `以陪练或护法身份指导用户继续修炼${targetText}，可提醒节奏、气息或风险。`;',
    'if (gameType === "fishing") return `以协助者身份提醒用户关注${targetText}的水情、鱼类动向或收竿时机。`;\n  if (gameType === "cultivation") return `以陪练或护法身份指导用户继续修炼${targetText}，可提醒节奏、气息或风险。`;',
    "Added resolveMentorSpeechDirection for fishing"
)

# 3. Modify fishingOptions to add mentor options
old_fishingOptions = '''function fishingOptions(session: JsonRecord): MiniGameActionOption[] {
  const phase = normalizePhase(session.phase, "prepare");
  if (phase === "prepare") {
    return [
      { action_id: "cast", label: "抛竿", desc: "开始本次垂钓", aliases: ["开始钓鱼", "甩竿", "下钩"] },
      { action_id: "finish", label: "#退出结束", desc: "输入 #退出 结束当前钓鱼", aliases: ["收摊", "结束钓鱼", "离开水边"] },
    ];
  }'''

new_fishingOptions = '''function fishingOptions(session: JsonRecord): MiniGameActionOption[] {
  const phase = normalizePhase(session.phase, "prepare");
  const publicState = asRecord(session.public_state);
  const mentors = uniqueTexts(asArray<string>(publicState.available_mentors));
  const mentorOptions = mentors.map((item) => ({
    action_id: `mentor:${item}`,
    label: item,
    desc: `选择${item}协助钓鱼`,
    aliases: [`选择${item}`, `${item}陪练`, `${item}协助`, `让${item}帮忙`, `请${item}帮忙`],
  }));
  if (phase === "prepare") {
    return [
      { action_id: "choose_mentor", label: "需要陪练", desc: "查看可选协助角色", aliases: ["需要陪练", "找陪练", "需要协助", "找人帮忙"] },
      { action_id: "no_mentor", label: "不需要陪练", desc: "独自钓鱼", aliases: ["不用陪练", "不需要陪练", "自己钓", "独自钓鱼"] },
      ...mentorOptions,
      { action_id: "cast", label: "抛竿", desc: "开始本次垂钓", aliases: ["开始钓鱼", "甩竿", "下钩"] },
      { action_id: "finish", label: "#退出结束", desc: "输入 #退出 结束当前钓鱼", aliases: ["收摊", "结束钓鱼", "离开水边"] },
    ];
  }'''

apply_replace(old_fishingOptions, new_fishingOptions, "Added mentor options to fishingOptions")

# 4. Modify resolveFishingRound signature
apply_replace(
    'function resolveFishingRound(session: JsonRecord, siteName: string): MiniGameStepResult {',
    'function resolveFishingRound(session: JsonRecord, siteName: string, ctx?: MiniGameControllerInput): MiniGameStepResult {',
    "Modified resolveFishingRound signature"
)

# 5. Add mentor logic after fishingExpGain
old_exp = '''  const fishingExpGain = Math.max(10, Number(publicState.exp_reward || 0));
  session.phase = "result";'''

new_exp = '''  const fishingExpGain = Math.max(10, Number(publicState.exp_reward || 0));
  const currentMentor = () => {
    const mentor = scalarText(publicState.mentor);
    return mentor && mentor !== "无" ? mentor : "";
  };
  const mentor = currentMentor();
  session.phase = "result";'''

apply_replace(old_exp, new_exp, "Added mentor logic to resolveFishingRound")

# 6. Add mentorSpeech to empty_hook result
old_empty = '''      resultTags: ["cast", "empty_hook"],
      memorySummary: "钓鱼空竿一次",
    };
  }
  const reward = resolveFishingReward(session);'''

new_empty = '''      resultTags: ["cast", "empty_hook"],
      memorySummary: "钓鱼空竿一次",
      mentorSpeech: mentor ? buildMentorMiniGameSpeechRequest(mentor, "fishing", siteName, "空竿了") : undefined,
    };
  }
  const reward = resolveFishingReward(session);'''

apply_replace(old_empty, new_empty, "Added mentorSpeech to empty_hook result")

# 7. Add mentorSpeech to success result
old_success_end = '''    memorySummary: `钓鱼成功，收获 ${reward.name}`,
  };
}

function fishingStep'''

new_success_end = '''    memorySummary: `钓鱼成功，收获 ${reward.name}`,
    mentorSpeech: mentor ? buildMentorMiniGameSpeechRequest(mentor, "fishing", siteName, `钓到 ${reward.name}`) : undefined,
  };
}

function fishingStep'''

apply_replace(old_success_end, new_success_end, "Added mentorSpeech to success result")

# 8. Update resolveFishingRound calls
apply_replace(
    'const fishRound = resolveFishingRound(session, siteName);',
    'const fishRound = resolveFishingRound(session, siteName, ctx);',
    "Updated resolveFishingRound calls to pass ctx"
)

# 9. Add mentor selection handling to fishingStep
old_fishingStep_start = '''function fishingStep(session: JsonRecord, actionId: string, ctx: MiniGameControllerInput): MiniGameStepResult {
  const publicState = asRecord(session.public_state);
  const hidden = asRecord(session.hidden_state);
  const narratorName = scalarText(ctx?.world?.narratorRole?.name) || "旁白";
  const playerName = scalarText(ctx?.world?.playerRole?.name) || "用户";
  const currentPhase = normalizePhase(session.phase, "prepare");
  const siteName = scalarText(publicState.site_name) || "水面";
  if (actionId === "finish") {'''

new_fishingStep_start = '''function fishingStep(session: JsonRecord, actionId: string, ctx: MiniGameControllerInput): MiniGameStepResult {
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
      const mentorList = mentors.length > 0 ? `可选陪练：${mentors.join("、")}。` : "当前没有可选陪练。";
      return {
        narration: `${mentorList}直接输入陪练角色名字选择协助，或输入"不需要陪练"独自开始。`,
        resultTags: ["choose_mentor"],
      };
    }
    if (actionId === "no_mentor") {
      publicState.mentor = "无";
      return {
        narration: `你决定独自钓鱼。准备好了就输入"抛竿"开始吧。`,
        resultTags: ["no_mentor"],
      };
    }
    if (actionId.startsWith("mentor:")) {
      const mentorName = actionId.replace("mentor:", "");
      publicState.mentor = mentorName;
      return {
        narration: `你邀请了 ${mentorName} 协助钓鱼。准备好了就输入"抛竿"开始吧。`,
        resultTags: ["mentor_selected", `mentor:${mentorName}`],
      };
    }
  }
  if (actionId === "finish") {'''

apply_replace(old_fishingStep_start, new_fishingStep_start, "Added mentor selection handling to fishingStep")

# 10. Update passivePatterns
apply_replace(
    'passivePatterns: [/钓鱼/, /去钓鱼/, /开始钓鱼/, /抛竿/],',
    'passivePatterns: [/钓鱼/, /去钓鱼/, /开始钓鱼/],',
    "Updated passivePatterns to remove /抛竿/"
)

# 11. Update RULEBOOKS.fishing - change setup and add rulebookNarration
# The setup is: setup: (ctx, sessionId, entrySource) => ({ ... }),
# We need to change it to a block function with mentors
old_fishing_rulebook = '''fishing: {
    gameType: "fishing",
    displayName: "钓鱼",
    version: "1.0",
    goal: "抛竿后立即结算，看看能否钓到鱼或宝物",
    phaseOrder: ["prepare", "waiting", "result", "settling"],
    triggerTags: ["#钓鱼"],
    passivePatterns: [/钓鱼/, /去钓鱼/, /开始钓鱼/],
    ruleSummary: "直接输入"抛竿""收杆""继续钓鱼"等动作。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。",
    setup: (ctx, sessionId, entrySource) => ({'''

new_fishing_rulebook = '''fishing: {
    gameType: "fishing",
    displayName: "钓鱼",
    version: "1.0",
    goal: "抛竿后立即结算，看看能否钓到鱼或宝物",
    phaseOrder: ["prepare", "waiting", "result", "settling"],
    triggerTags: ["#钓鱼"],
    passivePatterns: [/钓鱼/, /去钓鱼/, /开始钓鱼/],
    ruleSummary: "直接输入"抛竿""收杆""继续钓鱼"等动作。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。",
    rulebookNarration: `你来到 ${scalarText(publicState.site_name) || "水边"}，准备开始钓鱼。${mentors && mentors.length > 0 ? `可选陪练：${mentors.join("、")}。` : "当前没有可选陪练。"}准备好后直接输入"抛竿"开始。`,
    setup: (ctx, sessionId, entrySource) => {
      const mentors = collectCultivationMentorNames(ctx);
      return {'''

apply_replace(old_fishing_rulebook, new_fishing_rulebook, "Updated RULEBOOKS.fishing setup and added rulebookNarration")

# 12. Update public_state to include available_mentors
old_public_state = '''public_state: buildSimplePublicState({
        site_name: "当前水域",
        user_level: readMiniGamePlayerLevel(ctx.state),
        exp_reward: 0,
        current_status: "准备抛竿",
        last_result: "",
        last_reward: "",
      }),'''

new_public_state = '''public_state: buildSimplePublicState({
        site_name: "当前水域",
        user_level: readMiniGamePlayerLevel(ctx.state),
        exp_reward: 0,
        current_status: "准备抛竿",
        last_result: "",
        last_reward: "",
        available_mentors: mentors,
      }),'''

apply_replace(old_public_state, new_public_state, "Added available_mentors to fishing public_state")

# 13. Update participants count
apply_replace(
    'participants: buildParticipants(ctx, 1),',
    'participants: buildParticipants(ctx, Math.max(1, Math.min(3, mentors.length + 1))),',
    "Updated participants count in fishing setup"
)

# 14. Fix the closing of the setup function
# The old pattern ends with: ...can_suspend: true, can_quit: true, resume_token: `resume_${sessionId}`,
# We need to change the closing from }); to }; };
# Actually let's find where the closing should be and fix it
# The fishing setup uses arrow function returning object: => ({ ... })
# We changed to block function: => { ... return { ... }; },
# So we need to find the closing pattern

# Find the werewolf rulebook entry and check the fishing closing before it
werewolf_idx = content.find('werewolf: {')
if werewolf_idx > 0:
    fishing_idx = content.find('fishing: {')
    if fishing_idx > 0:
        setup_idx = content.find('setup: (ctx, sessionId, entrySource) => {', fishing_idx)
        if setup_idx > 0 and setup_idx < werewolf_idx:
            # Find the end of setup - look for the pattern that ends the setup
            # The original ends with "resume_token: `resume_${sessionId}`,"
            # and then });
            # We need to change }); to };
            old_closing = '''        action_log_ids: [], result: "ongoing", finish_reason: "", reward_preview: {}, writeback_whitelist: ["player_state.parameter_card", "player_state.inventory", "memory_state.mid_term"], can_suspend: true, can_quit: true, resume_token: `resume_${sessionId}`,
      }),
    options: fishingOptions,'''

            new_closing = '''        action_log_ids: [], result: "ongoing", finish_reason: "", reward_preview: {}, writeback_whitelist: ["player_state.parameter_card", "player_state.inventory", "memory_state.mid_term"], can_suspend: true, can_quit: true, resume_token: `resume_${sessionId}`,
      };
    },
    options: fishingOptions,'''

            apply_replace(old_closing, new_closing, "Fixed setup function closing")

with open('src/modules/game-runtime/engines/MiniGameController.ts', 'w', encoding='utf-8') as f:
    f.write(content)

print("Modifications applied:")
for m in modifications:
    print(f"  - {m}")
if not modifications:
    print("  (none applied - patterns may not match)")