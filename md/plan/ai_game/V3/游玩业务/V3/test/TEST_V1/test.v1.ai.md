![img.png](img.png)

## 现象

章节调试首次进入时：

- 进入很慢
- 先显示开场白：
  - “混沌虚空之中，一道巨大的裂隙缓缓旋转，如同一只沉睡巨兽微微张开的眼睛”
- 前端表现得像“下一位就是用户”

但实际章节内容里希望出现的是：

```text
@旁白：此刻你穿越来了这个世界。请输入你的名称 性别，年龄
```

## 关键信号

### `/orchestration` 返回

关键点：

- `currentEventDigest.eventSummary = ""`
- `eventStatus = "idle"`
- `plan.source = "fallback"`
- `plan.eventType = "on_opening"`
- `plan.presetContent = "混沌虚空之中，一道巨大的裂隙缓缓旋转，如同一只沉睡巨兽微微张开的眼睛"`

这说明：

- 当前只是返回了章节开场白
- 还没有正式进入第一轮剧情编排

### 浏览器 storage

关键点：

- `currentRole = 旁白`
- `currentRoleType = narrator`
- `currentStatus = waiting_player`
- `nextRole = 用户`
- `nextRoleType = player`

这说明：

- 前端把这一轮开场消息之后，处理成了“直接交给用户”

## 结论

这个问题不是“自由章节机制完全失效”，而是：

**章节调试首次进入时，开场白逻辑抢占了首轮剧情衔接。**

也就是：

1. 调试链优先返回 `openingText`
2. 没有继续承接 `content` 里的第一条有效剧情
3. 前端又把这轮 opening 之后直接理解成“该轮到用户”

## 当前代码依据

### 1. 调试首次进入优先走 opening

对应：

- [`src/routes/game/orchestration.ts`](/mnt/d/users/viaco/tools/toonflow-game/toonflow-game-app/src/routes/game/orchestration.ts)
  - `buildChapterStartPlan(...)`

当前逻辑是：

- 只要 `openingMessage.content` 有值
- 就直接返回一条 preset plan
- 不继续跑第一轮编排

### 2. opening message 只认 `openingText`

对应：

- [`src/modules/game-runtime/engines/NarrativeOrchestrator.ts`](/mnt/d/users/viaco/tools/toonflow-game/toonflow-game-app/src/modules/game-runtime/engines/NarrativeOrchestrator.ts)
  - `resolveOpeningMessage(...)`

这里的优先级很明确：

- 先读 `chapter.openingText`
- 有就直接返回 opening message
- 不会自动把 `content` 里的第一条 `@旁白：...` 当成开场后续承接

### 3. 当前事件还没真正起起来

从返回里看：

- `currentEventDigest.eventSummary` 为空
- `eventDigestWindowText = "1. [scene/未开始]"`

这说明：

- 当前事件只是一个空壳
- 首轮编排还没真正把它激活成剧情事件

## 正确预期

如果章节内容是：

```text
@旁白：此刻你穿越来了这个世界。请输入你的名称 性别，年龄
```

那更合理的调试体验应该是：

1. 先显示 `openingText`
2. 然后自动再推进一轮旁白
3. 再进入“请输入名称/性别/年龄”的用户输入节点

而不是：

1. 只显示 opening
2. 直接停到用户

## 问题归类

这条 case 主要不是“自由章节连续事件生成问题”，而是：

**章节调试首轮开场衔接问题**

具体涉及三块：

- `openingText`
- `content` 首句
- 用户输入节点

这三者在调试首次进入时没有串起来。

## 建议修复方向

### 方案 A

章节调试首次进入时：

- 如果先返回了 `openingText`
- 不要立刻停住
- 再自动跑一轮 `runNarrativePlan`
- 让章节真正进入第一事件

这是当前最合理的方案。

### 方案 B

把 `content` 首句并进 opening。

即：

- 如果 `openingText` 存在
- 且 `content` 第一条也是明确 narrator 引导
- 直接拼成首轮完整旁白

这个方案也能解决问题，但会把“开场白”和“正文第一句”混成一层，风险更大。

## 当前结论

这条问题已经定位为：

- 不是自由章节机制整体失效
- 是章节调试首次进入时，`openingText` 抢占了首轮流程
- `content` 中真正的第一条剧情引导没有接上
- 前端又把这一轮后错误处理成了“直接轮到用户”

后续优先级：

1. 先修章节调试首轮衔接
2. 再继续验证自由章节事件连续推进
