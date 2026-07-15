你说得对，我确实偏了。回到最基本的问题，先把事实摆清楚。

---

## 章节内容存哪、读哪

| 问题 | 答案 | 证据 |
|------|------|------|
| 章节内容存在哪 | `t_storyChapter.content` 字段（一张表，草稿和发布共用） | `initDB.ts:1685` |
| 游玩时读的是故事里的还是存档里的 | **读的是故事表里的**（`t_storyChapter` 实时查），不是存档里的 | `SessionService.ts:3857` `db("t_storyChapter").where({id})` |
| 存档里有章节正文吗 | **没有**。存档只存进度指针，不存 `chapter.content` | `gameEngine.ts:2418-2516` normalizeSessionState 全字段 |

**结论**：章节内容根本不在存档里，迁移时不需要"搬"章节内容。你的直觉是对的--章节内容不是重点。

---

## 存档里到底有什么

存档 = `t_gameSession.stateJson`，结构如下：

```
stateJson
├── chapterProgress          ← 进度指针（指向哪个章节的哪个阶段）
│   ├── chapterId            ← 章节ID
│   ├── phaseId              ← 当前阶段标题（如"苏醒"）
│   ├── phaseIndex           ← 阶段索引
│   ├── eventIndex           ← 事件索引
│   ├── eventStatus          ← idle/active/waiting_input/completed
│   ├── eventSummary         ← AI 生成的事件摘要文本
│   ├── completedEvents[]    ← 已完成事件列表 ["phase:苏醒", "userNode:xxx"]
│   └── userNodeId/Index/Status
│
├── dynamicEvents[]          ← 【动态数据核心】AI 运行时生成的事件状态
│   ├── eventIndex
│   ├── phaseId              ← 引用旧版本的 phaseId
│   ├── summary              ← AI 生成的事件摘要
│   ├── runtimeFacts[]       ← AI 提取的运行时事实（如"用户选择了武器A"）
│   └── memorySummary        ← AI 生成的事件记忆摘要
│
├── currentEvent             ← 从 chapterProgress 派生
│   ├── index, kind, summary, facts[], status
│
├── player                   ← 玩家角色卡（含参数卡）
├── narrator                 ← 旁白角色卡
├── npcs{}                   ← NPC 运行时状态（关系值等）
├── inventory[]              ← 背包
├── unlockedRoles[]          ← 已解锁角色
│
├── flags{}                  ← 旗标（如 quest_started: true）
├── vars{}                   ← 变量（如 dialogue_count: 5）
│
├── recentEvents[]           ← 最近事件历史（含 phaseId 引用）
├── miniGame{}               ← 小游戏状态
├── turnState                ← 回合状态
├── memorySummary            ← 全局记忆摘要
└── memoryFacts[]            ← 全局记忆事实
```

---

## 真正的迁移难点：动态数据

你的判断完全正确。迁移的真正难点不是章节内容（它根本不在存档里），而是**AI 在运行时生成的动态数据**。这些数据有三个特征：

### 1. 引用旧版本结构

```
chapterProgress.phaseId = "苏醒"        ← 新版可能改名了或删了
chapterProgress.eventSummary = "用户在..."  ← AI 生成的文本，新版本里没有对应物
dynamicEvents[0].phaseId = "苏醒"        ← 指向旧版本的 phase
dynamicEvents[0].runtimeFacts = [...]   ← AI 提取的事实
recentEvents[0].phaseId = "选择装备"     ← 引用旧版本
```

### 2. 语义不可重建

章节内容改了可以重新读，但这些是**AI 在游玩过程中生成的内容**：
- `eventSummary`：编排师生成的当前事件摘要
- `runtimeFacts`：记忆管理器提取的运行时事实
- `memorySummary`：全局记忆摘要
- `memoryFacts`：全局记忆事实列表

这些文本是"那次游玩经历"的产物，新版章节里不存在对应内容，**没法靠 phase 映射表解决**。

### 3. 互相交织

```
flags["met_merchant"] = true
  ← 这个旗标是在旧版"苏醒"阶段触发器设置的
  ← 新版如果删了"苏醒"阶段，这个旗标变成孤儿
  ← 但 NPC 关系 npcs["merchant"].relationship = 20 又依赖它
```

