/**
 * 玩家行动提示器 Agent (PlayTipAgent)
 *
 * 给玩家提供 3 条第一人称、可直接复制到输入框的行动建议。
 * 每次点击 play-tip-fab 都会调用一次。
 *
 * 模型：复用 storyOrchestratorModel（与任务编排师 / 角色发言器一致）
 *
 * 数据库 prompt code: play-tip-agent
 */

import u from "@/utils";
import { z } from "zod";
import { loadTaskPrompt } from "../taskMode/loadTaskPrompt";

const FALLBACK_SYSTEM = `你是玩家行动建议器。基于当前剧情/任务上下文，为玩家生成 3 条不同方向的可执行行动提示，让玩家可以直接复制到输入框发送。

# 要求

1. 第一人称视角：必须用"我..."开头，模拟玩家自己说出这句话
2. 每条 15-40 字，简洁明确
3. 三条要明显不同方向：例如
   - 探索（我去看看XX）
   - 推进主线（我直接做XX）
   - 互动 NPC（我问/找 @XX）
   - 道具/技能（我用XX）
   - 观察/等待（我先观察/等XX）
4. 提示要紧扣"任务目标 + 当前推进过程 + 最近对话 + 可用 NPC"
5. 严禁元说明、严禁旁白语气、不要"作为玩家..." 这种叙述
6. 不要重复玩家最近说过的话

# 入参

- 世界名 / 章节标题 / 全局背景
- 当前任务（如有）：标题/目标/推进过程
- 角色动态参数卡列表
- 最近对话
- 玩家身份卡

# 输出（严格 JSON，不要 markdown 代码块）

{"tips":["第一条提示","第二条提示","第三条提示"]}

tips 数组必须正好 3 条字符串。`;

const AI_SCHEMA = z.object({
  tips: z.array(z.string()).min(1).max(5),
});

export interface PlayTipContext {
  userId: number;
  worldName: string;
  chapterTitle: string;
  globalBackground: string;
  taskTitle?: string;
  taskObjective?: string;
  taskProcess?: string;
  npcCards: string;
  recentDialogue: string;
  playerCard: string;
  playerHandle: string;
}

export interface PlayTipResult {
  tips: string[];
  source: "ai" | "fallback";
  latencyMs: number;
}

function buildFallbackTips(ctx: PlayTipContext): string[] {
  const role = ctx.playerHandle || "@故事角色";
  const chapter = ctx.chapterTitle || "当前章节";
  return [
    `我想先观察${role}在《${chapter}》中的反应，再决定下一步。`,
    `直接推进当前章节目标，别再绕路。`,
    `${role}，你先给我一个稳妥方案，我按方案执行。`,
  ];
}

export async function generatePlayerTips(ctx: PlayTipContext): Promise<PlayTipResult> {
  const systemPrompt = await loadTaskPrompt("play-tip-agent", FALLBACK_SYSTEM);

  const userPrompt = `世界名：${ctx.worldName || "未命名世界"}
章节标题：${ctx.chapterTitle || "未命名章节"}
故事简介：
${ctx.intro || "（无）"}
故事全局背景：
${ctx.globalBackground || "（无）"}

当前任务：
${ctx.taskTitle ? `- 标题：${ctx.taskTitle}` : "- （当前没有进行中的任务）"}
${ctx.taskObjective ? `- 目标：${ctx.taskObjective}` : ""}
${ctx.taskProcess ? `- 推进过程：${ctx.taskProcess}` : ""}

玩家参数卡：
${ctx.playerCard || "（无）"}

可用角色（NPC）：
${ctx.npcCards || "（无可用 NPC）"}

最近对话：
${ctx.recentDialogue || "（暂无对话）"}

请根据以上上下文，为玩家生成 3 条不同方向的、可直接发送到输入框的第一人称行动提示。

请严格输出 JSON：
{"tips":["...","...","..."]}`;

  console.log("[story:play_tip:runtime] request", JSON.stringify({
    userId: ctx.userId,
    worldName: ctx.worldName,
    chapterTitle: ctx.chapterTitle,
    taskTitle: ctx.taskTitle || null,
    systemPromptChars: systemPrompt.length,
    userPromptChars: userPrompt.length,
  }));
  console.log("[story:play_tip:runtime] full_user_prompt:", userPrompt.replace(/\n/g, "↩"));

  const startedAt = Date.now();
  try {
    const modelConfig = await u.getPromptAi("storyOrchestratorModel", ctx.userId);
    const result = await u.ai.text.invoke({
      plainTextOutput: true,
      usageType: "玩家提示器",
      usageRemark: "PlayTipAgent",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }, modelConfig as any) as any;

    const rawText = String(result?.text || "").trim();
    const latencyMs = Date.now() - startedAt;

    console.log("[story:play_tip:runtime] response", JSON.stringify({
      rawTextPreview: rawText.slice(0, 200),
      latencyMs,
    }));

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[PlayTipAgent] AI 未返回 JSON：", rawText.slice(0, 200));
      console.log(`[story:play_tip:stats] status=json_not_found latency_ms=${latencyMs}`);
      return { tips: buildFallbackTips(ctx), source: "fallback", latencyMs };
    }
    let obj: any;
    try {
      obj = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.warn("[PlayTipAgent] JSON 解析失败：", e);
      console.log(`[story:play_tip:stats] status=parse_error latency_ms=${latencyMs}`);
      return { tips: buildFallbackTips(ctx), source: "fallback", latencyMs };
    }
    const parsed = AI_SCHEMA.safeParse(obj);
    if (!parsed.success) {
      console.warn("[PlayTipAgent] schema 校验失败：", parsed.error);
      console.log(`[story:play_tip:stats] status=schema_error latency_ms=${latencyMs}`);
      return { tips: buildFallbackTips(ctx), source: "fallback", latencyMs };
    }

    // 规整：去空、去重、限制长度，不足/超过 3 条都对齐
    const cleaned = parsed.data.tips
      .map(t => String(t || "").trim())
      .filter(Boolean)
      .filter((t, i, arr) => arr.indexOf(t) === i);

    let finalTips = cleaned.slice(0, 3);
    if (finalTips.length < 3) {
      const fallback = buildFallbackTips(ctx);
      for (const f of fallback) {
        if (finalTips.length >= 3) break;
        if (!finalTips.includes(f)) finalTips.push(f);
      }
    }

    console.log(`[story:play_tip:stats] tip_count=${finalTips.length} latency_ms=${latencyMs}`);
    return { tips: finalTips, source: "ai", latencyMs };
  } catch (e) {
    const latencyMs = Date.now() - startedAt;
    console.error("[PlayTipAgent] AI调用失败", e);
    console.log(`[story:play_tip:stats] status=exception latency_ms=${latencyMs} error=${(e as Error)?.message}`);
    return { tips: buildFallbackTips(ctx), source: "fallback", latencyMs };
  }
}