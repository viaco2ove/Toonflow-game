# 世界书注入扩展到 4 个 agent

## 目标
现在世界书只注入编排师。扩展到：角色发言器、记忆管理器、任务剧情编排器（TaskDirector）、任务角色发言器（TaskSpeaker）。让这些 agent 也能看到本轮匹配的世界书条目。

## 设计原则
1. **预加载在调用方**：worldBookEntries 由调用方读 DB 一次传入，避免每个 agent 重复读 DB
2. **各 agent 独立匹配**：每个 agent 的 scanText 不同（看各自关心的文本），用 selectWorldBookForInjection 独立匹配
3. **token 预算统一**：compact 800 / full 2000（复用现有估算）
4. **渲染复用模式**：payload 加 worldContext 字段，prompt 渲染加"世界知识"段

## 各 agent scanText 设计

| Agent | scanText 组成 | 理由 |
|---|---|---|
| 编排师（已有） | latestPlayerMessage + recentDialogue.content | 已实现 |
| 角色发言器 | motive + latestPlayerMessage + recentDialogue.content | motive 含编排师给的地点/角色线索，发言器据此生成台词 |
| 记忆管理器 | eventDeltaMessages.content + recentDialogue.content | 它看"新增对话"提炼记忆，eventDelta 是本轮增量 |
| 任务编排器 Director | playerMessage + dialogue.content | 任务模式用 dialogue（已拼好） |
| 任务发言器 Speaker | playerMessage + dialogue.content + directorResult.motive/direction | 发言要贴合编排方向 |

## 改动清单

### 1. 共享：gameEngine.ts
`selectWorldBookForInjection` 已有，无需改。可能加一个便捷函数 `buildWorldKnowledgeText(entries, scanText, budget): string` 返回拼好的世界知识文本（给任务模式那种字符串拼 prompt 的 agent 用），避免每个 agent 重复 map/join。

### 2. 角色发言器（NarrativeOrchestrator.ts）
- `runStorySpeakerContent` input 加 `worldBookEntries?: WorldBookEntry[]`
- payload 构造（4460）：scanText = motive + playerMessage + recentDialogue.content；matched = selectWorldBookForInjection；payload 加 `worldContext?: { worldKnowledge: string[] }`（发言器不需要 worldBookMatched，只要文本）
- `SpeakerPromptPayload` 加 worldContext 字段
- `buildSpeakerUserPrompt` 渲染：compact 加 world_knowledge 行；full 加"世界知识"段
- 调用点 `runNarrativeOrchestrator`（5015）：传 `worldBookEntries: input.worldBookEntries`（input 经 runNarrativePlan 已预加载）

### 3. 记忆管理器（NarrativeOrchestrator.ts）
- `runStoryMemoryManager` input 加 `worldBookEntries?: WorldBookEntry[]`
- payload 构造（5076）：scanText = eventDeltaMessages.content + recentDialogue.content；matched；payload 加 worldContext
- `buildMemoryUserPrompt` 渲染：compact/full 加世界知识段
- 调用点 `refreshStoryMemoryBestEffort`（5592）：预加载 worldBookEntries 传入（它有 world.worldId）
- 注意：记忆管理器的 payload 类型是内联的，加字段到内联对象

### 4. 任务模式（SessionService.ts + agents/taskMode/）
任务模式和编排师是平行链路，不走 runNarrativePlan，要独立预加载。

**4a. SessionService.ts `tryBuildTaskModePlan`（1367）**：
- 入口预加载：读 DB t_worldBook(worldId) -> worldBookEntries
- scanText = playerMessage + dialogue.content
- matched = selectWorldBookForInjection
- worldKnowledgeText = matched.map(content).join("\n\n")
- 传给 orchestrateTaskMode（ctx 加 worldKnowledge 字段）

**4b. TaskModeContext 加字段**：`worldKnowledge?: string`

**4c. TaskDirectorAgent.ts**：`directTaskNarrative` / `directorAi` 加 worldKnowledge 参数，拼进 userPrompt（在"动态全局背景"后加"世界知识"段）

**4d. TaskSpeakerAgent.ts**：`generateTaskSpeech` 加 worldKnowledge 参数，拼进 prompt

## 关键文件
| 用途 | 路径 |
|---|---|
| 角色发言器 | NarrativeOrchestrator.ts（runStorySpeakerContent 4334 / SpeakerPromptPayload 244 / buildSpeakerUserPrompt 2727 / runNarrativeOrchestrator 4985） |
| 记忆管理器 | NarrativeOrchestrator.ts（runStoryMemoryManager 5056 / buildMemoryUserPrompt 2924 / refreshStoryMemoryBestEffort 5592） |
| 任务模式入口 | SessionService.ts（tryBuildTaskModePlan 1367） |
| 任务编排器 | agents/taskMode/TaskModeOrchestrator.ts + TaskDirectorAgent.ts |
| 任务发言器 | agents/taskMode/TaskSpeakerAgent.ts |
| 共享工具 | gameEngine.ts（selectWorldBookForInjection 已有，加 buildWorldKnowledgeText 便捷函数） |

## 边界与零回归
- worldBookEntries 为空（无世界书/老存档）：各 agent worldContext 为空/undefined，渲染跳过，零回归
- DB 读失败：try-catch 兜底空数组
- token 预算：各 agent 独立预算，不互相挤占
- 任务模式 worldKnowledge 传空字符串时，prompt 拼接容错（显示"无"）
- 章节模式/自由模式都注入（之前已扩展为全模式）

## 验证
1. tsc --noEmit 零新增错误（基线21）
2. 发消息后看后端日志：编排师 + 发言器 + 记忆管理器都应出现 worldBook 匹配（可加各自 logOrchestratorKeyNode）
3. 前端"激活的世界书"面板仍正常（数据源是编排师的 worldBookMatched，不变）
4. 任务模式下发消息：Director/Speaker 的 prompt 日志含"世界知识"段

## 风险
- 记忆管理器加了世界知识可能让它把世界书内容误写进 summary/facts。需在记忆管理器 prompt 强调"世界书是参考上下文，不要照抄进 summary/facts"。
- 发言器 token 预算：发言器 prompt 本身可能已大，加 800 token 世界知识要测是否超模型上下文。compact 模式发言器预算可调小（如 500）。
- 任务模式 4 个 agent 都加，token 成本翻倍。任务模式 dialog 通常较短，可接受。