---

## 所以 AI 迁移应该做什么

**不是迁移章节内容，而是迁移这些动态数据的引用关系**：

| 动态数据 | 迁移策略 | AI 能帮什么 |
|---------|---------|------------|
| `chapterProgress.phaseId` | phase 标题映射 | 判断旧 phase 对应新哪个 phase（语义匹配） |
| `chapterProgress.eventSummary` | 丢弃或重新生成 | AI 可以基于新章节内容重新生成摘要 |
| `dynamicEvents[].phaseId` | 跟随 phase 映射 | 同上 |
| `dynamicEvents[].runtimeFacts` | **保留**（用户经历的事实） | 不需要 AI |
| `dynamicEvents[].memorySummary` | **保留** | 不需要 AI |
| `flags` / `vars` | **原样保留** | 不需要 AI |
| `npcs` / `inventory` | **原样保留** | 不需要 AI |
| `recentEvents[].phaseId` | 跟随 phase 映射或过滤 | 同上 |
| `memorySummary` / `memoryFacts` | **原样保留** | 不需要 AI |

**AI 真正能帮的只有一件事**：判断旧版本的 phaseId 在新版本里对应哪个 phase（语义匹配），以及基于新章节内容重新生成 `eventSummary`。

其他的动态数据（flags/vars/npcs/runtimeFacts/memorySummary）**原样保留就行**，不需要 AI 介入。

---

## 修正后的 AI 迁移设计

**输入应该聚焦在**：
- 旧版 phase 列表 + 旧 phaseId
- 新版 phase 列表
- 当前 eventSummary（让 AI 判断新版本里对应的事件）

**不需要传的**：
- ~~章节完整正文~~（截断 3000 字那个设计是过度工程）
- ~~player/narrator/npcs/inventory/flags/vars~~（原样保留，不迁移）

**输出应该是**：
```json
{
  "phaseMapping": {
    "苏醒": "环境描述",        // 语义匹配
    "开场白": "开场白",        // 精确匹配
    "选择装备": null          // 新版删了
  },
  "newPhaseId": "环境描述",
  "newEventSummary": "用户在环境描述阶段，刚进入新场景...",  // 基于新章节重新生成
  "orphanedFlags": ["quest_started"],  // 标记可能悬空的旗标
  "warnings": ["phase '选择装备' 在新版中不存在，进度已回退到上一个有效阶段"]
}
```

这样 token 消耗极低（只传 phase 标题列表 + 一个 eventSummary），AI 的职责也清晰：**做语义匹配 + 重新生成摘要**，不做全量状态迁移。


## 设计
好问题。这两块确实是上一个设计里漏掉的。先理清它们在 state 里的数据结构和依赖关系。

---

## 角色数据和故事背景在 state 里的位置

```
stateJson
├── player                    ← 来自 world.playerRole + 运行时叠加（HP、等级变化等）
├── narrator                  ← 来自 world.narratorRole + 运行时叠加
├── npcs{}                    ← 来自 world.settings.roles + 运行时叠加（关系值、状态变化等）
├── inventory[]               ← 物品列表
├── unlockedRoles[]           ← 已解锁角色 ID
├── flags{}                   ← 旗标（依赖故事事件，如 "met_merchant": true）
├── vars{}                    ← 变量（如 "merchant_name": "老王"）
├── memorySummary             ← 全局记忆摘要（AI 生成，可能引用旧角色/旧背景）
└── memoryFacts[]             ← 全局记忆事实（AI 生成）
```

**关键特征**：这些数据都是 **world 数据（静态定义）+ 运行时叠加（动态变化）** 的混合体。

---

## 角色变动的四种场景

| 场景 | 旧版 | 新版 | state 里的影响 |
|------|------|------|--------------|
| **新增 NPC** | 无"李四" | 有"李四" | 新 NPC 自动出现在编排 prompt 里（world.settings.roles 实时读），但 session.npcs 里没有运行时状态 |
| **删除 NPC** | 有"老王" | 无"老王" | session.npcs["老王"] 变成孤儿，编排师不会再引用它，但 flags/vars/memoryFacts 里可能还引用"老王" |
| **改名 NPC** | "老王" | "王老板" | session.npcs["老王"] 是孤儿 + world 里有空的"王老板"，运行时关系值丢失 |
| **改参数卡** | 老王 ATK=10 | 老王 ATK=20 | world 里的新参数卡会被 normalizeSessionState 合并进 state，但运行时叠加值（如受伤后 ATK 临时下降）可能冲突 |

