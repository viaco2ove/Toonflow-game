## 事件列表不显示的真实原因

### 调用链

```
进入调试
  ↓
state.chapters = api.getChapter()        ← 从DB加载，包含 runtimeOutline.phases ✅
  ↓
selectChapter(selectedChapterId)           ← 从 state.chapters 读取，填充编辑器 state
  ↓
buildEditorChapterSnapshot()               ← ❌ 问题在这里！
  ↓
state.chapters[index] = editorChapter     ← runtimeOutline 被丢弃了
  ↓
syncDebugChapter() → currentChapter → runtimeOutline.phases = ??? 
```

### `buildEditorChapterSnapshot` 丢掉了 runtimeOutline

这是 2090-2109 行返回的对象：

```typescript
return {
  id, title, content, openingRole, openingText,
  entryCondition, completionCondition, sort, ...
  // ❌ 没有 runtimeOutline！
};
```

当这个对象被合并进 `state.chapters`（第 4340 行），**原来从 DB 加载的 `runtimeOutline.phases` 直接被覆盖成 undefined**。

### 后端补救逻辑

`normalizeChapterOutput` 在保存时会重新从内容提取 phases：

```typescript
const phases = normalizedExisting.phases.length
  ? normalizedExisting.phases
  : extractRuntimePhasesFromContent(input.content, ...);  // 依赖章节内容的结构
```

`extractRuntimePhasesFromContent` 需要内容里有**特定格式的章节段落标题**（`extractRuntimeSections`）。如果章节内容是普通文本而不是结构化的，则 phases = `[]`。

### 所以分两种情况

| 情况 | 结果 |
|------|------|
| 用户写的是**结构化章节**（有 phases）→ 编辑后保存 → phases 丢失 | ❌ 不显示 |
| 用户写的是**普通文本章节**（无 phases）→ `extractRuntimePhasesFromContent` 也提取不到 | ❌ 不显示 |
| `buildEditorChapterSnapshot` 返回 null（纯新建章节）→ 不覆盖 `state.chapters` | ✅ DB 的 phases 保留 |

### 结论

**`buildEditorChapterSnapshot` 需要保留原有 `runtimeOutline`**，最简单的修复：

```typescript
// 在 buildEditorChapterSnapshot 中加一行：
const existingChapter = state.chapters.find((item) => item.id === (state.selectedChapterId || -Date.now()));
return {
  id: ...,
  runtimeOutline: existingChapter?.runtimeOutline,  // ← 加这个
  ...
};
```

这样：
1. 不编辑 outline 时 → 保留原有 phases → 事件列表正常显示
2. 编辑了 outline → 新的 runtimeOutline 也会被带入 → 正常显示
3. 调试进度的动态更新 → 仍然通过 `orchestrateDebug` 返回的 `eventDigestWindow` 更新