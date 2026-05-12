#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import re

with open('src/modules/game-runtime/engines/MiniGameController.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# Store modifications
modified = []

# 1. Add rulebookNarration to MiniGameRulebook interface (after ruleSummary: string)
if 'rulebookNarration?: string;' not in content:
    content = content.replace(
        '  ruleSummary: string;\n  setup:',
        '  ruleSummary: string;\n  rulebookNarration?: string;\n  setup:'
    )
    modified.append("Added rulebookNarration to interface")

# 2. Add resolveMentorSpeechDirection for fishing
if 'if (gameType === "fishing") return' not in content:
    content = content.replace(
        'if (gameType === "cultivation") return `以陪练或护法身份指导用户继续修炼${targetText}，可提醒节奏、气息或风险。`;',
        'if (gameType === "fishing") return `以协助者身份提醒用户关注${targetText}的水情、鱼类动向或收竿时机。`;\n  if (gameType === "cultivation") return `以陪练或护法身份指导用户继续修炼${targetText}，可提醒节奏、气息或风险。`;'
    )
    modified.append("Added resolveMentorSpeechDirection for fishing")

# 3. Modify fishingOptions to add mentor options
if 'const mentors = uniqueTexts(asArray<string>(publicState.available_mentors));\n  const mentorOptions = mentors.map' not in content:
    old_fishingOptions_start = '''function fishingOptions(session: JsonRecord): MiniGameActionOption[] {
  const phase = normalizePhase(session.phase, "prepare");
  if (phase === "prepare") {
    return [
      { action_id: "cast", label: "抛竿",'''
    new_fishingOptions_start = '''function fishingOptions(session: JsonRecord): MiniGameActionOption[] {
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
      { action_id: "cast", label: "抛竿",'''
    content = content.replace(old_fishingOptions_start, new_fishingOptions_start)
    modified.append("Added mentor options to fishingOptions")

# 4. Modify fishingStep to handle mentor selection (before finish handler)
if 'const mentors = uniqueTexts(asArray<string>(publicState.available_mentors));\n  // 处理陪练选择\n  if (currentPhase === "prepare")' not in content:
    old_fishingStep = '''function fishingStep(session: JsonRecord, actionId: string, ctx: MiniGameControllerInput): MiniGameStepResult {
  const publicState = asRecord(session.public_state);
  const hidden = asRecord(session.hidden_state);
  const narratorName = scalarText(ctx?.world?.narratorRole?.name) || "旁白";
  const playerName = scalarText(ctx?.world?.playerRole?.name) || "用户";
  const currentPhase = normalizePhase(session.phase, "prepare");
  const siteName = scalarText(publicState.site_name) || "水面";
  if (actionId === "finish") {'''

    new_fishingStep = '''function fishingStep(session: JsonRecord, actionId: string, ctx: MiniGameControllerInput): MiniGameStepResult {
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

    content = content.replace(old_fishingStep, new_fishingStep)
    modified.append("Added mentor selection handling to fishingStep")

# 5. Modify resolveFishingRound signature
if 'function resolveFishingRound(session: JsonRecord, siteName: string, ctx?: MiniGameControllerInput): MiniGameStepResult {' not in content:
    content = content.replace(
        'function resolveFishingRound(session: JsonRecord, siteName: string): MiniGameStepResult {',
        'function resolveFishingRound(session: JsonRecord, siteName: string, ctx?: MiniGameControllerInput): MiniGameStepResult {'
    )
    modified.append("Modified resolveFishingRound signature")

# 6. Add mentor logic and mentorSpeech to resolveFishingRound
if 'const currentMentor = () =>' not in content:
    # Add after the fishingExpGain line
    old_exp_line = '  const fishingExpGain = Math.max(10, Number(publicState.exp_reward || 0));\n  session.phase = "result";'
    new_exp_line = '''  const fishingExpGain = Math.max(10, Number(publicState.exp_reward || 0));
  const currentMentor = () => {
    const mentor = scalarText(publicState.mentor);
    return mentor && mentor !== "无" ? mentor : "";
  };
  const mentor = currentMentor();
  session.phase = "result";'''
    content = content.replace(old_exp_line, new_exp_line)
    modified.append("Added mentor logic to resolveFishingRound")

# 7. Add mentorSpeech to empty_hook result
if 'mentorSpeech: mentor ? buildMentorMiniGameSpeechRequest(mentor, "fishing", siteName, "空竿了") : undefined,' not in content:
    old_empty_result = '''      resultTags: ["cast", "empty_hook"],
      memorySummary: "钓鱼空竿一次",
    };
  }
  const reward = resolveFishingReward(session);'''

    new_empty_result = '''      resultTags: ["cast", "empty_hook"],
      memorySummary: "钓鱼空竿一次",
      mentorSpeech: mentor ? buildMentorMiniGameSpeechRequest(mentor, "fishing", siteName, "空竿了") : undefined,
    };
  }
  const reward = resolveFishingReward(session);'''
    content = content.replace(old_empty_result, new_empty_result)
    modified.append("Added mentorSpeech to empty_hook result")

# 8. Add mentorSpeech to success result
if 'memorySummary: `钓鱼成功，收获 ${reward.name}`,\n    mentorSpeech: mentor' not in content:
    old_success_end = '''    memorySummary: `钓鱼成功，收获 ${reward.name}`,
  };
}

