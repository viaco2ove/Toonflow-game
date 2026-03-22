# Toonflow 游戏化改造交付（task1）

## 0. 任务结论
你这个项目不是“从 0 做 AI 游戏”，而是“把已有创作系统升级为可游玩的 AI 叙事游戏系统”。

可行路线：
1. 保留现有创作链路（outline/script/storyboard/video/voice）。
2. 把 `game` 模块从“数据 CRUD”升级为“状态驱动运行时（Game Runtime）”。
3. 新增 Android 双模式端（游玩 + 创建编辑），Web 同步提供全流程入口（不仅创作台）。

## 1. 现状评估（基于代码）

### 1.1 已经有的基础（不是从零）
1. 已有游戏核心表：`t_storyWorld`、`t_storyChapter`、`t_chapterTask`、`t_chapterTrigger`、`t_gameSession`、`t_sessionMessage`、`t_sessionStateSnapshot`、`t_entityStateDelta`。
2. 已有游戏路由：`/game/startSession`、`/game/addMessage`、`/game/getSession`、`/game/getTask`、`/game/getTrigger`、`/game/getWorld`、`/game/save*`。
3. 已有语音转写路由：`/voice/transcribe`。

### 1.2 当前主要问题
1. 创作域与游玩域边界不清，路由平铺，缺少“运行时编排层”。
2. 任务树/触发器是配置数据，但缺少统一执行器（Trigger Runtime + Chapter Progress Evaluator）。
3. 前端交互以创作为主，游玩端体验和状态可视化不足。
4. 存档虽有表，但“快照策略、回放策略、冲突策略”未形成标准。

## 2. UI 设计方案

### 2.1 PC（Creator Studio）布局
目标：面向“创作+调试”，不是面向最终玩家。

推荐三栏布局：
1. 左栏（资源树）
- 世界观
- 章节树
- 任务树
- 触发器
- 角色库（玩家/旁白/NPC）

2. 中栏（主编辑区）
- 上：剧情编辑器（章节概要 + 场景节点）
- 中：任务树图编辑器（主线/支线/隐藏）
- 下：触发器规则编辑器（条件表达式 + 动作表达式）

3. 右栏（实时预览与调试）
- 会话状态（chapterId / flags / vars / attributes）
- 最近事件日志（触发器命中、状态变更）
- 对话模拟器（可手动输入消息测试）

### 2.2 Android（Player + Creator）布局
目标：游玩与创作双模式共存，保持低学习成本。

页面建议（按当前需求清单）：
1. 主页：随机推荐故事 + 输入框 + 互动数据。
2. 故事大厅：分类 + 搜索 + 故事卡片流。
3. 创建故事：角色页（用户固定、旁白特殊）+ 章节编辑 + 发布信息。
4. 聊过：游玩记录列表（最新在前，点击继续聊）。
5. 我的：账号资料、草稿箱、已发布故事、设置入口。
6. 游玩页：默认单条展示 + 历史记录模式切换。
7. 故事设定弹层：简介、角色列表、对话模式、分享/回溯等动作。
8. 交互层：长按菜单（复制/重听/点赞/点踩/改写）、语音/文字切换、AI 提示回答。

关键交互规则：
1. 用户在主页/故事大厅输入首句后，自动写入“聊过”并置顶。
2. 语音输入自动转文字并纠错；切到文本模式后需手动切回语音模式。
3. 章节结局可为空（AI 持续编排），并支持“结局条件对用户可见”开关。

## 3. 架构改造（后端 / Web / 安卓）

### 3.1 后端分层（在现有 Node/TS 上增量改）
按模块拆，不建议直接拆微服务：

1. `authoring`（创作域）
- 继续承接 outline/script/storyboard/video/asset。

2. `game-content`（游戏内容域）
- 世界观、章节、任务树、触发器、角色模板管理。

3. `game-runtime`（运行时域，新增核心）
- SessionManager
- TriggerEngine
- TaskProgressEngine
- StateStore
- NarrativeOrchestrator

4. `ai-gateway`（模型网关）
- 对话生成
- ASR/TTS
- 降级与重试

5. `telemetry`（可观测）
- 事件日志
- 状态变更日志
- API 性能指标

### 3.2 Web 端职责
1. Full Flow Web：覆盖主页、故事大厅、创建故事、聊过、我的、设置、游玩交互。
2. Creator Studio：继续承载高效批量编辑与章节调试能力。
3. Ops Console：查看真实玩家会话、故障诊断与质量统计。

