# 世界知识 与 Agent

## agents
[agent.aigame.list.csv](../../../../%E6%B8%B8%E7%8E%A9%E4%B8%9A%E5%8A%A1_ai_agent/agent.aigame.list.csv)

## 世界知识如何增加到上下文
世界知识的 `agentList` 字段控制注入范围。默认为全部 Agent 可见（`agentList` 为空或含 `"all"`）；填具体 Agent Key 则只发给指定 Agent。

发送给 Agent 的内容为条目的 **`content` 字段**（正文内容）。`title`、`keys`、`category`、`order`、`agentList` 等字段不发给模型，只用于匹配筛选和前端展示。

---

## 实现状态（18/18 已全部完成）

| # | Agent Key | Agent 名称 | 注入方式 |
|---|-----------|------------|------|
| 1 | `narrative_orchestrator` | 剧情编排师 | `selectWorldBookForInjection(...,"narrative_orchestrator")` → `payload.worldContext.worldKnowledge` → prompt `【世界知识】` section |
| 2 | `story_speaker` | 角色发言器 | `selectWorldBookForInjection(...,"story_speaker")` → `payload.worldContext.worldKnowledge` → prompt `[世界知识]` 行 |
| 3 | `story_memory_manager` | 记忆管理器 | `selectWorldBookForInjection(...,"story_memory_manager")` → prompt `【世界知识】` 行（注明仅参考不照抄） |
| 4 | `intent_classifier` | 意图分类器 | `IntentContext` 加 `worldId`，`classifyIntentWithAi` 内加载，追加到 `buildUserPrompt` 末尾 |
| 5 | `chapter_outcome_judge` | 章节结局判定器 | `evaluateChapterOutcomeByAi` 内加载，`buildChapterJudgePrompt` 末尾追加 |
| 6 | `event_progress_judge` | 事件进度判定器 | `evaluateEventProgressByAi` 内加载，userPrompt 末尾追加 |
| 7 | `story_update_align` | 存档智能对齐 | `runStoryUpdateAlignAgent` 输入加 `worldId`，userPrompt 前缀 |
| 8 | `task_progress` | 任务进度评估器 | `evaluateTaskProgress` 加 `worldKnowledge` 参数，调用点传入 `worldKnowledgeText` |
| 9 | `task_director` | 任务剧情编排师 | `buildWorldKnowledgeText(...,"task_director")` → 存入 `state.vars.taskWorldKnowledge`，复用到 TaskSpeaker |
| 10 | `task_speaker` | 任务角色发言器 | 复用 taskDirector 预存的 `taskWorldKnowledge` |
| 11 | `task_completion` | 任务完成评估器 | `evaluateTaskCompletion` 加 `worldKnowledge` 参数，调用点传入 |
| 12 | `mini_game_intent` | 小游戏动作解析 | `ResolveMiniGameIntentInput` 加 `worldId`，内部加载，注入 systemPrompt |
| 13 | `mini_game_mentor_speech` | 小游戏角色台词 | `generateMiniGameMentorSpeech` 内加载，注入 prompt 末尾 |
| 14 | `mini_game_sell_intent` | 小游戏卖出意图解析 | `resolveSellIntent` 加 `worldId` 参数，注入 systemPrompt |
| 15 | `free_task_resolution` | 自由章节任务裁决 | `evaluateFreeTaskResolutionByAi` 内加载，userPrompt 末尾追加 |
| 16 | `free_task_blueprint` | 自由章节任务蓝图生成 | `generateFreeChapterTaskBlueprintByAi` 内加载，userPrompt 末尾追加 |
| 17 | `orchestrate_options` | 编排选项生成器 | `OrchestrateOptionsContext` 加 `worldKnowledge`，SessionService 调用点预加载 |
| 18 | `play_tip` | 玩家提示器 | `PlayTipContext` 加 `worldKnowledge`，generatePlayTips 调用点预加载 |

---

## 已实现 Agent 的注入位置（按注入位置类型）

### 类型 A: 注入到 prompt section / 行（已有 worldContext 字段）
- **剧情编排师** `【世界知识】` section（NarrativeOrchestrator.ts:1735-1736）→ `worldKnowledge.join("\n\n")`
- **角色发言器** `[世界知识]` 行（NarrativeOrchestrator.ts:2799-2800）→ 同上
- **记忆管理器** `【世界知识】` 行（NarrativeOrchestrator.ts:3043-3044）→ 同上，注明"仅参考、不照抄"

