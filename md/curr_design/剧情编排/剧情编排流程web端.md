#### web端
整理为可直接使用的 `WebDebugLogUtil.log()` 调用格式，剔除了文件名、行号等冗余信息，保留完整日志标签与参数：

```typescript
```typescript
WebDebugLogUtil.log("[voice时序] Watch auto_advancing 触发检查", { playMode: 'live', debugLoading: false, runtimeProcessingPending: false, runtimeRevealPending: false, debugEndDialog: null })
WebDebugLogUtil.log("[voice时序] waitForMessageReveal revealing", { 消息id: 589, 消息角色: '林雅芝(顾母)', 消息内容: '（目光在你脸上虚虚飘了一圈，指尖绞着真丝披肩，神情装得十分动容）小泽……你、你瘦', 是否流式: false, autoVoice: false })
WebDebugLogUtil.log("[voice时序] 静音模式等待开始", { 消息id: 589, 设为状态: 'waiting_next', 等待ms: 2190 })
WebDebugLogUtil.log("[voice时序] Watch auto_advancing 触发检查", { playMode: 'live', debugLoading: false, runtimeProcessingPending: false, runtimeRevealPending: true, debugEndDialog: null })
WebDebugLogUtil.log("[voice时序] continueSessionNarrative 入口", { currentSessionId: 'gs_1783386790118_fbf1aa4ec1', hasMiniGame: false, miniGameVoiceWaitEnd: 0, 消息数: 32 })
WebDebugLogUtil.log("[voice时序] performContinueSessionNarrative 开始编排", { step: 0, isMiniGameActive: false, 当前消息数: 32 })
WebDebugLogUtil.log("[prefetchOrchestration] orchestrateSession")
WebDebugLogUtil.log("[voice时序] 静音模式等待结束", { 消息id: 589, 设为状态: 'waiting_next', 等待ms: 2190 })
WebDebugLogUtil.log("[orchestrateSession] result", { role: '用户', roleType: 'player', motive: '等待顾泽输入下一步行动' })
WebDebugLogUtil.log("[orchestrateSession] resolveSessionOrchestration result", { role: '用户', roleType: 'player', motive: '等待顾泽输入下一步行动' })
WebDebugLogUtil.log("[voice时序] 编排结果分析", { shouldStreamPlan: false, planRoleType: 'player', planRole: '用户' })
WebDebugLogUtil.log("[voice时序] Watch auto_advancing 触发检查", { playMode: 'live', debugLoading: false, runtimeProcessingPending: false, runtimeRevealPending: false, debugEndDialog: null })
WebDebugLogUtil.log("[voice时序] Watch return: canPlayerSpeak && !miniGameShouldContinue", { canPlayerSpeak: true, miniGameShouldContinue: false })
WebDebugLogUtil.log("[voice时序] orchestration 返回 player，本地兜底 awaitUser", { plan: {} })
WebDebugLogUtil.log("[voice时序] applyAwaitUserTurnFromPlan 设置玩家回合", { planRoleType: 'player', awaitUser: true, role: '用户', motive: '等待顾泽输入下一步行动' })
WebDebugLogUtil.log("[voice时序] break 条件检查", { step: 0, canPlayerSpeakNow: true, hasPendingAwaitUser: true, latestStatus: 'waiting_player', hasPlan: true })
WebDebugLogUtil.log("[voice时序] Watch auto_advancing 触发检查", { playMode: 'live', debugLoading: false, runtimeProcessingPending: false, runtimeRevealPending: false, debugEndDialog: null })
WebDebugLogUtil.log("[voice时序] Watch return: canPlayerSpeak && !miniGameShouldContinue", { canPlayerSpeak: true, miniGameShouldContinue: false })
WebDebugLogUtil.log("[voice时序] Watch1 检测到新消息", { 新消息数: 1, 新消息角色列表: [], myToken: 1, revealRunActive: 1 })
WebDebugLogUtil.log("[voice时序] Watch auto_advancing 触发检查", { playMode: 'live', debugLoading: false, runtimeProcessingPending: false, runtimeRevealPending: false, debugEndDialog: null })
WebDebugLogUtil.log("[voice时序] waitForMessageReveal revealing", { 消息id: -1783399688942, 消息角色: '用户', 消息内容: '.', 是否流式: false, autoVoice: false })
WebDebugLogUtil.log("[voice时序] Watch auto_advancing 触发检查", { playMode: 'live', debugLoading: false, runtimeProcessingPending: false, runtimeRevealPending: true, debugEndDialog: null })
WebDebugLogUtil.log("[voice时序] Watch auto_advancing 触发检查", { playMode: 'live', debugLoading: false, runtimeProcessingPending: false, runtimeRevealPending: false, debugEndDialog: null })
WebDebugLogUtil.log("[voice时序] Watch auto_advancing 触发检查", { playMode: 'live', debugLoading: false, runtimeProcessingPending: false, runtimeRevealPending: false, debugEndDialog: null })
WebDebugLogUtil.log("[voice时序] continueSessionNarrative 入口", { currentSessionId: 'gs_1783386790118_fbf1aa4ec1', hasMiniGame: false, miniGameVoiceWaitEnd: 0, 消息数: 33 })
WebDebugLogUtil.log("[voice时序] performContinueSessionNarrative 开始编排", { step: 0, isMiniGameActive: false, 当前消息数: 33 })
WebDebugLogUtil.log("[prefetchOrchestration] orchestrateSession")
WebDebugLogUtil.log("[orchestrateSession] result", { role: '顾铭远(顾父)', roleType: 'npc', motive: '以家长姿态安排顾泽落座开启家庭谈话' })
WebDebugLogUtil.log("[orchestrateSession] resolveSessionOrchestration result", { role: '顾铭远(顾父)', roleType: 'npc', motive: '以家长姿态安排顾泽落座开启家庭谈话' })
WebDebugLogUtil.log("[voice时序] 编排结果分析", { shouldStreamPlan: true, planRoleType: 'npc', planRole: '顾铭远(顾父)' })
WebDebugLogUtil.log("[voice时序] streamSessionPlan 开始", { step: 0, 消息数: 33 })
WebDebugLogUtil.log("[voice时序] Watch1 检测到新消息", { 新消息数: 1, 新消息角色列表: [], myToken: 1, revealRunActive: 1 })
WebDebugLogUtil.log("[voice时序] Watch auto_advancing 触发检查", { playMode: 'live', debugLoading: false, runtimeProcessingPending: true, runtimeRevealPending: false, debugEndDialog: null })
WebDebugLogUtil.log("[voice时序] waitForMessageReveal revealing", { 消息id: 1783399710870, 消息角色: '顾铭远(顾父)', 消息内容: '获取台词中', 是否流式: true, autoVoice: false })
WebDebugLogUtil.log("[voice时序] Watch auto_advancing 触发检查", { playMode: 'live', debugLoading: false, runtimeProcessingPending: true, runtimeRevealPending: true, debugEndDialog: null })
WebDebugLogUtil.log("[voice时序] Watch auto_advancing 触发检查", { playMode: 'live', debugLoading: false, runtimeProcessingPending: true, runtimeRevealPending: true, debugEndDialog: null })
WebDebugLogUtil.log("[voice时序] Watch auto_advancing 触发检查", { playMode: 'live', debugLoading: false, runtimeProcessingPending: true, runtimeRevealPending: true, debugEndDialog: null })
WebDebugLogUtil.log("[voice时序] Watch auto_advancing 触发检查", { playMode: 'live', debugLoading: false, runtimeProcessingPending: true, runtimeRevealPending: true, debugEndDialog: null })
WebDebugLogUtil.log("[voice时序] 流式外层 while break - 消息不再是 streaming 状态", { messageKey: 'gs_1783386790118_fbf1aa4ec1_1783399710870_1783399710870_npc', messageId: 1783399710870, status: 'generated', streaming: false, contentLength: 59 })
WebDebugLogUtil.log("[voice时序] 静音模式等待开始", { 消息id: 1783399710870, 设为状态: 'waiting_next', 等待ms: 1650 })
WebDebugLogUtil.log("[voice时序] Watch auto_advancing 触发检查", { playMode: 'live', debugLoading: false, runtimeProcessingPending: true, runtimeRevealPending: true, debugEndDialog: null })
WebDebugLogUtil.log("[voice时序] 静音模式等待结束", { 消息id: 1783399710870, 设为状态: 'waiting_next', 等待ms: 1650 })
WebDebugLogUtil.log("[voice时序] Watch auto_advancing 触发检查", { playMode: 'live', debugLoading: false, runtimeProcessingPending: true, runtimeRevealPending: false, debugEndDialog: null })
WebDebugLogUtil.log("[voice时序] Watch auto_advancing 触发检查", { playMode: 'live', debugLoading: false, runtimeProcessingPending: true, runtimeRevealPending: false, debugEndDialog: null })
WebDebugLogUtil.log("[orchestrateSession] prefetchNext", { messageId: 591 })
WebDebugLogUtil.log("[voice时序] prefetchNextSessionOrchestration 触发", { triggerMessageId: 591, timestamp: 1783399717326 })
WebDebugLogUtil.log("[prefetchOrchestration] orchestrateSession")
WebDebugLogUtil.log("[orchestrateSession] promise", Promise {<pending>})
WebDebugLogUtil.log("[voice时序] streamSessionPlan 完成", { step: 0, 消息数: 34, 最新消息id: 591 })
WebDebugLogUtil.log("[voice时序] break 条件检查", { step: 0, canPlayerSpeakNow: false, hasPendingAwaitUser: false, latestStatus: 'waiting_next', hasPlan: true })
WebDebugLogUtil.log("[voice时序] shouldStreamPlan=true，break 退出 for 循环", { step: 0, canPlayerSpeakNow: false, latestStatus: 'waiting_next' })
WebDebugLogUtil.log("[orchestrateSession] resolved result data", { role: '顾子航', roleType: 'npc', motive: '继续伪装温和，假意缓和气氛同时贬低顾泽' })
```

ai 这个弱智居然认为是预编排的问题？真他妈弱智！！！还想删了预编排？

## 预编排与编排消费

### 是什么

预编排（prefetch/prefetchNext）是一种**提前触发、延迟消费**的优化机制，目的是让下一轮编排对用户"感知零等待"。

### 核心思想

正常流程：上一轮语音播完 → 才开始调用编排 AI → 等 3-5s → 台词生成

预编排流程：上一轮台词生成完（语音播放中）→ **后台已经开始调用编排 AI** → 语音播完时编排已完成 → 直接拿结果

```
正常流程时间线：
  [语音播放 5s] → [编排 AI 3s] → [台词生成 2s]  =  等待 5s

