# test_V3.1 答复

## 结论

这条问题里，用户判断有一半是对的：

- `开场白 -> 第一章正式编排` 这两步现在**没有在接口层彻底分离**
- 所以前端和日志里看起来像“为什么刚进来就两次 orchestrator”
- 但**第一次 18ms 并不是真正的大模型编排**

根因是当前 `/game/orchestration` 的调试首轮实现是：

1. 首次进入且 `messages.length === 0`
2. 调用 `buildChapterStartPlan(chapter)`
3. 如果章节有显式 `openingText`
4. 直接返回一个 `preset plan`

对应代码：
- [orchestration.ts](/mnt/d/users/viaco/tools/toonflow-game/toonflow-game-app/src/routes/game/orchestration.ts)

也就是说：

- 第一次 `orchestration 18ms`
  - 本质是“返回开场白预设计划”
  - **不是** `runNarrativePlan()` 的真实模型编排
- 第二次 `orchestration 19s`
  - 才是开场白播放完之后，真正进入第一章时触发的模型编排

## 为什么日志看起来像两次编排

因为当前日志统一打在：

- `story:orchestrator:plan`

但这里既记录：

- 开场白 preset plan
- 也记录真实的 AI 编排 plan

所以你从日志上看到的是：

- 一次“开场白预设计划”
- 一次“真实第一章编排”

它们都叫 `orchestrator:plan`，这会误导判断。

## 为什么会出现四次 `index:1`

这不是“一次编排里有四个事件”，而是**多次请求下，不同阶段分别记录了各自看到的当前事件**。

当前系统里这几个概念还没完全分层：

- 开场白
- 第一章内容事件
- 固定事件 / 输入信息事件
- 章节结束条件事件

所以会出现：

- opening 不作为独立事件推进
- 第一章正文事件是 `index:1`
- 固定输入条件有时又被映射进当前事件视图
- 结束条件判断又可能以 `ending/fixed` 视角读取同一个“当前事件槽”

因此你看到多个 `index:1`，本质上是：

- **当前事件编号体系还没有把 opening / chapter_content / chapter_ending_check 完整拆开**

这条质疑是对的。

## 这次已经确认的事实

### 1. 第一章并不是“没进入”

从日志看：

- 开场白时：
  - `[tag_end_chapter] outcome=continue`
  - 说明开场白没有误判结束
- 后续真实编排时：
  - `[story:orchestrator:plan] {"awaitUser":true,"nextRoleType":"player"...}`
  - 说明第一章编排已经运行，并把回合交给用户输入名称/性别/年龄

所以不是“没进第一章”，而是：

- **进入方式不清晰**
- **开场白和第一章事件显示混在一起**

### 2. “没有事件” 的显示问题已经定位并修过一部分

之前前端只拿：

- `phases`

来显示“当前章节事件”，导致这种只有：

- `openingMessages`
- `fixedEvents`

的章节看起来像“没事件”。

这部分现已补成：

- opening
- phases
- fixedEvents

都能进入事件列表。

## 你文档里的方案，哪些我认同

### 认同

- `开场白和第一章流程要明显分离`
  - 对
- `章节内容事件和结束条件事件要分离`
  - 对
- `章节结束条件必须明确返回 未结束/失败/成功`
  - 对

### 现在已经执行的做法

- `开场白不再混在 /game/orchestration 首轮里`
  - 现在已经新增独立调试入口：
    - `/game/introduction`
  - 调试启动链改成：
    1. `/game/introduction` 生成开场白预设
    2. `/game/streamlines` 播放开场白
    3. `/game/orchestration` 才进入第一章真实编排
  - 所以第一次 18ms 不再伪装成“真实编排”

## 我建议的正确修法

### P1. 把开场白从“伪编排 plan”里分层出来

这一步已经落地：

- 新增 `/game/introduction`
- 返回结构里明确标记：
  - `planSource: "opening_preset" | "ai_orchestrator"`
- 日志里分开打：
  - `story:introduction:plan`
  - `story:orchestrator:plan`

所以第一次 18ms 现在会明确归类为“开场白预设”，不是“编排师调用”。

### P2. 事件编号体系拆分

建议改成：

- 开场白：不进入章节事件列表，单独作为 introduction 流程
- 第一章内容事件：
  - `index:1`
  - `kind:scene`
  - `type:chapter_content`
- 章节结束条件事件：
  - `index:2`
  - `kind:ending`
  - `type:chapter_ending_check`