### 类型 B: 追加到 user prompt 末尾
- **意图分类器** `buildUserPrompt` 末尾（IntentClassifier.ts:134）→ `【世界知识】\n{worldKnowledge}`
- **章节结局判定器** `buildChapterJudgePrompt` 末尾（ChapterRuntimeService.ts:375）→ `snapshot + "\n\n【世界知识】\n..."`
- **事件进度判定器** `userPrompt` 末尾（EventProgressRuntimeService.ts:564）→ `JSON.stringify + 【世界知识】\n...`
- **任务进度评估器** `userPrompt` 中段（TaskProgressAgent.ts:223）→ `dynamicGlobalBackground` 后追加 `【世界知识】\n...`
- **任务完成评估器** `userPrompt` 中段（TaskCompletionAgent.ts:111）→ 同上
- **小游戏角色台词** `userPrompt` 末尾（MiniGameController.ts:1048）→ `prompt + 【世界知识】\n...`
- **自由任务裁决** `userPrompt` 末尾（FreeChapterTaskService.ts:932）→ 同上
- **自由任务蓝图** `userPrompt` 末尾（FreeChapterTaskService.ts:1080）→ 同上
- **玩家提示器** `userPrompt` 末尾（PlayTipAgent.ts:113）→ 模板字符串最后追加

### 类型 C: 追加到 system prompt
- **小游戏动作解析** `systemPrompt` 末尾（MiniGameIntentService.ts:209）→ `loadMiniGamePrompt + schema + 【世界知识】\n...`
- **小游戏卖出意图** `systemPrompt` 末尾（MiniGameSellService.ts:217）→ `(dbPrompt \|\| DEFAULT) + 【世界知识】\n...`

### 类型 D: 注入到 user prompt 前缀
- **存档智能对齐** `userPrompt` 前缀（StoryUpdateAlignAgent.ts:113）→ `【世界知识】\n...` + 提示正文

### 类型 E: 通过 ctx.worldKnowledge 由调用方预加载
- **任务编排师** `directTaskNarrative`（TaskDirectorAgent））→ `ctx.worldKnowledge` 字段
- **任务发言器** `generateTaskSpeech`（TaskSpeakerAgent））→ 同上
- **编排选项生成器** `OrchestrateOptionsContext.worldKnowledge`（OrchestrateOptionsAgent））→ userPromptParts.push
- **任务模式 ctx.worldKnowledge** 在 SessionService.ts:1472 预加载并存 state.vars.taskWorldKnowledge

---

## 技术说明

- 注入引擎：`selectWorldBookForInjection(entries, scanText, tokenBudget, agentKey)`（gameEngine.ts:3171）
  - `agentKey` 为空/undefined：不过滤，条目对全部 Agent 可见
  - `agentKey` 有值：只在条目 `agentList` 为空或含 `"all"` 或包含该 key 时注入
- 匹配规则：constant 条目全收；非 constant 按 `keys` 匹配 `scanText` + category 白名单 + token 预算截断
- 每个 Agent 的 `scanText` 不同：
  - 编排师：latestPlayerMessage + recentDialogue
  - 发言器：motive + playerMessage + recentDialogue
  - 记忆管理器：eventDeltaMessages + dialogueMessages
  - 意图分类器：playerMessage + recentMessages
  - 章节结局/事件进度：messageContent + recentMessages
  - 存档对齐：currentProgress.eventSummary + oldPhases[].label
  - 任务进度/完成：playerMessage + dialogue
  - 小游戏动作：userInput
  - 小游戏台词：playerMessage
  - 小游戏卖出：userInput
  - 自由任务裁决：playerMessage + objective + dialogue
  - 自由任务蓝图：option.description + option.rawLine + title
  - 编排选项：playerMessage + dialogue
  - 玩家提示器：dialogue
- token 预算：编排/发言/任务 800-2000 字符，小游戏/分类器/对齐/裁决 300-400 字符，自由蓝图 600
- 加载方式：世界书条目按 worldId 在各 Agent 调用点**预加载一次**（避免每次重复读 DB），匹配结果拼接为字符串注入 prompt；任务模式下预存到 `state.vars.taskWorldKnowledge` 供 taskSpeaker 复用