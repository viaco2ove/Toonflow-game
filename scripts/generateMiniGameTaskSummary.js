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
      const m = line.match(/Intent:\s*(\w+)[\s\S]*?confidence["\s:]+([^,\s}]+)/);
      const m2 = line.match(/intent["\s:]+(\w+)[\s\S]*?confidence["\s:]+([^,\s}]+)/);
      if (m) return { intent: m[1], confidence: m[2] };
      if (m2) return { intent: m2[1], confidence: m2[2] };
      return {};
    },
  },

  // Progress Agent
  "task:progress": {
    label: "Progress Agent",
    desc: "任务推进判定结果",
    extract: (line) => {
      const m = line.match(/level["\s:]+([^,\s}]+)/);
      const m2 = line.match(/tier["\s:]+([^,\s}]+)/);
      const m3 = line.match(/needClarify["\s:]+([^,\s}]+)/);
      return {
        level: m ? m[1] : null,
        tier: m2 ? m2[1] : null,
        needClarify: m3 ? m3[1] : null,
      };
    },
  },

  // Director Agent
  "task:director": {
    label: "Director Agent",
    desc: "任务剧情编排结果",
    extract: (line) => {
      const m = line.match(/speaker["\s:]+([^,\s}]+)/);
      const m2 = line.match(/speakerRole["\s:]+([^,\s}]+)/);
      const m3 = line.match(/motive["\s:]+([^,\s}]+)/);
      const m4 = line.match(/taskType["\s:]+([^,\s}]+)/);
      const m5 = line.match(/direction["\s:]+([^,\s}]+)/);
      return {
        speaker: m ? m[1] : null,
        speakerRole: m2 ? m2[1] : null,
        motive: m3 ? m3[1] : null,
        taskType: m4 ? m4[1] : null,
        direction: m5 ? m5[1] : null,
      };
    },
  },

  // Speaker Agent / streamlines
  "task:speaker": {
    label: "Speaker / Streamlines",
    desc: "任务角色发言",
    extract: (line) => {
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
  // 匹配 | 新增对话 | [...] | 格式
  const match = line.match(/\|\s*新增对话\s*\|\s*(\[[\s\S]*?\])\s*\|/);
  if (!match) return null;
  let jsonStr = match[1];
  jsonStr = jsonStr.replace(/↩/g, " ").replace(/\s+/g, " ").trim();
  try {
    const dialogues = JSON.parse(jsonStr);
    if (Array.isArray(dialogues) && dialogues.length > 0) return dialogues;
  } catch (e) {}
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

  for (const rawLine of lines) {
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

    if (!currentSession || !isTaskModeLogLine(line)) continue;

    const tagInfo = detectLogTag(line);
    const tagName = tagInfo ? tagInfo.tag : "task:other";

    const entry = {
      timestamp: currentTimestamp,
      tag: tagName,
      line: rawLine,
    };

    const session = sessions.get(currentSession);

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
    else if (tagName === "task:speaker" || line.includes("[story:streamlines:runtime]")) {
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

    // 提取对话
    const dialogues = extractNewDialogue(line);
    if (dialogues && dialogues.length > 0) {
      session.dialogues.push(...dialogues);
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
      lines.push("| # | 时间 | 模型 | isTaskModePlan | speakerRouteReason | speakerMode |");
      lines.push("|---|------|------|----------------|--------------------|-------------|");
      session.speakerEntries.forEach((entry, i) => {
        const isWrong = entry.isMainSpeaker;
        const row = `| ${i + 1} | ${entry.timestamp} | \`${entry.modelKey || ""}\` | ${entry.isTaskModePlan || ""} | \`${entry.speakerRouteReason || ""}\` | ${entry.speakerMode || ""} |`;
        lines.push(isWrong ? row + " ⚠️走主线" : row);
      });
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