**第四种最麻烦**：`normalizeSessionState`（`gameEngine.ts:2418`）在每次编排时都会把 world 的角色定义和 state 的运行时叠加做 merge。新版改了参数卡，merge 后参数卡变了，但运行时叠加（如临时 buff）还指向旧字段。

---

## 故事背景变动的三种场景

| 场景 | 影响 | 是否需要迁移 |
|------|------|------------|
| **globalBackground 改了** | 每轮编排从 `world.settings.globalBackground` 实时读（`NarrativeOrchestrator.ts:596`），新版自动生效 | ❌ 不需要迁移 |
| **flags 变孤儿** | 旧版设了 `flags["quest_A_done"] = true`，新版删了任务A | ⚠️ 不影响运行，但 AI 记忆里可能引用 |
| **vars 引用旧元素** | `vars["merchant_name"] = "老王"`，新版改成了"王老板" | ⚠️ 编排师可能用这个变量生成对话，产生不一致 |

**故事背景本身不需要迁移**（实时读的），但**背景变动产生的连锁影响**（flags/vars/memoryFacts 里的旧引用）需要处理。

---

## 合并后的 AI 迁移设计（完整版）

把角色变动和背景变动纳入上一个设计，**输入增加两组数据，输出增加两组结果**：

### 输入数据

```json
{
  "oldPhases": [...],
  "newPhases": [...],
  "currentProgress": {...},
  "currentDynamicEvent": {...},

  "roleChanges": {
    "oldNpcs": [
      { "id": "merchant", "name": "老王", "roleType": "npc", "description": "村口商人" }
    ],
    "newNpcs": [
      { "id": "merchant", "name": "王老板", "roleType": "npc", "description": "镇上商人" },
      { "id": "guard", "name": "守卫", "roleType": "npc", "description": "城门守卫" }
    ],
    "runtimeNpcState": {
      "merchant": { "relationship": 20, "status": "friendly", "customVars": { "trade_count": 3 } }
    }
  },

  "backgroundChanges": {
    "oldGlobalBackground": "一个小村庄，村民淳朴善良...",
    "newGlobalBackground": "一座繁忙的小镇，商贾云集...",
    "orphanedFlags": {
      "quest_A_done": true,
      "village_chief_met": true
    },
    "orphanedVars": {
      "merchant_name": "老王",
      "village_name": "柳树村"
    },
    "memorySummary": "用户在柳树村遇到了老王，进行了3次交易...",
    "memoryFacts": [
      "用户在柳树村遇到了老王",
      "用户与老王交易了3次",
      "用户完成了村长任务"
    ]
  }
}
```

### System Prompt（在之前基础上追加）

