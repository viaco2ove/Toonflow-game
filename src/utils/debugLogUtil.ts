import fs from "fs";
import path from "path";

/**
 * 调试日志工具。
 *
 * 用途：
 * - 统一管理 `LOG_LEVEL=DEBUG` 的开关判断；
 * - 避免各个运行时类重复实现相同逻辑，导致后续行为不一致。
 */
export class DebugLogUtil {
  /**
   * 判断当前进程是否开启 DEBUG 级别日志。
   */
  static isDebugLogEnabled(): boolean {
    return String(process.env.LOG_LEVEL || "").trim().toUpperCase() === "DEBUG";
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
        currentEntry = {
          ...currentContext,
          currentEventIndex: extractField(currentEventText, "index"),
          currentEventSummary: extractField(currentEventText, "summary") || currentEventText,
          currentEventRaw: currentEventText,
        };
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

      if (line.includes("[story:chapter_ending_check:runtime]")) {
        const payload = parseJsonFromLogLine(line);
        if (payload) {
          const responseText = readString(payload.responseText);
          currentEntry.chapterJudge = [
            `result=${extractJsonTextField(responseText, "result")}`,
            `reason=${extractJsonTextField(responseText, "reason")}`,
            `guide_summary=${extractJsonTextField(responseText, "guide_summary")}`,
          ].join("，");
        }
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
        const linesForEntry = [
          `- 编排,current_event: ${currentEventIndex} ,${summary}`,
          `  - sesesion_id: ${sessionLikeId}`,
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
        }
        if (entry.chapterJudge) {
          linesForEntry.push(`  - 章节判定：${entry.chapterJudge}`);
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
}

type EventChainContext = {
  requestId?: string;
  sessionId?: string;
  debugRuntimeKey?: string;
};

type EventChainSummaryEntry = EventChainContext & {
  currentEventIndex?: string;
  currentEventSummary?: string;
  currentEventRaw?: string;
  orchestratorResponse?: string;
  motive?: string;
  speech?: string;
  eventStage?: string;
  chapterJudge?: string;
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
