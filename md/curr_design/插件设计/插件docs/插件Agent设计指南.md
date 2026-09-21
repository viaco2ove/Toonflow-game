# 插件 Agent 设计指南

> AI Agent 如何理解插件、如何编排插件行为、如何与插件状态交互。
> 与 `NarrativeOrchestrator`、`MiniGameIntentService`、`MiniGameController` 完全对齐。
> 最后更新：2026-09-21

---

## 一、插件在 AI 叙事体系中的位置

```
用户输入
    ↓
NarrativeOrchestrator.orchestrateSessionTurn()
    ↓
┌─ MiniGameController.handleMiniGameTurn() ─────────────────────┐
│  1. isMiniGameActiveState(state) → 检查是否在小游戏中          │
│  2. resolveMiniGameIntent() → AI 意图解析                    │
│     └→ MiniGameIntentService.resolveMiniGameIntentByAi()      │
│        └→ entry.py · get_intent_prompt()                     │
│  3. applyAction() → entry.py · apply_action()                │
│  4. writeback 合并 → session.state                          │
│  5. pendingNarrativePlan → NarrativeOrchestrator             │
└──────────────────────────────────────────────────────────────┘
    ↓
SessionService.commitNarrativeTurn()
    ↓
AI 编排 → streamlines → streamvoice → addMessage → 前端展示
```

**AI 看到的游戏内容全部来自 `public_state` 和 `ui.narration`**。

---

## 二、AI 理解插件的两个阶段

### 阶段 1：触发识别（Trigger Recognition）

当用户说"我想去野外探险"时，AI 需要知道：
- 这句话可能对应哪个插件（`field_survival`）
- 如何用标准格式响应触发

**实现方式：** AI 的 System Prompt 中注入 `entry.py · get_trigger_prompt()` 的内容。

```
AI 看到：
## 小游戏触发：野外生存 (#field_survival)
当用户表达以下意图时，触发野外生存小游戏：
- "我想去野外探险/挑战/战斗"
- "#{field_survival}" 或 "#野外生存"
...
```

### 阶段 2：游戏中意图解析（In-Game Intent）

当用户在游戏中输入"放火球术"时，AI 需要：
- 理解用户想要释放技能
- 将文字映射为 `action_id`（`use_skill`）
- 附加参数（`skill: "fire_ball"`）

**实现方式：** AI 调用 `MiniGameIntentService.resolveMiniGameIntentByAi()`，
该服务注入 `entry.py · get_intent_prompt()` 的内容。

---

## 三、AI 看到的游戏状态

AI **不**直接访问插件内部状态，只能通过以下渠道：

### 3.1 public_state（核心）

```typescript
// MiniGameController.ts 中注入到 AI context 的内容
const gameSummary = `
当前小游戏：野外生存
波次：3/5
HP：80/100 · MP：30/50
存活敌人：2只（灰狼3型 HP:25, 异兽狼2型 HP:40）
状态：战斗中
最近行动：你施放了火球术，对全体敌人造成35点伤害
`;
// 注入到 NarrativeOrchestrator 的 worldKnowledge 或 session context
```

### 3.2 ui.narration（AI 生成的叙事文本）

```json
{
  "ui": {
    "narration": "第3波开始了，3只怪物咆哮着冲向你！",
    "state_items": [
      {"key": "当前波次", "value": "3/5"},
      {"key": "生命值", "value": "80/100"}
    ],
    "input_hint": "输入指令或使用技能按钮进行操作"
  }
}
```

### 3.3 AI 不应知道的内部数据

以下数据**不在** AI 的可见范围内（防止作弊）：

```typescript
// AI 不可见
miniGameRoot.session.writeback    // 待写入的状态（未合并）
miniGameRoot.actionLog           // 历史动作日志（可选择性注入）
miniGameRoot.memorySummary        // AI 的游戏记忆摘要
```

---

## 四、如何设计 AI 的插件行为

### 4.1 提示词设计原则

