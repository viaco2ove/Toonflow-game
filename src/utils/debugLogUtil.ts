import fs from "fs";
import path from "path";
import { debugLogConfig } from "@/utils/debugLogConfig";

type MiniGamePromptStatRow = {
  block: string;
  content: string;
  chars: number;
  estimatedTokens: number;
};

/**
 * 调试日志工具。
 *
 * 用途：
 * - 统一管理 `LOG_LEVEL=DEBUG` 的开关判断；
 * - 统一通过 `debugLogConfig` 的黑/白名单约束日志输出；
 * - 避免各个运行时类重复实现相同逻辑，导致后续行为不一致。
 */
export class DebugLogUtil {
  /**
   * 估算一段文本大致会消耗多少 Prompt Tokens。
   *
   * 用途：
   * - 小游戏动作解析日志需要和编排/台词流日志保持同一估算口径；
   * - 这里沿用“4 个字符约等于 1 个 token”的保守估算，便于横向比较。
   */
  private static estimatePromptTokens(text: string): number {
    const chars = String(text || "").length;
    if (!chars) return 0;
    return Math.max(1, Math.ceil(chars / 4));
  }

  /**
   * 规范化日志里的长文本展示。
   *
   * 用途：
   * - 避免 system prompt / user prompt / 模型返回内容直接换行打散日志；
   * - 让小游戏 stats 日志和 streamlines stats 日志的可读性保持一致。
   */
  private static normalizePromptStatContent(content: string): string {
    return String(content || "").trim().replaceAll("\n", " ↩ ");
  }

  /**
   * 判断当前进程是否开启 DEBUG 级别日志。
   */
  static isDebugLogEnabled(): boolean {
    return String(process.env.LOG_LEVEL || "").trim().toUpperCase() === "DEBUG";
  }

  /**
   * 判断某个 tag 是否应该被打印（基于 debugLogConfig 的黑/白名单 + 前缀匹配）。
   *
   * 规则：
   * - blacklist 模式：命中任一黑名单前缀即屏蔽，否则放行（黑名单空 = 全放行）；
   * - whitelist 模式：仅命中某白名单前缀才放行，否则屏蔽（白名单空 = 全屏蔽）；
   * - 复合 tag（如 `story:event_progress:runtime][stage][buildRecentMessages`）只需匹配基础 tag 前缀。
   */
  private static shouldLogTag(tag: string): boolean {
    const normalizedTag = String(tag || "").trim();
    if (!normalizedTag) return true; // 无 tag 的裸日志不约束，保持原行为
    const mode = debugLogConfig.debugLogMode;
    if (mode === "whitelist") {
      const list = debugLogConfig.debugLogWhitelist;
      return list.some((item) => normalizedTag.startsWith(String(item || "").trim()));
    }
    // 默认 blacklist
    const list = debugLogConfig.debugLogBlacklist;
    return !list.some((item) => normalizedTag.startsWith(String(item || "").trim()));
  }

  /**
   * 统一日志入口：同时受 `LOG_LEVEL=DEBUG` 开关与黑/白名单约束。
   *
   * 用途：
   * - 替代散落各处的 `if (isDebugLogEnabled()) { console.log("[tag] ...") }` 写法；
   * - 统一在入口加 `[tag]` 前缀，保证日志格式一致且可被黑/白名单过滤。
   */
  static log(tag: string, ...args: unknown[]): void {
    if (!DebugLogUtil.isDebugLogEnabled()) return;
    if (!DebugLogUtil.shouldLogTag(tag)) return;
    if (args.length === 0) {
      console.log(`[${tag}]`);
      return;
    }
    // 保持与原有 `console.log("[tag] msg", rest)` 一致的输出形态。
    console.log(`[${tag}]`, ...args);
  }

  /**
   * 统一打印“当前章节”调试日志。
   *
   * 用途：
   * - 各条运行链都能用同一格式输出当前章节；
   * - 避免日志里只看到 current_event，却看不到它属于哪一章。
   */
  static logCurrentChapter(tag: string, chapter: {
    id?: unknown;
    title?: unknown;
    sort?: unknown;
  } | null | undefined): void {
    if (!DebugLogUtil.isDebugLogEnabled()) return;
    if (!DebugLogUtil.shouldLogTag(tag)) return;
    console.log(`[${tag}] current_chapter=${JSON.stringify({
      id: Number(chapter?.id || 0) || 0,
      title: String(chapter?.title || "").trim() || "未知",
      sort: Number(chapter?.sort || 0) || 0,
    })}`);
  }

