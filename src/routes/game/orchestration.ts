import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  getGameDb,
  normalizeChapterOutput,
  normalizeRolePair,
  normalizeSessionState,
  nowTs,
} from "@/lib/gameEngine";
import {
  allowPlayerTurn,
  applyNarrativeMemoryHintsToState,
  applyOrchestratorResultToState,
  applyPlayerProfileFromMessageToState,
  canPlayerSpeakNow,
  runNarrativePlan,
  RuntimeMessageInput,
  setRuntimeTurnState,
  triggerStoryMemoryRefreshInBackground,
} from "@/modules/game-runtime/engines/NarrativeOrchestrator";
import { handleMiniGameTurn } from "@/modules/game-runtime/engines/MiniGameController";
import {
  orchestrateSessionTurn,
  isSessionServiceError,
} from "@/modules/game-runtime/services/SessionService";
import {
  buildDebugFreePlotMessage,
  buildDebugRecentMessages,
  buildOpeningRuntimeMessage,
  debugMessageSchema,
  getPendingDebugChapterId,
  isDebugFreePlotActive,
  loadCachedDebugRuntimeState,
  resolveNextChapter,
  setPendingDebugChapterId,
  syncDebugChapterRuntime,
  applyDebugUserMessageProgress,
  buildEffectiveDebugChapter,
  evaluateDebugRuntimeOutcome,
  buildDebugEndDialogDetail,
} from "./debugRuntimeShared";
import {
  asTrimmedText,
  buildMinimalOrchestrationResponse,
  buildDebugSuccessFollowUpPlan,
  buildPlanResult,
  buildPresetPlan,
  resolveDebugResponseChapterMeta,
  sendDebugSuccess,
} from "./orchestrationResponseShared";
import u from "@/utils";
import { DebugLogUtil } from "@/utils/debugLogUtil";

const router = express.Router();

type OrchestrationRequestTrace = {
  requestId: string;
  route: "/game/orchestration";
  branch: "initial" | "player";
  userId: number;
  worldId: number;
  chapterId: number;
  sessionId: string;
  debugRuntimeKey?: string;
  planMode?: string;
  judgeMode?: string;
};

// 给每次 /game/orchestration 请求生成稳定 trace，方便判断是否同一个请求重复触发 AI。
function buildOrchestrationRequestTrace(params: {
  userId: number;
  worldId: number;
  chapterId: number;
  playerContent: string;
  sessionId: string;
}): OrchestrationRequestTrace {
  return {
    requestId: `orch_${params.userId}_${params.worldId}_${params.chapterId || 0}_${nowTs()}_${Math.random().toString(36).slice(2, 8)}`,
    route: "/game/orchestration",
    branch: params.playerContent ? "player" : "initial",
    userId: params.userId,
    worldId: params.worldId,
    chapterId: params.chapterId,
    sessionId: params.sessionId,
  };
}

// 用统一 tag 打关键节点，方便把一次编排请求里的章节判定/编排模型调用串起来看。
function logOrchestrationKeyNode(trace: OrchestrationRequestTrace, node: string, extra?: Record<string, unknown>) {
  if (!DebugLogUtil.isDebugLogEnabled()) return;
  console.log("[game:orchestrator:key_nodes]", JSON.stringify({
    requestId: trace.requestId,
    route: trace.route,
    branch: trace.branch,
    userId: trace.userId,
    worldId: trace.worldId,
    chapterId: trace.chapterId,
    sessionId: trace.sessionId || "",
    debugRuntimeKey: trace.debugRuntimeKey || "",
    node,
    ...(extra || {}),
  }));
}


// 调试态的候选编排只读状态快照，避免 speculative plan 提前污染主运行态。
function cloneDebugRuntimeValue<T>(input: T): T {
  try {
    return JSON.parse(JSON.stringify(input ?? null)) as T;
  } catch {
    return input;
  }
}

