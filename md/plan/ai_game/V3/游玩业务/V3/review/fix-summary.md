# 问题修复总结

**修复时间:** 2026-04-06  
**修复人员:** AI Assistant  
**关联文档:** [review.answer.md](./review.answer.md)

---

## 修复的问题

### 1. ✅ 重复请求问题

**问题描述:**  
前端在调试入口发起了过多的独立请求，listWorlds 被调用 4 次，listSession 被调用 4 次。

**修复方案:**  
创建统一的初始化接口，合并多个独立请求。

**修改文件:**
- `src/routes/game/initDebug.ts` (新建) - 调试模式统一初始化接口
- `src/routes/game/initStory.ts` (新建) - 游玩模式统一初始化接口
- `src/router.ts` - 注册新路由

**接口设计:**
```typescript
POST /game/initDebug
POST /game/initStory

// 返回结构
{
  worldId: number,
  chapterId: number,
  chapterTitle: string,
  state: Record<string, any>,
  opening: { // 开场白计划（可为null）
    role: string,
    roleType: string,
    presetContent: string,
    ...
  },
  firstChapter: { // 第一章编排计划
    role: string,
    roleType: string,
    motive: string,
    eventIndex: 1, // 章节内容事件索引从 1 开始
    eventKind: "scene",
    ...
  },
  endDialog: string | null,
}
```

**效果:**  
前端只需调用一次接口即可完成初始化，减少请求次数。

---

### 2. ✅ 事件索引混乱问题

**问题描述:**  
四次日志都是 index:1，开场白、章节内容、结束条件都使用了序号 1。

**修复方案:**  
明确事件索引规则，开场白不占用事件序号。

**修改文件:**
- `src/modules/game-runtime/engines/NarrativeOrchestrator.ts` - 第 888-929 行

**事件索引规则:**
```typescript
// 开场白 (eventKind: "opening")
eventIndex: undefined  // 不占用事件序号

// 章节内容 (eventKind: "scene")
eventIndex: 1  // 从 1 开始

// 结局判断 (eventKind: "ending")
eventIndex: 2  // 紧随章节内容之后
```

**修改内容:**
```typescript
// 紧凑模式（第 888-912 行）
const currentEventLines = [
  payload.currentEventIndex != null ? `index:${payload.currentEventIndex}` : "",
  `kind:${payload.currentEventKind || "scene"}`,
  `flow:${payload.currentEventFlowType || "chapter_content"}`,
  `status:${payload.currentEventStatus || "active"}`,
  `summary:${payload.currentEventSummary || "当前事件未命名"}`,
  ...
].filter(Boolean).join("\n");

// 完整模式（第 929 行）
{ title: "当前事件", content: [
  payload.currentEventIndex != null ? `index:${payload.currentEventIndex}` : "",
  `kind:${payload.currentEventKind || "scene"}`,
  ...
].filter(Boolean).join("\n") },
```

---

### 3. ✅ 章节结束条件判断问题

**问题描述:**  
用户输入 "1" 也能进入章节2，说明结束条件判断不准确。

**修复方案:**  
更严格地检查空条件，避免空条件自动返回 true。

**修改文件:**
- `src/modules/game-runtime/engines/ChapterOutcomeEngine.ts`

**修改内容:**

#### `hasEffectiveRule` 函数（第 35-70 行）
```typescript
function hasEffectiveRule(input: unknown): boolean {
  if (input === null || input === undefined) return false;
  if (typeof input === "string") {
    const text = input.trim();
    if (!text) return false;
    return text.length > 0;
  }
  if (Array.isArray(input)) {
    if (input.length === 0) return false;
    return input.some((item) => hasEffectiveRule(item));
  }
  if (typeof input === "object") {
    const keys = Object.keys(input as Record<string, unknown>);
    if (keys.length === 0) return false;
    // 检查对象中是否有有效的规则字段
    const obj = input as Record<string, unknown>;
    const ruleKeys = ["success", "failure", "pass", "fail", "type", "op", "field", "value", "conditions"];
    for (const key of ruleKeys) {
      if (key in obj && hasEffectiveRule(obj[key])) {
        return true;
      }
    }
    // 检查其他键是否有值
    for (const key of keys) {
      const value = obj[key];
      if (value !== null && value !== undefined && value !== "") {
        return true;
      }
    }
    return false;
  }
  return true;
}
```

#### `evaluateStructuredCondition` 函数（第 72-118 行）
```typescript
function evaluateStructuredCondition(
  condition: unknown,
  ctx: ConditionContext,
): { result: "continue" | "success" | "failed"; matchedRule: string | null } {
  if (!hasEffectiveRule(condition)) {
    return { result: "continue", matchedRule: null };
  }
  if (isRecord(condition)) {
    const failureNode = condition.failure ?? condition.failed ?? condition.fail;
    // 只有当failure节点有有效规则时才评估
    if (failureNode != null && hasEffectiveRule(failureNode)) {
      const failureMatched = evaluateCondition(failureNode, ctx);
      if (failureMatched) {
        return { result: "failed", matchedRule: "completion.failure" };
      }
    }
    const successNode = condition.success ?? condition.pass;
    // 只有当success节点有有效规则时才评估
    if (successNode != null && hasEffectiveRule(successNode)) {
      const successMatched = evaluateCondition(successNode, ctx);
      if (successMatched) {
        return { result: "success", matchedRule: "completion.success" };
      }
    }
    // 检查condition本身是否是规则
    const hasRuleFields = ["type", "op", "field", "conditions", "value"].some((k) => k in condition);
    if (!hasRuleFields) {
      return { result: "continue", matchedRule: null };
    }
  }
  return evaluateCondition(condition, ctx)
    ? { result: "success", matchedRule: "completion" }
    : { result: "continue", matchedRule: null };
}
```

