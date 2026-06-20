/**
 * 任务模式日志摘要生成脚本
 *
 * 用法：
 *   yarn debug:mini-game:task logs/app-2026-06-17.log
 *   node scripts/generateMiniGameTaskSummary.js logs/app-2026-06-17.log
 *
 * 支持：
 *   yarn debug:mini-game:task logs/app-2026-06-17.log --output=out.md
 */
const fs = require("fs");
const path = require("path");

// ============================================================================
// 任务模式日志标签定义
// ============================================================================

/**
 * 任务模式 log tag 列表及说明
 * 每个 tag 对应一个提取器，返回该行中包含的元信息
 */
const TASK_LOG_TAGS = {
  // 入口 / 会话状态
  "task:addMessage:entry": {
    label: "addMessage 入口",
    desc: "用户消息进入时的任务状态",
    extract: (line) => {
      const m = line.match(/activeTaskId["\s:]+([^,\s}]+)/);
      const m2 = line.match(/miniGameSessionStatus["\s:]+([^,\s}]+)/);
      const m3 = line.match(/miniGameGameType["\s:]+([^,\s}]+)/);
      return {
        activeTaskId: m ? m[1] : null,
        miniGameSessionStatus: m2 ? m2[1] : null,
        miniGameGameType: m3 ? m3[1] : null,
      };
    },
  },

  // 任务创建
  "task:created": {
    label: "任务已创建",
    desc: "applyFreeChapterTaskBlueprintToState 写入任务",
    extract: (line) => {
      const m = line.match(/taskId["\s:]+([^,\s}]+)/);
      const m2 = line.match(/activeTaskId["\s:]+([^,\s}]+)/);
      const m3 = line.match(/executingTask["\s:]+([^,\s}]+)/);
      return {
        taskId: m ? m[1] : null,
        activeTaskId: m2 ? m2[1] : null,
        executingTaskTitle: m3 ? m3[1] : null,
      };
    },
  },

  // minigame intercept
  "task:minigame:intercept": {
    label: "小游戏拦截路径",
    desc: "handleMiniGameTurn 拦截了请求",
    extract: (line) => {
      const m = line.match(/activeTaskId["\s:]+([^,\s}]+)/);
      const m2 = line.match(/executingTaskTitle["\s:]+([^,\s}]+)/);
      const m3 = line.match(/miniGameSessionStatus["\s:]+([^,\s}]+)/);
      const m4 = line.match(/miniGameGameType["\s:]+([^,\s}]+)/);
      return {
        activeTaskId: m ? m[1] : null,
        executingTaskTitle: m2 ? m2[1] : null,
        miniGameSessionStatus: m3 ? m3[1] : null,
        miniGameGameType: m4 ? m4[1] : null,
      };
    },
  },

  // 编排入口
  "task:orchestration:entry": {
    label: "编排入口",
    desc: "tryBuildTaskModePlan 开始执行",
    extract: (line) => {
      const m = line.match(/activeTaskId["\s:]+([^,\s}]+)/);
      const m2 = line.match(/miniGameTaskActive["\s:]+([^,\s}]+)/);
      const m3 = line.match(/varsTaskActive["\s:]+([^,\s}]+)/);
      const m4 = line.match(/taskModeActive["\s:]+([^,\s}]+)/);
      return {
        activeTaskId: m ? m[1] : null,
        miniGameTaskActive: m2 ? m2[1] : null,
        varsTaskActive: m3 ? m3[1] : null,
        taskModeActive: m4 ? m4[1] : null,
      };
    },
  },

  // 编排返回
  "task:orchestration:result": {
    label: "编排返回",
    desc: "tryBuildTaskModePlan 返回结果",
    extract: (line) => {
      const m = line.match(/hasTaskPlan["\s:]+([^,\s}]+)/);
      const m2 = line.match(/taskPlanRole["\s:]+([^,\s}]+)/);
      const m3 = line.match(/taskPlanRoleType["\s:]+([^,\s}]+)/);
      const m4 = line.match(/taskPlanSpeakerReason["\s:]+([^,\s}]+)/);
      return {
        hasTaskPlan: m ? m[1] : null,
        taskPlanRole: m2 ? m2[1] : null,
        taskPlanRoleType: m3 ? m3[1] : null,
        taskPlanSpeakerReason: m4 ? m4[1] : null,
      };
    },
  },

  // Intent Agent
  "task:intent": {
    label: "Intent Agent",
    desc: "任务意图分析结果",
    extract: (line) => {
      // 格式1: [task-mode-plan] Intent: task_inquiry 0.92
      const m1 = line.match(/Intent:\s*(\w+)[\s\t ]+([\d.]+)/);
      if (m1) return { intent: m1[1], confidence: m1[2] };
      // 格式2: intent:"xxx", confidence:0.92
      const m2 = line.match(/intent["\s:]+([^,\s}]+)[\s\S]*?confidence["\s:]+([^,\s}]+)/);
      if (m2) return { intent: m2[1], confidence: m2[2] };
      return {};
    },
  },

  // Progress Agent
  "task:progress": {
    label: "Progress Agent",
    desc: "任务推进判定结果",
    extract: (line) => {
      // 格式1: [task-mode-plan] Progress: normal / keyword / {...} | process: xxx → yyy
      // 提取 level
      const levelMatch = line.match(/Progress:\s*(\w+)[\/ ]/);
      // 提取 tier
      const tierMatch = line.match(/\/ ([\w]+)[\/ ]/);
      // 提取 JSON（从 / 后的 { 开始到 | process: 之前）
      const puMatch = line.match(/ \/ (\{[^|]+)\| process:/);
      // 提取 process 字段
      const processMatch = line.match(/\| process:\s*(.+)$/);
      // 格式2: level:"xxx", tier:"xxx" (JSON 格式)
      const levelMatch2 = line.match(/level["\s:]+([^,\s}]+)/);
      const tierMatch2 = line.match(/tier["\s:]+([^,\s}]+)/);
      const puMatch2 = line.match(/processUpdate["\s:]+(\{[\s\S]*?\})/);
      return {
        level: levelMatch ? levelMatch[1] : (levelMatch2 ? levelMatch2[1] : null),
        tier: tierMatch ? tierMatch[1] : (tierMatch2 ? tierMatch2[1] : null),
        processUpdate: puMatch ? puMatch[1].replace(/}\s*$/, "}").trim() : (puMatch2 ? puMatch2[1] : null),
        process: processMatch ? processMatch[1].trim() : null,
      };
    },
  },

  // Director Agent
  "task:director": {
    label: "Director Agent",
    desc: "任务剧情编排结果",
    extract: (line) => {
      // 格式1: Director: 任务系统 / status | motive: xxx | direction: xxx | speakerRole: xxx
      const m1 = line.match(/Director:\s*([^/]+)\s*\/\s*(\w+)\s*\|\s*motive:\s*([^|]+)(?:\| direction:\s*([^|]+))?(?:\| speakerRole:\s*([^|]+))?/);
      if (m1) return { speaker: m1[1].trim(), taskType: m1[2], motive: m1[3]?.trim(), direction: m1[4]?.trim(), speakerRole: m1[5]?.trim() };
      // 格式2: Director: 任务系统 / status
      const m2 = line.match(/Director:\s*([^/]+)\s*\/\s*(\w+)/);
      if (m2) return { speaker: m2[1].trim(), taskType: m2[2] };
      // 格式3: JSON 格式
      const m = line.match(/speaker["\s:]+([^,\s}]+)/);
      const m3 = line.match(/speakerRole["\s:]+([^,\s}]+)/);
      const m4 = line.match(/motive["\s:]+([^,\s}]+)/);
      const m5 = line.match(/taskType["\s:]+([^,\s}]+)/);
      const m6 = line.match(/direction["\s:]+([^,\s}]+)/);
      return {
        speaker: m ? m[1] : null,
        speakerRole: m3 ? m3[1] : null,
        motive: m4 ? m4[1] : null,
        taskType: m5 ? m5[1] : null,
        direction: m6 ? m6[1] : null,
      };
    },
  },

  // Speaker Agent / streamlines
  "task:speaker": {
    label: "Speaker / Streamlines",
    desc: "任务角色发言",
    extract: (line) => {
      // 格式1: [story:streamlines:debug] 剧情模式 - role: xxx, contentPreview: xxx
      const m1 = line.match(/role:\s*([^,]+),\s*eventType:\s*([^,]+),\s*contentPreview:\s*(.+)/);
      if (m1) return { role: m1[1].trim(), eventType: m1[2].trim(), contentPreview: m1[3].slice(0, 100) };
      // 格式2: JSON 格式
      const m = line.match(/modelKey["\s:]+([^,\s}]+)/);
      const m2 = line.match(/isTaskModePlan["\s:]+([^,\s}]+)/);
      const m3 = line.match(/speakerRouteReason["\s:]+([^,\s}]+)/);
      const m4 = line.match(/speakerMode["\s:]+([^,\s}]+)/);
      // 如果有 modelKey 但不是 task 相关，说明走了主线 speaker
      const isMainSpeaker = m && m[1] && !String(m[1]).includes("task");
      return {
        modelKey: m ? m[1] : null,
        isTaskModePlan: m2 ? m2[1] : null,
        speakerRouteReason: m3 ? m3[1] : null,
        speakerMode: m4 ? m4[1] : null,
        isMainSpeaker: isMainSpeaker || false,
      };
    },
  },

  // Completion Agent
  "task:completion": {
    label: "Completion Agent",
    desc: "任务完成评估",
    extract: (line) => {
      const m = line.match(/result["\s:]+([^,\s}]+)/);
      const m2 = line.match(/status["\s:]+([^,\s}]+)/);
      const m3 = line.match(/finalStatus["\s:]+([^,\s}]+)/);
      return {
        result: m ? m[1] : null,
        status: m2 ? m2[1] : null,
        finalStatus: m3 ? m3[1] : null,
      };
    },
  },

  // Revisit / 回溯
  "task:revisit": {
    label: "回溯",
    desc: "用户回溯操作",
    extract: (line) => {
      const m = line.match(/revisitType["\s:]+([^,\s}]+)/);
      const m2 = line.match(/messageId["\s:]+([^,\s}]+)/);
      const m3 = line.match(/revisitRoleType["\s:]+([^,\s}]+)/);
      const m4 = line.match(/revisitedContent["\s:]+([^,\s}]+)/);
      return {
        revisitType: m ? m[1] : null,
        messageId: m2 ? m2[1] : null,
        revisitRoleType: m3 ? m3[1] : null,
        revisitedContent: m4 ? m4[1] : null,
      };
    },
  },

  // Memory patch
  "task:memory:patch": {
    label: "记忆补丁",
    desc: "内存更新写入 player.parameterCardJson",
    extract: (line) => {
      const m = line.match(/preservedTaskFields["\s:]+(\{[\s\S]*?\})/);
      return m ? { preservedTaskFields: m[1] } : {};
    },
  },
};

// ============================================================================
// 解析工具
// ============================================================================

function parseCliArgs(argv) {
  const inputArg = argv.find((item) => item.startsWith("--input=")) || argv.find((item) => !item.startsWith("--"));
  const outputArg = argv.find((item) => item.startsWith("--output="));
  const inputPath = inputArg?.startsWith("--input=")
    ? inputArg.slice("--input=".length)
    : inputArg;
  if (!inputPath) {
    throw new Error(
      "缺少日志文件路径，示例：node scripts/generateMiniGameTaskSummary.js logs/app-2026-06-17.log\n" +
        "或：yarn debug:mini-game:task logs/app-2026-06-17.log",
    );
  }
  const normalizedInputPath = path.resolve(inputPath);
  const defaultOutputPath = path.resolve(
    "logs/event_log",
    `${path.basename(inputPath, path.extname(inputPath))}.task.summary.md`,
  );
  const outputPath = outputArg
    ? path.resolve(
        outputArg.startsWith("--output=") ? outputArg.slice("--output=".length) : outputArg,
      )
    : defaultOutputPath;
  return { inputPath: normalizedInputPath, outputPath };
}

function extractSessionId(line) {
  const match = line.match(/sessionId["\s:]+([\w_]+)/);
  return match ? match[1] : null;
}

function extractTimestamp(line) {
  const match = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]/);
  return match ? match[1] : "";
}

function extractNewDialogue(line) {
  // 格式1: | 新增对话 | [...] | (旧格式)
  const match1 = line.match(/\|\s*新增对话\s*\|\s*(\[[\s\S]*?\])\s*\|/);
  if (match1) {
    let jsonStr = match1[1].replace(/↩/g, " ").replace(/\s+/g, " ").trim();
    try {
      const dialogues = JSON.parse(jsonStr);
      if (Array.isArray(dialogues) && dialogues.length > 0) return dialogues;
    } catch (e) {}
  }
  // 格式2: [新增对话(JSON数组)]\n[...]\n\n (多行格式)
  if (line.includes("[新增对话(JSON数组)]") || line.includes("新增对话(JSON数组)")) {
    // 尝试从后续行获取完整 JSON（多行情况）
    // 在主循环中会继续处理后续行，这里只做标记
    return null; // 由多行处理逻辑处理
  }
  return null;
}

// 多行对话提取器 - 用于处理跨行的 JSON 数组
function parseMultiLineDialogue(lines, startIndex) {
  const result = [];
  // 跳过标题行，从 [ 开始收集
  let jsonLines = [];
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "]" || line.startsWith("]") || line === "" || line.startsWith("[任务]") || line.startsWith("[输出格式")) {
      // JSON 结束
      break;
    }
    jsonLines.push(line);
  }
  if (jsonLines.length > 0) {
    const jsonStr = jsonLines.join("").replace(/↩/g, " ");
    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return { dialogues: parsed, endIndex: startIndex + jsonLines.length };
      }
    } catch (e) {
      // 尝试逐个解析
      try {
        const parsed = JSON.parse("[" + jsonLines.join(",") + "]");
        if (Array.isArray(parsed) && parsed.length > 0) {
          return { dialogues: parsed, endIndex: startIndex + jsonLines.length };
        }
      } catch (e2) {}
    }
  }
  return null;
}

// ============================================================================
// 任务模式识别：检测某行是否属于任务模式相关日志
// ============================================================================

const TASK_MODE_TAG_PREFIXES = [
  "[story:mini_game:task]",
  "[task-mode-plan]",
  "[story:orchestrator:runtime]",
  "[story:orchestrator:minigame]",
  "[story:streamlines:runtime]",
  "[story:streamlines:debug]",
  "[story:revisit",
  "[task:",
];

function isTaskModeLogLine(line) {
  return TASK_MODE_TAG_PREFIXES.some((prefix) => line.includes(prefix));
}

function detectLogTag(line) {
  for (const [tag, config] of Object.entries(TASK_LOG_TAGS)) {
    if (line.includes(`[${tag}]`)) {
      return { tag, ...config };
    }
  }
  // 通用任务标签匹配
  for (const prefix of TASK_MODE_TAG_PREFIXES) {
    if (line.includes(prefix)) {
      return { tag: "task:other", label: "其他任务日志", desc: "" };
    }
  }
  return null;
}

// ============================================================================
// 主解析逻辑
// ============================================================================

function parseTaskModeLogs(lines) {
  const sessions = new Map();
  let currentSession = null;
  let currentTimestamp = "";
  let dialogueBuffer = null; // 多行对话缓冲

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const rawLine = lines[lineIndex];
    const line = rawLine.trim();
    if (!line) continue;

    const ts = extractTimestamp(line);
    if (ts) currentTimestamp = ts;

    const sid = extractSessionId(line);
    if (sid) {
      currentSession = sid;
      if (!sessions.has(sid)) {
        sessions.set(sid, {
          logEntries: [],
          dialogues: [],
          taskCreation: null,
          orchestrationEntries: [],
          speakerEntries: [],
          intentEntries: [],
          progressEntries: [],
          directorEntries: [],
          completionEntries: [],
          revisitEntries: [],
          memoryPatchEntries: [],
        });
      }
    }

    // 提取对话（多行格式处理）- 不依赖 isTaskModeLogLine，因为对话行可能不在任务标签列表中
    // 精确匹配纯标题行（不含 [LOG] 前缀）
    if (rawLine.trim() === "[新增对话(JSON数组)]") {
      const dialogueBuffer = [];
      for (let j = lineIndex + 1; j < lines.length && j < lineIndex + 50; j++) {
        const nextLine = lines[j].trim();
        // 遇到空行或任务标记就停止
        if (nextLine === "" || nextLine.startsWith("[任务]") || nextLine.startsWith("[输出格式") || nextLine.startsWith("已生成台词")) {
          break;
        }
        // 收集所有内容
        dialogueBuffer.push(nextLine);
        // 检测到结束标记
        if (nextLine === "]" || nextLine.startsWith("],")) {
          break;
        }
      }
      // 解析对话
      const dialogueSession = sessions.get(currentSession);
      if (dialogueBuffer.length > 0 && dialogueSession) {
        // 直接拼接（buffer 已经是完整 JSON 数组内容：[{...}, {...}...]）
        const jsonStr = dialogueBuffer.join("").replace(/↩/g, " ");
        try {
          const dialogues = JSON.parse(jsonStr);
          if (Array.isArray(dialogues) && dialogues.length > 0) {
            dialogueSession.dialogues.push(...dialogues);
          }
        } catch (e) {
          // 解析失败，跳过
        }
      }
      // 对话行继续往下走，可能会被 isTaskModeLogLine 过滤，但对话已提取
    }

    if (!currentSession || !isTaskModeLogLine(line)) continue;

    const tagInfo = detectLogTag(line);
    const tagName = tagInfo ? tagInfo.tag : "task:other";

    const entry = {
      timestamp: currentTimestamp,
      tag: tagName,
      line: rawLine,
    };

    const session = sessions.get(currentSession);
    if (!session) continue;

    // 任务创建
    if (tagName === "task:created" || line.includes("[story:mini_game:task] applyFreeChapterTaskBlueprintToState")) {
      const extract = TASK_LOG_TAGS["task:created"]?.extract(line) || {};
      session.taskCreation = { timestamp: currentTimestamp, ...extract, raw: line };
      session.logEntries.push(entry);
    }
    // addMessage 入口
    else if (tagName === "task:addMessage:entry" || line.includes("[story:mini_game:task] addMessage 入口")) {
      session.addMessageEntry = session.addMessageEntry || [];
      const extract = TASK_LOG_TAGS["task:addMessage:entry"]?.extract(line) || {};
      session.addMessageEntry.push({ timestamp: currentTimestamp, ...extract, raw: line });
      session.logEntries.push(entry);
    }
    // 编排入口
    else if (tagName === "task:orchestration:entry" || line.includes("[task-mode-plan] tryBuildTaskModePlan 入口")) {
      const extract = TASK_LOG_TAGS["task:orchestration:entry"]?.extract(line) || {};
      session.orchestrationEntries.push({ timestamp: currentTimestamp, ...extract, raw: line });
      session.logEntries.push(entry);
    }
    // 编排返回
    else if (tagName === "task:orchestration:result" || line.includes("[story:orchestrator:runtime] tryBuildTaskModePlan 返回")) {
      const extract = TASK_LOG_TAGS["task:orchestration:result"]?.extract(line) || {};
      session.orchestrationResult = { timestamp: currentTimestamp, ...extract, raw: line };
      session.logEntries.push(entry);
    }
    // Intent
    else if (tagName === "task:intent" || line.includes("[task-mode-plan] Intent:")) {
      const extract = TASK_LOG_TAGS["task:intent"]?.extract(line) || {};
      session.intentEntries.push({ timestamp: currentTimestamp, ...extract, raw: line });
      session.logEntries.push(entry);
    }
    // Progress
    else if (tagName === "task:progress" || line.includes("[task-mode-plan] Progress:")) {
      const extract = TASK_LOG_TAGS["task:progress"]?.extract(line) || {};
      session.progressEntries.push({ timestamp: currentTimestamp, ...extract, raw: line });
      session.logEntries.push(entry);
    }
    // Director
    else if (tagName === "task:director" || line.includes("[task-mode-plan] Director:")) {
      const extract = TASK_LOG_TAGS["task:director"]?.extract(line) || {};
      session.directorEntries.push({ timestamp: currentTimestamp, ...extract, raw: line });
      session.logEntries.push(entry);
    }
    // Speaker / streamlines
    else if (tagName === "task:speaker" || line.includes("[story:streamlines:runtime]") || line.includes("[story:streamlines:debug]")) {
      const extract = TASK_LOG_TAGS["task:speaker"]?.extract(line) || {};
      session.speakerEntries.push({ timestamp: currentTimestamp, ...extract, raw: line });
      session.logEntries.push(entry);
    }
    // Completion
    else if (tagName === "task:completion" || line.includes("[task-mode-plan] Completion:")) {
      const extract = TASK_LOG_TAGS["task:completion"]?.extract(line) || {};
      session.completionEntries.push({ timestamp: currentTimestamp, ...extract, raw: line });
      session.logEntries.push(entry);
    }
    // Revisit
    else if (tagName === "task:revisit" || line.includes("[story:revisit") || line.includes("revisitMessage")) {
      const extract = TASK_LOG_TAGS["task:revisit"]?.extract(line) || {};
      // 额外提取回溯类型
      if (line.includes("用户消息回溯")) extract.revisitKind = "用户消息回溯";
      else if (line.includes("旁白消息回溯")) extract.revisitKind = "旁白消息回溯";
      if (line.includes("执行回溯删除")) extract.action = "执行回溯删除";
      if (line.includes("回溯到这句话之前")) extract.action = "回溯到这句话之前";
      if (line.includes("可继续编排")) extract.action = "可继续编排";
      session.revisitEntries.push({ timestamp: currentTimestamp, ...extract, raw: line });
      session.logEntries.push(entry);
    }
    // Memory patch
    else if (tagName === "task:memory:patch" || line.includes("applyMemoryPlayerCardPatchToState")) {
      const extract = TASK_LOG_TAGS["task:memory:patch"]?.extract(line) || {};
      session.memoryPatchEntries.push({ timestamp: currentTimestamp, ...extract, raw: line });
      session.logEntries.push(entry);
    }
    // 其他任务日志
    else {
      session.logEntries.push(entry);
    }
  }

  return sessions;
}

// ============================================================================
// Markdown 生成
// ============================================================================

function generateMarkdown(sessions, logFilePath) {
  const lines = [];

  lines.push("# 任务模式日志摘要");
  lines.push("");
  lines.push(`生成时间: ${new Date().toISOString()}`);
  lines.push(`日志文件: ${logFilePath}`);
  lines.push("");

  // 图例
  lines.push("## 图例：Log Tag → 含义");
  lines.push("");
  lines.push("| Tag | 含义 |");
  lines.push("|-----|-----|");
  for (const [tag, config] of Object.entries(TASK_LOG_TAGS)) {
    lines.push(`| \`[${tag}]\` | ${config.desc} |`);
  }
  lines.push("");

  // 如果没有任务日志
  if (sessions.size === 0) {
    lines.push("---");
    lines.push("");
    lines.push("**未检测到任务模式日志**");
    lines.push("");
    lines.push("请确认日志文件中包含以下标签：");
    for (const prefix of TASK_MODE_TAG_PREFIXES) {
      lines.push(`- ${prefix}`);
    }
    lines.push("");
    return lines.join("\n");
  }

  lines.push("---");
  lines.push("");

  // 按 session 遍历
  for (const [sessionId, session] of sessions) {
    lines.push(`## 会话: \`${sessionId}\``);
    lines.push("");

    // 会话健康检查摘要
    {
      const revisitCount = session.revisitEntries.length;
      const addMsgEntries = session.addMessageEntry || [];
      const stateLossCount = addMsgEntries.filter(
        (e) => !e.activeTaskId || e.activeTaskId === "null" || e.activeTaskId === "undefined",
      ).length;
      const mainSpeakerCount = session.speakerEntries.filter((e) => e.isMainSpeaker).length;
      const taskPlanCount = session.orchestrationEntries.length;
      lines.push("### 会话健康检查");
      lines.push("");
      lines.push(`| 指标 | 数值 | 状态 |`);
      lines.push(`|-----|------|------|`);
      lines.push(`| 回溯次数 | ${revisitCount} | ${revisitCount > 0 ? "⚠️ 有回溯" : "✅ 无回溯"} |`);
      lines.push(`| 状态丢失次数 | ${stateLossCount}/${addMsgEntries.length} | ${stateLossCount > 0 ? "⚠️ 存在丢失" : "✅ 状态完好"} |`);
      lines.push(`| 走主线 Speaker | ${mainSpeakerCount}/${session.speakerEntries.length} | ${mainSpeakerCount > 0 ? "⚠️ 路由错误" : "✅ 任务路由"} |`);
      lines.push(`| 任务编排次数 | ${taskPlanCount} | ${taskPlanCount > 0 ? "✅ 正常编排" : "⚠️ 未编排"} |`);
      lines.push("");
    }

    // ----------------------------------------------------------------
    // 1. 任务创建
    // ----------------------------------------------------------------
    if (session.taskCreation) {
      const tc = session.taskCreation;
      lines.push("### 任务创建");
      lines.push("");
      lines.push(`- 时间: ${tc.timestamp}`);
      lines.push(`- 任务ID: \`${tc.taskId || "未知"}\``);
      lines.push(`- ActiveTaskId: \`${tc.activeTaskId || "未知"}\``);
      lines.push(`- 任务标题: **${tc.executingTaskTitle || "未知"}**`);
      lines.push("");
    }

    // ----------------------------------------------------------------
    // 2. addMessage 入口状态
    // ----------------------------------------------------------------
    if (session.addMessageEntry && session.addMessageEntry.length > 0) {
      lines.push("### addMessage 入口状态");
      lines.push("");
      lines.push("| # | 时间 | activeTaskId | miniGameSessionStatus | miniGameGameType |");
      lines.push("|---|------|-------------|----------------------|------------------|");
      session.addMessageEntry.forEach((entry, i) => {
        lines.push(
          `| ${i + 1} | ${entry.timestamp} | \`${entry.activeTaskId || ""}\` | ${entry.miniGameSessionStatus || ""} | ${entry.miniGameGameType || ""} |`,
        );
      });
      lines.push("");
      // 警告：如果状态丢失
      const hasStateLoss = session.addMessageEntry.some(
        (e) => !e.activeTaskId || e.activeTaskId === "null",
      );
      if (hasStateLoss) {
        lines.push("> ⚠️ **状态丢失警告**：检测到 activeTaskId 为空，任务模式可能被错误跳过");
        lines.push("");
      }
    }

    // ----------------------------------------------------------------
    // 3. 编排链路
    // ----------------------------------------------------------------
    if (session.orchestrationEntries.length > 0 || session.orchestrationResult) {
      lines.push("### 编排链路（Intent → Progress → Director）");
      lines.push("");

      // 3a. 编排入口
      if (session.orchestrationEntries.length > 0) {
        lines.push("#### 编排入口 (`tryBuildTaskModePlan`)");
        lines.push("");
        lines.push("| # | 时间 | activeTaskId | miniGameTaskActive | varsTaskActive | taskModeActive |");
        lines.push("|---|------|-------------|-------------------|----------------|----------------|");
        session.orchestrationEntries.forEach((entry, i) => {
          lines.push(
            `| ${i + 1} | ${entry.timestamp} | \`${entry.activeTaskId || ""}\` | ${entry.miniGameTaskActive || ""} | ${entry.varsTaskActive || ""} | ${entry.taskModeActive || ""} |`,
          );
        });
        lines.push("");
      }

      // 3b. Intent
      if (session.intentEntries.length > 0) {
        lines.push("#### Intent Agent");
        lines.push("");
        session.intentEntries.forEach((entry, i) => {
          lines.push(`**回合 ${i + 1}** (${entry.timestamp})`);
          lines.push(`- 意图: \`${entry.intent || "未知"}\``);
          lines.push(`- 置信度: ${entry.confidence || "未知"}`);
          lines.push("");
        });
      }

      // 3c. Progress
      if (session.progressEntries.length > 0) {
        lines.push("#### Progress Agent");
        lines.push("");
        session.progressEntries.forEach((entry, i) => {
          lines.push(`**回合 ${i + 1}** (${entry.timestamp})`);
          lines.push(`- 推进等级: \`${entry.level || "未知"}\``);
          lines.push(`- 分层: ${entry.tier || "未知"}`);
          lines.push(`- 需澄清: ${entry.needClarify || "未知"}`);
          if (entry.processUpdate) {
            lines.push(`- processUpdate: \`${entry.processUpdate.slice(0, 100)}${entry.processUpdate.length > 100 ? "..." : ""}\``);
          }
          if (entry.process) {
            lines.push(`- 推进过程：${entry.process}`);
          }
          lines.push("");
        });
      }

      // 3d. Director
      if (session.directorEntries.length > 0) {
        lines.push("#### Director Agent");
        lines.push("");
        session.directorEntries.forEach((entry, i) => {
          lines.push(`**回合 ${i + 1}** (${entry.timestamp})`);
          lines.push(`- 发言者: **${entry.speaker || "未知"}**`);
          lines.push(`- 角色类型: ${entry.speakerRole || "未知"}`);
          lines.push(`- 动机: ${entry.motive || "未知"}`);
          lines.push(`- 任务类型: ${entry.taskType || "未知"}`);
          lines.push(`- 方向: ${entry.direction || "未知"}`);
          lines.push("");
        });
      }

      // 3e. 编排返回
      if (session.orchestrationResult) {
        const res = session.orchestrationResult;
        lines.push("#### 编排返回结果");
        lines.push("");
        lines.push(`- 时间: ${res.timestamp}`);
        lines.push(`- 是否有任务 Plan: ${res.hasTaskPlan || "未知"}`);
        lines.push(`- Plan Role: \`${res.taskPlanRole || ""}\``);
        lines.push(`- Plan RoleType: ${res.taskPlanRoleType || ""}`);
        lines.push(`- SpeakerRouteReason: \`${res.taskPlanSpeakerReason || ""}\``);
        if (res.taskPlanSpeakerReason !== "task-mode-plan") {
          lines.push("> ⚠️ **路由错误**：speakerRouteReason 不是 task-mode-plan，streamlines 会走主线 speaker！");
        }
        lines.push("");
      }
    }

    // ----------------------------------------------------------------
    // 4. Speaker / Streamlines
    // ----------------------------------------------------------------
    if (session.speakerEntries.length > 0) {
      lines.push("### Speaker / Streamlines");
      lines.push("");
      // 优先使用 role/eventType/contentPreview 格式（格式1）
      const hasRoleFormat = session.speakerEntries.some(e => e.role);
      if (hasRoleFormat) {
        lines.push("| # | 时间 | 角色 | 事件类型 | 发言预览 |");
        lines.push("|---|------|------|---------|---------|");
        session.speakerEntries.forEach((entry, i) => {
          const role = entry.role || "";
          const eventType = entry.eventType || "";
          const preview = entry.contentPreview ? entry.contentPreview.slice(0, 60) : "";
          lines.push(`| ${i + 1} | ${entry.timestamp} | ${role} | ${eventType} | ${preview} |`);
        });
      } else {
        lines.push("| # | 时间 | 模型 | isTaskModePlan | speakerRouteReason | speakerMode |");
        lines.push("|---|------|------|----------------|--------------------|-------------|");
        session.speakerEntries.forEach((entry, i) => {
          const isWrong = entry.isMainSpeaker;
          const row = `| ${i + 1} | ${entry.timestamp} | \`${entry.modelKey || ""}\` | ${entry.isTaskModePlan || ""} | \`${entry.speakerRouteReason || ""}\` | ${entry.speakerMode || ""} |`;
          lines.push(isWrong ? row + " ⚠️走主线" : row);
        });
      }
      lines.push("");
    }

    // ----------------------------------------------------------------
    // 5. 对话流程
    // ----------------------------------------------------------------
    if (session.dialogues.length > 0) {
      lines.push("### 对话流程");
      lines.push("");

      const roleIcon = {
        player: "【用户】",
        narrator: "【旁白】",
        npc: "【NPC】",
      };

      for (let i = 0; i < session.dialogues.length; i++) {
        const d = session.dialogues[i];
        const roleLabel = roleIcon[d.roleType] || `【${d.role}】`;
        const content = String(d.content || "").slice(0, 200);
        const eventName = d.eventType || "";
        lines.push(`**${i + 1}.** ${roleLabel} ${content}`);
        if (eventName) lines.push(`   - 事件: \`${eventName}\``);
        lines.push("");
      }
    }

    // ----------------------------------------------------------------
    // 6. Completion
    // ----------------------------------------------------------------
    if (session.completionEntries.length > 0) {
      lines.push("### Completion Agent");
      lines.push("");
      session.completionEntries.forEach((entry, i) => {
        lines.push(`**回合 ${i + 1}** (${entry.timestamp})`);
        lines.push(`- 结果: **${entry.result || "未知"}**`);
        lines.push(`- 状态: ${entry.status || "未知"}`);
        lines.push(`- 最终状态: ${entry.finalStatus || "未知"}`);
        lines.push("");
      });
    }

    // ----------------------------------------------------------------
    // 7. 回溯记录
    // ----------------------------------------------------------------
    lines.push("### 回溯记录");
    lines.push("");
    if (session.revisitEntries.length === 0) {
      lines.push("*该会话无回溯操作*");
    } else {
      lines.push("| # | 时间 | 回溯类型 | 操作 | 消息ID | 恢复内容 |");
      lines.push("|---|------|---------|------|--------|---------|");
      session.revisitEntries.forEach((entry, i) => {
        const kind = entry.revisitKind || entry.revisitType || "";
        const action = entry.action || "";
        const msgId = entry.messageId || "";
        const content = entry.revisitedContent ? entry.revisitedContent.slice(0, 30) : "";
        lines.push(
          `| ${i + 1} | ${entry.timestamp} | ${kind} | ${action} | \`${msgId}\` | ${content} |`,
        );
      });
      // 检查回溯后状态是否保留
      const hasInputFill = session.revisitEntries.some((e) => e.action?.includes("回溯到这句话之前"));
      if (hasInputFill) {
        lines.push("");
        lines.push("> ✅ 回溯后用户输入已自动填入输入框");
      }
    }
    lines.push("");

    // ----------------------------------------------------------------
    // 8. 原始日志（关键行）
    // ----------------------------------------------------------------
    if (session.logEntries.length > 0) {
      lines.push("### 关键日志行");
      lines.push("");
      lines.push("```");
      session.logEntries.slice(0, 30).forEach((entry) => {
        lines.push(`[${entry.timestamp}] [${entry.tag}]`);
      });
      lines.push("```");
      lines.push("");
    }

    lines.push("---\n");
  }

  return lines.join("\n");
}

// ============================================================================
// Main
// ============================================================================

function main() {
  const { inputPath, outputPath } = parseCliArgs(process.argv.slice(2));

  if (!fs.existsSync(inputPath)) {
    throw new Error(`日志文件不存在: ${inputPath}`);
  }

  const rawLog = fs.readFileSync(inputPath, "utf8");
  const lines = rawLog.split(/\r?\n/);

  console.log(`[debug:mini-game:task] 解析日志: ${inputPath}`);
  const sessions = parseTaskModeLogs(lines);
  console.log(`[debug:mini-game:task] 检测到 ${sessions.size} 个会话`);

  const markdown = generateMarkdown(sessions, inputPath);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, markdown, "utf8");
  console.log(`[debug:mini-game:task] 输出: ${outputPath}`);
  console.log(`[debug:mini-game:task] 完成`);
}

try {
  main();
} catch (error) {
  console.error(`[debug:mini-game:task] 失败: ${error && error.message || error}`);
  process.exit(1);
}
