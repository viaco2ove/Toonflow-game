# 实现 debugLog 黑/白名单过滤 + 记录所有 log tag

## 目标
- `debugLogConfig.ts` 已有 `debugLogMode`(`blacklist`/`whitelist`) + `debugLogBlacklist` / `debugLogWhitelist` 三个配置。
- 约束 `debugLogUtil.ts` 的日志输出：黑名单模式命中即屏蔽，白名单模式仅放行命中的 tag。
- `logTagList.ts`(当前 0 字节) 记录所有 log tag。
- 全量迁移直接 `console.log("[tag]...")` 调用点到统一入口（用户已选「全量迁移」）。
- tag 匹配采用「前缀匹配」（用户已选）：`story:event_progress:runtime` 会覆盖复合变体 `[story:event_progress:runtime][stage][buildRecentMessages]`。

## 核心设计

### 1. `logTagList.ts` — 记录所有 log tag（新建，当前为空文件）

导出 `logTagList`：一个常量数组，列出代码里用到的全部后端 debug 日志 tag。以 `story:*` / `game:*` / `debug:*` / `voice:*` / `video:*` 等开头、带冒号分层结构的 tag 为主。这些 tag 同时也是黑/白名单可配置的合法取值。

来源：从全仓 grep 已汇总出的唯一 tag 列表（约 80 个），按领域分组并加中文注释。仅收录「调试相关、受 LOG_LEVEL=DEBUG 控制」的 tag；排除 `[npm:err]` 这类系统噪音。复合变体（如 `[story:event_progress:runtime][stage]`）只收录基础 tag `story:event_progress:runtime`，前缀匹配时子变体自然命中。

并导出 `DebugLogTag` 类型：`typeof logTagList[number]`，给 `debugLogConfig` 复用做类型约束。

### 2. `debugLogConfig.ts` — 收紧类型 + 清理

当前 `debugLogBlacklist: ["/api/debug/log"]` 像是 API 路径，不符合「tag 黑名单」语义，改为空数组（或保留少量示例 tag）。把 list 的元素类型约束为 `string`（运行期不强制 `DebugLogTag`，避免新增未登记 tag 时类型报错阻断）。

```ts
import { logTagList, DebugLogTag } from "@/utils/logTagList";

export const debugLogConfig = {
  debugLogMode: "blacklist" as "blacklist" | "whitelist",
  debugLogBlacklist: [] as string[],
  debugLogWhitelist: [] as string[],
};

// 合法 tag 枚举（注释用，约束 IDE 自动补全）
export type { DebugLogTag };
export { logTagList };
```

### 3. `debugLogUtil.ts` — 新增统一过滤入口

新增私有方法：
```ts
private static shouldLogTag(tag: string): boolean
```
逻辑：
- 黑名单模式：若存在任一 blacklist 项是 `tag` 的前缀（`tag.startsWith(item)`），则屏蔽（return false）。
- 白名单模式：仅当存在某 whitelist 项是 `tag` 的前缀时放行（return true），否则屏蔽。
- 空 list 语义：黑名单空 = 全放行；白名单空 = 全屏蔽（避免误配全静默，会在代码注释里强调）。

新增公共统一入口（替换散落的 `console.log`）：
```ts
static log(tag: string, ...args: unknown[]): void {
  if (!DebugLogUtil.isDebugLogEnabled()) return;
  if (!DebugLogUtil.shouldLogTag(tag)) return;
  console.log(`[${tag}]`, ...args); // 保留原 [tag] 前缀风格
}
```
注意：现有 wrapper 多用 `console.log(\`[${tag}] xxx\`)` 模板字符串手拼前缀。迁移时统一改为 `DebugLogUtil.log(tag, "xxx", ...)`，由入口统一加 `[tag]` 前缀，保证格式不变、可读性一致。

对 5 个现有 wrapper 方法（`logCurrentChapter`、`logEventProgressResolution`、`logMiniGameActionResolution`、`logMiniGamePromptStats`、`logPlayerMemoryDirective`）：在每个方法开头 `isDebugLogEnabled()` 判断后，补 `if (!DebugLogUtil.shouldLogTag(tag)) return;`；方法内部所有 `console.log` 行改为调用 `DebugLogUtil.log(tag, ...)`，使其受黑/白名单约束。其中 `logMiniGamePromptStats` 里有硬编码 `[story:mini_game:runtime]` 的日志行，改为传 `"story:mini_game:runtime"` tag。