预编排时间线：
  [语音播放 5s]  ←同时→  [编排 AI 3s（后台]
                →  [台词生成 2s]                =  等待 ≈0s
```

### 三个关键时机

| 时机 | 发生了什么 | 目的 |
|------|-----------|------|
| **台词生成完（streaming 结束）** | 后台发起下一轮编排请求（/orchestration），promise 存入 `pendingOrchestrationPromise` | 让编排 AI 在语音播放期间运行 |
| **语音播完（waiting_next）** | Watch 检测到状态变化，触发 `continueSessionNarrative` | 驱动下一轮流程开始 |
| **continueSessionNarrative 中** | 先检查 `pendingOrchestrationPromise`，有就直接 await 拿结果；没有才发新请求 | 复用预编排结果，或兜底重请求 |

### 为什么叫"预编排"而不是"预取"

- **"预取"（prefetch）**：提前把数据拉过来，用不用不一定。
- **"预编排"（prefetch orchestration）**：提前触发编排请求，结果一定会被消费（除非轮次结束了）。

预编排的结果**必须被消费**，否则下一轮的 `canPlayerSpeak` / `pendingPlan` 就对不上，会导致状态错乱。

### 消费条件：必须满足 break 条件

预编排发出的编排请求，返回的 plan 不一定被使用。需要 `continueSessionNarrative` 的 for 循环满足 break 条件，才算真正"消费"了这个预编排。

break 条件（满足任一即 break）：
- `hasPlan = true` 且 `canPlayerSpeakNow = true`（轮到用户了）
- `hasPlan = true` 且 `shouldStreamPlan = true`（有 NPC 台词要流式生成）

如果预编排返回的 plan 不满足 break 条件（例如编排的是用户等待节点，而实际应该编排 NPC），for 循环不会 break，会继续下一次编排。这不是预编排的问题，是编排 AI 的判断问题。

### 预编排与编排 AI 是独立的

- **预编排**：前端主动发起 /orchestration 请求，是前端行为
- **编排 AI**：后端 NarrativeOrchestrator 内部调用 AI 模型，是后端行为
- 两者不是同一个东西。预编排只是"提前发了请求"，编排 AI 怎么判断、调用哪个模型、返回什么 plan，全由后端决定

### 预编排会被丢弃吗

**会**，在以下情况：

1. **轮次结束了**：用户发了新消息（orchestrateSessionOrchestration 的新请求），旧的 `pendingOrchestrationPromise` 被清空
2. **会话切换了**：clearPendingSessionOrchestrationPrefetch
3. **小游戏激活了**：小游戏模式会清空 pendingOrchestrationPrefetch

丢弃后，下一轮会重新发编排请求（没有预编排可复用）。

### 图示

```
[用户发消息] → [编排 AI] → [台词流式生成] → [break: 有NPC台词]
                                        ↓
                              [后台预编排下一轮]  ←--- 这时候语音还在播
                                        ↓
                              [break: 有NPC台词，继续下一轮]
                                        ↓
                              [后台预编排下下一轮]
                                        ↓
                              ...（循环直到轮到用户）
