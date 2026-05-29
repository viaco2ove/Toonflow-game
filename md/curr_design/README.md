# Toonflow AI 游戏系统 - 当前设计文档

> 本文档描述 Toonflow AI 游戏系统的最新设计架构与实现状态。

---

## 1. 项目概述

Toonflow 是一个 AI 短剧与多角色 AI 故事游戏平台，包含两个主要业务线：

1. **AI 短剧 Pipeline**：小说 → 大纲 → 剧本 → 分镜 → AI 图/视频 → 最终视频
2. **多角色 AI 故事游戏**（当前重点）：世界创建 → 章节设计 → 游戏会话 → 角色互动 → 叙事引擎驱动

### 1.1 技术栈

- **后端**：Node.js + TypeScript + Express
- **前端**：Vue3 SPA (Vite + TypeScript)
- **Android**：Kotlin + Compose
- **数据库**：SQLite + Knex
- **AI**：支持 OpenAI/DeepSeek/Anthropic/Google/xAI/阿里通义/智谱 等多模型

---

## 2. 系统架构

### 2.1 分层架构

```
src/
├── routes/                  # 路由层（自动发现）
│   ├── game/              # AI 游戏 API (43+ 端点)
│   ├── novel/, outline/, script/, storyboard/, video/, assets/, setting/, user/
│
├── modules/game-runtime/   # 游戏运行时核心模块
│   ├── engines/           # 引擎层（纯函数，无副作用）
│   │   ├── NarrativeOrchestrator.ts    # 叙事编排引擎
│   │   ├── ChapterProgressEngine.ts    # 章节进度状态机 (~1900行)
│   │   ├── MiniGameController.ts       # 小游戏控制器
│   │   ├── TriggerEngine.ts            # 条件触发器引擎
│   │   ├── RuleOrchestrator.ts         # 规则编排器
│   │   ├── ChapterOutcomeEngine.ts     # 章节结局评估
│   │   ├── SpeakerRouteEngine.ts       # 发言人路由引擎
│   │   └── TaskProgressEngine.ts       # 任务进度引擎
│   ├── services/          # 服务层（带副作用，数据库访问）
│   │   ├── SessionService.ts          # 会话核心服务
│   │   ├── ChapterRuntimeService.ts   # 章节运行时评估
│   │   └── SnapshotService.ts          # 快照服务
│   └── types/             # 类型定义
│       └── runtime.ts
│
├── agents/                # AI Agent 层
│   ├── outlineScript/     # 大纲/剧本生成
│   ├── storyboard/       # 分镜生成
│   └── voicePromptPolish.ts
│
├── lib/                   # 共享库
│   ├── gameEngine.ts      # 核心状态结构 + 状态工具 (~1900行)
│   ├── initDB.ts         # SQLite schema + 初始化数据
│   └── voiceGateway.ts   # 语音服务网关
│
└── utils/                # 工具函数
    └── db.ts             # Knex + SQLite 连接
```

### 2.2 关键设计原则

1. **纯函数状态机**：游戏状态使用纯函数 (`readXxx`/`setXxx`/`upsertXxx`)
2. **事件驱动叙事**：Phase → Event → Turn 三层结构
3. **文件路由自动发现**：`core.ts` 使用 fast-glob 自动从 `src/routes/**/*.ts` 发现路由
4. **Session Lock**：防止同一会话并发编排
5. **Revisit Cache**：消息回溯的内存层 + 数据库持久化
6. **规则优先 + AI 补位**：规则能决定的直接产出，规则无法决定时才调用 AI

---

## 3. 核心状态管理

### 3.1 核心状态结构 (`src/lib/gameEngine.ts`)

| 状态类型 | 用途 |
|---------|------|
| `ChapterProgressState` | 追踪当前 phaseId, phaseIndex, eventIndex, completedEvents |
| `RuntimeDynamicEventState` | 每个事件的状态：phaseId, flowType, runtimeFacts, memorySummary |
| `RuntimeEventDigestState` | 事件摘要 = 动态事件 + 记忆数据 |
| `ChapterRuntimeOutline` | 章节大纲：openingMessages, phases[], userNodes[], fixedEvents[], endingRules |
| `ChapterRuntimePhase` | phase 定义：id, label, kind, allowedSpeakers, nextPhaseIds, completionEventIds |

### 3.2 状态操作函数

- **读取**：`readChapterProgressState`, `readRuntimeDynamicEventState`
- **写入**：`setChapterProgressState`, `upsertRuntimeDynamicEventState`
- **评估**：`evaluateCondition` - 支持结构化条件 + 自然语言条件 + 逻辑组合 (and/or/not/equals/contains/gt)

---

## 4. 游戏运行时引擎

### 4.1 NarrativeOrchestrator (叙事编排引擎)

**职责**：
- AI 提示词编排
- 记忆提示注入
- 轮次状态管理
- 发言者路由
- 叙事计划执行