  /**
   * 统一打印“事件进度处理结果”调试日志。
   *
   * 用途：
   * - 把 AI 事件进度检测最终如何判断当前事件、当前阶段、下一事件明确打出来；
   * - 便于定位“为什么 current_event 还停留在 1”。
   */
  static logEventProgressResolution(tag: string, payload: {
    chapter?: { id?: unknown; title?: unknown; sort?: unknown } | null;
    currentEventIndex?: unknown;
    currentPhaseId?: unknown;
    currentPhaseLabel?: unknown;
    ended?: unknown;
    eventStatus?: unknown;
    nextEventIndex?: unknown;
    nextEventSummary?: unknown;
  }): void {
    if (!DebugLogUtil.isDebugLogEnabled()) return;
    if (!DebugLogUtil.shouldLogTag(tag)) return;
    DebugLogUtil.logCurrentChapter(tag, payload.chapter || null);
    console.log(`[${tag}] resolution=${JSON.stringify({
      currentEventIndex: Number(payload.currentEventIndex || 0) || 0,
      currentPhaseId: String(payload.currentPhaseId || "").trim(),
      currentPhaseLabel: String(payload.currentPhaseLabel || "").trim(),
      ended: Boolean(payload.ended),
      eventStatus: String(payload.eventStatus || "").trim(),
      nextEventIndex: Number(payload.nextEventIndex || 0) || 0,
      nextEventSummary: String(payload.nextEventSummary || "").trim(),
    })}`);
  }