// 把编排结果回写到 turn-state，确保“当前轮到谁发言”前后端一致。
function applyDebugPlanTurnState(
  state: Record<string, any>,
  world: any,
  rolePair: ReturnType<typeof normalizeRolePair>,
  plan: {
    awaitUser?: boolean;
    nextRole?: string;
    nextRoleType?: string;
    role?: string;
    roleType?: string;
  },
) {
  // 调试编排也复用正式会话的 turn-state 规则，保证“该轮到谁说”在前后端一致。
  const shouldYieldToUser = Boolean(plan.awaitUser);
  if (shouldYieldToUser) {
    allowPlayerTurn(
      state,
      world,
      String(plan.roleType || "narrator"),
      String(plan.role || rolePair.narratorRole.name || "旁白"),
    );
    return;
  }
  setRuntimeTurnState(state, world, {
    canPlayerSpeak: false,
    expectedRoleType: String(plan.nextRoleType || plan.roleType || "narrator"),
    expectedRole: String(plan.nextRole || plan.role || rolePair.narratorRole.name || "旁白"),
    lastSpeakerRoleType: String(plan.roleType || "narrator"),
    lastSpeaker: String(plan.role || rolePair.narratorRole.name || "旁白"),
  });
}

// 统一把编排结果真正落到调试运行态，确保 candidatePlan / finalPlan 最终只提交一次。
function applyDebugNarrativePlanToState(params: {
  userId: number;
  world: any;
  chapter: any;
  state: Record<string, any>;
  recentMessages: ReturnType<typeof buildDebugRecentMessages>;
  rolePair: ReturnType<typeof normalizeRolePair>;
  plan: Awaited<ReturnType<typeof runNarrativePlan>>;
}) {
  applyOrchestratorResultToState(params.state, params.plan);
  applyNarrativeMemoryHintsToState(params.state, params.plan.memoryHints);
  if (params.plan.triggerMemoryAgent) {
    triggerStoryMemoryRefreshInBackground({
      userId: params.userId,
      world: params.world,
      chapter: params.chapter,
      state: params.state,
      recentMessages: params.recentMessages,
    });
  }
  applyDebugPlanTurnState(params.state, params.world, params.rolePair, params.plan);
  return buildPlanResult({ ...params.plan, eventType: "on_orchestrated_reply", planSource: "ai_orchestrator" });
}

// 调试态统一走“编排 -> 回写 state -> 记忆刷新”的完整链路。
async function runAndApplyDebugNarrativePlan(params: {
  userId: number;
  world: any;
  chapter: any;
  state: Record<string, any>;
  recentMessages: ReturnType<typeof buildDebugRecentMessages>;
  playerMessage: string;
  rolePair: ReturnType<typeof normalizeRolePair>;
  requestTrace: OrchestrationRequestTrace;
}) {
  logOrchestrationKeyNode(params.requestTrace, "runNarrativePlan:start", {
    playerMessageLength: params.playerMessage.length,
    recentMessageCount: params.recentMessages.length,
  });
  const plan = await runNarrativePlan({
    userId: params.userId,
    world: params.world,
    chapter: params.chapter,
    state: params.state,
    recentMessages: params.recentMessages,
    playerMessage: params.playerMessage,
    maxRetries: 0,
    allowControlHints: false,
    allowStateDelta: false,
    traceMeta: params.requestTrace,
  });
  logOrchestrationKeyNode(params.requestTrace, "runNarrativePlan:done", {
    role: asTrimmedText(plan.role),
    roleType: asTrimmedText(plan.roleType),
    awaitUser: Boolean(plan.awaitUser),
    source: asTrimmedText(plan.source),
  });
  return applyDebugNarrativePlanToState({
    userId: params.userId,
    world: params.world,
    chapter: params.chapter,
    state: params.state,
    recentMessages: params.recentMessages,
    rolePair: params.rolePair,
    plan,
  });
}