```
entry.py · get_trigger_prompt() 设计要点：

1. 触发条件要具体 + 包含变体表达
   ✅ "我想去野外探险/挑战/战斗"
   ❌ "用户想玩户外游戏"

2. 触发后用标准 JSON 格式响应（对齐 MiniGameIntentSchema）
   {
     "action_id": "field_survival",
     "target_name": "",
     "reason": "用户想进行野外生存挑战"
   }

3. 包含规则摘要（AI 在编排旁白时使用）
```

### 4.2 意图解析提示词设计

```
entry.py · get_intent_prompt() 设计要点：

1. 列出所有 action_id + 中文别名
   - "攻击/砍/打" → attack
   - "用火球/放技能" → use_skill
   - "喝血瓶/用药" → use_item

2. 当前状态要简洁（5行以内）
   波次/HP/MP/敌人数量/最近动作

3. 边界情况要覆盖
   - MP不足时：提示"MP不足，无法使用该技能"
   - 物品不存在：提示"背包中没有该物品"
```

### 4.3 旁白生成指南

当 AI 需要为小游戏生成旁白时，遵循以下原则：

```typescript
// ✅ 好的旁白
"第3波开始了，3只怪物咆哮着冲向你！"
"你挥剑斩向灰狼，造成18点伤害！灰狼倒下了。"

// ❌ 不好的旁白（泄露内部数据）
"你攻击了 enemy_3_1（HP:25→7，ATK:12，DEF:3）"
"use_skill action_id 解析为 fire_ball"

// ❌ 连续播报过多（AI 生成旁白要克制）
"你攻击了...你施放了...你使用了...敌人反击了..."
// → 应该让 entry.py 的 pending_narrative_plan 控制播报节奏
```

---

## 五、编排计划（Pending Narrative Plan）

当插件需要 AI 生成播报内容时，通过 `pendingNarrativePlan` 注入：

```typescript
// entry.py apply_action() 返回
{
  "pending_narrative_plan": {
    "role": "narrator",           // narrator / npc / player
    "roleType": "narrator",
    "eventType": "mini_game_narration",
    "content": "第3波开始了，3只怪物咆哮着冲向你！"
  }
}

// MiniGameController.ts 接收后：
pendingNarrativePlan = {
  role: "narrator",
  roleType: "narrator",
  content: stepResult.pendingNarrativePlan.content,
  eventType: "mini_game_narration",
  speakerMode: "premium",  // 流式语音输出
  // 走 orchestration → streamlines → streamvoice 通道
}
```

**多消息编排**（需要 NPC 说话时）：

```typescript
// entry.py apply_action() 返回
{
  "messages": [
    {
      "role": "narrator",
      "roleType": "narrator",
      "eventType": "mini_game_narration",
      "content": "你击败了第3波所有敌人！"
    },
    {
      "role": "npc",
      "roleType": "npc",
      "eventType": "mini_game_narration",
      "content": "不错，继续保持！"
    }
  ]
}
```

---

## 六、消息发送控制

### 6.1 插件如何发送消息到故事

插件**不直接发送消息**，而是通过 `pendingNarrativePlan` / `messages` 让 AI 代为生成并编排。

```
entry.js (前端)
    ↓ dispatchAction("attack", {...})
entry.py (后端) apply_action()
    ↓ 返回 pendingNarrativePlan
MiniGameController
    ↓ pendingNarrativePlan
NarrativeOrchestrator
    ↓ 编排 AI
    ↓ streamlines + streamvoice
    ↓ addMessage
前端展示
```

### 6.2 紧急消息（不需要 AI 生成）

```python
# entry.py 中，当状态变化需要即时反馈时，使用 ui_update.narration
# AI 会自动把 narration 字段作为旁白文本输出（不需要二次生成）
ui_update = {
    "narration": "HP不足，无法使用该技能！",  # AI 直接复用
}
```

### 6.3 NPC 对话控制

