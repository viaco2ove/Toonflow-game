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

function resolveNextRuleRole(roles: RuleOrchestratorRole[], currentRole: RuleOrchestratorRole) {
  const narrator = roles.find((item) => sanitizeRoleType(item.roleType) === "narrator") || null;
  const firstNpc = roles.find((item) => sanitizeRoleType(item.roleType) === "npc") || null;
  const otherNpc = roles.find((item) =>
    sanitizeRoleType(item.roleType) === "npc"
    && normalizeScalarText(item.name) !== normalizeScalarText(currentRole.name),
  ) || null;
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

function buildRuleMotive(role: RuleOrchestratorRole, phase: ChapterRuntimePhase | null): string {
  const roleType = sanitizeRoleType(role.roleType);
  const phaseLabel = normalizeScalarText(phase?.label) || "剧情推进";
  const pendingGoal = normalizeScalarText(phase?.targetSummary);
  if (roleType === "narrator") {
    return pendingGoal || ("按当前阶段“" + phaseLabel + "”补一句环境与局势变化。");
  }
  return pendingGoal || ("按当前阶段“" + phaseLabel + "”继续承接局势并推进剧情。");
}

function buildRulePlan(
  role: RuleOrchestratorRole,
  roles: RuleOrchestratorRole[],
  phase: ChapterRuntimePhase | null,
): RuleNarrativePlanResult {
  const nextRole = resolveNextRuleRole(roles, role);
  return {
    role: normalizeScalarText(role.name),
    roleType: sanitizeRoleType(role.roleType),
    motive: buildRuleMotive(role, phase),
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

// 在规则足够明确时，直接给出本轮发言计划，避免再走完整 AI 编排。
export function resolveRuleNarrativePlan(input: {
  phase: ChapterRuntimePhase | null;
  state: JsonRecord;
  roles: RuleOrchestratorRole[];
  turnState: RuleOrchestratorTurnState;
  userDisplayName?: string;
  latestPlayerMessage?: string;
  currentEventKind?: string;
  currentEventFlowType?: string;
  currentEventStatus?: string;
}): RuleNarrativeDecision {
  const progress = readChapterProgressState(input.state);
  const userDisplayName = normalizeScalarText(input.userDisplayName) || "用户";
  const latestPlayerMessage = normalizeScalarText(input.latestPlayerMessage);
  const nonPlayerRoles = input.roles.filter((item) => sanitizeRoleType(item.roleType) !== "player");
  const allowedSpeakers = Array.isArray(input.phase?.allowedSpeakers)
    ? input.phase.allowedSpeakers.map((item) => normalizeScalarText(item).toLowerCase()).filter(Boolean)
    : [];
  const shouldLetAiHandleLatestUserInput = Boolean(latestPlayerMessage)
    && (
      progress.userNodeStatus === "waiting_input"
      || normalizeScalarText(input.currentEventStatus) === "waiting_input"
      || normalizeScalarText(input.currentEventKind) === "ending"
      || normalizeScalarText(input.currentEventFlowType) === "chapter_ending_check"
    );

  if (!shouldLetAiHandleLatestUserInput && (
    input.turnState.canPlayerSpeak
    || input.phase?.kind === "user"
    || progress.userNodeStatus === "waiting_input"
  )) {
    return {
      resolved: true,
      reason: "await_user_phase",
      plan: buildAwaitUserPlan(userDisplayName),
    };
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
        plan: buildRulePlan(singleAllowedRole, nonPlayerRoles, input.phase),
      };
    }
  }

  return {
    resolved: false,
    reason: "rule_not_matched",
    plan: null,
  };
}