```
你是故事存档迁移专家。你的任务是将用户在旧版故事中的存档进度迁移到新版故事，同时尽可能保留用户的游玩经历。

# 输入说明

你会收到一段 JSON，包含以下数据：

## 章节结构
- oldPhases: 旧版章节的阶段列表，每个阶段含 phaseId、phaseIndex、kind
- newPhases: 新版章节的阶段列表，结构同上

## 当前进度
- currentProgress: 用户当前所在的阶段和事件状态
  - eventIndex: 事件索引
  - phaseId: 当前阶段标题
  - phaseIndex: 阶段索引
  - eventSummary: 当前事件摘要
  - eventKind: 事件类型（opening/scene/user/fixed）
  - eventStatus: 事件状态（idle/active/waiting_input/completed）

## 当前动态事件
- currentDynamicEvent: AI 在运行时为当前事件生成的状态
  - phaseId: 关联的阶段 ID
  - summary: AI 生成的事件摘要
  - runtimeFacts: AI 提取的运行时事实列表（如"用户选择了长剑"）
  - memorySummary: 记忆摘要
  - memoryFacts: 记忆事实列表

## 角色变动
- roleChanges:
  - oldNpcs: 旧版 NPC 列表（id、name、roleType、description）
  - newNpcs: 新版 NPC 列表（结构同上）
  - runtimeNpcState: 旧版 NPC 的运行时状态（关系值、状态等）

## 故事背景变动
- backgroundChanges:
  - oldGlobalBackground: 旧版全局背景描述
  - newGlobalBackground: 新版全局背景描述
  - orphanedFlags: 旧版中存在但新版可能失效的旗标
  - orphanedVars: 旧版中引用了旧元素的变量
  - memorySummary: 旧版的全局记忆摘要
  - memoryFacts: 旧版的全局记忆事实列表

# 迁移规则

## 一、阶段映射

优先级从高到低：
1. 精确匹配：旧版和新版的 phaseId 完全相同 -> 直接映射
2. 语义匹配：phaseId 不同但描述的是同一个场景/事件 -> 映射到新版的对应阶段
3. 无法匹配：旧版阶段在新版中完全没有对应物 -> 返回 null

判断语义相似时考虑：阶段标题的语义、kind 类型是否一致、在章节中的位置是否相近。

## 二、事件摘要重新生成

基于旧版的 eventSummary 和 runtimeFacts，生成符合新版阶段语义的新摘要：
- 新摘要应反映用户之前做了什么（依据 runtimeFacts）
- 用新版的叙事语境表述
- 如果旧阶段在新版中不存在，摘要应说明"用户在此前的旧版阶段完成了..."
- 保持简洁，不超过 100 字

## 三、记忆数据保留

以下数据是用户的游玩经历，必须原样保留，不修改不丢弃：
- runtimeFacts: 运行时事实列表
- memoryFacts: 记忆事实列表

memorySummary 可以微调（将旧版引用替换为新版对应表述），但不丢弃内容。

## 四、角色变动处理

### NPC 映射策略
- ID 相同、名字相同 -> 未变动，不需要处理
- ID 相同、名字不同 -> 标记为"rename"，保留运行时状态，更新名字
- ID 不同、但描述语义相似 -> 标记为"rename"，保留运行时状态，更新 ID 和名字
- 旧版有、新版完全没有 -> 标记为"deleted"，运行时状态保留但不映射
- 新版有、旧版没有 -> 标记为"added"，不需要处理

### 参数卡冲突
- 新版改了角色基础属性（如等级、技能）-> 不处理，运行时叠加值保留
- 新版删了某个属性字段 -> 在 warnings 中标记"可能失效"

### 运行时状态
- relationship（关系值）、customVars（自定义变量）等运行时状态全部保留
- 孤儿 NPC 的运行时状态也保留，不删除

## 五、故事背景变动处理

### 孤儿 flags
- 不删除任何 flag（保留用户经历）
- 在 orphanedFlags 中标记哪些 flag 在新版中可能失效

### 孤儿 vars 修正
- 如果 var 的值引用了旧版元素（如角色名"老王"），尝试映射到新版对应元素（如"王老板"）
- 无法确定映射关系的，保留原值，在 warnings 中说明

### memorySummary 更新
- 将 memorySummary 中的旧版引用替换为新版对应表述
- 例如："用户在柳树村遇到了老王" -> "用户在柳树镇遇到了王老板"
- 如果无法确定映射关系，保留原文，在 warnings 中说明
- memoryFacts 原样保留，不修改

## 六、兜底原则

- 遇到不确定的情况时保守处理：宁可少迁移，也不要错误映射
- 宁可多保留数据，也不要丢失用户经历
- 所有无法处理的情况都写入 warnings
- 不要编造映射关系

# 输出格式

严格输出以下 JSON，不要输出 markdown 围栏，不要输出 JSON 以外的任何文字：

{
  "phaseMapping": {
    "旧phaseId": "新phaseId 或 null"
  },
  "newPhaseId": "映射后的当前阶段ID，无法映射则为 null",
  "newEventIndex": 映射后的事件索引,
  "newEventSummary": "基于新版阶段重新生成的事件摘要",

  "roleMigration": {
    "npcMapping": {
      "旧NPC名": {
        "newId": "新版NPC的ID",
        "newName": "新版NPC的名字",
        "strategy": "rename | deleted | unchanged"
      }
    },
    "orphanedNpcs": ["已删除的NPC名"],
    "newNpcs": ["新增的NPC名"],
    "runtimeStatePreserved": true
  },

  "backgroundMigration": {
    "orphanedFlags": ["可能失效的flag名"],
    "varsUpdated": {
      "变量名": "新值"
    },
    "varsUnmapped": ["无法自动映射的变量名"],
    "newMemorySummary": "更新后的记忆摘要",
    "memoryFactsPreserved": true
  },

  "warnings": ["需要用户注意的警告信息"],
  "summary": "一句话总结迁移结果"
}

# 示例

输入：
{
  "oldPhases": [
    { "phaseId": "开场白", "phaseIndex": 0, "kind": "opening" },
    { "phaseId": "苏醒", "phaseIndex": 1, "kind": "scene" },
    { "phaseId": "选择装备", "phaseIndex": 2, "kind": "user" }
  ],
  "newPhases": [
    { "phaseId": "开场白", "phaseIndex": 0, "kind": "opening" },
    { "phaseId": "环境描述", "phaseIndex": 1, "kind": "scene" },
    { "phaseId": "选择武器", "phaseIndex": 2, "kind": "user" }
  ],
  "currentProgress": {
    "eventIndex": 3,
    "phaseId": "选择装备",
    "phaseIndex": 2,
    "eventSummary": "用户选择了长剑",
    "eventKind": "scene",
    "eventStatus": "waiting_input"
  },
  "currentDynamicEvent": {
    "phaseId": "选择装备",
    "summary": "用户在装备选择界面选择了长剑作为初始武器",
    "runtimeFacts": ["用户选择了长剑", "用户没有选择盾牌"],
    "memorySummary": "用户完成了初始装备选择",
    "memoryFacts": ["初始武器：长剑", "防具：无"]
  },
  "roleChanges": {
    "oldNpcs": [
      { "id": "merchant", "name": "老王", "roleType": "npc", "description": "村口商人" }
    ],
    "newNpcs": [
      { "id": "merchant", "name": "王老板", "roleType": "npc", "description": "镇上商人" },
      { "id": "guard", "name": "守卫", "roleType": "npc", "description": "城门守卫" }
    ],
    "runtimeNpcState": {
      "merchant": { "relationship": 20, "status": "friendly" }
    }
  },
  "backgroundChanges": {
    "oldGlobalBackground": "一个小村庄，村民淳朴善良",
    "newGlobalBackground": "一座繁忙的小镇，商贾云集",
    "orphanedFlags": { "village_chief_met": true },
    "orphanedVars": { "merchant_name": "老王" },
    "memorySummary": "用户在村庄遇到了老王，进行了多次交易",
    "memoryFacts": ["用户在村庄遇到了老王", "用户与老王交易了3次"]
  }
}

输出：
{
  "phaseMapping": {
    "开场白": "开场白",
    "苏醒": "环境描述",
    "选择装备": "选择武器"
  },
  "newPhaseId": "选择武器",
  "newEventIndex": 3,
  "newEventSummary": "用户已完成初始装备选择，选择了长剑作为武器。当前处于新版武器选择阶段。",

  "roleMigration": {
    "npcMapping": {
      "老王": {
        "newId": "merchant",
        "newName": "王老板",
        "strategy": "rename"
      }
    },
    "orphanedNpcs": [],
    "newNpcs": ["守卫"],
    "runtimeStatePreserved": true
  },

  "backgroundMigration": {
    "orphanedFlags": ["village_chief_met"],
    "varsUpdated": {
      "merchant_name": "王老板"
    },
    "varsUnmapped": [],
    "newMemorySummary": "用户在小镇遇到了王老板，进行了多次交易",
    "memoryFactsPreserved": true
  },

  "warnings": [
    "flag 'village_chief_met' 在新版中可能失效"
  ],
  "summary": "已映射3个阶段、1个NPC改名、1个变量更新，1个flag可能失效"
}
```

