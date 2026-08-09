# 游玩业务 AI Agent 列表

> 收录 `toonflow-game-app` 中所有调用 AI 模型生成游戏叙事内容的 Agent，共 16 个（2026-08 整理）

---

## 一、主演示编排 Agent（自由模式 / 章节模式）

### 1. 剧情编排师（Narrative Orchestrator）
| 属性 | 内容 |
|------|------|
| **入口函数** | `NarrativeOrchestrator.ts` → `runNarrativePlan()` |
| **调用 AI** | `u.ai.text.invoke()` → `storyOrchestratorModel` |
| **用途** | 核心叙事编排引擎。输入对话历史 + 世界上下文 + 事件图，输出角色/旁白发言计划（role / roleType / motive / eventType 等） |
| **调用位置** | `SessionService.ts` → `orchestrateSessionTurnInner()` → `runConcurrentSessionJudgeAndNarrative()` |
| **所在文件** | `src/modules/game-runtime/engines/NarrativeOrchestrator.ts:4827` |

### 2. 角色发言器（Story Speaker）
| 属性 | 内容 |
|------|------|
| **入口函数** | `runStorySpeakerContent()` |
| **调用 AI** | `u.ai.text.invoke()` → `storySpeakerModel`（或 `storyFastSpeakerModel`） |
| **用途** | 给定编排师输出的 role/motive，生成 NPC 或旁白的具体台词（流式） |
| **调用位置** | `NarrativeOrchestrator.ts:5054`（编排后触发）、`streamlines.ts` |
| **所在文件** | `src/modules/game-runtime/engines/NarrativeOrchestrator.ts:4358` |

### 3. 记忆管理器（Story Memory Manager）
| 属性 | 内容 |
|------|------|
| **入口函数** | `runStoryMemoryManager()` / `refreshStoryMemoryBestEffort()` |
| **调用 AI** | `u.ai.text.invoke()` → `storyMemoryModel` |
| **用途** | 根据当前叙事进展更新动态全局背景、提取事件摘要、NPC 当前行为，维护"世界正在发生什么" |
| **调用位置** | `NarrativeOrchestrator.ts:5705`（编排后后台刷新） |
| **所在文件** | `src/modules/game-runtime/engines/NarrativeOrchestrator.ts:5097` |

### 4. 意图分类器（Intent Classifier）— 快速路径
| 属性 | 内容 |
|------|------|
| **入口函数** | `classifyIntentWithAi()` |
| **调用 AI** | `u.ai.text.invoke()` → `intentClassifierModel` |
| **用途** | 理解玩家输入，识别是否为正常对话/任务意图/退出意图/系统指令 |
| **调用位置** | `IntentClassifier.ts:175` |
| **所在文件** | `src/modules/game-runtime/agents/intentAnalyzer/IntentClassifier.ts:175` |

### 5. 章节结局判定器（Chapter Outcome Judge）
| 属性 | 内容 |
|------|------|
| **入口函数** | `evaluateChapterOutcomeByAi()` |
| **调用 AI** | `u.ai.text.invoke()` → `storyChapterJudgeModel` |
| **用途** | 判断当前叙事是否满足章节结束条件（success / failed / continue / guide），含规则兜底 |
| **调用位置** | `ChapterRuntimeService.ts:469` → `evaluateRuntimeOutcome()` |
| **所在文件** | `src/modules/game-runtime/services/ChapterRuntimeService.ts:469` |

### 5b. 事件进度判定器（Event Progress Judge）
| 属性 | 内容 |
|------|------|
| **入口函数** | `evaluateEventProgressByAi()` |
| **调用 AI** | `u.ai.text.invoke()` → `storyEventProgressModel`（fallback: `storyChapterJudgeModel` → `storyOrchestratorModel`） |
| **用途** | AI 检测当前章节事件是否已结束，生成进度摘要和事件事实。用于事件图推进 |
| **调用位置** | `EventProgressRuntimeService.ts:530` |
| **所在文件** | `src/modules/game-runtime/services/EventProgressRuntimeService.ts:530` |

### 6. 存档智能对齐（Story Update Align）
| 属性 | 内容 |
|------|------|
| **入口函数** | `runStoryUpdateAlignAgent()` |
| **调用 AI** | `u.ai.text.invoke()` → `storyMemoryModel` |
| **用途** | 玩家长时间离开后，重新进入时用 AI 对齐存档摘要与近期事件，避免记忆丢失 |
| **调用位置** | `SessionService.ts:5054` |
| **所在文件** | `src/modules/game-runtime/agents/storyUpdateAlign/StoryUpdateAlignAgent.ts:94` |

---

## 二、任务模式 Agent（Task Mode）

任务模式复用主叙事引擎，但有独立的 4-Agent 链路。