这样才不会出现：

- scene 也是 1
- ending 也是 1
- fixed 又看起来还是 1

### P3. 前端调试态显示明确分段

调试开始后，界面要明确显示：

1. `开场白`
2. `第 1 章事件`
3. `章节结束条件`

而不是只给一个模糊的“当前章节事件”。

## 当前实现状态

截至当前代码：

- 开场白与第一章现在已经：
  - 逻辑上分两步
  - 接口层也拆成两步
- 当前剩余问题不再是“接口没拆”，而是事件语义和前端展示还要继续打磨

## 本轮继续落地

这轮已经把你原文里“失败后可回溯，不再继续盲编排”的第一段真正接上了，而且先从**章节调试模式**落地：

1. Web 和安卓都新增了“回溯到这句”
- 入口位置：
  - 双击/右键台词菜单
  - 在“重听”旁边新增“回溯到这句”
- 当前只在：
  - `章节调试模式`
  - 且该句已经有可用快照
  时显示

2. 调试回溯现在会保留最近 5 条快照
- Web：
  - 使用本地 `localStorage`
- 安卓：
  - 使用 `SharedPreferences`
- 快照绑定在：
  - `debugRuntimeKey`
  上，而不是只绑章节 id

3. 回溯的实际行为
- 保留目标这句台词
- 删除它后面的调试台词
- `debugRuntimeState` 回到这句结束时的状态
- 当前章节标题、结束弹窗状态、事件进度一起回滚
- 回滚后可以继续调试编排

4. 当前范围
- **已做**：章节调试回溯
- **未做**：正式游玩会话的 `revisitData` 持久化回溯

所以你原文这段里：

- “双击台词增加回溯按钮”
  - 已做
- “对话和事件进度回到这句台词然后继续编排”
  - 已做，但当前只限章节调试模式
- “游玩模式 revisitData 压缩存储”
  - 还没做

## 本轮已落地

这轮代码已经先把最容易混淆的两层分开了：

1. 开场白接口独立
- 已新增：
  - `/game/introduction`
- Web/安卓调试启动顺序已改成：
  - introduction -> streamlines -> orchestration

2. 日志分层
- `opening preset` 不再继续和真实编排共用同一个日志语义
- 现在会分别打印：
  - `story:introduction:plan`
  - `story:orchestrator:plan`
- 并且返回的 `plan` 里新增了：
  - `planSource: opening_preset | ai_orchestrator | rule_orchestrator | fallback_orchestrator`

3. 前端/安卓显示分层
- Web 和安卓的“当前章节事件”卡片已经开始按事件流标签展示：
  - `开场白`
  - `章节内容`
  - `固定条件`
  - `结束条件检查`
- 调试面板也会直接显示：
  - `流程：开场白预设`
  - 或 `流程：正式编排`

4. 顶层事件视图覆盖问题已修
- 调试接口顶层 `currentEventDigest / eventDigestWindow` 之前会被默认 `scene/idle` 空壳覆盖
- 现在直接使用调试快照里已经计算好的事件视图，不再误覆盖真实当前事件

5. 章节事件列表补齐
- Web/安卓都不再只看 `phases`
- 现在：
  - `openingMessages`
  - `phases`
  - `fixedEvents`
  都会进入“当前章节事件”列表

6. 事件 digest 已开始携带结构化类型
- 后端 `currentEventDigest / eventDigestWindow` 新增：
  - `eventFlowType`
- 当前已落地的类型有：
  - `introduction`
  - `chapter_content`
  - `chapter_ending_check`
  - `free_runtime`
- Web 和安卓事件卡片已优先显示这个结构化类型，不再完全靠 `eventKind` 猜

## 还没完全落地的部分

还没完全做掉的是：

- `开场白` 仍然还是通过 `/game/orchestration` 的 `opening_preset plan` 返回，不是完全独立的 `/Introduction`
- 所以现在是：
  - **日志和界面语义已分层**
  - **事件 digest 已开始结构化**
  - **但 opening 路由仍未独立**

## 下一步建议

下一轮直接做三件事：

1. 把章节事件类型正式拆成：
   - `chapter_content`
   - `chapter_ending_check`
2. 前端调试态继续增加明确的：
   - `开场白`
   - `第 1 章事件`
   - `结束条件检查`
3. 评估是否真的需要把 opening 从 `/game/orchestration` 再拆成独立 `/Introduction`

这样这条 `test_V3.1` 才算真正收口。