### 3.3 Android 端职责
1. Player + Creator Client：游玩与创建编辑一体化客户端。
2. 本地缓存层：离线消息缓存、草稿缓存、失败重发、快速恢复。
3. 实时通信：HTTP + WebSocket（流式对话/状态同步）。
4. 媒体能力：语音转写、语音重听、图片与音频素材上传。

## 4. 核心流程（正确闭环）

### 4.1 创作发布流程
1. 创作（Web/Android 均可）：世界观/章节/任务/触发器。
2. 调试：PC 模拟会话，验证触发器命中。
3. 发布：章节版本冻结（content_version）。
4. 游玩：新会话绑定 content_version。

### 4.2 游玩运行流程
1. 客户端 `startSession`。
2. 玩家输入（文本或 ASR）。
3. 若是主页/大厅首句输入：写入“聊过”并置顶。
4. `addMessage` 写日志。
5. TriggerEngine 执行动作。
6. TaskProgressEngine 判定任务变化。
7. NarrativeOrchestrator 生成下一条叙事输出。
8. 写入 snapshot + delta。
9. 返回客户端并渲染。

## 5. 数据关系（角色 / 故事 / 存档）

### 5.1 关系图（逻辑）
1. `StoryWorld` 1-N `StoryChapter`
2. `StoryChapter` 1-N `ChapterTask`
3. `StoryChapter` 1-N `ChapterTrigger`
4. `StoryWorld` 1-N `GameSession`
5. `GameSession` 1-N `SessionMessage`
6. `GameSession` 1-N `SessionStateSnapshot`
7. `GameSession` 1-N `EntityStateDelta`

### 5.2 角色关系
1. 固定系统角色：`player`、`narrator`（每 world 唯一）。
2. 可变角色：`npc`（章节/事件动态加入）。
3. 每条消息必须标注：`role` + `roleType`。

### 5.3 故事与存档关系
1. 故事配置是“静态内容层”（world/chapter/task/trigger）。
2. 存档是“动态运行层”（session/message/snapshot/delta）。
3. 同一 world 可有多 session；同一 session 必须绑定一个章节进度状态。

## 6. 立刻可执行的改进清单

### 6.1 一周内
1. 建立 `game-runtime` 目录并抽离 TriggerEngine。
2. 在 `addMessage` 中统一调用 TaskProgressEngine。
3. 规范快照策略：每 N 轮 + 关键事件强制快照。
4. 增加 `content_version` 字段并在 `startSession` 固化版本。

### 6.2 两到三周
1. PC 增加“任务树+触发器”可视化编辑与调试面板。
2. Android/Web 首版：主页/大厅/创建故事/聊过/我的/设置/游玩闭环全部打通。
3. 增加回放能力：按 snapshot + delta 重建状态。

### 6.3 四到六周
1. 对话导演（NarrativeOrchestrator）支持多角色调度。
2. 章节完成检测做成可配置策略（规则 + LLM 兜底）。
3. 增加 A/B 机制评估剧情分支质量。

## 7. 目录改造建议（toonflow-game-app）

```txt
src/
  modules/
    authoring/
    game-content/
    game-runtime/
      engines/
        TriggerEngine.ts
        TaskProgressEngine.ts
        NarrativeOrchestrator.ts
      services/
        SessionService.ts
        SnapshotService.ts
      types/
    ai-gateway/
  routes/
    game/
    gameRuntime/
  lib/
```

## 8. 风险与约束
1. 不要把 AI 生成逻辑和状态机逻辑混在一个路由里。
2. 不要跳过快照层直接靠消息重算，后期会崩。
3. 触发器表达式必须可审计，禁止任意脚本执行。
4. 先做“稳定全流程闭环（游玩 + 创建）”，2.5D 先只预留接口。

## 9. 执行顺序（直接干活）
1. 先把后端 runtime 引擎抽出来并跑通一条章节链路。
2. 再补 PC 调试面板（查看触发命中和状态变化）。
3. 最后做 Android/Web 全流程 MVP（主页 + 创建 + 聊过 + 我的 + 游玩 + 设置）。

这条路线可以在保留现有资产生产能力的前提下，把项目从“AI 漫剧工具”升级为“可持续游玩的 AI 游戏”。