  /**
   * 统一打印小游戏文本输入的命中结果 + 真实 token 统计。
   *
   * 用途：
   * - 明确记录小游戏输入被归一化后的文本；
   * - 明确记录最终命中的控制动作、局内动作或战斗动作；
   * - 打印真实的 AI 调用 token 消耗、耗时等统计，与 [story:streamlines:stats] 格式对齐；
   * - 便于直接从日志判断聊天框输入有没有真正命中目标玩法，以及 AI 调用成本。
   */
  static logMiniGameActionResolution(tag: string, payload: {
    gameType?: unknown;
    phase?: unknown;
    status?: unknown;
    input?: unknown;
    normalizedInput?: unknown;
    controlAction?: unknown;
    actionId?: unknown;
    battleActionId?: unknown;
    resolverSource?: unknown;
    resolverReason?: unknown;
    resultTags?: unknown;
    intercepted?: unknown;
    /** AI 意图解析的真实 token 消耗（来自 MiniGameIntentService） */
    tokenUsage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } | null;
    /** AI 意图解析的耗时（来自 MiniGameIntentService） */
    timing?: { buildMs?: number; invokeMs?: number; totalMs?: number } | null;
    /** 发送给模型的内容摘要 */
    requestPreview?: string;
    /** 模型返回的内容摘要 */
    responsePreview?: string;
  }): void {
    if (!DebugLogUtil.isDebugLogEnabled()) return;
    if (!DebugLogUtil.shouldLogTag(tag)) return;
    // 第一行：动作命中结果（保持向后兼容）
    console.log(`[${tag}] action=${JSON.stringify({
      gameType: String(payload.gameType || "").trim(),
      phase: String(payload.phase || "").trim(),
      status: String(payload.status || "").trim(),
      input: String(payload.input || "").trim(),
      normalizedInput: String(payload.normalizedInput || "").trim(),
      controlAction: String(payload.controlAction || "").trim(),
      actionId: String(payload.actionId || "").trim(),
      battleActionId: String(payload.battleActionId || "").trim(),
      resolverSource: String(payload.resolverSource || "").trim(),
      resolverReason: String(payload.resolverReason || "").trim(),
      resultTags: Array.isArray(payload.resultTags) ? payload.resultTags : [],
      intercepted: Boolean(payload.intercepted),
    })}`);
    // 以下为真实 token 统计，参考 [story:orchestrator:stats] / [story:streamlines:stats] 格式
    const tokenUsage = payload.tokenUsage;
    const timing = payload.timing;
    if (tokenUsage || timing) {
      // 耗时统计
      if (timing) {
        console.log(
          `[${tag}] build_ms=${Number(timing.buildMs || 0)} invoke_ms=${Number(timing.invokeMs || 0)} total_ms=${Number(timing.totalMs || 0)}`,
        );
      }
      // 真实 token 消耗
      if (tokenUsage) {
        console.log(
          `[${tag}] actual_input_tokens=${tokenUsage.inputTokens || 0} `
          + `actual_output_tokens=${tokenUsage.outputTokens || 0} `
          + `actual_reasoning_tokens=${tokenUsage.reasoningTokens || 0}`,
        );
      }
      // 汇总表格
      console.log(`[${tag}] | 指标 | 值 |`);
      console.log(`[${tag}] |---|---|`);
      if (timing) {
        console.log(`[${tag}] | 构建耗时 | ${Number(timing.buildMs || 0)} ms |`);
        console.log(`[${tag}] | 调用耗时 | ${Number(timing.invokeMs || 0)} ms |`);
        console.log(`[${tag}] | 总耗时 | ${Number(timing.totalMs || 0)} ms |`);
      }
      if (tokenUsage) {
        console.log(`[${tag}] | 输入 Token | ${tokenUsage.inputTokens || 0} |`);
        console.log(`[${tag}] | 输出 Token | ${tokenUsage.outputTokens || 0} |`);
        console.log(`[${tag}] | 推理 Token | ${tokenUsage.reasoningTokens || 0} |`);
      }
    }
    // 发送内容 / 返回内容（参考 [story:orchestrator:stats]）
    if (payload.requestPreview) {
      console.log(`[${tag}] request_preview=${payload.requestPreview}`);
    }
    if (payload.responsePreview) {
      console.log(`[${tag}] response_preview=${payload.responsePreview}`);
    }
  }

  /**
   * 统一打印小游戏动作解析 agent 的 prompt / token / 返回内容统计。
   *
   * 用途：
   * - 让 `[story:mini_game:stats]` 和 `[story:streamlines:stats]` 使用相同的日志结构；
   * - 既能看到真实 usage token，也能看到 system prompt、user prompt 和最终返回内容；
   * - 当模型失败或回退时，也能直接在 stats 日志里看出失败原因。
   */
  static logMiniGamePromptStats(tag: string, input: {
    gameType: string;
    phase: string;
    status: string;
    systemPrompt: string;
    userPrompt: string;
    rawResponse?: string | null;
    tokenUsage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } | null;
    timing?: { buildMs?: number; invokeMs?: number; totalMs?: number } | null;
    runtimeError?: unknown;
  }): void {
    if (!DebugLogUtil.isDebugLogEnabled()) return;
    if (!DebugLogUtil.shouldLogTag(tag)) return;
    const rows: MiniGamePromptStatRow[] = [
      {
        block: "系统提示词",
        content: input.systemPrompt || "无",
        chars: input.systemPrompt.length,
        estimatedTokens: DebugLogUtil.estimatePromptTokens(input.systemPrompt),
      },
      {
        block: "用户提示词",
        content: input.userPrompt || "无",
        chars: input.userPrompt.length,
        estimatedTokens: DebugLogUtil.estimatePromptTokens(input.userPrompt),
      },
    ];
    const totalPromptChars = input.systemPrompt.length + input.userPrompt.length;
    const totalPromptTokens = DebugLogUtil.estimatePromptTokens(`${input.systemPrompt}\n${input.userPrompt}`.trim());
    const responseText = String(input.rawResponse || "").trim();
    const runtimeLog = {
      gameType: String(input.gameType || "").trim(),
      phase: String(input.phase || "").trim(),
      status: String(input.status || "").trim(),
      requestChars: totalPromptChars,
      estimatedTokens: totalPromptTokens,
      systemChars: input.systemPrompt.length,
      userChars: input.userPrompt.length,
      requestStatus: input.runtimeError ? "fallback" : "success",
      responseTextLength: responseText.length,
      responseText: responseText.slice(0, 500),
      tokenUsage: input.tokenUsage || null,
      buildMs: Number(input.timing?.buildMs || 0),
      invokeMs: Number(input.timing?.invokeMs || 0),
      totalMs: Number(input.timing?.totalMs || 0),
      error: input.runtimeError ? String((input.runtimeError as Error)?.message || input.runtimeError || "") : "",
    };
    // 这一行用独立的 mini_game:runtime tag，单独受其黑/白名单约束。
    DebugLogUtil.log("story:mini_game:runtime", JSON.stringify(runtimeLog));
    console.log(
      `[${tag}] game_type=${runtimeLog.gameType} request_chars=${totalPromptChars} estimated_tokens=${totalPromptTokens} `
      + `system_chars=${input.systemPrompt.length} user_chars=${input.userPrompt.length} `
      + `build_ms=${Number(input.timing?.buildMs || 0)} invoke_ms=${Number(input.timing?.invokeMs || 0)} total_ms=${Number(input.timing?.totalMs || 0)}`,
    );
    if (input.tokenUsage) {
      console.log(
        `[${tag}] actual_input_tokens=${input.tokenUsage.inputTokens || 0} `
        + `actual_output_tokens=${input.tokenUsage.outputTokens || 0} `
        + `actual_reasoning_tokens=${input.tokenUsage.reasoningTokens || 0}`,
      );
    }
    if (responseText) {
      console.log(`[${tag}] response_chars=${responseText.length}`);
      console.log(`[${tag}] response_preview=${DebugLogUtil.normalizePromptStatContent(responseText)}`);
    }
    if (input.runtimeError) {
      console.log(
        `[${tag}] request_status=fallback reason=${DebugLogUtil.normalizePromptStatContent(
          String((input.runtimeError as Error)?.message || input.runtimeError || ""),
        )}`,
      );
    } else {
      console.log(`[${tag}] request_status=success`);
    }
    console.log(`[${tag}] 以下为 prompt 体积估算，不等于模型真实 usage。`);
    console.log(`[${tag}] | 区块 | 实际内容 | 字符数 | 估算 Prompt Tokens |`);
    console.log(`[${tag}] |---|---|---:|---:|`);
    rows.forEach((row) => {
      console.log(
        `[${tag}] | ${row.block} | ${DebugLogUtil.normalizePromptStatContent(row.content)} | ${row.chars} | ${row.estimatedTokens} |`,
      );
    });
    if (responseText) {
      console.log(`[${tag}] | 返回内容 | ${DebugLogUtil.normalizePromptStatContent(responseText)} | ${responseText.length} | - |`);
    }
    if (input.tokenUsage) {
      console.log(
        `[${tag}] | 实际推理消耗 | input=${input.tokenUsage.inputTokens || 0}, `
        + `output=${input.tokenUsage.outputTokens || 0}, reasoning=${input.tokenUsage.reasoningTokens || 0} | - | - |`,
      );
    }
    console.log(`[${tag}] System Prompt`);
    console.log(`${input.systemPrompt}\n \n userPrompt:\n${input.userPrompt}`);
  }

  /**
   * 统一打印显式“@记忆管理”指令的参数卡写回结果。
   *
   * 用途：
   * - 明确看到这条输入是否真的命中了显式记忆指令解析；
   * - 明确看到技能 / 物品 / 装备分别新增了什么；
   * - 避免只看用户面板时无法判断是后端没写回，还是前端没刷新。
   */
  static logPlayerMemoryDirective(tag: string, payload: {
    mode?: unknown;
    applied?: unknown;
    body?: unknown;
    addedSkills?: unknown;
    addedItems?: unknown;
    addedEquipment?: unknown;
    addedOther?: unknown;
  }): void {
    if (!DebugLogUtil.isDebugLogEnabled()) return;
    if (!DebugLogUtil.shouldLogTag(tag)) return;
    console.log(`[${tag}] directive=${JSON.stringify({
      mode: String(payload.mode || "").trim(),
      applied: Boolean(payload.applied),
      body: String(payload.body || "").trim(),
      addedSkills: Array.isArray(payload.addedSkills) ? payload.addedSkills : [],
      addedItems: Array.isArray(payload.addedItems) ? payload.addedItems : [],
      addedEquipment: Array.isArray(payload.addedEquipment) ? payload.addedEquipment : [],
      addedOther: Array.isArray(payload.addedOther) ? payload.addedOther : [],
    })}`);
  }

  /**
   * 根据日志行里的 tag，抽取单轮编排链摘要并写成 markdown 文件。
   *
   * 输入：
   * - `logFilePath`: 原始日志文件
   * - `outputMarkdownPath`: 生成的 md 文件
   *
   * 输出：
   * - 返回生成结果，包含写入路径和识别到的编排条数
   *
   * 说明：
   * - 该函数只依赖日志文本，不依赖运行时上下文
   * - 输出格式按 `md/code/日志tag.md` 里的模板组织
   *
   * 编排流程文件生成命令： yarn debug:event-chain logs/app-2026-04-13.log
   * 核心脚本：scripts/generateEventChainSummary.ts
   */
  static generateEventChainSummaryMarkdown(logFilePath: string, outputMarkdownPath: string): {
    outputPath: string;
    entryCount: number;
  } {
    const rawLog = fs.readFileSync(logFilePath, "utf8");
    const lines = rawLog.split(/\r?\n/);
    const entries: EventChainSummaryEntry[] = [];
    let currentEntry: EventChainSummaryEntry | null = null;
    let currentContext: EventChainContext = {};

    /**
     * 把章节/判定结果/下一章等上下文补到当前 entry。
     *
     * 用途：
     * - 这些日志常常和“当前事件”分开打印；
     * - 摘要生成时需要继承最近一次有效上下文，避免出现大量“未知”。
     */
    const applyContextToEntry = (entry: EventChainSummaryEntry | null): EventChainSummaryEntry | null => {
      if (!entry) return entry;
      return {
        ...currentContext,
        ...entry,
        chapterTitle: entry.chapterTitle || currentContext.chapterTitle || "",
        sessionStatus: entry.sessionStatus || currentContext.sessionStatus || "",
        outcome: entry.outcome || currentContext.outcome || "",
        nextChapterId: entry.nextChapterId || currentContext.nextChapterId || "",
      };
    };

    /**
     * 当前 entry 有内容时才入列，避免空壳条目污染摘要。
     */
    const pushCurrentEntry = () => {
      if (!currentEntry) return;
      if (
        !currentEntry.currentEventSummary
        && !currentEntry.orchestratorResponse
        && !currentEntry.speech
        && !currentEntry.eventStage
      ) {
        currentEntry = null;
        return;
      }
      entries.push(currentEntry);
      currentEntry = null;
    };

    for (const line of lines) {
      if (!line.trim()) continue;

      // 先用关键节点日志更新 request/session/debugRuntimeKey 上下文，后续 entry 会复用。
      if (line.includes("[game:orchestrator:key_nodes]")) {
        const payload = parseJsonFromLogLine(line);
        if (payload) {
          currentContext = {
            ...currentContext,
            requestId: readString(payload.requestId),
            sessionId: readString(payload.sessionId),
            debugRuntimeKey: readString(payload.debugRuntimeKey),
          };
        }
      }

      // “当前事件”是最稳定的一轮编排起点，看到它就开启一条新的摘要 entry。
      if (line.includes("[story:orchestrator:stats] | 当前事件 | ")) {
        pushCurrentEntry();
        const currentEventText = extractTableContent(line, "当前事件");
        currentEntry = applyContextToEntry({
          ...currentContext,
          currentEventIndex: extractField(currentEventText, "index"),
          currentEventSummary: extractField(currentEventText, "summary") || currentEventText,
          currentEventRaw: currentEventText,
        });
        continue;
      }

      if (line.includes("[story:orchestrator:stats] current_chapter=")) {
        const payload = parseJsonFromLogLine(line.replace("[story:orchestrator:stats] current_chapter=", ""));
        if (payload) {
          currentContext.chapterTitle = readString(payload.title);
          currentEntry = applyContextToEntry(currentEntry || { ...currentContext });
          if (currentEntry) {
            currentEntry.chapterTitle = currentContext.chapterTitle;
          }
        }
        continue;
      }

      if (!currentEntry) continue;

      if (line.includes("[story:orchestrator:stats] response_preview=")) {
        currentEntry.orchestratorResponse = extractAfter(line, "response_preview=");
        continue;
      }

      if (line.includes("[story:streamlines:stats] | 本轮动机 | ")) {
        currentEntry.motive = extractTableContent(line, "本轮动机");
        continue;
      }

      if (line.includes("[story:streamlines:stats] | 返回内容 | ")) {
        currentEntry.speech = extractTableContent(line, "返回内容");
        continue;
      }

      if (line.includes("[story:event_progress:runtime]")) {
        const payload = parseJsonFromLogLine(line);
        if (payload) {
          currentEntry.eventStage = [
            `event_status=${readString(payload.responseText).includes("\"event_status\": \"waiting_input\"") ? "waiting_input" : readString(payload.responseText).includes("\"event_status\": \"completed\"") ? "completed" : "active"}`,
            `ended=${readString(payload.responseText).includes("\"ended\": true") ? "true" : "false"}`,
            `progress_summary=${extractJsonTextField(readString(payload.responseText), "progress_summary")}`,
          ].join("，");
        }
        continue;
      }

      if (line.includes("[story:event_progress:stats] resolution=")) {
        currentEntry.eventProgressResolution = extractAfter(line, "resolution=");
        continue;
      }

      if (line.includes("[story:chapter_ending_check:runtime]")) {
        const payload = parseJsonFromLogLine(line);
        if (payload) {
          const responseText = readString(payload.responseText);
          currentContext.chapterTitle = extractJsonTextField(responseText, "chapter_title") || currentContext.chapterTitle || "";
          currentEntry.chapterTitle = currentContext.chapterTitle || currentEntry.chapterTitle;
          currentEntry.chapterJudge = [
            `result=${extractJsonTextField(responseText, "result")}`,
            `reason=${extractJsonTextField(responseText, "reason")}`,
            `guide_summary=${extractJsonTextField(responseText, "guide_summary")}`,
          ].join("，");
        }
        continue;
      }

      if (line.includes("[story:chapter_ending_check:stats] sessionStatus:")) {
        currentContext.sessionStatus = extractAfter(line, "sessionStatus:");
        currentEntry.sessionStatus = currentContext.sessionStatus;
      }

      if (line.includes("[story:chapter_ending_check:stats] outcome:")) {
        currentContext.outcome = extractAfter(line, "outcome:");
        currentEntry.outcome = currentContext.outcome;
      }

      if (line.includes("[story:chapter_ending_check:stats] nextChapterId:")) {
        currentContext.nextChapterId = extractAfter(line, "nextChapterId:");
        currentEntry.nextChapterId = currentContext.nextChapterId;
      }
    }

    pushCurrentEntry();

    const markdownLines = [
      "# 事件链分析摘要",
      "",
      ...entries.flatMap((entry) => {
        const summary = entry.currentEventSummary || "无";
        const currentEventIndex = entry.currentEventIndex || "0";
        const sessionLikeId = entry.sessionId || entry.debugRuntimeKey || entry.requestId || "未知";
        const chapterTitle = entry.chapterTitle || "未知";
        const linesForEntry = [
          `- 编排,current_event: ${currentEventIndex} ,${summary}`,
          `  - sesesion_id: ${sessionLikeId}`,
          `  - chapterTitle: ${chapterTitle}`,
        ];
        if (entry.orchestratorResponse) {
          linesForEntry.push(`  - 返回了，${entry.orchestratorResponse}`);
        }
        if (entry.motive) {
          linesForEntry.push(`  - 本轮动机，${entry.motive}`);
        }
        if (entry.speech) {
          linesForEntry.push(`  - 台词： ${entry.speech}`);
        }
        if (entry.eventStage) {
          linesForEntry.push(`  - 事件阶段：${entry.eventStage}`);
          if (entry.eventProgressResolution) {
            linesForEntry.push(`  - 事件进度处理结果：${entry.eventProgressResolution}`);
          }
        }
        if (entry.chapterJudge) {
          linesForEntry.push(`  - 章节判定：${entry.chapterJudge}`);
          linesForEntry.push(`  会话层面的状态：${entry.sessionStatus}`);
          linesForEntry.push(`  当前章节判定出来的结果：${entry.outcome}`);
          linesForEntry.push(`  nextChapterId：${entry.nextChapterId}`);
        }

        linesForEntry.push("");
        return linesForEntry;
      }),
    ];

    fs.mkdirSync(path.dirname(outputMarkdownPath), { recursive: true });
    fs.writeFileSync(outputMarkdownPath, markdownLines.join("\n").trim() + "\n", "utf8");
    return {
      outputPath: outputMarkdownPath,
      entryCount: entries.length,
    };
  }

  /**
   * 根据小游戏输入命中日志生成 markdown 摘要。
   *
   * 用途：
   * - 把 `story:mini_game:stats` 抽成可直接验收的简表；
   * - 方便定位聊天框输入到底命中了哪个动作、是否被拦截、结果标签是什么。
   */
  static generateMiniGameActionSummaryMarkdown(logFilePath: string, outputMarkdownPath: string): {
    outputPath: string;
    entryCount: number;
  } {
    const rawLog = fs.readFileSync(logFilePath, "utf8");
    const lines = rawLog.split(/\r?\n/);
    const entries: MiniGameActionSummaryEntry[] = [];

    // 逐行解析，遇到 action= 行后继续向后扫描同一 tag 的 token 统计行
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes("[story:mini_game:stats] action=")) continue;
      const payload = parseJsonFromLogLine(line.replace("[story:mini_game:stats] action=", ""));
      if (!payload) continue;
      const entry: MiniGameActionSummaryEntry = {
        gameType: readString(payload.gameType),
        phase: readString(payload.phase),
        status: readString(payload.status),
        input: readString(payload.input),
        normalizedInput: readString(payload.normalizedInput),
        controlAction: readString(payload.controlAction),
        actionId: readString(payload.actionId),
        battleActionId: readString(payload.battleActionId),
        resolverSource: readString(payload.resolverSource),
        resolverReason: readString(payload.resolverReason),
        resultTags: Array.isArray(payload.resultTags) ? payload.resultTags.map((item) => readString(item)).filter(Boolean) : [],
        intercepted: Boolean(payload.intercepted),
      };
      // 向后扫描紧跟的 token 统计行（最多看 10 行）
      for (let j = i + 1; j < Math.min(i + 11, lines.length); j++) {
        const nextLine = lines[j];
        if (!nextLine.includes("[story:mini_game:stats]")) break;
        // 解析 actual_input_tokens=xx actual_output_tokens=xx actual_reasoning_tokens=xx
        const tokenMatch = nextLine.match(/actual_input_tokens=(\d+)\s+actual_output_tokens=(\d+)\s+actual_reasoning_tokens=(\d+)/);
        if (tokenMatch) {
          entry.tokenUsage = {
            inputTokens: Number(tokenMatch[1]),
            outputTokens: Number(tokenMatch[2]),
            reasoningTokens: Number(tokenMatch[3]),
          };
        }
        // 解析 build_ms=xx invoke_ms=xx total_ms=xx
        const timingMatch = nextLine.match(/build_ms=(\d+)\s+invoke_ms=(\d+)\s+total_ms=(\d+)/);
        if (timingMatch) {
          entry.timing = {
            buildMs: Number(timingMatch[1]),
            invokeMs: Number(timingMatch[2]),
            totalMs: Number(timingMatch[3]),
          };
        }
      }
      entries.push(entry);
    }

    const markdownLines = [
      "# 小游戏输入命中摘要",
      "",
      ...entries.flatMap((entry, index) => {
        const baseLines = [
          `## ${index + 1}. ${entry.gameType || "未知小游戏"}`,
          "",
          `- 阶段：${entry.phase || "未知"}`,
          `- 状态：${entry.status || "未知"}`,
          `- 原始输入：${entry.input || "空"}`,
          `- 归一化输入：${entry.normalizedInput || "空"}`,
          `- 控制动作：${entry.controlAction || "无"}`,
          `- 命中动作：${entry.actionId || entry.battleActionId || "无"}`,
          `- 解析来源：${entry.resolverSource || "未知"}`,
          `- 解析原因：${entry.resolverReason || "空"}`,
          `- 结果标签：${entry.resultTags.length ? entry.resultTags.join("、") : "无"}`,
          `- 是否拦截：${entry.intercepted ? "是" : "否"}`,
        ];
        // 追加 token 统计信息
        if (entry.tokenUsage) {
          baseLines.push(
            `- 输入 Token：${entry.tokenUsage.inputTokens || 0}`,
            `- 输出 Token：${entry.tokenUsage.outputTokens || 0}`,
            `- 推理 Token：${entry.tokenUsage.reasoningTokens || 0}`,
          );
        }
        if (entry.timing) {
          baseLines.push(
            `- 构建耗时：${entry.timing.buildMs || 0} ms`,
            `- 调用耗时：${entry.timing.invokeMs || 0} ms`,
            `- 总耗时：${entry.timing.totalMs || 0} ms`,
          );
        }
        baseLines.push("");
        return baseLines;
      }),
    ];

    fs.mkdirSync(path.dirname(outputMarkdownPath), { recursive: true });
    fs.writeFileSync(outputMarkdownPath, markdownLines.join("\n").trim() + "\n", "utf8");
    return {
      outputPath: outputMarkdownPath,
      entryCount: entries.length,
    };
  }
}

