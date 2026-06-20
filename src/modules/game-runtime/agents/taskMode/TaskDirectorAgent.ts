/**
 * 任务剧情编排师 Agent (TaskDirectorAgent)
 *
 * 决定本轮谁说话 + 动机 + taskType
 */

import u from "@/utils";
import { z } from "zod";
import { ProgressLevel } from "./TaskProgressAgent";
import { loadTaskPrompt } from "./loadTaskPrompt";

const FALLBACK_SYSTEM = `你是任务剧情编排师。输出严格JSON。

# taskType路由
- opening：任务开始时
- rule：解释规则时
- status：玩家询问状态时
- advance：正常推进
- finished：任务完成时
- failed：任务失败时

# 角色选择策略
- 强力推进：选与推进相关的核心 NPC
- 正常推进：选与节点相关的 NPC（优先 NPC，避免一直让旁白说话）
- 微弱推进：选引导型 NPC
- 维持/查询：可选任务系统说明状态，也可选 NPC 用对话方式回答

# 输出（严格 JSON，不要 markdown 围栏）
{"speaker":"角色名","motive":"为什么这个角色在本轮说话","taskType":"类型","direction":"推进方向（一句话）","expectedResult":"期望玩家状态"}

speaker 只允许：NPC列表中的某个 name / 旁白 / 任务系统`;

export type TaskType = "opening" | "rule" | "status" | "advance" | "finished" | "failed";

export interface DirectorResult {
  speaker: string;
  speakerRole: "npc" | "narrator" | "system";
  motive: string;
  taskType: TaskType;
  direction: string;
  expectedResult: string;
}

const AI_SCHEMA = z.object({
  speaker: z.string(),
  motive: z.string(),
  taskType: z.enum(["opening", "rule", "status", "advance", "finished", "failed"]),
  direction: z.string(),
  expectedResult: z.string(),
});

const SPEAKER_MAP: Record<string, "npc" | "narrator" | "system"> = {
  narrator: "narrator",
  "旁白": "narrator",
  "系统": "system",
  "任务系统": "system",
};

function resolveSpeakerRole(
  speaker: string,
  npcList: Array<{ name: string }>,
): "npc" | "narrator" | "system" {
  if (SPEAKER_MAP[speaker]) return SPEAKER_MAP[speaker];
  // 命中 NPC 列表 → npc
  if (npcList.some(n => n.name === speaker)) return "npc";
  // 兜底当作 NPC（避免错误降级为旁白）
  return speaker ? "npc" : "narrator";
}