**核心流程**：
```
用户输入 → addMessage → orchestrateSessionTurn
    ↓
RuleOrchestrator（规则优先决定 speaker）
    ↓
AI Orchestrator（规则无法决定时才调用）
    ↓
Speaker Mode Router（T0模板/T1轻量/T2高质量）
    ↓
streamlines → commitNarrativeTurn → voice async
```

### 4.2 ChapterProgressEngine (章节进度引擎)

**职责**：
- Phase 图遍历
- 事件完成追踪
- 自由章节动态事件处理
- AI 事件进度检测
- 事件完整性验证

**关键方法**：
- `resolveNextPhaseFromGraph`：根据 phase 图解析下一 phase
- `ensureFreeChapterDynamicEventState`：自由章节动态事件状态初始化
- `applyAiEventProgressResolution`：AI 进度检测推进章节

### 4.3 MiniGameController (小游戏控制器)

**支持的游戏类型**：

| 类型 | 描述 |
|------|------|
| `battle` | 战斗系统 |
| `fishing` | 钓鱼系统 |
| `mining` | 挖矿系统 |
| `alchemy` | 炼药系统 |
| `cultivation` | 修炼系统 |
| `research_skill` | 研发技能 |
| `upgrade_equipment` | 升级装备 |
| `werewolf` | 狼人杀 |

**通用架构**：
```json
{
  "mini_game_session": {
    "session_id": "mg_xxx",
    "game_type": "battle",
    "status": "active|finished|aborted",
    "phase": "encounter|action|resolution",
    "round": 1,
    "public_state": {},
    "hidden_state": {},
    "rng_state": { "seed": "", "queue": [] },
    "writeback_whitelist": []
  }
}
```

### 4.4 RuleOrchestrator (规则编排器)

**职责**：
- 规则优先决定下一位 speaker
- 只在规则无法确定时才调用 AI Orchestrator
- 输出 `decisionSource: "rule" | "ai" | "fallback"`

### 4.5 ChapterOutcomeEngine (章节结局引擎)

**职责**：
- 评估 `runtimeOutline.endingRules`
- 评估 `completionCondition`
- 返回 `continue/success/failed`

---

## 5. 服务层

### 5.1 SessionService (会话服务)

**核心方法**：
- `addSessionMessage`：添加用户/NPC消息
- `orchestrateSessionTurn`：编排会话轮次
- `continueSessionNarrative`：继续会话叙事
- `handleMiniGameTurn`：小游戏回合处理

**关键特性**：
- Session Lock：防止同一会话并发编排
- Revisit Cache：`SESSION_REVISIT_HOT` 内存缓存 + DB 持久化
- Chapter Switch：章节切换时重置运行时状态
- Memory Refresh：后台调度记忆刷新

### 5.2 ChapterRuntimeService (章节运行时服务)

**职责**：
- `evaluateRuntimeOutcome`：AI 判断章节结局
- 支持流式输出

---

## 6. API 路由结构

### 6.1 核心游戏 API

| 端点 | 方法 | 描述 |
|------|------|------|
| `/game/startSession` | POST | 开始新游戏会话 |
| `/game/addMessage` | POST | 添加用户/NPC消息 |
| `/game/orchestration` | POST | 叙事编排（支持 debug/session 双模式）|
| `/game/orchestration/minigame` | POST | 小游戏编排 |
| `/game/streamlines` | POST | 流式叙事生成 |
| `/game/commitNarrativeTurn` | POST | 提交叙事轮次 |
| `/game/getSession` | GET | 获取会话详情 |
| `/game/continueSession` | POST | 继续会话叙事 |

### 6.2 内容管理 API

| 端点 | 方法 | 描述 |
|------|------|------|
| `/game/initStory` | POST | 初始化故事/世界 |
| `/game/initChapter` | POST | 初始化章节 |
| `/game/getWorld` | GET | 获取世界信息 |
| `/game/saveWorld` | POST | 保存世界 |
| `/game/getChapter` | GET | 获取章节信息 |
| `/game/saveChapter` | POST | 保存章节 |
| `/game/getTask` | GET | 获取任务 |
| `/game/saveTask` | POST | 保存任务 |
| `/game/getTrigger` | GET | 获取触发器 |
| `/game/saveTrigger` | POST | 保存触发器 |

### 6.3 辅助 API

| 端点 | 方法 | 描述 |
|------|------|------|
| `/game/generateImage` | POST | AI 图片生成 |
| `/game/revisitMessage` | POST | 消息回溯 |
| `/game/previewRuntimeOutline` | POST | 预览运行时大纲 |

---

## 7. 数据模型

### 7.1 核心表结构

```
t_game_world          # 游戏世界
t_game_chapter        # 游戏章节
t_game_session        # 游戏会话
t_game_message        # 会话消息
t_game_snapshot       # 状态快照
t_game_run_parameter  # 游玩中的角色参数
t_project            # 项目
t_novel              # 小说
t_outline            # 大纲
t_script             # 剧本
t_assets             # 素材
t_aiTokenUsageLog    # AI token 使用日志
```

### 7.2 数据关系

