# 进入调试到底做了什么导致的加载慢？
让我看看调试启动的流程。
重点看 `syncDebugChapterRuntime` 调用的 `initializeChapterProgressForState`：
关键是 `readRuntimeOutline`。看看它做什么：
现在看 `normalizeChapterRuntimeOutline` — 这是关键，解析 `runtimeOutline` 是否有耗时操作：
`normalizeChapterRuntimeOutline` 只是数据规整，不耗时。真正耗时的肯定是网络请求。看一下调试流程中的 AI 调用路径：
看到了！**第 218 行**：`!playerContent` 且有历史消息时，调用 `runNarrativeOrchestrator`（AI 请求）。

继续往前看前端调用 debugStep 的逻辑：
前端代码在别处，看前端项目：
找到关键点了！继续看 `orchestrateDebug` 和 `streamDebugPlan`、`continueDebugNarrative`：
`orchestrateDebug` 调用的是 `/game/orchestration`。让我看这个接口：
现在我看清楚了整个流程。再看前端进入调试后的逻辑链：
现在全局图谱清晰了。让我看 `streamDebugPlan` 具体做了什么，是否有多次 AI 调用：
现在我有足够信息了。让我看 `saveWorldOnly` 和 `saveChapterDraft` 是否也有 AI 调用：
`saveWorldOnly` 和 `saveChapterDraft` 只是普通数据库操作。现在我有完整图谱了。

---

## 「进入调试卡半天」的完整原因

进入调试时，前端顺序做了这些事：

```
点击「调试」按钮
  ↓
① saveWorldOnly()          — 保存 world（1次 DB 写）
  ↓
② saveChapterDraft()       — 保存章节草稿（1次 DB 写）
  ↓
③ getChapter()             — 拉取章节列表（1次 DB 读）
  ↓
④ reloadWorldsAfterSave()  — 刷新 world 列表（1次 DB 读）
  ↓
⑤ orchestrateDebug()       — ⚠️ 第 1 次 AI 调用（/game/orchestration）
  └─ 章节无开场白内容？
     → runNarrativePlan() —— 真 AI 请求（最慢，1~5秒）
  ↓
⑥ shouldStreamDebugPlan()  → true
   streamDebugPlan()       — ⚠️ 第 2 次 AI 调用（/game/streamDebugLines，流式）
  ↓
⑦ shouldAutoContinueDebugAfterStart() → true（有 presetContent 或 on_opening）
   continueDebugNarrative()
     └─ 循环最多 3 次：
        orchestrateDebug() — ⚠️ 第 3~5 次 AI 调用
        streamDebugPlan()  — ⚠️ 第 4~6 次 AI 调用（流式）
```

### 最坏情况串行 AI 调用次数：

| 步骤 | 操作 | 是否 AI |
|------|------|---------|
| ⑤ | orchestration（无开场白时跑 runNarrativePlan） | ✅ AI |
| ⑥ | streamDebugLines（流式生成内容） | ✅ AI |
| ⑦ | continueDebugNarrative 循环 3 步，每步再来一轮 orchestration + stream | ✅×6 |

**最多触发 8 次 AI 调用，全部串行**，每次 2-5 秒 = **轻松卡 10~30 秒**。

### 根本原因总结

1. **没有开场白文案时，`orchestration` 接口直接跑 AI 编排**（第 316 行），这是一次冷启动 AI 调用
2. `shouldAutoContinueDebugAfterStart` 判断条件太宽松，`on_opening` 类型会触发无限 `continueDebugNarrative` 链式调用
3. 所有调用都是串行的，没有任何预加载或缓存

### 解决方案，进入调试的工作过界了
调试的等待阶段做了太多与基础环境搭建无关的事情！应该拆分的更清楚。在前端就让人知道在干嘛
保存草稿-》加载完-》（第一章的话开场白）-》编排-》台词->播放

正确思路是**分阶段展示进度，每完成一步立刻给用户反馈**：

```
进入调试
  ↓
① 加载基础环境（saveWorld + saveChapter + getChapter）
   → 完成立刻显示调试界面骨架，Loading结束
  ↓
② 编排（orchestrateDebug）
   → 完成立刻显示「第一个事件/场景」，开场白也是一个事件而且开场白说完就进入第一章节的第一个事件。
  ↓
③ 台词生成（streamlines）
   → 流式边生成边显示，不等完整结果
  ↓
④ 播放
   → 每段台词生成完就立刻可以播放，不等全部
```

**关键差别**：用户进来就能看到界面，而不是盯着 Loading 等30秒后才一口气全出来。

这是前端的问题——`performStartDebugCurrentChapter` 里那一串 `await` 是串行等完再更新 UI，需要改成每个阶段完成就更新一次状态。看一下当前前端代码里哪些地方在阻塞 UI 更新：
现在结构一目了然。**问题根源确认**：

`debugLoading = true` 从第4306行一直卡到第4378行 `finally` 才释放。用户看到的 Loading 横跨了**全部步骤**——保存、编排、生成台词、推进到用户回合，一个都不提前结束。

**应该在哪里放开 Loading**：第4325行「创建会话环境」完成后，骨架就够了，界面可以出来。后面的编排和台词生成应该是**界面内的局部状态**，而不是全局 Loading。

具体改法很清楚：
1. **第4332行之后**，`debugLoading = false`，界面先出来
2. 编排阶段用单独的 `state.debugOrchestrating = true` 标记，显示在消息区
3. `streamDebugPlan` 流式的，原本就是边出边显示，不需要等
4. `continueDebugNarrative` 同理，跑着就行，UI不阻塞
