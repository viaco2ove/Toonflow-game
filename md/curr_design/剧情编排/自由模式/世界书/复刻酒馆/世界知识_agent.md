# 世界知识 与 Agent

## agents
[agent.aigame.list.csv](../../../../%E6%B8%B8%E7%8E%A9%E4%B8%9A%E5%8A%A1_ai_agent/agent.aigame.list.csv)

## 世界知识如何增加到上下文
世界知识的 `agentList` 字段控制注入范围。默认为全部 Agent 可见（`agentList` 为空或含 `"all"`）；填具体 Agent Key 则只发给指定 Agent。

发送给 Agent 的内容为条目的 **`content` 字段**（正文内容）。`title`、`keys`、`category`、`order`、`agentList` 等字段不发给模型，只用于匹配筛选和前端展示。

---

## 实现状态

| # | Agent Key | Agent 名称 | 是否已实现世界书注入 | 注入方式 |
|---|-----------|------------|------|------|
| 1 | `narrative_orchestrator` | 剧情编排师 | ✅ 已实现 | `selectWorldBookForInjection(entries, scanText, budget, "narrative_orchestrator")` → `payload.worldContext.worldKnowledge` → prompt `【世界知识】` section |
| 2 | `story_speaker` | 角色发言器 | ✅ 已实现 | `selectWorldBookForInjection(entries, scanText, budget, "story_speaker")` → `payload.worldContext.worldKnowledge` → prompt `[世界知识]` 行 |
| 3 | `story_memory_manager` | 记忆管理器 | ✅ 已实现 | `selectWorldBookInject(entries, scanText, budget, "story_memory_manager")` → prompt `【世界知识】` 行（注明仅参考不照抄） |
| 4 | `intent_classifier` | 意图分类器 | ❌ 未实现 | — |
| 5 | `chapter_outcome_judge` | 章节结局判定器 | ❌ 未实现 | — |
| 6 | `event_progress_judge` | 事件进度判定器 | ❌ 未实现 | — |
| 7 | `story_update_align` | 存档智能对齐 | ❌ 未实现 | — |
| 8 | `task_progress` | 任务进度评估器 | ❌ 未实现 | — |
| 9 | `task_director` | 任务剧情编排师 | ✅ 已实现 | `buildWorldKnowledgeText(wbEntries, scanText, 800, "task_director")` → `taskWorldKnowledge` 存入 state.vars，复用到 TaskSpeaker |
| 10 | `task_speaker` | 任务角色发言器 | ✅ 已实现（复用 taskDirector 预存的 taskWorldKnowledge） | state.vars.taskWorldKnowledge 复用 |
| 11 | `task_completion` | 任务完成评估器 | ❌ 未实现 | — |
| 12 | `mini_game_intent` | 小游戏动作解析 | ❌ 未实现 | — |
| 13 | `mini_game_mentor_speech` | 小游戏角色台词 | ❌ 未实现 | — |
| 14 | `mini_game_sell_intent` | 小游戏卖出意图解析 | ❌ 未实现 | — |
| 15 | `free_task_resolution` | 自由章节任务裁决 | ❌ 未实现 | — |
| 16 | `free_task_blueprint` | 自由章节任务蓝图生成 | ❌ 未实现 | — |
| 17 | `orchestrate_options` | 编排选项生成器 | ❌ 未实现 | — |
| 18 | `play_tip` | 玩家提示器 | ❌ 未实现 | — |

**已实现 5/18，未实现 13/18。**

---

## 已实现 Agent 的注入位置

| Agent | prompt 中的标签 | 注入方式 |
|-------|---------|------|
| 剧情编排师 | `【世界知识】` section（NarrativeOrchestrator.ts:1735-1736） | `worldKnowledge.join("\n\n")` 多条目内容用双换行拼接 |
| 角色发言器 | `[世界知识]` 行（NarrativeOrchestrator.ts:2799-2800） | 同上，插入 `[世界知识]` 标签 |
| 记忆管理器 | `【世界知识】` 行（NarrativeOrchestrator.ts:3043-3044） | 同上；提示词注明**仅参考、不照抄**进 summary/facts |
| 任务编排师（taskDirector） | `【世界知识】` 行（SessionService.ts:1472，`buildWorldKnowledgeText`） | `buildWorldKnowledgeText(entries, scanText, 800, "task_director")` 返回拼接字符串，存入 `state.vars.taskWorldKnowledge` |
| 任务发言器（taskSpeaker） | 复用 taskDirector 的 `state.vars.taskWorldKnowledge` | SessionService.ts 预存，TaskSpeaker 直接读取复用 |

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
  - 任务编排师：playerMessage + dialogue