### 7. 任务进度评估器（Task Progress Agent）
| 属性 | 内容 |
|------|------|
| **入口函数** | `evaluateTaskProgress()` |
| **调用 AI** | `u.ai.text.invoke()` → `storyEventProgressModel` |
| **用途** | 判定当前意图对任务推进的影响（advance / retreat / stuck / clarify 等等级） |
| **调用位置** | `TaskModeOrchestrator.ts:67`；`SessionService.ts:1552` |
| **所在文件** | `src/modules/game-runtime/agents/taskMode/TaskProgressAgent.ts:336` |

### 8. 任务剧情编排师（Task Director Agent）
| 属性 | 内容 |
|------|------|
| **入口函数** | `directTaskNarrative()` |
| **调用 AI** | `u.ai.text.invoke()` → `storyOrchestratorModel` |
| **用途** | 根据进度等级编排任务中 NPC/旁白的发言动机（motive）和事件类型 |
| **调用位置** | `TaskModeOrchestrator.ts:93`；`SessionService.ts:1721` |
| **所在文件** | `src/modules/game-runtime/agents/taskMode/TaskDirectorAgent.ts:218` |

### 9. 任务角色发言器（Task Speaker Agent）
| 属性 | 内容 |
|------|------|
| **入口函数** | `generateTaskSpeech()` |
| **调用 AI** | `u.ai.text.invoke()` → `storyOrchestratorModel` |
| **用途** | 给定 Director 的任务发言计划，生成 NPC 的具体台词（流式） |
| **调用位置** | `TaskModeOrchestrator.ts:109` |
| **所在文件** | `src/modules/game-runtime/agents/taskMode/TaskSpeakerAgent.ts:172` |

### 10. 任务完成评估器（Task Completion Agent）
| 属性 | 内容 |
|------|------|
| **入口函数** | `evaluateTaskCompletion()` |
| **调用 AI** | `u.ai.text.invoke()` → `storyMemoryModel` |
| **用途** | 评估任务是否成功/失败/放弃，生成完成旁白和后续建议 |
| **调用位置** | `TaskModeOrchestrator.ts:174`；`SessionService.ts:1496/1615/1655` |
| **所在文件** | `src/modules/game-runtime/agents/taskMode/TaskCompletionAgent.ts:228` |

---

## 三、小游戏 Agent

### 11. 小游戏动作解析（Mini Game Intent）
| 属性 | 内容 |
|------|------|
| **入口函数** | `analyzeMiniGameIntent()` |
| **调用 AI** | `u.ai.text.invoke()` → `storyMiniGameModel`（fallback: `storyEventProgressModel` → `storyOrchestratorModel`） |
| **用途** | 解析玩家对小游戏的操作输入，返回程序可执行的指令 |
| **调用位置** | `MiniGameIntentService.ts:202` |
| **所在文件** | `src/modules/game-runtime/services/MiniGameIntentService.ts:202` |

### 12. 小游戏角色台词（Mini Game Mentor Speech）
| 属性 | 内容 |
|------|------|
| **入口函数** | `buildMiniGameMentorSpeech()` |
| **调用 AI** | `u.ai.text.invoke()` → `storyMiniGameModel`（fallback 同上） |
| **用途** | 为小游戏中的 NPC 角色生成引导台词 |
| **调用位置** | `MiniGameController.ts:1034` |
| **所在文件** | `src/modules/game-runtime/engines/MiniGameController.ts:1030` |

### 12b. 小游戏卖出意图解析（Mini Game Sell Intent）
| 属性 | 内容 |
|------|------|
| **入口函数** | `resolveSellIntent()` |
| **调用 AI** | `u.ai.text.invoke()` → `storyMiniGameModel`（fallback: `storyEventProgressModel` → `storyOrchestratorModel`） |
| **用途** | 解析玩家自然语言卖出指令（如 "#卖出 青鱼"），匹配物品名称并计算价格 |
| **调用位置** | `MiniGameSellService.ts:200` |
| **所在文件** | `src/modules/game-runtime/services/MiniGameSellService.ts:200` |

---

## 四、自由章节任务 Agent

### 13. 自由章节任务裁决（Free Chapter Task Resolution）
| 属性 | 内容 |
|------|------|
| **入口函数** | `evaluateFreeTaskResolutionByAi()` |
| **调用 AI** | `u.ai.text.invoke()` → `storyOrchestratorModel` |
| **用途** | 裁决自由章节任务是否成功/失败/继续，生成裁决旁白和奖励摘要 |
| **调用位置** | `FreeChapterTaskService.ts:870` → `maybeResolveActiveFreeChapterTaskEvent()` |
| **所在文件** | `src/modules/game-runtime/services/FreeChapterTaskService.ts:870` |

