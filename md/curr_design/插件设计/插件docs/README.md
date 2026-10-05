# Toonflow 插件开发文档

> 基于真实代码分析，与现有 `MiniGameController`、`MiniGameStateManager`、`ScenePlay.vue` 完全对齐。
> 最后更新：2026-10-05

---

## 文档索引

| 文档 | 内容 |
|------|------|
| **[插件前端开发指南.md](./插件前端开发指南.md)** | `entry.js` 写法、UI 挂载、事件总线、**reqId 异步结果配对** |
| **[插件后端开发指南.md](./插件后端开发指南.md)** | `entry.ts` 写法、状态读写、奖励发放、**AI 类 action（sys_chat）** |
| **[插件Agent设计指南.md](./插件Agent设计指南.md)** | AI Agent 如何理解插件、如何编排插件行为、**插件专属 agent 注册** |
| **[插件对话链路设计.md](./插件对话链路设计.md)** | ★ 新增：插件内 NPC 对话如何**真实调用大模型**（task-speaker-agent 全链路契约） |
| **[插件API参考.md](./插件API参考.md)** | `ctx`、`plugin`、`api` 所有接口的完整类型定义 + `ctx.tsApi.agent.run` |
| **[插件运行时实现.md](./插件运行时实现.md)** | 安装/卸载/启停插件的后端运行时（PluginRegistry、9 个 HTTP 路由） |
| **[插件前端运行时层.md](./插件前端运行时层.md)** | `usePluginRuntime` composable、命令面板注入、minigame iframe 容器 |

### 2026-10-05 更新要点（依据 `toonflow-game-plugins/md/curr_design/toonflow-field-survival/game.md`）

| 主题 | 变化 |
|------|------|
| 插件内对话 | 新增统一链路 `sendTick("sys_chat")` → 后端 `ctx.tsApi.agent.run("task-speaker-agent")` → 真 LLM → `state.chatResult` 按 `reqId` 回推 |
| 插件专属 agent | `task-speaker-agent`（角色发言器）已注册；`runPluginAgent` 新增「文本进/文本出」分支（无兜底、15s 超时） |
| 新增路由 | `POST /plugin/agentRun`（dev-host 桩代跑 agent，保证 `--conn` 也是真 LLM） |
| 插件数据 | `POST /plugin/data` 支持 `sessionId="all"` → 跨会话共享数据（地图包等资源可独立安装） |
| 异步结果约定 | `/plugin/tick` 回包会被后续 tick 覆盖 → 长耗时结果一律写 `state.xxxResult` + `reqId` 配对 |
| 地图实体 | 实体外观由 `object.gid` 决定，`entity_type` 只决定行为类（NPC/DOOR/CHEST…） |

---

## 核心概念

### 插件与小游戏的关系

Toonflow 的插件系统是**小游戏系统的超集**：

```
插件 (Plugin)
  ├── type: "minigame"     → 挂载到会话界面小游戏面板（与现有 battle/fishing/shop 等平级）
  ├── type: "panel"        → 独立浮层面板（故事主界面之外的独立 UI）
  └── type: "standalone"   → 完全独立页面（不依赖会话 UI）
```

**现有小游戏（如 battle/fishing）其实是内置插件。** 插件系统让你可以把任意小游戏接入同一套运行时。

### 状态分层

Toonflow 会话状态（`session.state`）是 JSON，各层读写路径如下：

```
session.state
├── player
│   └── parameterCardJson       ← 角色参数卡（HP/MP/等级/技能/物品/金币/经验）
├── inventory                   ← 物品栏（{name, kind, rarity}）
├── worldClock                  ← 世界时钟
├── miniGame                    ← 小游戏状态（见下）
├── turnState                   ← 当前回合状态
├── npcs                        ← NPC 运行时状态
└── [vars.*]                    ← 任意自定义变量

miniGame 结构：
{
  session: {
    game_type: "battle" | "fishing" | "field_survival" | ...
    status: "idle" | "preparing" | "active" | "settling" | "finished" | "aborted" | "suspended"
    phase: "ready" | "playing" | "result" | ...
    round: number
    public_state: { ... }       ← 对 AI 可见的游戏状态
  },
  ui: {
    narration: string           ← 当前播报文本（AI 生成）
    state_items: [...]          ← 前端展示的状态条目
    phase_label: string         ← 阶段标签
    rule_summary: string        ← 规则摘要
    input_hint: string          ← 输入提示
    accepts_text_input: boolean
  },
  rulebook: { ... },
  actionLog: [...],
  writeback: { ... },           ← 待写入会话状态的变更
  memorySummary: string
}
```

### 插件在故事对话中的生命周期

```
用户输入 → MiniGameController.handleMiniGameTurn()
           ├── 被动触发（被动模式匹配）→ 自动开启小游戏
           └── 主动触发（#tag 触发）→ 开启小游戏
           ↓
        小游戏状态写入 session.state.miniGame
           ↓
        AI 编排（orchestration → streamlines → streamvoice）
           ↓
        前端 ScenePlay.vue 读取 activeMiniGame → 展开小游戏面板
           ↓
        用户操作 → entry.js 事件总线 → miniGameAction() API
           ↓
        后端 applyAction() → 更新 public_state
           ↓
        writeback 合并到 session.state
           ↓
        结束 → clearMiniGameSession() → 参数卡/物品更新
```

---

## 快速开始

### 第一步：创建插件骨架

```
toonflow-game-plugins/plugins/your-plugin/
├── manifest.json       # 必须：插件元数据
├── entry.js            # 必须：前端入口（选择界面）
├── entry.py            # 推荐：后端逻辑
├── ui/
│   └── game.html       # type=minigame 时：Canvas 游戏页面
│   └── panel.html      # type=panel 时：浮层面板
├── locales/
│   └── zh-CN.json      # 国际化
└── assets/             # 图片/音频资源（可选）
```

### 第二步：注册插件

在 `MiniGameStateManager.ts` 的 `miniGameConfigList` 中添加配置（内置插件），
或通过插件管理器动态注册（用户安装的插件）。

### 第三步：触发方式

- **AI 触发**：在 `entry.py` 的 `get_trigger_prompt()` 中告诉 AI 何时开启
- **用户触发**：在 AI 提示词中包含 `#your_game` 标签，AI 识别后触发
- **UI 触发**：在 `entry.js` 选择面板直接开启

---

## 现有小游戏类型（参考）

| 类型 | 状态路径 | AI 提示 | 触发标签 |
|------|---------|---------|---------|
| battle | `public_state.enemy_list` | MiniGameIntentService | #战斗 |
| fishing | `public_state.current_status` | MiniGameIntentService | #钓鱼 |
| shop | `public_state.*` | MiniGameSellService | #商城 |
| cultivation | `public_state.*` | MiniGameIntentService | #修炼 |
| alchemy | `public_state.*` | MiniGameIntentService | #炼丹 |
| mining | `public_state.*` | MiniGameIntentService | #挖矿 |
| upgrade_equipment | `public_state.*` | MiniGameIntentService | #强化 |
| task | `public_state.*` | FreeChapterTaskService | #任务 |
| werewolf | `public_state.*` | MiniGameIntentService | #狼人杀 |

**自定义插件**（如 field_survival）只需注册新的 `gameType`，其他流程完全一致。
