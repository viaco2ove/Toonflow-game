/**
 * 任务模式编排器 - 主入口（AI 版）
 *
 * 串联 4 个 Agent：Intent → Progress → Director → Speaker → Completion
 * 复用现有模型配置（storyOrchestratorModel / storyEventProgressModel / storyMemoryModel）
 */

import { ProgressLevel, evaluateTaskProgress } from "./TaskProgressAgent";
import { directTaskNarrative } from "./TaskDirectorAgent";
import { generateTaskSpeech } from "./TaskSpeakerAgent";
import { CompletionLevel, evaluateTaskCompletion } from "./TaskCompletionAgent";
import type { IntentResult, IntentType } from "../intentAnalyzer/IntentClassifier";

export interface TaskModeContext {
  userId: number;
  playerMessage: string;
  activeTaskId?: string | null;
  task?: {
    title?: string;
    objective?: string;
    process?: string[];
  } | null;
  npcList?: Array<{ id: string; name: string; roleType?: string; card?: string }>;
  recentDialogue?: Array<{ role: string; content: string }>;
  chapterTitle?: string;
}

export interface TaskModeResult {
  intercepted: boolean;
  shouldComplete: boolean;
  completionLevel?: CompletionLevel;
  narration?: string;
  speaker?: string;
  speakerRole?: "npc" | "narrator" | "system";
  meta?: Record<string, unknown>;
}

/**
 * 主入口：执行任务模式编排链路（AI 驱动）
 */
export async function orchestrateTaskMode(ctx: TaskModeContext): Promise<TaskModeResult> {
  console.log("[TaskMode] 入口", {
    message: String(ctx.playerMessage || "").slice(0, 60),
    taskTitle: ctx.task?.title,
    userId: ctx.userId,
  });

  // 1. 意图识别
  const intentResult = await analyzeTaskIntent(ctx);
  console.log("[TaskMode] Step1 意图：", intentResult.intent, intentResult.confidence);

  // 退出意图 → 直接评估完成
  if (intentResult.intent === "exit_task" && intentResult.confidence >= 0.7) {
    return handleTaskCompletion(ctx, "abandon", intentResult);
  }

  // 2. 推进判定（AI）
  const taskForProgress = ctx.task ? { objective: ctx.task.objective, process: ctx.task.process } : null;
  const progressResult = await evaluateTaskProgress(
    intentResult,
    taskForProgress,
    ctx.recentDialogue || [],
    ctx.playerMessage,
    ctx.userId,
  );
  console.log("[TaskMode] Step2 推进：", progressResult.level, "/", progressResult.tier);

  // 需要澄清
  if (progressResult.needClarify) {
    return {
      intercepted: true,
      shouldComplete: false,
      speaker: "任务系统",
      speakerRole: "system",
      narration: progressResult.clarifyContent || "请明确你的意图。",
    };
  }

  // 推进等级为放弃 → 触发完成
  if (progressResult.level === "abandon") {
    return handleTaskCompletion(ctx, "abandon", intentResult);
  }

  // 3. 剧情编排（AI）
  const directorResult = await directTaskNarrative(
    progressResult.level,
    ctx.task || { objective: "进行任务" },
    ctx.npcList || [],
    ctx.recentDialogue || [],
    ctx.playerMessage,
    ctx.userId,
    ctx.npcCards || "",
    ctx.originalGlobalBackground || "",
    ctx.dynamicGlobalBackground || "",
  );
  console.log("[TaskMode] Step3 编排：", directorResult.speaker, "/", directorResult.taskType);

  // 4. 角色发言（AI）
  const npcCard = ctx.npcList?.find(n => n.name === directorResult.speaker)?.card || "";
  const speakerResult = await generateTaskSpeech(
    directorResult,
    npcCard,
    ctx.task || { objective: "进行任务" },
    ctx.recentDialogue || [],
    ctx.playerMessage,
    ctx.userId,
  );
  console.log("[TaskMode] Step4 发言：", String(speakerResult.content || "").slice(0, 60));

  return {
    intercepted: true,
    shouldComplete: false,
    speaker: speakerResult.speaker,
    speakerRole: speakerResult.speakerRole,
    narration: speakerResult.content,
    meta: {
      progressLevel: progressResult.level,
      directorType: directorResult.taskType,
      motive: directorResult.motive,
    },
  };
}

/**
 * 简化的意图识别（复用 IntentClassifier）
 */
async function analyzeTaskIntent(ctx: TaskModeContext): Promise<IntentResult & { confidence: number }> {
  const mod = await import("../intentAnalyzer");
  const analyzeIntent = mod.analyzeIntent as any;

  const result = await analyzeIntent({
    userId: ctx.userId,
    playerMessage: ctx.playerMessage,
    activeTaskId: ctx.activeTaskId,
    chapterTitle: ctx.chapterTitle,
  });

  if (result) {
    return result as IntentResult & { confidence: number };
  }

  return {
    intent: "normal_dialog" as IntentType,
    confidence: 0.5,
    reasoning: "意图分析不可用",
    params: {},
    path: "fallback" as const,
  };
}

/**
 * 任务完成评估（AI 驱动）
 */
async function handleTaskCompletion(
  ctx: TaskModeContext,
  finalStatus: "abandon" | "success" | "failed",
  intentResult: IntentResult,
): Promise<TaskModeResult> {
  console.log("[TaskMode] 完成评估", { finalStatus });

  const completionResult = await evaluateTaskCompletion(
    finalStatus,
    ctx.task || {},
    ctx.recentDialogue || [],
    ctx.playerMessage,
    intentResult.reasoning || "任务结束",
    ctx.userId,
  );
  console.log("[TaskMode] 评估结果：", completionResult.level);

  return {
    intercepted: true,
    shouldComplete: true,
    completionLevel: completionResult.level,
    speaker: "旁白",
    speakerRole: "narrator",
    narration: completionResult.narration,
    meta: {
      completionLevel: completionResult.level,
      statement: completionResult.statement,
      suggestion: completionResult.suggestion,
    },
  };
}