### 14. 自由章节任务蓝图生成（Free Chapter Task Blueprint）
| 属性 | 内容 |
|------|------|
| **入口函数** | `generateFreeChapterTaskBlueprintByAi()` |
| **调用 AI** | `u.ai.text.invoke()` → `storyOrchestratorModel` |
| **用途** | 将自由章节任务简报升级为完整可执行蓝图（含流程步骤、成功条件、失败条件） |
| **调用位置** | `FreeChapterTaskService.ts:1007` → `maybeActivateFreeChapterTaskEvent()` / `createTaskFromUserRequest()` |
| **所在文件** | `src/modules/game-runtime/services/FreeChapterTaskService.ts:1007` |

---

## 五、辅助 Agent

### 15. 编排选项生成器（Orchestrate Options Agent）
| 属性 | 内容 |
|------|------|
| **入口函数** | `runOrchestrateOptionsAgent()` |
| **调用 AI** | `u.ai.text.invoke()` → `storyOrchestratorModel` |
| **用途** | 生成多条候选编排选项供玩家选择（换一换功能） |
| **调用位置** | `OrchestrateOptionsAgent.ts` → `/game/getOrchestrateOptions` |
| **所在文件** | `src/modules/game-runtime/agents/orchestrateOptions/OrchestrateOptionsAgent.ts` |

### 16. 玩家提示器（Play Tip Agent）
| 属性 | 内容 |
|------|------|
| **入口函数** | `runPlayTipAgent()` |
| **调用 AI** | `u.ai.text.invoke()` → `storyOrchestratorModel` |
| **用途** | 生成 3 条不同方向的第一人称玩家行动提示（快捷输入建议） |
| **调用位置** | `PlayTipAgent.ts` → `/game/getPlayTips` |
| **所在文件** | `src/modules/game-runtime/agents/playTip/PlayTipAgent.ts` |

---

## 五、模型配置映射汇总

| 模型 Key | 用途 | 主要使用 Agent |
|----------|------|----------------|
| `storyOrchestratorModel` | 主编排 + 任务引导 | Narrative Orchestrator、Task Director、Task Speaker、Orchestrate Options、Play Tip、Free Chapter Task |
| `storySpeakerModel` | 角色发言 | Story Speaker |
| `storyFastSpeakerModel` | 快速发言 | Story Speaker（降级路径） |
| `storyMemoryModel` | 记忆管理 | Memory Manager、Task Completion、Story Update Align |
| `storyEventProgressModel` | 事件进度 | Task Progress、Event Progress Judge、Mini Game Intent/Sell（fallback） |
| `storyChapterJudgeModel` | 章节判定 | Chapter Outcome Judge、Event Progress Judge（fallback） |
| `storyMiniGameModel` | 小游戏 | Mini Game Intent、Mini Game Mentor Speech、Mini Game Sell Intent |
| `intentClassifierModel` | 意图分类 | Intent Classifier（快速路径） |

---

## 六、Agent 调用链路图

```
玩家输入
  │
  ├─► Intent Classifier（快速规则） ──► normal_dialog / exit_task / system_command / game_action / ...
  │
  └─► [AI 路径] Intent Classifier ──► classifyIntentWithAi()
                                       │
                              ┌────────┴────────┐
                              ▼                 ▼
                         正常对话           任务模式
                              │                 │
                              ▼                 ├─► Task Progress Agent
                       Narrative Orchestrator   │
                              │                 ├─► Task Director Agent
                       ┌──────┴──────┐          │
                       ▼             ▼          ▼
                  Story Speaker   Memory Manager  Task Speaker Agent
                  （流式台词）     （后台刷新）
                       │
                       ▼
                  [语音合成 + 播放]

───────────────────────────────────────────────

自由章节任务：
  玩家发起任务 ──► Blueprint 生成（AI）──► 任务进行 ──► Resolution 裁决（AI）
                    Free Chapter Task Blueprint      Free Chapter Task Resolution

小游戏：
  玩家输入 ──► Mini Game Intent 解析（AI）──► 程序结算 ──► Mentor Speech（AI）
               Mini Game Intent                         Mini Game Mentor Speech

卖出指令：
  #卖出 物品 ──► Sell Intent 解析（AI）──► 结算
               Mini Game Sell Intent
```

---

## 七、注意事项

- **Mini Game Intent** 有三级 fallback：`storyMiniGameModel` → `storyEventProgressModel` → `storyOrchestratorModel`
- **意图分类** 有快速路径（规则匹配）和慢速路径（AI 分类），快速命中时跳过一次 AI 调用
- **记忆管理** 是后台异步刷新（`refreshStoryMemoryBestEffort`），不阻塞主叙事流
- 所有 Agent 均通过 `u.ai.text.invoke()` 统一调用，`u.getPromptAi(modelKey, userId)` 解析模型配置