// 章节开场单独拆出来，统一处理“显式开场白”和“无开场白直接编排”两种情况。
async function buildDebugChapterStartPlan(params: {
  userId: number;
  world: any;
  targetChapter: any;
  state: Record<string, any>;
  rolePair: ReturnType<typeof normalizeRolePair>;
  recentMessages: ReturnType<typeof buildDebugRecentMessages>;
  debugFreePlotActive: boolean;
  requestTrace: OrchestrationRequestTrace;
}) {
  params.state.chapterId = Number(params.targetChapter.id || 0);
  const effectiveChapter = buildEffectiveDebugChapter(params.targetChapter, params.debugFreePlotActive);
  syncDebugChapterRuntime(effectiveChapter, params.state);
  const openingMessage = buildOpeningRuntimeMessage(
    params.world,
    params.targetChapter,
    String(params.rolePair.narratorRole.name || "旁白"),
  );
  setRuntimeTurnState(params.state, params.world, {
    canPlayerSpeak: false,
    expectedRoleType: "narrator",
    expectedRole: String(params.rolePair.narratorRole.name || "旁白"),
    lastSpeakerRoleType: String(openingMessage.roleType || "narrator"),
    lastSpeaker: String(openingMessage.role || params.rolePair.narratorRole.name || "旁白"),
  });

  // 有显式章节开场词时，先把这一句完整返回给前端；没有时再直接跑一次编排器。
  if (String(openingMessage.content || "").trim()) {
    logOrchestrationKeyNode(params.requestTrace, "chapter_start:opening_preset", {
      targetChapterId: Number(params.targetChapter.id || 0),
      contentLength: String(openingMessage.content || "").trim().length,
    });
    return {
      chapterId: Number(params.targetChapter.id || 0),
      chapterTitle: String(params.targetChapter.title || ""),
      plan: buildPresetPlan(openingMessage, {
        awaitUser: false,
        nextRole: String(params.rolePair.narratorRole.name || "旁白"),
        nextRoleType: "narrator",
      }),
    };
  }

  const startedAt = Date.now();
  const plan = await runAndApplyDebugNarrativePlan({
    userId: params.userId,
    world: params.world,
    chapter: effectiveChapter,
    state: params.state,
    recentMessages: params.recentMessages,
    playerMessage: "",
    rolePair: params.rolePair,
    requestTrace: params.requestTrace,
  });
  console.log(
    `[runNarrativePlan] userId=${params.userId} chapter=${effectiveChapter.id} 耗时=${Date.now() - startedAt}ms`,
  );
  return {
    chapterId: Number(params.targetChapter.id || 0),
    chapterTitle: String(params.targetChapter.title || ""),
    plan,
  };
}

// 统一读取当前故事和章节，避免主流程里反复写同一段查询逻辑。
async function resolveDebugWorldAndChapter(params: {
  db: ReturnType<typeof getGameDb>;
  userId: number;
  worldId: number;
  chapterId: number;
}) {
  const world = await params.db("t_storyWorld as w")
    .leftJoin("t_project as p", "w.projectId", "p.id")
    .where("w.id", params.worldId)
    .where("p.userId", params.userId)
    .select("w.*")
    .first();
  if (!world) {
    throw new Error("NOT_FOUND_WORLD");
  }

  let chapter: any = null;
  if (params.chapterId > 0) {
    chapter = await params.db("t_storyChapter").where({ id: params.chapterId, worldId: params.worldId }).first();
  }
  if (!chapter) {
    chapter = await params.db("t_storyChapter")
      .where({ worldId: params.worldId })
      .orderBy("sort", "asc")
      .orderBy("id", "asc")
      .first();
  }
  chapter = normalizeChapterOutput(chapter);
  if (!chapter) {
    throw new Error("NOT_FOUND_CHAPTER");
  }

  return { world, chapter };
}

// 把请求里的 state/messages 还原成调试运行上下文，供后续所有分支复用。
function buildDebugRuntimeContext(params: {
  req: express.Request;
  userId: number;
  worldId: number;
  world: any;
  chapter: any;
  playerContent: string;
  inputMessages: RuntimeMessageInput[];
}) {
  const rolePair = normalizeRolePair(params.world.playerRole, params.world.narratorRole);
  const cachedRuntimeState = loadCachedDebugRuntimeState(params.req.body.state, params.userId, params.worldId);
  const state = normalizeSessionState(
    cachedRuntimeState || params.req.body.state,
    params.worldId,
    Number(params.chapter.id || 0),
    rolePair,
    params.world,
  );
  if (params.playerContent) {
    applyPlayerProfileFromMessageToState(state, params.world, params.playerContent);
  }
  const debugFreePlotActive = isDebugFreePlotActive(state);
  const effectiveChapter = buildEffectiveDebugChapter(params.chapter, debugFreePlotActive);
  syncDebugChapterRuntime(effectiveChapter, state);
  // 先把前端消息裁成纯文本快照，避免后续 recentMessages 混入脏字段。
  const messages = params.inputMessages.map((item) => ({
    role: asTrimmedText(item.role),
    roleType: asTrimmedText(item.roleType),
    eventType: asTrimmedText(item.eventType),
    content: asTrimmedText(item.content),
    createTime: Number(item.createTime || 0),
  }));
  const recentMessages = buildDebugRecentMessages(
    messages,
    asTrimmedText(state.player?.name, rolePair.playerRole.name || "用户"),
    params.playerContent,
  );
  return { rolePair, state, debugFreePlotActive, effectiveChapter, recentMessages };
}