### 输出数据

```json
{
  "phaseMapping": {
    "开场白": "开场白",
    "苏醒": "环境描述",
    "选择装备": "选择武器"
  },
  "newPhaseId": "选择武器",
  "newEventIndex": 3,
  "newEventSummary": "用户已完成初始装备选择，选择了长剑。当前处于新版武器选择阶段。",

  "roleMigration": {
    "npcMapping": {
      "老王": { "newId": "merchant", "newName": "王老板", "strategy": "rename" }
    },
    "orphanedNpcs": [],
    "newNpcs": ["守卫"],
    "runtimeStatePreserved": true
  },

  "backgroundMigration": {
    "orphanedFlags": ["quest_A_done", "village_chief_met"],
    "varsUpdated": {
      "merchant_name": "王老板"
    },
    "varsUnmapped": ["village_name"],
    "newMemorySummary": "用户在柳树镇遇到了王老板，进行了3次交易...",
    "memoryFactsPreserved": true
  },

  "warnings": [
    "flag 'quest_A_done' 在新版中可能失效",
    "var 'village_name' 无法自动映射，保留原值"
  ],
  "summary": "已映射 3 个 phase、1 个 NPC 改名、2 个变量更新，1 个 flag 可能失效"
}
```

### 迁移后 state 应用（补充角色和背景部分）

