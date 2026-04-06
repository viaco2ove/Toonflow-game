# Review 问题修复记录

## 修复状态概览

| 问题 | 状态 | 修复文件 |
|------|------|----------|
| 回溯功能 | ✅ 已修复 | `src/routes/game/orchestration.ts`, `src/routes/game/debugRuntimeShared.ts` |
| `[tag_end_chapter]` 日志 | ✅ 已存在 | `src/modules/game-runtime/services/ChapterRuntimeService.ts` |
| 编排师日志记录 | ✅ 已修复 | `src/modules/game-runtime/engines/NarrativeOrchestrator.ts` |
| 章节结束条件判定交互 | ✅ 已存在 | `src/routes/game/orchestration.ts` |

---

## 1. 回溯功能修复

### 问题描述
台词和游戏动态参数的缓存和持久化恢复方案未正确工作。

### 修复内容

#### 1.1 修改 `src/routes/game/orchestration.ts`
- **导入 `saveDebugRevisitPoint`**：添加回溯点保存函数导入
- **修改 `buildOrchestrationPayload`**：在返回响应前自动保存回溯点
- **更新所有调用点**：传入 `messages` 参数以支持回溯

```typescript
// 在 buildOrchestrationPayload 中添加回溯点保存
const debugRuntimeKey = stateSnapshot.debugRuntimeKey as string;
if (debugRuntimeKey && params.messages) {
  saveDebugRevisitPoint(
    debugRuntimeKey,
    params.state,
    params.messages,
    params.chapterId
  );
}
```

#### 1.2 回溯存储机制（已存在）
- **内存层**：`DEBUG_REVISIT_HOT` Map 保留最近 5 条热数据
- **文件层**：溢出数据写入 `tmp/debug_revisit/<key>.json`
- **清理**：退出时自动清空临时文件

### API 端点（已存在）
- `POST /revisit`：回溯到指定 messageCount 状态
- `GET /revisit/history`：获取可回溯历史列表

---

## 2. `[tag_end_chapter]` 日志

### 状态
✅ 已存在，无需修复

### 实现位置
`src/modules/game-runtime/services/ChapterRuntimeService.ts` 第 67-90 行

```typescript
console.log("[tag_end_chapter]", JSON.stringify({
  chapterId: Number(input.chapter?.id || 0),
  chapterTitle: String(input.chapter?.title || "").trim(),
  outcome,
  hasRule: evaluation.hasRule,
  matchedBy: evaluation.matchedBy,
  matchedRule: evaluation.matchedRule,
  // ...
}));
```

---

## 3. 编排师日志增强

### 问题描述
`[story:orchestrator:runtime]` 日志没有记录返回内容和 token 消耗。

### 修复内容

#### 修改 `src/modules/game-runtime/engines/NarrativeOrchestrator.ts`
在 `doRunNarrativePlan` 函数中，模型调用后添加详细日志：

```typescript
// 记录编排师返回内容和 token 消耗
console.log("[story:orchestrator:runtime]", JSON.stringify({
  chapterId: currentChapter.id,
  eventIndex: currentEvent.eventIndex,
  model: orchestratorRuntime.model,
  manufacturer: orchestratorRuntime.manufacturer,
  responseText: rawText.slice(0, 500), // 限制长度避免日志过大
  responseTextLength: rawText.length,
  tokenUsage: (result as any)?.usage || null,
  promptChars: systemPrompt.length + userPrompt.length,
}));
```

### 日志字段说明
| 字段 | 说明 |
|------|------|
| `chapterId` | 当前章节 ID |
| `eventIndex` | 当前事件索引 |
| `model` | 使用的模型名称 |
| `manufacturer` | 模型厂商 |
| `responseText` | 模型返回内容（前500字符）|
| `responseTextLength` | 返回内容总长度 |
| `tokenUsage` | Token 消耗信息 |
| `promptChars` | Prompt 字符数 |

---

## 4. 章节结束条件判定交互

### 状态
✅ 已存在，无需修复

### 实现位置
`src/routes/game/orchestration.ts` 第 567-595 行

当 `outcome.result === "failed"` 时：
1. 返回 `endDialog: "已失败"`
2. 生成详细失败原因（`buildDebugEndDialogDetail`）
3. 返回预设消息提示用户

```typescript
if (outcome.result === "failed") {
  const message = {
    role: String(rolePair.narratorRole.name || "旁白"),
    roleType: "narrator",
    eventType: "on_debug_failed",
    content: `章节《${String(chapter.title || "当前章节")}》判定失败，调试结束。`,
    createTime: nowTs(),
  };
  return res.status(200).send(success(buildOrchestrationPayload({
    // ...
    endDialog: "已失败",
    endDialogDetail: buildDebugEndDialogDetail({...}),
  })));
}
```

---

## 测试验证

### Web 端测试
1. 进入章节调试
2. 发送消息触发剧情推进
3. 检查日志中是否出现 `[story:orchestrator:runtime]`
4. 检查 `tmp/debug_revisit/` 目录是否生成回溯文件
5. 触发章节失败条件，验证是否显示失败弹框

### 安卓端测试
与 Web 端相同，通过 API 响应验证功能正常。

---

## 构建状态

```
✅ 后端服务构建完成: build/app.js
✅ Electron主进程构建完成: build/main.js
```

所有修复已通过 TypeScript 编译验证。