```
StoryWorld 1-N StoryChapter
StoryChapter 1-N ChapterTask
StoryChapter 1-N ChapterTrigger
StoryWorld 1-N GameSession
GameSession 1-N SessionMessage
GameSession 1-N SessionStateSnapshot
GameSession 1-N EntityStateDelta
GameSession 1-N GameRunParameter
```

---

## 8. 叙事流程

### 8.1 正常叙事流程

```
用户输入
    ↓
addMessage (写日志)
    ↓
TriggerEngine (执行触发器动作)
    ↓
TaskProgressEngine (判定任务变化)
    ↓
applySessionUserEventProgress (章节进度)
    ↓
evaluateRuntimeOutcome (检查章节是否结束)
    ↓
orchestrateSessionTurn (生成下一条叙事)
    ↓
streamlines (流式生成台词)
    ↓
commitNarrativeTurn (提交轮次)
    ↓
snapshot + delta (写快照)
```

### 8.2 小游戏流程

```
用户输入 "战斗"
    ↓
触发小游戏 (miniGameController)
    ↓
MiniGameStateManager 检测游戏类型
    ↓
MiniGameIntentService 解析用户动作
    ↓
MiniGameController 处理游戏逻辑
    ↓
battleStep 返回下一回合
    ↓
编排通道 → 发言 → 语音
```

---

## 9. 发言分级机制 (T0/T1/T2)

| 级别 | 触发条件 | 特点 |
|------|---------|------|
| **T0 模板** | 旁白、环境补句、万能角色 | 不调用模型，模板拼装，<200ms |
| **T1 轻量** | 普通 NPC、非关键角色 | 低延迟模型，短上下文，1-3s |
| **T2 高质量** | 关键角色、关键节点 | 高质量模型，完整上下文，3-8s |

---

## 10. 三级记忆系统

### 10.1 短期记忆
上下文装载最近聊天记录，适合容量限制。

### 10.2 中期记忆
上下文装载重要的事件和内容。需要记忆管理 agent 挖掘聊天内容，生成记忆目录（索引）。

触发条件：
- 新关系建立/破裂
- 用户做出明确立场选择
- 新任务出现
- 新关键道具出现/消失
- 章节阶段切换
- 章节成功/失败
- 关键角色状态变化

### 10.3 长期记忆
上下文装载故事背景等全局控制情报。

---

## 11. 实现状态

### 11.1 已完成

| 模块 | 状态 | 说明 |
|------|------|------|
| 叙事编排引擎 | ✅ 完成 | 完整的 AI 编排 + 规则编排 |
| 章节进度引擎 | ✅ 完成 | Phase 图遍历 + 事件追踪 |
| 小游戏控制器 | ✅ 完成 | 8 种小游戏类型支持 |
| 触发器引擎 | ✅ 完成 | 条件评估 + 动作执行 |
| 会话服务 | ✅ 完成 | Session Lock + Revisit Cache |
| API 路由 | ✅ 完成 | 43+ 端点 |
| 状态管理 | ✅ 完成 | 纯函数状态操作 |

### 11.2 进行中/待优化

| 模块 | 状态 | 说明 |
|------|------|------|
| 战斗小游戏旁白 | 🔄 进行中 | 硬编码旁白台词需删除，走编排通道 |
| 小游戏全链路日志 | 🔄 进行中 | Web/Android 两端 debug tags |
| 发言分级 (T0/T1/T2) | 🔄 待完善 | 模板直出机制 |
| 规则编排器 | 🔄 待完善 | 规则优先替代 AI 编排 |

### 11.3 验收标准

1. **功能闭环**：创作 → 游玩 → 存档 全流程
2. **性能目标**：
   - T0 模板：<200ms
   - T1 轻量：1-3s
   - T2 高质量：3-8s
3. **稳定性**：无硬编码旁白，全链路 debug tags
4. **类型安全**：`yarn lint` 通过

---

## 12. 设计亮点

### 12.1 规则优先 + AI 补位

```
规则能决定 → 直接产出 speaker
规则不能决定 → 才调用 AI Orchestrator
```

### 12.2 记忆按事件刷新

只有命中关键变化时才触发记忆更新：
- 新关系建立
- 关键道具变化
- 任务切换
- 章节判定

### 12.3 小游戏白名单机制

小游戏结算后只允许回写白名单字段：
- `player_state.resources`
- `player_state.inventory`
- `relationship_state`
- `event_pool.done`

### 12.4 双运行时模式

- **Debug 模式**：无状态，用于调试和开发
- **Session 模式**：有状态，支持存档、回溯

---

## 13. 相关文档

- [编排师设计](./游玩业务/编排师.md)
- [角色发言设计](./游玩业务/角色发言.md)
- [章节判定设计](./游玩业务/章节判定.md)
- [事件管理设计](./游玩业务/事件管理.md)
- [记忆管理设计](./游玩业务/记忆管理.md)
- [角色设计](./游玩业务/角色设计.md)
- [自由章节设计](./游玩业务/自由章节设计.md)
- [游玩时的语音克隆生成](./游玩业务/游玩时的语音克隆生成.md)