// 处理“未输入用户消息”的启动分支：首次进入、切下一章、等待用户或继续编排。
async function handleInitialDebugTurn(params: {
  res: express.Response;
  db: ReturnType<typeof getGameDb>;
  userId: number;
  worldId: number;
  world: any;
  chapter: any;
  state: Record<string, any>;
  rolePair: ReturnType<typeof normalizeRolePair>;
  recentMessages: ReturnType<typeof buildDebugRecentMessages>;
  debugFreePlotActive: boolean;
  inputMessages: RuntimeMessageInput[];
  effectiveChapter: any;
  requestTrace: OrchestrationRequestTrace;
}) {
  const responseChapterMeta = resolveDebugResponseChapterMeta({
    chapter: params.chapter,
    effectiveChapter: params.effectiveChapter,
    state: params.state,
  });
  const pendingChapterId = getPendingDebugChapterId(params.state);
  if (pendingChapterId) {
    // 上一轮已经宣告章节完成，但前端还没请求下一轮时，用 pending 标记串起新章节开场。
    const nextChapter = normalizeChapterOutput(await params.db("t_storyChapter").where({ id: pendingChapterId, worldId: params.worldId }).first());
    setPendingDebugChapterId(params.state, null);
    if (!nextChapter) {
      return sendDebugSuccess(params.res, {
        userId: params.userId,
        worldId: params.worldId,
        chapterId: responseChapterMeta.chapterId,
        chapterTitle: responseChapterMeta.chapterTitle,
        state: params.state,
        endDialog: null,
        plan: null,
        messages: params.inputMessages,
      });
    }
    const nextChapterStart = await buildDebugChapterStartPlan({
      userId: params.userId,
      world: params.world,
      targetChapter: nextChapter,
      state: params.state,
      rolePair: params.rolePair,
      recentMessages: params.recentMessages,
      debugFreePlotActive: params.debugFreePlotActive,
      requestTrace: params.requestTrace,
    });
    return sendDebugSuccess(params.res, {
      userId: params.userId,
      worldId: params.worldId,
      chapterId: nextChapterStart.chapterId,
      chapterTitle: nextChapterStart.chapterTitle,
      state: params.state,
      endDialog: null,
      plan: nextChapterStart.plan,
      messages: params.inputMessages,
    });
  }

  if (!params.recentMessages.length) {
    // 首次进入调试页时没有历史消息，直接生成当前章节开场。
    const chapterStart = await buildDebugChapterStartPlan({
      userId: params.userId,
      world: params.world,
      targetChapter: params.chapter,
      state: params.state,
      rolePair: params.rolePair,
      recentMessages: params.recentMessages,
      debugFreePlotActive: params.debugFreePlotActive,
      requestTrace: params.requestTrace,
    });
    return sendDebugSuccess(params.res, {
      userId: params.userId,
      worldId: params.worldId,
      chapterId: chapterStart.chapterId,
      chapterTitle: chapterStart.chapterTitle,
      state: params.state,
      endDialog: null,
      plan: chapterStart.plan,
      messages: params.inputMessages,
    });
  }

  if (canPlayerSpeakNow(params.state, params.world)) {
    return sendDebugSuccess(params.res, {
      userId: params.userId,
      worldId: params.worldId,
      chapterId: responseChapterMeta.chapterId,
      chapterTitle: responseChapterMeta.chapterTitle,
      state: params.state,
      endDialog: null,
      plan: null,
      messages: params.inputMessages,
    });
  }

  // 当前不该轮到用户时，继续推进一次旁白/NPC 的编排结果。
  const plan = await runAndApplyDebugNarrativePlan({
    userId: params.userId,
    world: params.world,
    state: params.state,
    recentMessages: params.recentMessages,
    chapter: params.effectiveChapter,
    playerMessage: "",
    rolePair: params.rolePair,
    requestTrace: params.requestTrace,
  });
  return sendDebugSuccess(params.res, {
    userId: params.userId,
    worldId: params.worldId,
    chapterId: responseChapterMeta.chapterId,
    chapterTitle: responseChapterMeta.chapterTitle,
    state: params.state,
    endDialog: null,
    plan,
    messages: params.inputMessages,
  });
}

