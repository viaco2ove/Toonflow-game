# 简化版 NPC 自主行为 实现方案

## 目标
让自由模式下 NPC 有"当前行为"（在哪、在干嘛），由记忆管理器每轮维护，写进角色卡的 `role_key_information` 字段。万能角色/旁白不做。

## 设计决策（已与用户确认）
1. **存储格式**：纯文本追加。在 `role_key_information` 里用固定前缀 `【当前行为】` 标记行为段，如：
   ```
   退役军中锻造师，左臂有烧伤疤痕
   【当前行为】在铁匠铺打铁，正在赶制神秘订单（黄昏·阴）
   ```
   记忆管理器每轮覆写【当前行为】段，身份备注不动。复用现成字段，零 schema 改动。
2. **时间范围**：仅自由模式。记忆管理器 payload 仅在 `free_runtime` 时注入 worldClock；章节模式不传，不维护当前行为。

## 现状（已全部确认）
- `role_key_information` 字段已存在，别名 `information`
- 记忆管理器补丁白名单 `sanitizeMemoryParameterCardPatch` 的 `scalarKeys` 已含 `role_key_information`
- 补丁应用 `mergeMemoryParameterCardPatch` 标量覆盖 ✅
- 编排师读角色卡 `summarizeParameterCardText`(654)/`summarizeParameterCardKeyText`(687) 已读 `role_key_information` ✅
- 记忆管理器每轮跑（`refreshStoryMemoryBestEffort`）✅

## 缺口（本方案要补的）
| 缺口 | 位置 | 说明 |
|---|---|---|
| A 记忆管理器 prompt 缺"当前行为"语义 | `fixDB.prompts.ts` 记忆管理器段 | 只说"身份备注/编排限制"，没引导写位置+动作 |
| B 记忆管理器 payload 没传 worldClock | `NarrativeOrchestrator.ts` ~4928 payload | 看不到时间天气，行为无法跟时间挂钩 |
| C 编排侧 buildWorldBreathing 没填 npcActivities | `NarrativeOrchestrator.ts` ~2641 | 字段定义了但返回空 |
| D 编排师 compact 渲染漏 npcActivities | `NarrativeOrchestrator.ts` 1645 | 拼接只取 timeOfDay/weather/ambientEvents |

## 改动清单

### 1. fixDB.prompts.ts（记忆管理器提示词）
在记忆管理器 system prompt（1336 起）补一段【角色当前行为维护】规则：
- 明确 `role_key_information` 末尾用 `【当前行为】` 段记录 NPC 当前位置+动作+时间天气
- 仅自由模式维护（payload 会带 worldClock 时才写）
- 每轮覆写【当前行为】段，保留其前的身份备注不动
- 万能角色(general)/旁白(narrator) 不写当前行为
- 依据：最近对话里 NPC 实际发生的位移/动作 + worldClock 时间天气，不主观编造
- 输出示例的 npc_card_patches.patch.information 补 `【当前行为】` 段示例（2458、2521 行两处）

### 2. NarrativeOrchestrator.ts
**2a. 记忆管理器 payload 注入 worldClock（~4928）**
在 `runStoryMemoryManager` 的 payload 里，当 `currentEvent.eventFlowType === "free_runtime"` 时加：
```typescript
...(currentEvent.eventFlowType === "free_runtime" ? {
  worldClock: readWorldClock(input.state),  // {tick, timeOfDay, weather}
} : {}),
```

**2b. buildMemoryUserPrompt 渲染 worldClock**
在记忆管理器 user prompt 里渲染 `[世界时钟]` 段（仅自由模式有），让 AI 看到当前时间天气。

**2c. buildWorldBreathing 填充 npcActivities（~2641）**
从 `state.npcs` 遍历在场 NPC，读每个 NPC 卡的 `role_key_information`，提取 `【当前行为】` 段，拼成 `["铁匠老王：在铁匠铺打铁", ...]` 填进返回值的 `npcActivities`。
- 工具函数：`extractCurrentBehavior(roleKeyInformation): string | null` —— 正则匹配 `【当前行为】(.+)`，返回行为文本（去掉时间天气尾巴可选）
- 只收 npc 类型（跳过 general/narrator），名字 + 行为拼接

**2d. compact 渲染补 npcActivities（1645）**
```typescript
payload.worldBreathing ? `world_breathing:${[payload.worldBreathing.timeOfDay, payload.worldBreathing.weather, ...(payload.worldBreathing.ambientEvents || []), ...(payload.worldBreathing.npcActivities || [])].filter(Boolean).join("｜")}` : "",
```

### 3. 不需要改的
- `sanitizeMemoryParameterCardPatch`：已含 role_key_information ✅
- `applyMemoryNpcCardPatchesToState` / `mergeMemoryParameterCardPatch`：标量覆盖现成 ✅
- 编排师读角色卡：已读 role_key_information ✅
- 数据库/角色卡 schema：零改动 ✅

## 数据流（改后）
```
自由模式每轮编排:
  buildWorldBreathing 读 state.npcs 各 NPC 卡的 role_key_information
    -> 提取【当前行为】段 -> 填 worldBreathing.npcActivities
    -> 编排师 payload.world_breathing 带 npcActivities -> AI 看到 NPC 在干嘛
  
  runStoryMemoryManager payload 带 worldClock(仅自由模式)
    -> 记忆管理器看到时间天气 + 角色卡现有【当前行为】段
    -> prompt 引导: 依据最近对话 + 时间, 覆写各 NPC 的【当前行为】段
    -> 输出 npc_card_patches[].patch.role_key_information(含新【当前行为】段)
    -> applyMemoryNpcCardPatchesToState 标量覆盖写回 NPC 卡
```

## 边界与零回归
- 章节模式：worldClock 不注入记忆管理器，提示词规则限定"仅自由模式维护"，行为段不写
- 万能角色/旁白：prompt 明确排除，编排侧 buildWorldBreathing 也只收 npc
- 老存档：NPC 卡没有【当前行为】段时，extractCurrentBehavior 返回 null，npcActivities 为空数组，和现状一致
- mergeMemoryParameterCardPatch 是标量覆盖：记忆管理器需返回**完整的 role_key_information**（身份备注 + 新【当前行为】段），否则会覆盖丢身份备注。这点在 prompt 里强调。

## 风险点
- **记忆管理器可能只返回【当前行为】段而丢了身份备注**（标量覆盖风险）。必须在 prompt 里强约束："返回 role_key_information 时必须包含原身份备注 + 新【当前行为】段，缺一不可"。这是最大风险，靠提示词约束兜。
- 记忆管理器看不到 NPC 完整角色卡？看 `buildMemoryRoleCardSummary`（710 行）——它已经把 `role_key_information` 传给记忆管理器了（736 行），所以记忆管理器能看到现有的【当前行为】段，能正确覆写。

## 测试方法
1. 自由模式连续对话 3-4 轮，让 NPC 有明显位移/动作
2. 查 session.stateJson 的 `npcs[*].parameterCardJson.role_key_information`，确认出现 `【当前行为】xxx（时段·天气）` 段，且身份备注保留
3. 查编排请求体 `world_breathing`，确认 `npcActivities` 数组非空，内容是各 NPC 当前行为
4. 继续对话，确认【当前行为】段随剧情+时间更新（如黄昏->夜晚，行为变化）
5. 章节模式对话，确认 role_key_information 不出现【当前行为】段，world_breathing 无 npcActivities
6. 确认万能角色/旁白的 role_key_information 不被写入【当前行为】
