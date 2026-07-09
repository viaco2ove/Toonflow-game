# 章节判定结果处理（Web 端）

## 1. 数据来源

Web 端通过 `/game/storyInfo` 接口获取章节运行时信息，返回结构中与章节判定相关的字段：

```json
{
  "state": {
    "chapterProgress": {
      "pendingGoal": "用户成功抢夺顾子航的房间"
    },
    "flags": {
      "chapterCompleted": false,
      "chapterFailed": false
    }
  },
  "endDialog": null,
  "endDialogDetail": ""
}
```

## 2. pendingGoal 的显示

### 2.1 显示位置

`pendingGoal` 显示在 Web 端的"当前目标"区域，位于事件面板或状态栏中。

### 2.2 显示逻辑

```
前端从 state.chapterProgress.pendingGoal 读取当前目标文本

显示规则：
- pendingGoal 有值 → 显示文本内容
- pendingGoal 为空 → 显示 "当前目标：*****"（掩码）
```

### 2.3 来源说明

`pendingGoal` 的值来自 `chapterProgress`，由 `ChapterProgressEngine` 在事件推进时设置：
- 进入新事件时，设置为事件的 `targetSummary` 或章节的 `completionCondition`
- 章节成功/失败后，清空为 `""`

## 3. 章节结束的显示

### 3.1 失败处理

当 `sessionStatus === "failed"` 或 `flags.chapterFailed === true` 时：

1. **弹窗提示**：显示 `endDialog: "结束条件失败"`
2. **详情内容**：来自 `endDialogDetail`
   ```
   章节《xxx》结束条件失败。当前故事已结束，可继续查看当前记录，或返回历史重新开始。
   ```
3. **状态锁定**：失败后章节状态锁定，AI 编排不再影响结局

#### 问题点

**问题 1：章节失败弹框点击按钮后行为异常**

- **现象**：点击”返回历史”后弹框不消失，点击”继续查看”后弹框消失又立即弹出
- **原因分析**：
  - `closeSessionEndDialog()` 只清除了前端 state 中的 `sessionEndDialog` 和 `sessionEndDialogDetail`
  - 但 `sessionEndDialog` 的来源是 `/game/storyInfo` 接口返回值
  - 编排检测器（每 2 秒轮询）持续调用 `refreshSessionStoryInfoInBackground()`
  - 只要后端 `sessionStatus` 未改变（仍为 `active`），弹框会再次出现
- **根因**：前端弹框状态与后端 `sessionStatus` 未同步，需要后端配合修改

**问题 2：编排检测器在失败状态下疯狂请求**

- **现象**：用户不点击弹框时，前端持续发起请求（每 2 秒一次）
- **原因分析**：
  - 编排检测器 `runOrchestrationChecker()` 在 `useToonflowStore.ts` 中每 2 秒执行
  - 检测器判定逻辑 `isUserTurn` 只检查 `canPlayerSpeakNow || latestStatus === “waiting_player”`
  - 当章节失败时，`canPlayerSpeakNow` 可能仍为 `true`（后端 `turnState.canPlayerSpeak` 未锁定为 false）
  - 检测器认为”可以继续编排”，不断调用 `scheduleContinueSessionNarrative()`
- **根因**：编排检测器未识别”章节失败”状态，导致继续尝试编排

### 3.2 成功处理

当章节判定返回 `result: “success”` 时：

1. **切章标记**：设置 `pendingDebugChapterId`（调试）或 `pendingChapterId`（正式）
2. **状态更新**：`flags.chapterCompleted = true`
3. **下一章进入**：
   - 调试模式：自动转入自由剧情（无下一章时）
   - 正式模式：下一句台词落地后切换章节

#### 问题点

**问题 3：最后一个章节成功时未弹出成功引导**

- **现象**：最后一个章节成功完成时，没有弹出成功弹框，直接继续
- **期望行为**：
  - 检测到是最后一个章节成功 → 弹出成功弹框，显示”进入自由模式”
  - 点击”进入自由模式”后 → 进入自由模式游玩（无结束条件）
  - 保证续玩时同时处于自由模式
  - 除非用户回溯到没有成功的状态