// 调试态并发启动“章节判定 + 候选编排”，最后只把裁决后的 finalPlan 落到主运行态。
async function runConcurrentDebugJudgeAndNarrative(params: {
  userId: number;
  world: any;
  chapter: any;
  effectiveChapter: any;
  state: Record<string, any>;
  rolePair: ReturnType<typeof normalizeRolePair>;
  recentMessages: ReturnType<typeof buildDebugRecentMessages>;
  playerContent: string;
  requestTrace: OrchestrationRequestTrace;
  debugFreePlotActive: boolean;
}) {
  const candidateState = cloneDebugRuntimeValue(params.state);
  const candidateRecentMessages = cloneDebugRuntimeValue(params.recentMessages);
  const candidateTrace = {
    ...params.requestTrace,
    planMode: "candidate",
  };
  logOrchestrationKeyNode(params.requestTrace, "concurrent_arbiter:start", {
    recentMessageCount: params.recentMessages.length,
  });
  const candidatePlanPromise = runNarrativePlan({
    userId: params.userId,
    world: params.world,
    chapter: params.effectiveChapter,
    state: candidateState,
    recentMessages: candidateRecentMessages,
    playerMessage: params.playerContent,
    maxRetries: 0,
    allowControlHints: false,
    allowStateDelta: false,
    traceMeta: candidateTrace,
  });
  const outcome = await evaluateDebugRuntimeOutcome({
    userId: params.userId,
    chapter: params.chapter,
    state: params.state,
    messageContent: params.playerContent,
    eventType: "on_message",
    meta: {},
    recentMessages: params.recentMessages,
    debugFreePlotActive: params.debugFreePlotActive,
    traceMeta: {
      ...params.requestTrace,
      judgeMode: "primary",
    },
  });
  logOrchestrationKeyNode(params.requestTrace, "concurrent_arbiter:judge_done", {
    outcome: asTrimmedText(outcome.result),
    hasPendingEndingGuide: params.state.__pendingEndingGuide === true,
  });

  const discardCandidatePlan = () => {
    void candidatePlanPromise.catch(() => null);
  };

  if (outcome.result !== "continue") {
    logOrchestrationKeyNode(params.requestTrace, "concurrent_arbiter:discard_candidate", {
      reason: `judge_${asTrimmedText(outcome.result)}`,
    });
    discardCandidatePlan();
    return {
      outcome,
      plan: null as ReturnType<typeof buildPlanResult> | null,
    };
  }

  if (params.state.__pendingEndingGuide === true) {
    logOrchestrationKeyNode(params.requestTrace, "concurrent_arbiter:rerun_with_guide", {
      reason: "judge_continue_requires_guide",
    });
    discardCandidatePlan();
    return {
      outcome,
      plan: await runAndApplyDebugNarrativePlan({
        userId: params.userId,
        world: params.world,
        chapter: params.effectiveChapter,
        state: params.state,
        recentMessages: params.recentMessages,
        playerMessage: params.playerContent,
        rolePair: params.rolePair,
        requestTrace: {
          ...params.requestTrace,
          planMode: "final",
        },
      }),
    };
  }

  try {
    const candidatePlan = await candidatePlanPromise;
    logOrchestrationKeyNode(params.requestTrace, "concurrent_arbiter:reuse_candidate", {
      role: asTrimmedText(candidatePlan.role),
      awaitUser: Boolean(candidatePlan.awaitUser),
    });
    return {
      outcome,
      plan: applyDebugNarrativePlanToState({
        userId: params.userId,
        world: params.world,
        chapter: params.effectiveChapter,
        state: params.state,
        recentMessages: params.recentMessages,
        rolePair: params.rolePair,
        plan: candidatePlan,
      }),
    };
  } catch (err) {
    logOrchestrationKeyNode(params.requestTrace, "concurrent_arbiter:candidate_failed", {
      reason: asTrimmedText((err as any)?.message, "candidate_failed"),
    });
    return {
      outcome,
      plan: await runAndApplyDebugNarrativePlan({
        userId: params.userId,
        world: params.world,
        chapter: params.effectiveChapter,
        state: params.state,
        recentMessages: params.recentMessages,
        playerMessage: params.playerContent,
        rolePair: params.rolePair,
        requestTrace: {
          ...params.requestTrace,
          planMode: "fallback_final",
        },
      }),
    };
  }
}