```python
# 方式1：AI 生成（推荐）
pending_narration = ""  # 空，让 AI 自己生成
mentor_speech = "很好，保持这个节奏！"  # 提供线索，AI 生成台词

# 方式2：固定台词（简单场景）
pending_narration = "陪练NPC点了点头：'不错，你的攻击很果断。'"

# 方式3：完全不发言
pending_narration = "敌人被击败了。"  # 只播报结果，不触发 NPC 对话
```

---

## 七、插件间协作

### 7.1 事件总线

```javascript
// entry.js 中
// 插件 A 广播
ctx.bus.emit("role:hp_changed", { roleId: "player", hp: 75, maxHp: 100 });

// 插件 B 监听
ctx.bus.on("role:hp_changed", ({ roleId, hp, maxHp }) => {
  if (roleId === "player") {
    updateHpBar(hp, maxHp);
  }
});
```

### 7.2 跨插件数据共享

```
ctx.state.vars.my_plugin_shared_data = {...}
ctx.state.inventory                   // 物品栏全局共享
ctx.state.player.parameterCardJson   // 参数卡全局共享
```

### 7.3 跨 Agent 协作

```
故事 Agent（NarrativeOrchestrator）
    ↓ 触发 field_survival 插件
野外生存 Agent（MiniGameIntentService）
    ↓ 奖励发放（装备变化）
装备管理 Agent（如果存在）
    ↓ 更新参数卡
故事 Agent
    ↓ 继续编排
```

---

## 八、调试与日志

### 8.1 AI 调试日志

```typescript
// 在 MiniGameIntentService.ts / MiniGameController.ts 中
DebugLogUtil.log("[aiGame][miniGame] AI 识别意图", {
  userInput: ctx.playerMessage,
  recognizedAction: result.actionId,
  targetName: result.targetName,
  confidence: result.reason,
  logMeta: result.logMeta,  // token 使用量、耗时等
});
```

### 8.2 插件调试提示

```python
# entry.py 中
def apply_action(state, action_id, params, ctx=None):
    print(f"[field-survival] apply_action: {action_id}, params={params}")
    # ...
```

### 8.3 前端调试

```javascript
// entry.js 中
function debugState() {
  const state = getMiniGameState();
  console.table(state.publicState);
  console.table(state.ui);
}
```

---

## 九、示例：野外生存插件的 AI 提示词

```python
def get_trigger_prompt(ctx=None):
    return """
## 小游戏触发：野外生存 (#field_survival)

当用户表达以下意图时，触发野外生存小游戏：
- "我想去野外探险"、"去荒野挑战"、"进入野外"
- "#{field_survival}" 或 "#野外生存"
- 用户描述要进入充满危险的环境

触发后响应格式：
{"action_id": "field_survival", "target_name": "", "reason": "..."}

规则摘要：
- 5-10波怪物，每波击败后有准备期
- 可用攻击、技能、物品
- 击败所有波次获得经验、金币和物品奖励
- HP归零则挑战失败
""".strip()


def get_intent_prompt(current_state, available_actions, ctx=None):
    action_list = "\n".join(
        f"- `{aid}`: {label}"
        for aid, label in available_actions
    )
    return f"""
## 野外生存 意图解析

当前状态：
- 波次：{current_state.get('current_wave', 0)}/{current_state.get('wave_count', 5)}
- HP：{current_state.get('player_hp', 0)}/{current_state.get('player_max_hp', 100)}
- MP：{current_state.get('player_mp', 0)}/{current_state.get('player_max_mp', 50)}
- 存活敌人：{current_state.get('active_enemy_count', 0)}只

可用动作：
{action_list}

解析规则：
- "攻击/砍/打" → attack
- "火球/放技能/用技能" → use_skill（需要从params.skill获取技能名）
- "血瓶/喝药/用药" → use_item（需要从params.item获取物品名）
- "下一波/继续/前进" → next_wave
- "退出/不玩了" → exit_game

MP不足时：提示用户"MP不足，该技能需要XX点MP"
物品不存在时：提示用户"背包中没有该物品"
""".strip()
```