async function directorAi(
  progressLevel: ProgressLevel,
  taskObjective: string,
  taskProcess: string[],
  npcList: Array<{ name: string; roleType?: string }>,
  dialogue: string,
  message: string,
  userId: number,
  npcCards: string,
  originalGlobalBackground: string,
  dynamicGlobalBackground: string,
): Promise<DirectorResult> {
  const systemPrompt = await loadTaskPrompt("task-director-agent", FALLBACK_SYSTEM);

  const npcText = npcList.length
    ? npcList.map(n => `- ${n.name}（${n.roleType || "npc"}）`).join("\n")
    : "（无可用 NPC，可让旁白或任务系统说话）";

  const processText = taskProcess.length
    ? `【推进过程】${taskProcess.join(" → ")}`
    : "";

  const userPrompt = `【推进等级】${progressLevel}
${processText}
【任务目标】${taskObjective}
【可用 NPC 列表】
${npcText}
【最近对话】${dialogue || "无"}
【玩家本轮输入】${message}

角色动态参数卡列表：
${npcCards || "（无可用角色参数卡）"}

故事初始全局背景描述：
${originalGlobalBackground || "（无）"}

故事动态全局背景描述：
${dynamicGlobalBackground || "（无）"}

请输出 JSON：
{"speaker":"...","motive":"...","taskType":"...","direction":"...","expectedResult":"..."}`;

  try {
    console.log("[story:mini_game:task:orchestrator:runtime] request", JSON.stringify({
      userId,
      progressLevel,
      objective: taskObjective,
      processPreview: taskProcess.join("→").slice(0, 200),
      npcCount: npcList.length,
      messagePreview: message.slice(0, 100),
    }));
    console.log("[story:mini_game:task:orchestrator:runtime] full_user_prompt:", userPrompt.replace(/\n/g, "↩"));

    const startedAt = Date.now();
    const modelConfig = await u.getPromptAi("storyOrchestratorModel", userId);
    const result = await u.ai.text.invoke({
      plainTextOutput: true,
      usageType: "任务编排",
      usageRemark: "TaskDirectorAgent",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }, modelConfig as any) as any;

    const rawText = String(result?.text || "").trim();
    const latencyMs = Date.now() - startedAt;

    console.log("[story:mini_game:task:orchestrator:runtime] response", JSON.stringify({
      rawTextPreview: rawText.slice(0, 200),
      latencyMs,
    }));

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[TaskDirectorAgent] AI 未返回 JSON：", rawText.slice(0, 200));
      console.log(`[story:mini_game:task:orchestrator:stats] status=json_not_found latency_ms=${latencyMs}`);
      return fallbackDirector(progressLevel, npcList);
    }
    let obj: any;
    try {
      obj = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.warn("[TaskDirectorAgent] JSON 解析失败：", e);
      console.log(`[story:mini_game:task:orchestrator:stats] status=parse_error latency_ms=${latencyMs}`);
      return fallbackDirector(progressLevel, npcList);
    }
    const parsed = AI_SCHEMA.safeParse(obj);
    if (!parsed.success) {
      console.warn("[TaskDirectorAgent] schema 校验失败：", parsed.error);
      console.log(`[story:mini_game:task:orchestrator:stats] status=schema_error latency_ms=${latencyMs}`);
      return fallbackDirector(progressLevel, npcList);
    }

    console.log(`[story:mini_game:task:orchestrator:stats] speaker=${obj.speaker} taskType=${obj.taskType} latency_ms=${latencyMs}`);
    const d = parsed.data;
    return {
      speaker: d.speaker,
      speakerRole: resolveSpeakerRole(d.speaker, npcList),
      motive: d.motive,
      taskType: d.taskType as TaskType,
      direction: d.direction,
      expectedResult: d.expectedResult,
    };
  } catch (e) {
    console.error("[TaskDirectorAgent] AI调用失败", e);
    return fallbackDirector(progressLevel, npcList);
  }
}

function fallbackDirector(
  level: ProgressLevel,
  npcList: Array<{ name: string; roleType?: string }>,
): DirectorResult {
  // 优先选 NPC（避免老让旁白/系统说话）
  if (npcList.length > 0) {
    const npc = npcList[0];
    return {
      speaker: npc.name,
      speakerRole: "npc",
      motive: level === "maintain" ? "回答玩家询问，给出当前任务方向" : "推动剧情向前",
      taskType: level === "maintain" ? "status" : "advance",
      direction: level === "maintain" ? "回应玩家询问并指明当前任务方向" : "推进剧情",
      expectedResult: "玩家了解下一步行动",
    };
  }
  if (level === "maintain") {
    return {
      speaker: "任务系统",
      speakerRole: "system",
      motive: "说明状态",
      taskType: "status",
      direction: "告知玩家任务当前状态",
      expectedResult: "玩家了解任务状态",
    };
  }
  return {
    speaker: "旁白",
    speakerRole: "narrator",
    motive: "推进剧情",
    taskType: "advance",
    direction: "继续推进",
    expectedResult: "玩家完成任务",
  };
}

export async function directTaskNarrative(
  progressLevel: ProgressLevel,
  task: { objective?: string; process?: string[] },
  npcList: Array<{ id: string; name: string; roleType?: string }>,
  dialogue: Array<{ role: string; content: string }>,
  message: string,
  userId: number,
  npcCards: string,
  originalGlobalBackground: string,
  dynamicGlobalBackground: string,
): Promise<DirectorResult> {
  const hist = dialogue.slice(-6).map(d => `${d.role}:${String(d.content || "").slice(0, 60)}`).join("|");
  // ★ 不再短路：所有等级都走 AI（包括 maintain），保证任务系统/旁白也是 AI 编排出来的
  return directorAi(progressLevel, task?.objective || "无", task?.process || [], npcList, hist, message, userId, npcCards, originalGlobalBackground, dynamicGlobalBackground);
}