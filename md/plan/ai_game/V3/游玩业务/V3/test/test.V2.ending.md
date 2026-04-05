## 根因找到了：「章节结局评估」的 failure null 陷阱

### 完整调用链路

用户输入 "1" → `debugStep.ts:400` → `applyDebugUserMessageProgress` → `markCurrentUserNodeCompleted` → `evaluateDebugRuntimeOutcome` → `evaluateRuntimeOutcome` → `evaluateChapterOutcome` → `evaluateStructuredCondition`

### 关键问题：`evaluateStructuredCondition` 中的 failure 空值误判

**`ChapterOutcomeEngine.ts` 第 73-81 行：**

```typescript
function evaluateStructuredCondition(condition, ctx) {
  if (isRecord(condition)) {
    const failureNode = condition.failure ?? condition.failed ?? condition.fail;
    if (failureNode !== undefined && evaluateCondition(failureNode, ctx)) { // ← 问题在这里
      return { result: "failed", matchedRule: "completion.failure" };
    }
    const successNode = condition.success ?? condition.pass;
    if (successNode !== undefined && evaluateCondition(successNode, ctx)) {
      return { result: "success", matchedRule: "completion.success" };
    }
  }
  return evaluateCondition(condition, ctx)
    ? { result: "success", matchedRule: "completion" }
    : { result: "continue", matchedRule: null };
}
```

**`gameEngine.ts` 第 1752 行，`evaluateCondition` 对 null/undefined 直接返回 true：**

```typescript
export function evaluateCondition(input: unknown, ctx: ConditionContext): boolean {
  const condition = tryParseCondition(input);
  if (condition === null || condition === undefined) return true; // ← null/undefined → true!
  // ...
}
```

### 触发路径

测试章节的 `completionCondition` 配置大概是：

```json
{
  "success": "绑定角色",
  "failure": null
}
```

执行时：

1. `condition.failure = null`（不是 undefined）
2. `evaluateCondition(null, ctx)` 被调用
3. `tryParseCondition(null)` → `null`（因为不是 string）
4. `condition === null` → `true`，返回 `true`
5. `failureNode !== undefined`（null !== undefined 为 true）
6. **`evaluateCondition(null, ctx)` 返回 `true`**
7. 章节直接判定为 **"failed"** 或 **"success"** → 跳到 Chapter 2

### 修复方案

在 `evaluateStructuredCondition` 中添加对 null/undefined 的检查：

```typescript
const failureNode = condition.failure ?? condition.failed ?? condition.fail;
if (failureNode != null && evaluateCondition(failureNode, ctx)) { // ← 改成 != null
  return { result: "failed", matchedRule: "completion.failure" };
}
const successNode = condition.success ?? condition.pass;
if (successNode != null && evaluateCondition(successNode, ctx)) { // ← 同样改
  return { result: "success", matchedRule: "completion.success" };
}
```

**核心区别**：`!== undefined` 改为 `!= null`（null 和 undefined 都被排除），这样 `failure: null` 不会再被误判为成功条件。

---

要我现在修复这个问题吗？