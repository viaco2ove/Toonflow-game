/**
 * 任务角色发言器 Agent (TaskSpeakerAgent)
 *
 * 根据 Director 的编排生成角色台词
 */

import u from "@/utils";
import { z } from "zod";
import { DirectorResult } from "./TaskDirectorAgent";
import { loadTaskPrompt } from "./loadTaskPrompt";

const FALLBACK_SYSTEM = `你是任务角色发言器。生成符合角色的台词。

# 发言风格
- NPC：符合性格，口语化，有推进感
- 旁白：描述性，说明场景/氛围
- 系统：正式易懂，不带情感

# 输出
{"speaker":"角色名","content":"台词","tone":"语气","emotion":"情绪"}`;

export interface SpeakerResult {
  speaker: string;
  speakerRole: "npc" | "narrator" | "system";
  content: string;
  tone?: string;
  emotion?: string;
}

const AI_SCHEMA = z.object({
  speaker: z.string(),
  content: z.string(),
  tone: z.string().optional(),
  emotion: z.string().optional(),
});

async function generateAi(
  director: DirectorResult,
  npcCard: string,
  taskObjective: string,
  dialogue: string,
  message: string,
  userId: number,
): Promise<SpeakerResult> {
  const systemPrompt = await loadTaskPrompt("task-speaker-agent", FALLBACK_SYSTEM);

  const roleHint = director.speakerRole === "system"
    ? "你是任务系统（中性叙述者，告知玩家任务规则/状态/进度）"
    : director.speakerRole === "narrator"
      ? "你是旁白（描述场景氛围与剧情切换，不直接对话）"
      : `你是 NPC「${director.speaker}」`;

  const userPrompt = `【角色】${roleHint}
【发言动机】${director.motive}
【剧情类型】${director.taskType}（${director.direction}）
【期望效果】${director.expectedResult}
${npcCard ? `【NPC 人设】\n${npcCard}` : ""}
【任务目标】${taskObjective}
【最近对话】${dialogue || "无"}
【玩家本轮输入】${message}

请生成本轮台词，要求：
- 直接、自然，不要废话和元说明（不要写"作为旁白"、"任务系统说明"等）
- 紧扣玩家本轮输入与任务目标
- 1-3 句话即可

只输出台词内容本身，不要 JSON 包装、不要标签。`;

  try {
    const modelConfig = await u.getPromptAi("storyOrchestratorModel", userId);
    const result = await u.ai.text.invoke({
      plainTextOutput: true,
      usageType: "角色发言",
      usageRemark: "TaskSpeakerAgent",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }, modelConfig as any) as any;

    const rawText = String(result?.text || "").trim();
    if (!rawText) {
      console.warn("[TaskSpeakerAgent] AI 返回空文本");
      return fallbackTemplate(director);
    }
    // 去掉可能的 markdown 代码围栏 / JSON 包装
    let content = rawText;
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const obj = JSON.parse(jsonMatch[0]);
        if (obj && typeof obj.content === "string" && obj.content.trim()) {
          content = obj.content.trim();
        }
      } catch {
        // 忽略，使用原文
      }
    }
    // 去掉常见前缀
    content = content
      .replace(/^```[\w]*\s*|```\s*$/g, "")
      .replace(/^"|"$/g, "")
      .trim();
    return {
      speaker: director.speaker,
      speakerRole: director.speakerRole,
      content,
    };
  } catch (e) {
    console.error("[TaskSpeakerAgent] AI调用失败", e);
    return fallbackTemplate(director);
  }
}

function fallbackTemplate(director: DirectorResult): SpeakerResult {
  const templates: Record<string, string> = {
    status: `当前任务：${director.direction}
（任务系统说明状态）`,
    rule: `任务规则说明：
（${director.motive}）
${director.direction}`,
    opening: `任务开启！
目标：进行中
（${director.direction}）`,
    finished: `任务完成！
（${director.direction}）`,
    failed: `任务失败/放弃
（${director.direction}）`,
  };
  return {
    speaker: director.speaker,
    speakerRole: director.speakerRole,
    content: templates[director.taskType] || `（${director.direction}）`,
  };
}

export async function generateTaskSpeech(
  director: DirectorResult,
  npcCard: string,
  task: { objective?: string },
  dialogue: Array<{ role: string; content: string }>,
  message: string,
  userId: number,
): Promise<SpeakerResult> {
  const hist = dialogue.slice(-8).map(d => `${d.role}:${String(d.content || "").slice(0, 60)}`).join("|");
  // ★ 不再短路：system/narrator/npc 都走 AI 生成台词
  // 之前直接返回模板会让"任务系统"、"旁白"输出僵硬的占位文本（如"清晰告知玩家任务进展"）
  return generateAi(director, npcCard, task?.objective || "无", hist, message, userId);
}