**问题 4：失败弹框状态下编排检测器未停止**

- **现象**：显示失败弹框时，编排检测器仍在疯狂请求
- **期望行为**：
  - 章节失败后，`sessionStatus` 应更新为 `failed`
  - 编排检测器应检测到 `sessionStatus === “failed”`，停止轮询编排
  - `scheduleContinueSessionNarrative()` 不应被调用

## 4. 关键流程图

```
用户发言
    │
    ▼
后端 evaluateRuntimeOutcome()
    │
    ├─► outcome = continue  → 正常推进，pendingGoal 保持
    │
    ├─► outcome = guide    → 设置 __pendingEndingGuide = true
    │                          前端显示引导提示
    │
    ├─► outcome = success  → flags.chapterCompleted = true
    │                          pendingGoal 清空
    │                          进入下一章流程
    │
    └─► outcome = failed   → flags.chapterFailed = true
                               pendingGoal 清空
                               显示失败弹窗
```

## 5. 接口响应字段

| 字段 | 说明 |
|------|------|
| `state.chapterProgress.pendingGoal` | 当前章节目标文本 |
| `state.flags.chapterCompleted` | 章节是否成功完成 |
| `state.flags.chapterFailed` | 章节是否失败 |
| `endDialog` | 失败弹窗标题（null 表示无弹窗） |
| `endDialogDetail` | 失败弹窗详情内容 |
| `sessionStatus` | 会话状态（active / failed / chapter_completed） |

## 6. Web 端处理要点

1. **读取时机**：`storyInfo` 返回后读取 `pendingGoal`
2. **掩码显示**：当 `pendingGoal` 为空时，前端显示 `*****` 而非空
3. **失败弹窗**：优先显示 `endDialog`，其次回退到 `sessionStatus` 判断
4. **切章动画**：检测到 `chapterId` 变化时，触发章节切换过渡效果

## 7. 修复记录

### 7.1 失败弹框反复弹出 + 编排检测器疯狂请求

**修复点**：
- 编排检测器 `runOrchestrationChecker()` 增加 `sessionStatus` 判断，`failed` / `chapter_completed` 时直接 return
- 新增 `sessionFailedAcknowledged` 标志：用户点击"继续查看"后置 true，storyInfo 同步时不再覆盖弹框
- `closeSessionEndDialog()` 同时设置 `sessionFailedAcknowledged = true`
- `toggleHistoryMode()` 先调用 `closeSessionEndDialog()` 清除弹框

**修改文件**：
- `Toonflow-game-web/src/composables/useToonflowStore.ts`
- `Toonflow-game-web/src/components/ScenePlay.vue`

### 7.2 最后一章成功弹框引导

**修复点**：
- 后端 `storyInfo.ts` 新增 `isLastChapterCompleted()` 函数，检测 `chapter_completed` 且没有下一章
- 最后一章完成时返回 `endDialog = "已完结"` + 引导文案
- 前端弹框根据 `endDialog` 值切换显示：
  - `"已完结"` → 显示"故事完结" + "进入自由模式"按钮
  - 其他 → 显示"章节失败" + "返回历史"按钮

**修改文件**：
- `toonflow-game-app/src/routes/game/storyInfo.ts`
- `Toonflow-game-web/src/components/ScenePlay.vue`

### 7.3 自由模式跳过 AI 章节判定

**问题**：用户点击"进入自由模式"后，后端仍然会调用 AI 章节判定，这没有意义且浪费资源。

**修复点**：
- 当 `fallbackStatus = "chapter_completed"` 时，后端自动跳过 AI 章节判定
- 这等效于"没有章节结束条件"，让编排师自由生成台词
- 无需前端额外传递参数，后端通过数据库中已存储的 `sessionStatus` 自动判断

**实现逻辑**（`ChapterRuntimeService.ts`）：
```typescript
const isChapterCompletedFreeMode = String(input.fallbackStatus || "").toLowerCase() === "chapter_completed";
const shouldSkipAi = input.skipAi || (isRuleContinue && !isNaturalLanguage) || isChapterCompletedFreeMode;
```

**修改文件**：
- `toonflow-game-app/src/modules/game-runtime/services/ChapterRuntimeService.ts`