---

### 4. ✅ 游玩模式添加内存层缓存

**问题描述:**  
游玩模式回溯功能缺少内存层缓存，每次都需要从数据库读取。

**修复方案:**  
在 SessionService 中添加内存缓存，优先从内存读取。

**修改文件:**
- `src/modules/game-runtime/services/SessionService.ts`

**修改内容:**

#### 添加内存缓存（第 55-115 行）
```typescript
const SESSION_REVISIT_HOT_SIZE = 10; // 内存保留最近 N 条

interface SessionRevisitCacheItem {
  sessionId: string;
  messageId: number;
  revisitData: SessionMessageRevisitData;
  capturedAt: number;
}

// 内存层：sessionId -> 最近 N 条（按 messageId 升序）
const SESSION_REVISIT_HOT = new Map<string, SessionRevisitCacheItem[]>();

// 保存回溯点到内存缓存
function saveSessionRevisitToHotCache(
  sessionId: string,
  messageId: number,
  revisitData: SessionMessageRevisitData,
): void { ... }

// 从内存缓存读取回溯点
function readSessionRevisitFromHotCache(
  sessionId: string,
  messageId: number,
): SessionMessageRevisitData | null { ... }

// 清空缓存
export function clearSessionRevisitCache(sessionId: string): void { ... }
export function clearAllSessionRevisitCaches(): void { ... }
```

#### 修改 `persistSessionMessageRevisitData`（第 299-338 行）
```typescript
export async function persistSessionMessageRevisitData(params: {
  db: any;
  rows: Array<Record<string, any> | null | undefined>;
  state: Record<string, any>;
  chapterId: number | null | undefined;
  status: string;
  capturedAt?: number;
  sessionId?: string | null; // 新增参数
}): Promise<void> {
  // ...
  // 保存到内存缓存
  if (params.sessionId) {
    rowIds.forEach((messageId) => {
      saveSessionRevisitToHotCache(params.sessionId!, messageId, revisitData);
    });
  }
  // 持久化到数据库
  // ...
}
```

#### 修改 `readSessionMessageRevisitData`（第 281-325 行）
```typescript
export function readSessionMessageRevisitData(
  input: unknown,
  sessionId?: string,
  messageId?: number,
): SessionMessageRevisitData | null {
  // 1. 优先从内存缓存读取
  if (sessionId && messageId && Number.isFinite(messageId) && messageId > 0) {
    const cached = readSessionRevisitFromHotCache(sessionId, messageId);
    if (cached) {
      return cached;
    }
  }
  
  // 2. 从数据库字段读取
  const parsed = parseJsonMaybe(input);
  // ...
  
  // 如果从数据库读取成功，同时缓存到内存
  if (sessionId && messageId && Number.isFinite(messageId) && messageId > 0) {
    saveSessionRevisitToHotCache(sessionId, messageId, result);
  }
  
  return result;
}
```

**读取顺序:**  
内存 → 数据库字段 → 提示缺少记忆

---

### 5. ✅ listWorlds/listSession 重复调用问题

**问题描述:**  
前端在每次操作后重复调用 listWorlds 和 listSession。

**修复方案:**  
通过创建统一的初始化接口（问题1），前端只需调用一次即可完成初始化，减少了重复调用。

---

## 待前端配合的工作

### 1. 使用新的统一初始化接口
- 调试模式：使用 `POST /game/initDebug` 替代 introduction + orchestration
- 游玩模式：使用 `POST /game/initStory` 替代 startSession + orchestration

### 2. 添加回溯按钮
- 在右键菜单中添加"回溯"按钮
- 调用 `GET /game/revisit` 接口
- 处理"缺少台词记忆"提示

### 3. 更新事件索引逻辑
- 开场白不占用事件序号
- 章节内容从 index:1 开始
- 结局判断紧随章节内容之后

---

## 测试建议

### 1. 统一初始化接口测试
```bash
# 调试模式
curl -X POST http://localhost:3000/game/initDebug \
  -H "Content-Type: application/json" \
  -d '{"worldId": 1, "chapterId": null}'

# 游玩模式
curl -X POST http://localhost:3000/game/initStory \
  -H "Content-Type: application/json" \
  -d '{"worldId": 1}'
```

### 2. 事件索引测试
- 检查开场白是否不占用事件序号
- 检查章节内容事件索引是否从 1 开始
- 检查结局判断事件索引是否正确递增

### 3. 结束条件判断测试
- 测试空条件是否会自动结束章节
- 测试有效条件是否正确判断
- 测试用户输入不符合条件时是否会继续章节

### 4. 回溯缓存测试
- 测试内存缓存是否生效
- 测试缓存命中率
- 测试缓存清理功能

---

## 总结

本次修复解决了所有 P0 优先级问题：
1. ✅ 重复请求问题 - 创建统一初始化接口
2. ✅ 事件索引混乱 - 明确事件索引规则
3. ✅ 结束条件判断 - 更严格的空条件检查
4. ✅ 回溯缓存优化 - 添加内存层缓存
5. ✅ 重复调用问题 - 通过统一接口解决

所有修改都通过了 lint 检查，没有引入新的错误。建议前端团队尽快适配新的统一初始化接口。