```typescript
export function applyMigration(
  oldState: SessionState,
  migration: MigrationResult,
): { newState: SessionState; report: MigrationReport } {

  const newState = { ...oldState };

  // === 之前设计的：phase + event 迁移 ===
  newState.chapterProgress = { /* ... 同之前 ... */ };

  // === 新增：角色迁移 ===
  if (migration.roleMigration && newState.npcs) {
    const npcMap = migration.roleMigration.npcMapping;
    const newNpcs: Record<string, any> = {};

    for (const [oldKey, npcState] of Object.entries(newState.npcs)) {
      const mapping = npcMap[oldKey];
      if (mapping?.strategy === "rename") {
        // 改名：保留运行时状态，更新 key
        newNpcs[mapping.newId] = {
          ...npcState,
          name: mapping.newName,
        };
      } else if (migration.roleMigration.orphanedNpcs.includes(oldKey)) {
        // 已删除：保留但标记（不丢弃用户经历）
        newNpcs[`__orphan__${oldKey}`] = npcState;
      } else {
        // 未变动：原样保留
        newNpcs[oldKey] = npcState;
      }
    }
    newState.npcs = newNpcs;
  }

  // === 新增：背景变量迁移 ===
  if (migration.backgroundMigration) {
    const bg = migration.backgroundMigration;

    // vars 更新
    if (bg.varsUpdated && newState.vars) {
      newState.vars = { ...newState.vars };
      for (const [key, value] of Object.entries(bg.varsUpdated)) {
        newState.vars[key] = value;
      }
    }

    // flags 不删除，只标记（保留在 state 里，编排师可以忽略）
    // orphanedFlags 仅写入 report 供用户参考

    // memorySummary 更新
    if (bg.newMemorySummary) {
      newState.memorySummary = bg.newMemorySummary;
    }
    // memoryFacts 原样保留（memoryFactsPreserved = true）
  }

  // === 之前设计的：recentEvents 过滤 ===
  // ...

  return { newState, report: { /* ... */ } };
}
```

### Token 消耗估算

| 数据项 | token（估算） |
|--------|-------------|
| phase 列表（old + new） | ~300 |
| currentProgress + currentDynamicEvent | ~400 |
| roleChanges（oldNpcs + newNpcs + runtimeNpcState） | ~500 |
| backgroundChanges（背景 + flags + vars + memory） | ~600 |
| system prompt | ~800 |
| **输入合计** | **~2600** |
| **输出** | **~600** |
| **总计** | **~3200 token** |

MiniMax 成本约 ¥0.0005/session，依然很低。

---

## 三个维度的迁移策略总结

| 维度 | 什么迁移 | 什么保留 | 什么丢弃 |
|------|---------|---------|---------|
| **章节结构** | phaseId、eventIndex、eventSummary | runtimeFacts、memoryFacts | 无法映射的 completedEvents |
| **角色** | NPC 改名映射（key + name） | 运行时状态（关系值、customVars） | 无（孤儿 NPC 也保留，标记为 `__orphan__`） |
| **故事背景** | vars 值更新、memorySummary 微调 | flags（不删）、memoryFacts | 无（全部保留） |

**核心原则不变**：用户经历不丢（runtimeFacts/memoryFacts/flags/关系值原样保留），只迁移"结构引用"（phaseId/NPC名/变量值）。
