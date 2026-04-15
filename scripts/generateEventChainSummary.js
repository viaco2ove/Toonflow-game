const fs = require("fs");
const path = require("path");

/**
 * 解析命令行参数，得到输入日志和输出 md 路径。
 */
function parseCliArgs(argv) {
  const directArgs = argv.filter((item) => !item.startsWith("--"));
  const inputArg = argv.find((item) => item.startsWith("--input=")) || directArgs[0] || "";
  const outputArg = argv.find((item) => item.startsWith("--output=")) || directArgs[1] || "";
  const inputPath = inputArg.startsWith("--input=") ? inputArg.slice("--input=".length) : inputArg;
  if (!inputPath) {
    throw new Error("缺少日志文件路径，示例：node scripts/generateEventChainSummary.js logs/app-2026-04-13.log");
  }
  const normalizedInputPath = path.resolve(inputPath);
  const defaultOutputPath = path.resolve(
    "logs/event_log",
    `${path.basename(inputPath, path.extname(inputPath))}.event_chain.summary.md`,
  );
  const outputPath = outputArg
    ? path.resolve(outputArg.startsWith("--output=") ? outputArg.slice("--output=".length) : outputArg)
    : defaultOutputPath;
  return {
    inputPath: normalizedInputPath,
    outputPath,
  };
}

/**
 * 从整行日志中提取最后一个 JSON 对象。
 */
function parseJsonFromLogLine(line) {
  const jsonStart = line.indexOf("{");
  if (jsonStart < 0) return null;
  try {
    return JSON.parse(line.slice(jsonStart));
  } catch {
    return null;
  }
}

/**
 * 统一读取字符串值。
 */
function readString(input) {
  return String(input ?? "").trim();
}

/**
 * 从表格日志里提取中间内容列。
 */
function extractTableContent(line, label) {
  const pattern = new RegExp(`\\| ${escapeRegExp(label)} \\| (.*) \\| \\d+ \\|`);
  const matched = line.match(pattern);
  return matched && matched[1] ? matched[1].trim() : "";
}

/**
 * 从 `xxx=yyy` 格式里提取尾部值。
 */
function extractAfter(line, marker) {
  const index = line.indexOf(marker);
  if (index < 0) return "";
  return line.slice(index + marker.length).trim();
}

/**
 * 从 `index:1 ↩ summary:xxx` 拼接文本里提取字段。
 */
function extractField(text, field) {
  return text
    .split("↩")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${field}:`))
    ?.slice(field.length + 1)
    .trim() || "";
}

/**
 * 从 JSON 字符串里抽取简单文本字段。
 */
function extractJsonTextField(rawJsonText, field) {
  const matched = rawJsonText.match(new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*"([^"]*)"`, "m"));
  return matched && matched[1] ? matched[1].trim() : "";
}

/**
 * 转义正则特殊字符，避免日志字段名导致匹配异常。
 */
function escapeRegExp(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 直接从日志文本生成事件链摘要 markdown。
 */
function generateEventChainSummaryMarkdown(logFilePath, outputMarkdownPath) {
  const rawLog = fs.readFileSync(logFilePath, "utf8");
  const lines = rawLog.split(/\r?\n/);
  const entries = [];
  let currentEntry = null;
  let currentContext = {};

  /**
   * 把当前上下文灌进 entry。
   *
   * 用途：
   * - 章节、会话状态、下一章等日志常常不会和“当前事件”出现在同一行；
   * - 如果不做上下文继承，摘要里就会出现大量“未知”。
   */
  const applyContextToEntry = (entry) => {
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
   * 有实际内容的条目才写入结果。
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
    if (line.includes("[story:orchestrator:stats] | 当前事件 | ")) {
      pushCurrentEntry();
      const currentEventText = extractTableContent(line, "当前事件");
      currentEntry = applyContextToEntry({
        ...currentContext,
        currentEventIndex: extractField(currentEventText, "index"),
        currentEventSummary: extractField(currentEventText, "summary") || currentEventText,
      });
      continue;
    }
    if (line.includes("[story:orchestrator:stats] current_chapter=")) {
      const payload = parseJsonFromLogLine(line.replace("[story:orchestrator:stats] current_chapter=", ""));
      if (payload) {
        currentContext.chapterTitle = readString(payload.title);
        currentEntry = applyContextToEntry(currentEntry || { ...currentContext });
        currentEntry.chapterTitle = currentContext.chapterTitle;
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
        const responseText = readString(payload.responseText);
        currentEntry.eventStage = [
          `event_status=${responseText.includes("\"event_status\": \"waiting_input\"") ? "waiting_input" : responseText.includes("\"event_status\": \"completed\"") ? "completed" : "active"}`,
          `ended=${responseText.includes("\"ended\": true") ? "true" : "false"}`,
          `progress_summary=${extractJsonTextField(responseText, "progress_summary")}`,
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
      continue;
    }
    if (line.includes("[story:chapter_ending_check:stats] outcome:")) {
      currentContext.outcome = extractAfter(line, "outcome:");
      currentEntry.outcome = currentContext.outcome;
      continue;
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
      if (entry.orchestratorResponse) linesForEntry.push(`  - 返回了，${entry.orchestratorResponse}`);
      if (entry.motive) linesForEntry.push(`  - 本轮动机，${entry.motive}`);
      if (entry.speech) linesForEntry.push(`  - 台词： ${entry.speech}`);
      if (entry.eventStage) {
        linesForEntry.push(`  - 事件阶段：${entry.eventStage}`);
        if (entry.eventProgressResolution) {
          linesForEntry.push(`  - 事件进度处理结果：${entry.eventProgressResolution}`);
        }
      }
      if (entry.chapterJudge) {
        linesForEntry.push(`  - 章节判定：${entry.chapterJudge}`);
        linesForEntry.push(`  sessionStatus：${entry.sessionStatus || ""}`);
        linesForEntry.push(`  nextChapterId：${entry.nextChapterId || ""}`);
      }
      linesForEntry.push("");
      return linesForEntry;
    }),
  ];

  fs.mkdirSync(path.dirname(outputMarkdownPath), { recursive: true });
  fs.writeFileSync(outputMarkdownPath, `${markdownLines.join("\n").trim()}\n`, "utf8");
  return {
    outputPath: outputMarkdownPath,
    entryCount: entries.length,
  };
}

/**
 * 脚本主入口。
 */
function main() {
  const { inputPath, outputPath } = parseCliArgs(process.argv.slice(2));
  const result = generateEventChainSummaryMarkdown(inputPath, outputPath);
  console.log(`[debug:event-chain] input=${inputPath}`);
  console.log(`[debug:event-chain] output=${result.outputPath}`);
  console.log(`[debug:event-chain] entries=${result.entryCount}`);
}

main();
