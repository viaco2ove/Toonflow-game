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
    throw new Error("缺少日志文件路径，示例：node scripts/generateMiniGameSummary.js logs/app-2026-04-16.log");
  }
  const normalizedInputPath = path.resolve(inputPath);
  const defaultOutputPath = path.resolve(
    "logs/event_log",
    `${path.basename(inputPath, path.extname(inputPath))}.mini_game.summary.md`,
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
 * 直接从日志文本生成小游戏输入命中摘要 markdown。
 */
function generateMiniGameSummaryMarkdown(logFilePath, outputMarkdownPath) {
  const rawLog = fs.readFileSync(logFilePath, "utf8");
  const lines = rawLog.split(/\r?\n/);
  const entries = [];

  for (const line of lines) {
    if (!line.includes("[story:mini_game:stats] action=")) continue;
    const payload = parseJsonFromLogLine(line.replace("[story:mini_game:stats] action=", ""));
    if (!payload) continue;
    entries.push({
      gameType: readString(payload.gameType),
      phase: readString(payload.phase),
      status: readString(payload.status),
      input: readString(payload.input),
      normalizedInput: readString(payload.normalizedInput),
      controlAction: readString(payload.controlAction),
      actionId: readString(payload.actionId),
      battleActionId: readString(payload.battleActionId),
      resultTags: Array.isArray(payload.resultTags) ? payload.resultTags.map((item) => readString(item)).filter(Boolean) : [],
      intercepted: Boolean(payload.intercepted),
    });
  }

  const markdownLines = [
    "# 小游戏输入命中摘要",
    "",
    ...entries.flatMap((entry, index) => {
      return [
        `## ${index + 1}. ${entry.gameType || "未知小游戏"}`,
        "",
        `- 阶段：${entry.phase || "未知"}`,
        `- 状态：${entry.status || "未知"}`,
        `- 原始输入：${entry.input || "空"}`,
        `- 归一化输入：${entry.normalizedInput || "空"}`,
        `- 控制动作：${entry.controlAction || "无"}`,
        `- 命中动作：${entry.actionId || entry.battleActionId || "无"}`,
        `- 结果标签：${entry.resultTags.length ? entry.resultTags.join("、") : "无"}`,
        `- 是否拦截：${entry.intercepted ? "是" : "否"}`,
        "",
      ];
    }),
  ];

  fs.mkdirSync(path.dirname(outputMarkdownPath), { recursive: true });
  fs.writeFileSync(outputMarkdownPath, markdownLines.join("\n").trim() + "\n", "utf8");
  return {
    outputPath: outputMarkdownPath,
    entryCount: entries.length,
  };
}

function main() {
  const { inputPath, outputPath } = parseCliArgs(process.argv.slice(2));
  const result = generateMiniGameSummaryMarkdown(inputPath, outputPath);
  console.log(`[debug:mini-game] output=${result.outputPath} entries=${result.entryCount}`);
}

try {
  main();
} catch (error) {
  console.error(`[debug:mini-game] failed: ${(error && error.message) || error}`);
  process.exit(1);
}