// 处理“用户已发言”的分支：小游戏、结束判定、切章与继续编排都从这里统一分发。
async function handleDebugPlayerTurn(params: {
  res: express.Response;
  db: ReturnType<typeof getGameDb>;
  userId: number;
  worldId: number;
  world: any;
  chapter: any;
  state: Record<string, any>;
  rolePair: ReturnType<typeof normalizeRolePair>;
  recentMessages: ReturnType<typeof buildDebugRecentMessages>;
  debugFreePlotActive: boolean;
  inputMessages: RuntimeMessageInput[];
  playerContent: string;
  effectiveChapter: any;
  requestTrace: OrchestrationRequestTrace;
}) {
  const responseChapterMeta = resolveDebugResponseChapterMeta({
    chapter: params.chapter,
    effectiveChapter: params.effectiveChapter,
    state: params.state,
  });
  if (!canPlayerSpeakNow(params.state, params.world)) {
    return params.res.status(409).send(error("当前还没轮到用户发言"));
  }

  const miniGameResult = await handleMiniGameTurn({
    userId: params.userId,
    world: params.world,
    chapter: params.chapter,
    state: params.state,
    recentMessages: params.recentMessages,
    playerMessage: params.playerContent,
    mode: "debug",
  });
  if (miniGameResult?.intercepted) {
    // 小游戏命中了自己的状态机时，剧情编排本轮直接让位给小游戏结果。
    const presetMessages = (miniGameResult.messages && miniGameResult.messages.length
      ? miniGameResult.messages
      : miniGameResult.message
        ? [miniGameResult.message]
        : []
    ).map((item) => ({
      role: item.role,
      roleType: item.roleType,
      eventType: item.eventType,
      content: item.content,
      createTime: nowTs(),
    }));
    return sendDebugSuccess(params.res, {
      userId: params.userId,
      worldId: params.worldId,
      chapterId: responseChapterMeta.chapterId,
      chapterTitle: responseChapterMeta.chapterTitle,
      state: params.state,
      endDialog: null,
      plan: presetMessages[0]
        ? buildPresetPlan(presetMessages[0], { awaitUser: false, nextRole: "", nextRoleType: "" })
        : null,
      messages: [...params.inputMessages, ...presetMessages],
    });
  }

  // 先把用户这句输入应用到调试态，再进入章节结束判定。
  await applyDebugUserMessageProgress({
    chapter: params.chapter,
    state: params.state,
    messageContent: params.playerContent,
    eventType: "on_message",
    meta: {},
    recentMessages: params.recentMessages,
    userId: params.userId,
    traceMeta: params.requestTrace,
  });
  const arbitration = await runConcurrentDebugJudgeAndNarrative({
    userId: params.userId,
    world: params.world,
    chapter: params.chapter,
    effectiveChapter: params.effectiveChapter,
    state: params.state,
    rolePair: params.rolePair,
    recentMessages: params.recentMessages,
    playerContent: params.playerContent,
    requestTrace: params.requestTrace,
    debugFreePlotActive: params.debugFreePlotActive,
  });
  const outcome = arbitration.outcome;

  if (outcome.result === "failed") {
    // 调试结束用 endDialog 呈现即可，不再额外塞一条系统台词污染最近对话。
    return sendDebugSuccess(params.res, {
      userId: params.userId,
      worldId: params.worldId,
      chapterId: responseChapterMeta.chapterId,
      chapterTitle: responseChapterMeta.chapterTitle,
      state: params.state,
      endDialog: "已失败",
      plan: null,
      endDialogDetail: buildDebugEndDialogDetail({
        endDialog: "已失败",
        chapterTitle: asTrimmedText(params.chapter.title),
        matchedBy: outcome.matchedBy,
        matchedRule: outcome.matchedRule,
      }),
      messages: params.inputMessages,
    });
  }

  if (outcome.result === "success") {
    const nextChapter = normalizeChapterOutput(
      await resolveNextChapter(params.db, params.worldId, params.chapter, outcome.nextChapterId),
    );
    if (DebugLogUtil.isDebugLogEnabled()) {
      // 判章模型可能不给 next_chapter_id，这里记录“排序兜底后真正将要进入的下一章”。
      console.log(`[story:chapter_ending_check:stats] sessionStatus: chapter_completed`);
      console.log(`[story:chapter_ending_check:stats] outcome: success`);
      console.log(`[story:chapter_ending_check:stats] nextChapterId: ${nextChapter ? String(nextChapter.id || "") : ""}`);
    }
    if (!nextChapter) {
      // 没有下一章时，调试态自动转入自由剧情，方便继续压编排与角色发言。
      (params.state as any).debugFreePlot = {
        active: true,
        fromChapterId: Number(params.chapter.id || 0),
        unlockedAt: nowTs(),
      };
      const freePlotMessage = buildDebugFreePlotMessage(
        asTrimmedText(params.rolePair.narratorRole.name, "旁白"),
        asTrimmedText(params.chapter.title, "当前章节"),
      );
      return sendDebugSuccess(params.res, {
        userId: params.userId,
        worldId: params.worldId,
        chapterId: responseChapterMeta.chapterId,
        chapterTitle: responseChapterMeta.chapterTitle,
        state: params.state,
        endDialog: null,
        plan: buildPresetPlan(freePlotMessage, {
          awaitUser: false,
          nextRole: asTrimmedText(params.rolePair.narratorRole.name, "旁白"),
          nextRoleType: "narrator",
        }),
        messages: params.inputMessages,
      });
    }

    // 这里只登记“待进入下一章”，但不能在编排接口里直接切下一章。
    // 真正的章节切换要等当前确认台词经 /game/streamlines 落地后再发生，
    // 否则前端会在台词还没生成时就拿到下一章的 storyInfo，造成 phase / 下一位 / 事件列表全部串章。
    setPendingDebugChapterId(params.state, Number(nextChapter.id || 0));
    setRuntimeTurnState(params.state, params.world, {
      canPlayerSpeak: false,
      expectedRoleType: "narrator",
      expectedRole: asTrimmedText(params.rolePair.narratorRole.name, "旁白") || "旁白",
      lastSpeakerRoleType: "player",
      lastSpeaker: asTrimmedText(params.state.player?.name, "用户") || "用户",
    });
    return sendDebugSuccess(params.res, {
      userId: params.userId,
      worldId: params.worldId,
      chapterId: Number(nextChapter.id || 0),
      chapterTitle: asTrimmedText(nextChapter.title),
      state: params.state,
      endDialog: null,
      plan: buildDebugSuccessFollowUpPlan({
        state: params.state,
        rolePair: params.rolePair,
      }),
      messages: params.inputMessages,
    });
  }

  // 章节未结束时继续交给编排师，生成下一轮角色/旁白发言。
  const plan = arbitration.plan;
  return sendDebugSuccess(params.res, {
    userId: params.userId,
    worldId: params.worldId,
    chapterId: responseChapterMeta.chapterId,
    chapterTitle: responseChapterMeta.chapterTitle,
    state: params.state,
    endDialog: null,
    plan,
    messages: params.inputMessages,
  });
}