function fishingStep'''

    new_success_end = '''    memorySummary: `钓鱼成功，收获 ${reward.name}`,
    mentorSpeech: mentor ? buildMentorMiniGameSpeechRequest(mentor, "fishing", siteName, `钓到 ${reward.name}`) : undefined,
  };
}

function fishingStep'''
    content = content.replace(old_success_end, new_success_end)
    modified.append("Added mentorSpeech to success result")

# 9. Update resolveFishingRound calls
content = content.replace(
    'const fishRound = resolveFishingRound(session, siteName);',
    'const fishRound = resolveFishingRound(session, siteName, ctx);'
)
modified.append("Updated resolveFishingRound calls to pass ctx")

# 10. Update passivePatterns
if "passivePatterns: [/钓鱼/, /去钓鱼/, /开始钓鱼/]" not in content:
    content = content.replace(
        "passivePatterns: [/钓鱼/, /去钓鱼/, /开始钓鱼/, /抛竿/],",
        "passivePatterns: [/钓鱼/, /去钓鱼/, /开始钓鱼/],"
    )
    modified.append("Updated passivePatterns to remove /抛竿/")

# 11. Update RULEBOOKS.fishing - add mentors setup and rulebookNarration
# This is complex because we need to handle the setup function
old_fishing_setup_start = '''fishing: {
    gameType: "fishing",
    displayName: "钓鱼",
    version: "1.0",
    goal: "抛竿后立即结算，看看能否钓到鱼或宝物",
    phaseOrder: ["prepare", "waiting", "result", "settling"],
    triggerTags: ["#钓鱼"],
    passivePatterns: [/钓鱼/, /去钓鱼/, /开始钓鱼/],
    ruleSummary: "直接输入"抛竿""收杆""继续钓鱼"等动作。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。",
    setup: (ctx, sessionId, entrySource) => ({'''

new_fishing_setup_start = '''fishing: {
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

if old_fishing_setup_start not in content:
    # Try with different quote types
    print("First pattern not found, trying alternatives...")
else:
    content = content.replace(old_fishing_setup_start, new_fishing_setup_start)
    modified.append("Updated RULEBOOKS.fishing setup and added rulebookNarration")

# 12. Update public_state in fishing setup to include available_mentors
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

if 'available_mentors: mentors,' not in content:
    content = content.replace(old_public_state, new_public_state)
    modified.append("Added available_mentors to fishing public_state")

# 13. Update participants in fishing setup
if 'participants: buildParticipants(ctx, 1),' in content:
    content = content.replace(
        'participants: buildParticipants(ctx, 1),',
        'participants: buildParticipants(ctx, Math.max(1, Math.min(3, mentors.length + 1))),'
    )
    modified.append("Updated participants count in fishing setup")

# 14. Fix the closing of fishing setup function
# The old setup was: setup: (ctx, sessionId, entrySource) => ({ ... })
# We changed it to: setup: (ctx, sessionId, entrySource) => { ... return { ... }; },
# Need to find and fix the closing

# Find the fishing setup and check if it ends correctly
fishing_start = content.find('fishing: {')
if fishing_start > 0:
    # Find the next setup: after fishing: {
    setup_start = content.find('setup: (ctx, sessionId, entrySource) => {', fishing_start)
    if setup_start > 0:
        # Find the closing - look for the pattern }, and the next entry
        # We need to find where the setup returns and closes
        # It should end with };
        # Find the werewolf entry after
        werewolf_idx = content.find('werewolf: {', fishing_start)
        if werewolf_idx > setup_start:
            # The content between setup_start and werewolf_idx should have the setup
            between = content[setup_start:werewolf_idx]
            print(f"Content between setup and werewolf: {between[-200:]}")
            # Check if it has proper closing
            if '      };\n    },' not in between and '      })\n    },' not in between:
                print("Setup may need closing fix")

with open('src/modules/game-runtime/engines/MiniGameController.ts', 'w', encoding='utf-8') as f:
    f.write(content)

print("Modifications applied:")
for m in modified:
    print(f"  - {m}")
if not modified:
    print("  (none applied - patterns may not match)")