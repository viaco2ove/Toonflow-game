import {
  ChapterRuntimePhase,
  JsonRecord,
  readChapterProgressState,
} from "@/lib/gameEngine";

export interface RuleOrchestratorRole {
  id: string;
  roleType: string;
  name: string;
}

export interface RuleOrchestratorTurnState {
  canPlayerSpeak: boolean;
  expectedRoleType: string;
  expectedRole: string;
  lastSpeakerRoleType: string;
  lastSpeaker: string;
}

export interface RuleNarrativePlanResult {
  role: string;
  roleType: string;
  motive: string;
  memoryHints: string[];
  triggerMemoryAgent: boolean;
  stateDelta: JsonRecord;
  awaitUser: boolean;
  nextRole: string;
  nextRoleType: string;
  chapterOutcome: "continue" | "success" | "failed";
  nextChapterId: number | null;
  source: "rule";
}

export interface RuleNarrativeDecision {
  resolved: boolean;
  reason: string;
  plan: RuleNarrativePlanResult | null;
}

function buildAwaitUserPlan(userDisplayName: string): RuleNarrativePlanResult {
  return {
    role: "",
    roleType: "player",
    motive: "",
    memoryHints: [],
    triggerMemoryAgent: false,
    stateDelta: {},
    awaitUser: true,
    nextRole: userDisplayName,
    nextRoleType: "player",
    chapterOutcome: "continue",
    nextChapterId: null,
    source: "rule",
  };
}

function normalizeScalarText(input: unknown): string {
  const text = String(input ?? "").trim();
  if (!text || text === "null" || text === "undefined") return "";
  return text;
}

function sanitizeRoleType(input: unknown): "player" | "narrator" | "npc" {
  const text = normalizeScalarText(input).toLowerCase();
  if (text === "player") return "player";
  if (text === "npc") return "npc";
  return "narrator";
}

function roleActsAsWildcard(role: RuleOrchestratorRole | null | undefined): boolean {
  const name = normalizeScalarText(role?.name);
  return /万能角色|万能|某男子|某男士|某女士|某女孩|某少年|某青年|某人/.test(name);
}

function findFirstRoleByType(roles: RuleOrchestratorRole[], roleType: "player" | "narrator" | "npc") {
  return roles.find((item) => sanitizeRoleType(item.roleType) === roleType) || null;
}

function findRoleByTurnState(roles: RuleOrchestratorRole[], turnState: RuleOrchestratorTurnState) {
  const expectedRole = normalizeScalarText(turnState.expectedRole);
  if (expectedRole) {
    const matchedByName = roles.find((item) => normalizeScalarText(item.name) === expectedRole) || null;
    if (matchedByName) return matchedByName;
  }
  const expectedRoleType = sanitizeRoleType(turnState.expectedRoleType);
  if (expectedRoleType === "player") return null;
  return roles.find((item) => sanitizeRoleType(item.roleType) === expectedRoleType) || null;
}

function resolveNextRuleRole(roles: RuleOrchestratorRole[], currentRole: RuleOrchestratorRole) {
  const narrator = findFirstRoleByType(roles, "narrator");
  const firstNpc = findFirstRoleByType(roles, "npc");
  const otherNpc = roles.find((item) => sanitizeRoleType(item.roleType) === "npc" && normalizeScalarText(item.name) !== normalizeScalarText(currentRole.name)) || null;
  if (sanitizeRoleType(currentRole.roleType) === "narrator") {
    const next = otherNpc || firstNpc || narrator || currentRole;
    return {
      nextRole: normalizeScalarText(next?.name) || "旁白",
      nextRoleType: sanitizeRoleType(next?.roleType),
    };
  }
  const next = narrator || otherNpc || currentRole;
  return {
    nextRole: normalizeScalarText(next?.name) || "旁白",
    nextRoleType: sanitizeRoleType(next?.roleType),
  };
}

function buildRuleMotive(role: RuleOrchestratorRole, phase: ChapterRuntimePhase | null, reason: string): string {
  const roleType = sanitizeRoleType(role.roleType);
  const phaseLabel = normalizeScalarText(phase?.label) || "剧情推进";
  const pendingGoal = normalizeScalarText(phase?.targetSummary);
  if (reason === "single_allowed_speaker") {
    if (roleType === "narrator") {
      return pendingGoal || ("按当前阶段“" + phaseLabel + "”补一句环境与局势变化。");
    }
    return pendingGoal || ("按当前阶段“" + phaseLabel + "”继续承接局势并推进剧情。");
  }
  if (reason === "expected_role") {
    if (roleType === "narrator") {
      return pendingGoal || "承接上一轮局势，补一句环境与氛围变化。";
    }
    return pendingGoal || "承接上一轮的预期回合，顺着当前局势继续推进。";
  }
  if (reason === "phase_named_role") {
    if (roleType === "narrator") {
      return pendingGoal || "按当前阶段点明的旁白职责，补一句环境与局势变化。";
    }
    return pendingGoal || "按当前阶段已经点明的角色，继续承接当前冲突。";
  }
  if (reason === "narrator_bridge") {
    return pendingGoal || "描述现场变化，给下一轮角色互动或用户观察留出空间。";
  }
  if (roleType === "narrator") {
    return pendingGoal || "描述现场变化，稳定推进当前阶段。";
  }
  return pendingGoal || "按当前阶段继续推进当前冲突。";
}

