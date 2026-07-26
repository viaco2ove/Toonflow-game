# 世界书 阶段2：注入引擎

## 目标
自由模式下，世界书条目按关键词匹配注入编排师上下文。与 worldBreathing 合并成 worldContext 区块，token 预算联动 compact/advanced。仅 locations/events/world/random 四类注入（characters/factions/items 走参数卡）。

## 设计决策（文档阶段2要求）
1. **扫描源**：`latestPlayerMessage` + `recentDialogue` 各 turn 的 content 拼接
2. **匹配规则**：constant 条目始终注入；非 constant 按 keys（纯文本包含匹配）命中才注入
3. **token 预算**：compact 模式 800 token、advanced 模式 2000 token（用 estimatePromptTokens chars/4 估算）；按 order 升序排序，超预算的低 order 条目截断
4. **category 过滤**：只注入 locations/events/world/random，跳过 characters/factions/items/constants（constants 走 worldBreathing 已有？不--constants 类目的常驻条目要注入，因为它是世界宪法层。修正：constant=true 的条目无论 category 都注入；非 constant 只注入 locations/events/world/random）
5. **合并 worldContext**：payload 新增 `worldContext` 字段，含 worldBreathing 原字段 + worldKnowledge（匹配到的条目 content 列表）。prompt 渲染处合并展示
6. **仅自由模式**：所有改动包在 `eventFlowType === "free_runtime"` 块内，章节模式零回归

## 数据流
```
runNarrativePlan 入口（自由模式判定）
  -> 读 DB: db("t_worldBook").where({worldId}) 拿全部条目（仅自由模式读一次）
  -> 传 input.worldBookEntries 给 doRunNarrativePlan
  -> buildOrchestratorPromptPayload:
       scanText = latestPlayerMessage + recentDialogue.content 拼接
       matched = matchWorldBookEntries(entries, scanText)
         - constant 条目全收
         - 非 constant 且 category∈{locations,events,world,random} 按 keys 匹配
       budget = compactMode ? 800 : 2000
       kept = 按 order 排序 + token 预算截断
       payload.worldContext = { ...worldBreathing, worldKnowledge: kept.map(content) }
  -> sections 渲染:
       compact: world_breathing 行扩展成 world_context 行（含 worldKnowledge）
       full: 新增 "世界知识" section
```

## 改动清单

### 1. gameEngine.ts -- 匹配+预算工具函数
新增（纯函数，不碰 DB）：
```typescript
export interface WorldBookEntry { ... }  // 阶段1已定义

// 把条目匹配+预算成要注入的 content 列表
export function selectWorldBookForInjection(
  entries: WorldBookEntry[],
  scanText: string,
  tokenBudget: number,
): WorldBookEntry[] {
  // 1. constant 全收；非 constant 且 category∈{locations,events,world,random} 按 keys 匹配
  // 2. 按 order 升序排序
  // 3. 按 token 预算截断（estimatePromptTokens 估算每条 content）
}
```
keys 匹配：纯文本 `scanText.includes(key)`，支持 `/regex/` 包裹的正则（try-catch 容错）。

### 2. NarrativeOrchestrator.ts
**2a. OrchestratorInput 加字段**
```typescript
export interface OrchestratorInput {
  ...
  worldBookEntries?: WorldBookEntry[];  // 自由模式由 runNarrativePlan 预加载
}
```

**2b. OrchestratorPromptPayload 加 worldContext**
```typescript
worldContext?: {
  timeOfDay?: string;
  weather?: string;
  ambientEvents?: string[];
  npcActivities?: string[];
  worldKnowledge: string[];  // 匹配到的条目 content 列表
} | null;
```
（worldBreathing 保留兼容，worldContext 是合并后的新字段）

**2c. buildOrchestratorPromptPayload 填充 worldContext**
在 free_runtime 块内（3936-3941 附近）：
```typescript
if (input.currentEvent.eventFlowType === "free_runtime") {
  const breathing = buildWorldBreathing(input.state);
  // 世界书注入：仅自由模式
  const scanText = [payload.latestPlayerMessage, ...payload.recentDialogue.map(t => t.content)].join("\n");
  const budget = input.compactMode ? 800 : 2000;
  const matched = input.worldBookEntries?.length
    ? selectWorldBookForInjection(input.worldBookEntries, scanText, budget)
    : [];
  payload.worldContext = {
    ...(breathing || {}),
    worldKnowledge: matched.map(e => e.content),
  };
  payload.worldBreathing = breathing;  // 保留兼容
}
```

**2d. sections 渲染**
- compact（1645行附近）：world_breathing 行改成 world_context，拼接 worldKnowledge
- full（1696行 + sections 1703）：世界呼吸行改成世界呼吸+世界知识；sections 加 `{ title: "世界知识", content: payload.worldContext?.worldKnowledge.join("\n\n") || "无" }`（放在"当前事件"前）

### 3. runNarrativePlan 预加载世界书
入口处（4656行），自由模式时读 DB：
```typescript
export async function runNarrativePlan(input: OrchestratorInput): Promise<NarrativePlanResult> {
  // 自由模式预加载世界书条目（仅一次 DB 读）
  const isFreeMode = readCurrentRuntimeEventContext(input.chapter, input.state).eventFlowType === "free_runtime";
  if (isFreeMode && !input.worldBookEntries) {
    const db = getGameDb();
    const worldId = Number(input.world?.id || 0);
    if (worldId) {
      const rows = await db("t_worldBook").where({ worldId }).select("*");
      input.worldBookEntries = normalizeWorldBookOutput(rows);
    }
  }
  ...原逻辑
}
```
需要 import `getGameDb`。

## 关键文件
| 用途 | 路径 |
|---|---|
| 匹配+预算工具 | src/lib/gameEngine.ts (selectWorldBookForInjection) |
| 引擎注入 | src/modules/game-runtime/engines/NarrativeOrchestrator.ts |
| 预加载入口 | NarrativeOrchestrator.ts runNarrativePlan (4656) |
| payload 填充 | buildOrchestratorPromptPayload free_runtime 块 (3936) |
| 渲染 compact | buildCompactOrchestratorSections (1645) |
| 渲染 full | sections (1696, 1703) |

## 边界与零回归
- 章节模式：isFreeMode=false，不读 DB，不填 worldContext，worldBreathing 仍 null，完全零回归
- 老存档/无世界书：worldBookEntries 为空，worldKnowledge 为空数组，worldContext 只含 worldBreathing 字段
- DB 读失败：try-catch 兜底，worldBookEntries 留空，编排正常进行
- characters/factions/items 类目：非 constant 的不注入（走参数卡），constant 的仍注入（世界宪法层如"主角核心规则"）
- token 预算：compact 800/advanced 2000，用 estimatePromptTokens 估算，超预算按 order 截断低优先级

## 验证
1. tsc --noEmit 零新增错误（基线21）
2. 自由模式对话提到"黑风寨" -> 检查编排请求体 world_context.world_knowledge 含"黑风寨"条目 content
3. 提到未匹配关键词 -> 只有 constant 条目注入
4. 章节模式 -> world_context 为 null，无世界知识 section
5. compact 模式 -> 世界知识受 800 token 预算约束
6. 日志：logOrchestratorKeyNode 记录 matched 条目数/截断数

## 风险
- DB 读增加编排延迟：仅自由模式、仅一次 select、按 worldId 索引（阶段1已建 idx_worldBook_worldId），影响可控
- keys 正则容错：用户可能写非法正则，try-catch 降级为纯文本匹配
- worldBreathing vs worldContext 双字段：保留 worldBreathing 兼容现有引用，worldContext 是合并新字段，渲染优先用 worldContext