type EventChainContext = {
  requestId?: string;
  sessionId?: string;
  debugRuntimeKey?: string;
  chapterTitle?: string;
  sessionStatus?: string;
  outcome?: string;
  nextChapterId?: string;
};

type EventChainSummaryEntry = EventChainContext & {
  chapterTitle?: string;
  currentEventIndex?: string;
  currentEventSummary?: string;
  currentEventRaw?: string;
  orchestratorResponse?: string;
  motive?: string;
  speech?: string;
  eventStage?: string;
  eventProgressResolution?: string;
  chapterJudge?: string;
  sessionStatus?: string;
  nextChapterId?: string;
  outcome?: string;
};

type MiniGameActionSummaryEntry = {
  gameType?: string;
  phase?: string;
  status?: string;
  input?: string;
  normalizedInput?: string;
  controlAction?: string;
  actionId?: string;
  battleActionId?: string;
  resolverSource?: string;
  resolverReason?: string;
  resultTags: string[];
  intercepted?: boolean;
  /** AI 意图解析的真实 token 消耗 */
  tokenUsage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } | null;
  /** AI 意图解析的耗时 */
  timing?: { buildMs?: number; invokeMs?: number; totalMs?: number } | null;
};

/**
 * 从整行日志中提取最后一个 JSON 对象。
 *
 * 说明：
 * - 日志前缀固定为 `[time] [LOG] [tag] `
 * - 真正的 JSON 一定从第一个 `{` 开始
 */