function buildRulePlan(
  role: RuleOrchestratorRole,
  roles: RuleOrchestratorRole[],
  phase: ChapterRuntimePhase | null,
  reason: string,
): RuleNarrativePlanResult {
  const nextRole = resolveNextRuleRole(roles, role);
  return {
    role: normalizeScalarText(role.name),
    roleType: sanitizeRoleType(role.roleType),
    motive: buildRuleMotive(role, phase, reason),
    memoryHints: [],
    triggerMemoryAgent: false,
    stateDelta: {},
    awaitUser: false,
    nextRole: nextRole.nextRole,
    nextRoleType: nextRole.nextRoleType,
    chapterOutcome: "continue",
    nextChapterId: null,
    source: "rule",
  };
}

function phaseSignalTexts(phase: ChapterRuntimePhase | null): string[] {
  const label = normalizeScalarText(phase?.label);
  const targetSummary = normalizeScalarText(phase?.targetSummary);
  const signals = Array.isArray(phase?.advanceSignals)
    ? phase.advanceSignals.map((item) => normalizeScalarText(item)).filter(Boolean)
    : [];
  return [label, targetSummary, ...signals].filter(Boolean);
}

// 章节 outline 已经明确点名单一角色时，直接按章节骨架承接，不再浪费一次 AI 编排。
function resolveNamedRoleFromPhase(roles: RuleOrchestratorRole[], phase: ChapterRuntimePhase | null): RuleOrchestratorRole | null {
  const signals = phaseSignalTexts(phase);
  if (!signals.length) return null;
  const matched = roles.filter((role) => {
    const name = normalizeScalarText(role.name);
    if (!name || sanitizeRoleType(role.roleType) === "player") return false;
    return signals.some((item) => item.includes(name));
  });
  const uniqueByName = Array.from(new Map(matched.map((item) => [normalizeScalarText(item.name), item])).values());
  return uniqueByName.length === 1 ? uniqueByName[0] : null;
}

function shouldUseNarratorBridge(phase: ChapterRuntimePhase | null, roles: RuleOrchestratorRole[]): boolean {
  const narrator = findFirstRoleByType(roles, "narrator");
  if (!narrator || !phase) return false;
  const label = normalizeScalarText(phase.label);
  const summary = normalizeScalarText(phase.targetSummary);
  const joined = [label, summary, ...phaseSignalTexts(phase)].join("\n");
  if (/用户发言时机|用户状态|场景背景|失败\/未达成处理|达成反馈|结尾|过渡/.test(label)) {
    return true;
  }
  return /旁白|空间戒指|环境|氛围|现场|局势|目光|空气|背景|状态/.test(joined);
}

function resolveWildcardRoleFromPhase(roles: RuleOrchestratorRole[], phase: ChapterRuntimePhase | null): RuleOrchestratorRole | null {
  const signals = phaseSignalTexts(phase).join("\n");
  if (!/万能角色|万能|某男子|某男士|某女士|路人|起哄|挑衅|嘲讽|拱火|逼.*表态/.test(signals)) {
    return null;
  }
  const wildcardRoles = roles.filter((item) => roleActsAsWildcard(item));
  return wildcardRoles.length === 1 ? wildcardRoles[0] : null;
}

function shouldForceAwaitUserByContext(input: {
  phase: ChapterRuntimePhase | null;
  latestUserMessage: string;
  chapterUserTurns?: string;
  recentDialogue?: string;
}): boolean {
  if (normalizeScalarText(input.latestUserMessage)) return false;
  const phaseText = phaseSignalTexts(input.phase).join("\n");
  const chapterUserTurns = normalizeScalarText(input.chapterUserTurns);
  const recentDialogue = normalizeScalarText(input.recentDialogue);
  const hardSignals = [
    phaseText,
    chapterUserTurns,
    recentDialogue,
  ].join("\n");
  if (/你可以行动了|请(?:发言|选择|行动|输入)|轮到你(?:了)?|该你(?:发言|行动|回应|选择)|等待你表态|等你的反应|你怎么看|你打算|你说说|说句话|如何应对/.test(hardSignals)) {
    return true;
  }
  const directQuestionToUser = /你说说|你怎么看|你要不要|你打算|说句话|表个态|该你了|轮到你了|如何应对/.test(recentDialogue);
  const bridgeToUser = /等待你表态|等你的反应|目光.*你|看向你|投向入口处的你|都在等你的反应|摆明了要拉你/.test(recentDialogue);
  return directQuestionToUser && bridgeToUser;
}