// 调试路由的主分发函数：负责鉴权、装配上下文，并按“首次进入/用户发言”两条链拆开处理。
async function handleDebugOrchestrationRequest(req: express.Request, res: express.Response) {
  const sessionId = asTrimmedText(req.body.sessionId);
  if (sessionId) {
    const result = await orchestrateSessionTurn(sessionId);
    // data 里只保留 role/roleType/motive/awaitUser/command；code/message 由标准响应信封承载。
    return res.status(200).send(success(buildMinimalOrchestrationResponse(
      result.plan
        ? {
          ...result.plan,
          command: result.command || null,
        }
        : {
          command: result.command || null,
        },
    )));
  }

  const db = getGameDb();
  const userId = Number((req as any)?.user?.id || 0);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(401).send(error("用户未登录"));
  }

  const worldId = Number(req.body.worldId || 0);
  if (!worldId) {
    return res.status(400).send(error("worldId 不能为空"));
  }
  const chapterId = Number(req.body.chapterId || 0);
  const playerContent = asTrimmedText(req.body.playerContent);
  const inputMessages = (Array.isArray(req.body.messages) ? req.body.messages : []) as RuntimeMessageInput[];
  const requestTrace = buildOrchestrationRequestTrace({
    userId,
    worldId,
    chapterId,
    playerContent,
    sessionId,
  });
  logOrchestrationKeyNode(requestTrace, "request:accepted", {
    inputMessageCount: inputMessages.length,
    playerMessageLength: playerContent.length,
  });

  let world: any;
  let chapter: any;
  try {
    ({ world, chapter } = await resolveDebugWorldAndChapter({ db, userId, worldId, chapterId }));
  } catch (err) {
    const errCode = err instanceof Error ? err.message : "";
    if (errCode === "NOT_FOUND_WORLD") {
      return res.status(404).send(error("未找到故事"));
    }
    if (errCode === "NOT_FOUND_CHAPTER") {
      return res.status(404).send(error("当前没有章节可调试"));
    }
    throw err;
  }

  // 先构建一次统一运行上下文，后续两个主分支都直接复用，避免重复做状态归一化。
  const runtimeContext = buildDebugRuntimeContext({
    req,
    userId,
    worldId,
    world,
    chapter,
    playerContent,
    inputMessages,
  });
  requestTrace.debugRuntimeKey = asTrimmedText(runtimeContext.state?.debugRuntimeKey);
  requestTrace.chapterId = Number(runtimeContext.effectiveChapter?.id || chapter.id || requestTrace.chapterId || 0);
  logOrchestrationKeyNode(requestTrace, "runtime_context:ready", {
    debugFreePlotActive: runtimeContext.debugFreePlotActive,
    recentMessageCount: runtimeContext.recentMessages.length,
  });

  if (!playerContent) {
    return handleInitialDebugTurn({
      res,
      db,
      userId,
      worldId,
      world,
      chapter,
      state: runtimeContext.state,
      rolePair: runtimeContext.rolePair,
      recentMessages: runtimeContext.recentMessages,
      debugFreePlotActive: runtimeContext.debugFreePlotActive,
      inputMessages,
      effectiveChapter: runtimeContext.effectiveChapter,
      requestTrace,
    });
  }

  return handleDebugPlayerTurn({
    res,
    db,
    userId,
    worldId,
    world,
    chapter,
    state: runtimeContext.state,
    rolePair: runtimeContext.rolePair,
    recentMessages: runtimeContext.recentMessages,
    debugFreePlotActive: runtimeContext.debugFreePlotActive,
    inputMessages,
    playerContent,
    effectiveChapter: runtimeContext.effectiveChapter,
    requestTrace,
  });
}