```

### 预编排不等于"并行编排"

预编排是**同一时刻只有一个编排请求在飞**（要么预编排、要么 continueSessionNarrative 发起的新请求），不是多个并行编排。它只是把"编排请求的发起时机"提前到上一轮台词生成完，而不是等到语音播完。


## 增加编排检测器线程
### 2秒检查一次：
- 最新的的编排结果
- 这个编排是否被消费了
- 是否在请求编排中
- 是否处于用户输入回合
- 是否处于停摆中，没有请求，没有编排，也不是用户输入回合

对应的日志
WebDebugLogUtil.log("[orchestrateSession] [checker] 最新的的编排结果：",...)
WebDebugLogUtil.log("[orchestrateSession] [checker] 这个编排是否被消费了：",...)
WebDebugLogUtil.log("[orchestrateSession] [checker] 是否在请求编排中：",...)
WebDebugLogUtil.log("[orchestrateSession] [checker] 是否处于用户输入回合：",...)
WebDebugLogUtil.log("[orchestrateSession] [checker] 是否处于停摆中，没有请求，没有编排，也不是用户输入回合：",...)

### 编排检测器线程

**文件**: `useToonflowStore.ts` (`src/composables/useToonflowStore.ts`)

每隔 2 秒检查一次编排状态，发现停摆时自动恢复。

**启动/停止时机**:
- `openSession`（会话打开成功）→ `startOrchestrationChecker()`
- `deleteSession`（退出会话）→ `stopOrchestrationChecker()`

**检测项**（每次运行打印 6 条日志）:

| 日志 | 检测内容 |
|------|-----------|
| `[orchestrateSession] [checker] 最新的编排结果：` | `prefetchRole` / `prefetchRoleType` / `prefetchMotive` / `hasPrefetch` / `prefetchTriggerId` |
| `[orchestrateSession] [checker] 这个编排是否被消费了：` | `consumed` / `pendingPrefetchExists` |
| `[orchestrateSession] [checker] 最新消息状态：` | `latestStatus`、`latestRole`、`latestId` |
| `[orchestrateSession] [checker] 是否在请求编排中：` | `isProcessing` |
| `[orchestrateSession] [checker] 是否处于用户输入回合：` | `isUserTurn`、`canPlayerSpeakNow` |
| `[orchestrateSession] [checker] 是否处于停摆中，没有预编排、没有请求、也不是用户回合：` | `isStalled` |

**关键状态机**：

- `prefetchRole` / `prefetchRoleType` / `prefetchMotive` — 最近一次预编排返回的 plan 内容。来源：`prefetchNextSessionOrchestration` 中 `api.orchestrateSession` promise 的 `then` 回调写入 `lastPrefetchSnapshot`。
- `consumed` — 该预编排是否已被消费。`clearPendingSessionOrchestrationPrefetch()` 调用时标记为 `true`（消费或丢弃）。
- `latestRole` / `latestStatus` — 会话中最新一条消息，对比 `prefetchRole` 可快速识别"编排结果和最新消息角色是否一致"。

**对照示例（你截图中场景）**：

```
最新的编排结果: { hasPrefetch: true, prefetchRole: '旁白', prefetchRoleType: 'narrator', prefetchMotive: '还原现场氛围...' }
这个编排是否被消费了: { consumed: false, pendingPrefetchExists: true }
最新消息状态: { latestStatus: 'waiting_next', latestRole: '顾子航', latestId: 597 }
```

对比可看出：编排返回的是"旁白"，但最新消息是"顾子航"——编排结果没和最新消息对齐，需要等 Watch 触发下一轮消费，或者检测到停摆时强制恢复。

**状态变化时额外打印**:
- 当 `isUserTurn` 或 `isStalled` 变化时，打印 `[orchestrateSession] [checker] 状态变化：` 记录前值 `from` 与新值 `to`。

**停摆判定逻辑**:
```typescript
isStalled = !isUserTurn && !pendingPrefetch && !isProcessing
// - !isUserTurn：既不是玩家回合，也没有在等待玩家
// - !pendingPrefetch：没有预编排在进行
// - !isProcessing：没有编排请求在进行
```

**自动恢复**:
检测到停摆（`isStalled = true`）时，立即调用 `scheduleContinueSessionNarrative()` 触发编排恢复，不等待下一个语音播放完成。

**与编排流程的关系**: 检测器是编排流程的兜底保障，正常情况下编排靠 Watch 监听 `waiting_next` 自动推进；检测器只在编排流程异常停滞（无预编排、无请求、用户未轮到）时介入。

### 编排异常自动恢复。
如果处于停摆中即时恢复。