// 在规则足够明确时，直接给出本轮发言计划，避免再走完整 AI 编排。
export function resolveRuleNarrativePlan(input: {
  phase: ChapterRuntimePhase | null;
  state: JsonRecord;
  roles: RuleOrchestratorRole[];
  turnState: RuleOrchestratorTurnState;
  latestUserMessage: string;
  userDisplayName?: string;
  chapterUserTurns?: string;
  recentDialogue?: string;
}): RuleNarrativeDecision {
  const latestUserMessage = normalizeScalarText(input.latestUserMessage);
  const progress = readChapterProgressState(input.state);
  const userDisplayName = normalizeScalarText(input.userDisplayName) || "用户";
  const nonPlayerRoles = input.roles.filter((item) => sanitizeRoleType(item.roleType) !== "player");
  const allowedSpeakers = Array.isArray(input.phase?.allowedSpeakers)
    ? input.phase.allowedSpeakers.map((item) => normalizeScalarText(item).toLowerCase()).filter(Boolean)
    : [];

  if (input.turnState.canPlayerSpeak || input.phase?.kind === "user" || progress.userNodeStatus === "waiting_input") {
    return {
      resolved: true,
      reason: "await_user_phase",
      plan: buildAwaitUserPlan(userDisplayName),
    };
  }

  if (shouldForceAwaitUserByContext({
    phase: input.phase,
    latestUserMessage,
    chapterUserTurns: input.chapterUserTurns,
    recentDialogue: input.recentDialogue,
  })) {
    return {
      resolved: true,
      reason: "context_forces_user_turn",
      plan: buildAwaitUserPlan(userDisplayName),
    };
  }

  if (!latestUserMessage) {
    const expectedRole = findRoleByTurnState(nonPlayerRoles, input.turnState);
    const allowSameRoleContinuation = Boolean(
      (input.phase?.kind === "scene" && sanitizeRoleType(input.turnState.expectedRoleType) !== "player")
      || allowedSpeakers.length === 1
      || sanitizeRoleType(expectedRole?.roleType) === "narrator"
    );
    if (
      expectedRole
      && (
        normalizeScalarText(expectedRole.name) !== normalizeScalarText(input.turnState.lastSpeaker)
        || allowSameRoleContinuation
      )
    ) {
      return {
        resolved: true,
        reason: "expected_role",
        plan: buildRulePlan(expectedRole, nonPlayerRoles, input.phase, "expected_role"),
      };
    }

    const namedRole = resolveNamedRoleFromPhase(nonPlayerRoles, input.phase);
    if (namedRole) {
      return {
        resolved: true,
        reason: "phase_named_role",
        plan: buildRulePlan(namedRole, nonPlayerRoles, input.phase, "phase_named_role"),
      };
    }

    const wildcardRole = resolveWildcardRoleFromPhase(nonPlayerRoles, input.phase);
    if (wildcardRole) {
      return {
        resolved: true,
        reason: "phase_wildcard_role",
        plan: buildRulePlan(wildcardRole, nonPlayerRoles, input.phase, "phase_named_role"),
      };
    }

    if (shouldUseNarratorBridge(input.phase, nonPlayerRoles)) {
      const narrator = findFirstRoleByType(nonPlayerRoles, "narrator");
      if (narrator) {
        return {
          resolved: true,
          reason: "narrator_bridge",
          plan: buildRulePlan(narrator, nonPlayerRoles, input.phase, "narrator_bridge"),
        };
      }
    }
  }

  if (allowedSpeakers.length) {
    const singleAllowedRole = nonPlayerRoles.find((item) => {
      const normalizedName = normalizeScalarText(item.name).toLowerCase();
      const normalizedType = sanitizeRoleType(item.roleType);
      return allowedSpeakers.includes(normalizedName) || allowedSpeakers.includes(normalizedType);
    }) || null;
    const matchedAllowedCount = nonPlayerRoles.filter((item) => {
      const normalizedName = normalizeScalarText(item.name).toLowerCase();
      const normalizedType = sanitizeRoleType(item.roleType);
      return allowedSpeakers.includes(normalizedName) || allowedSpeakers.includes(normalizedType);
    }).length;
    if (singleAllowedRole && matchedAllowedCount === 1) {
      return {
        resolved: true,
        reason: "single_allowed_speaker",
        plan: buildRulePlan(singleAllowedRole, nonPlayerRoles, input.phase, "single_allowed_speaker"),
      };
    }
  }

  return {
    resolved: false,
    reason: "rule_not_matched",
    plan: null,
  };
}