/**
 * 只允许返回 谁说法，动机是什么，禁止进行大杂烩接口，禁止进行编排下一个角色是谁！！！！
 * （第一章节的话有开场白）->编排接口-> 台词接口（steam 形式返回）->语音接口 和编排接口 同时发送->语音播放完毕（错误or 静音）-》台词接口（steam 形式返回）
 * 其他信息只能通过 storyInfo 接口返回!!!!
 * 接口返回
 * {"code": 200, "data": {"role": "旁白","roleType": "narrator","motive": "介绍空间戒指当前的具体存储物品情况"}
 * ,"message": "成功"} data 只允许返回 谁说法，动机是什么.
 * 不允许返回任何其他信息！！！ 这不是大杂烩接口！！！！
 * 其他信息在/streamlines 访问后端时后端自己在后端获取。
 */
export default router.post(
  "/",
  validateFields({
    sessionId: z.string().optional().nullable(),
    worldId: z.number().optional().nullable(),
    chapterId: z.number().optional().nullable(),
    playerContent: z.string().optional().nullable(),
    state: z.any().optional().nullable(),
    messages: z.array(debugMessageSchema).optional().nullable(),
  }),
  async (req, res) => {
    try {
      // 路由本体只保留异常收口，真正的调试流程交给拆分后的主分发函数。
      return await handleDebugOrchestrationRequest(req, res);
    } catch (err) {
      if (isSessionServiceError(err)) {
        return res.status(err.status).send(error(err.message));
      }
      res.status(500).send(error(u.error(err).message));
    }
  },
);
