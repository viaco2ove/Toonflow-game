/**
 * 约束 debugLogUtil.ts 的日志输出
 * 日志模式：debugLogMode：blacklist, whitelist
 * 黑名单模式：blacklist
 * 白名单模式：whitelist
 * logTagList.ts 记录所有logtag
 *
 * 说明：
 * - `debugLogBlacklist` / `debugLogWhitelist` 里放的是日志 tag（如 `story:orchestrator:runtime`），
 *   不是 API 路径；
 * - 匹配采用「前缀匹配」：列出 `story:event_progress:runtime` 会同时覆盖其复合变体
 *   `[story:event_progress:runtime][stage][buildRecentMessages]`；
 * - 黑名单空 = 全放行；白名单空 = 全屏蔽（配置白名单模式时务必确认非空，否则会静默）。
 */
import { logTagList, DebugLogTag } from "@/utils/logTagList";

export const debugLogConfig = {
  /** 日志过滤模式：blacklist=命中即屏蔽；whitelist=仅放行命中的 tag。 */
  debugLogMode: "blacklist" as "blacklist" | "whitelist",
  /** 黑名单 tag（前缀匹配）。黑名单模式下命中即屏蔽。 */
  debugLogBlacklist: [] as string[],
  /** 白名单 tag（前缀匹配）。白名单模式下仅放行命中的 tag。 */
  debugLogWhitelist: [] as string[],
};

// 合法 tag 枚举与登记表（re-export 供调用方做 IDE 补全 / 校验参考）。
export { logTagList };
export type { DebugLogTag };