### 4. 全量迁移直接调用点（约 20 个文件 / 117 处 isDebugLogEnabled 守卫）

把每个文件里的模式：
```ts
if (DebugLogUtil.isDebugLogEnabled()) {
  console.log("[story:orchestrator:runtime] xxx", JSON.stringify({...}));
}
```
统一改为：
```ts
DebugLogUtil.log("story:orchestrator:runtime", "xxx", JSON.stringify({...}));
```
`DebugLogUtil.log` 内部已做 `isDebugLogEnabled()` + `shouldLogTag()` 判断，调用点不再需要外层 if。涉及文件（按 grep 确认）：
- `src/modules/game-runtime/services/`: SessionService.ts, ChapterRuntimeService.ts, EventProgressRuntimeService.ts, FreeChapterTaskService.ts, MiniGameSellService.ts, MiniGameIntentService.ts, PlayerMemoryDirectiveService.ts
- `src/modules/game-runtime/engines/`: NarrativeOrchestrator.ts, MiniGameController.ts
- `src/routes/game/`: orchestration/index.ts, orchestration/minigame.ts, streamlines.ts, streamIntroduction.ts, revisitMessage.ts, introduction.ts, orchestrationResponseShared.ts, convertAvatarVideoToGif.ts
- `src/routes/voice/`: preview.ts, generateBindingVoice.ts, mossTtsInstall.ts
- `src/routes/ai/`: qwen060Install.ts
- `src/routes/setting/`: getVoiceModelList.ts
- `src/lib/`: siliconflowVoice.ts, localQwen060.ts, localMossTts.ts, roleParameterCard.ts

迁移策略：**保持日志文本完全不变**——原 `console.log("[tag] msg")` → `DebugLogUtil.log("tag", "msg")`，原 `console.log("[tag] msg", x)` → `DebugLogUtil.log("tag", "msg", x)`。复合 tag（如 `[story:event_progress:runtime][stage][buildRecentMessages]`）整体迁移为传基础 tag `"story:event_progress:runtime"`，消息里保留 `[stage][buildRecentMessages]` 段落以保证原文可读、且 `generateEventChainSummary` 的 `line.includes(...)` 解析不受影响。

### 5. 不改动 / 注意事项
- `modelConfigType.ts` 仅 import 了 `DebugLogUtil` 但未使用，保持不动（避免无关 diff）。
- `NarrativeOrchestrator.bak.ts.txt` 是备份，不迁移。
- `generateEventChainSummaryMarkdown` / `generateMiniGameActionSummaryMarkdown` 是离线日志解析函数，**不是**运行时输出，不受黑/白名单约束，但其依赖的运行时日志行格式必须保持（见上：消息段落不变）。
- CLAUDE.md 明确要求「不要去掉 `DebugLogUtil.isDebugLogEnabled()` 判断」——`DebugLogUtil.log` 内部仍保留该判断，调用点改为统一入口后判断并未消失，只是收敛到一处。
- 前端 `WebDebugLogUtil`、安卓 `AndroidDebugLogUtil` 不在本次范围。

## 验证
1. `yarn lint`（tsc --noEmit）通过。
2. 不配黑/白名单（默认 blacklist + 空数组）时，所有原有日志行为不变（前缀匹配 + 空 list 放行）。
3. 配 `debugLogBlacklist: ["story:event_progress:runtime"]` 后，`[story:event_progress:runtime]` 及其复合变体日志被屏蔽，其余正常。
4. 配 `debugLogMode: "whitelist"` + `debugLogWhitelist: ["story:orchestrator:stats"]` 后，仅该 tag 前缀日志输出。

## 改动文件清单
- 新建：`src/utils/logTagList.ts`
- 改：`src/utils/debugLogConfig.ts`
- 改：`src/utils/debugLogUtil.ts`
- 改：约 24 个调用点文件（见 §4）