function parseJsonFromLogLine(line: string): Record<string, unknown> | null {
  const jsonStart = line.indexOf("{");
  if (jsonStart < 0) return null;
  try {
    return JSON.parse(line.slice(jsonStart)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 读取对象里的字符串值，统一做 trim。
 */
function readString(input: unknown): string {
  return String(input ?? "").trim();
}

/**
 * 从 `| 区块 | 内容 | 字符数 | tokens |` 这类日志表格里提取中间内容列。
 */
function extractTableContent(line: string, label: string): string {
  const pattern = new RegExp(`\\| ${escapeRegExp(label)} \\| (.*) \\| \\d+ \\|`);
  const matched = line.match(pattern);
  return matched?.[1]?.trim() || "";
}

/**
 * 从 `xxx=yyy` 这类日志尾部提取右侧内容。
 */
function extractAfter(line: string, marker: string): string {
  const index = line.indexOf(marker);
  if (index < 0) return "";
  return line.slice(index + marker.length).trim();
}

/**
 * 从 `index:1 ↩ summary:xxx` 这类拼接文本里抽取指定字段。
 */
function extractField(text: string, field: string): string {
  const segments = text.split("↩").map((item) => item.trim()).filter(Boolean);
  for (const segment of segments) {
    if (segment.startsWith(`${field}:`)) {
      return segment.slice(field.length + 1).trim();
    }
  }
  return "";
}

/**
 * 从 JSON 字符串文本里抽取一层字符串字段，避免为了日志摘要再做完整 schema 解析。
 */
function extractJsonTextField(rawJsonText: string, field: string): string {
  const matched = rawJsonText.match(new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*"([^"]*)"`, "m"));
  return matched?.[1]?.trim() || "";
}

/**
 * 转义正则特殊字符，避免日志 label 中含特殊字符导致匹配异常。
 */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
