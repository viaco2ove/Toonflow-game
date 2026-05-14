import path from "path";
import { DebugLogUtil } from "@/utils/debugLogUtil";

/**
 * 解析命令行参数，得到输入日志和输出 md 路径。
 *
 * 用途：
 * - 支持最简单的 `tsx scripts/generateEventChainSummary.ts 日志文件`
 * - 也支持显式传 `--input=` 和 `--output=`
 */
function parseCliArgs(argv: string[]): {
  inputPath: string;
  outputPath: string;
} {
  const directArgs = argv.filter((item) => !item.startsWith("--"));
  const inputArg = argv.find((item) => item.startsWith("--input=")) || directArgs[0] || "";
  const outputArg = argv.find((item) => item.startsWith("--output=")) || directArgs[1] || "";
  const inputPath = inputArg.startsWith("--input=") ? inputArg.slice("--input=".length) : inputArg;
  if (!inputPath) {
    throw new Error("缺少日志文件路径，示例：yarn debug:event-chain logs/app-2026-04-13.log");
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
 * 脚本主入口。
 *
 * 用途：
 * - 调用 `DebugLogUtil.generateEventChainSummaryMarkdown(...)`
 * - 在终端输出生成结果，方便直接复制给用户
 */
function main() {
  const { inputPath, outputPath } = parseCliArgs(process.argv.slice(2));
  const result = DebugLogUtil.generateEventChainSummaryMarkdown(inputPath, outputPath);
  console.log(`[debug:event-chain] input=${inputPath}`);
  console.log(`[debug:event-chain] output=${result.outputPath}`);
  console.log(`[debug:event-chain] entries=${result.entryCount}`);
}

main();
