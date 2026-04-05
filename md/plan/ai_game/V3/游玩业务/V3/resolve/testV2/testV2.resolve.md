# test.V2 处理方案

## 目标

针对 [test.V2.md](/mnt/d/users/viaco/tools/toonflow-game/toonflow-game-app/md/plan/ai_game/V3/游玩业务/V3/test/test.V2.md) 里剩余的两类核心问题做收口：

1. 编排 payload 仍然过重，尤其是角色卡、章节提纲和事件窗口。
2. 章节结束条件判断存在空值误判，导致开场后可能错误切章或直接进入结局链。

## 现状判断

### 已经做过的部分

- 当前事件、动态事件、结束事件 `ending` 已经接入运行态。
- 前端“当前章节事件”面板已经接入 Web 和安卓。
- 调试态和正式会话都已经有 `currentEventDigest / eventDigestWindow / eventDigestWindowText`。
- `storyOrchestratorModel` 已增加显式 `payloadMode`：
  - `compact`
  - `advanced`
- 文本模型配置已增加 `reasoning_effort`：
  - `minimal`
  - `low`
  - `medium`
  - `high`

### 还没收干净的部分

- 编排师 `compactMode` 触发范围太窄。
  - 当前只对 `volcengine/doubao + mini/lite/flash` 生效。
  - 实际项目里常见的 `autodl_chat:MiniMax-M2.5`、`DeepSeek-R1-*` 这类模型仍然走了偏重 payload。
- `describeRole()` 在编排侧仍然会把太多静态描述、参数卡内容塞进 prompt。
- `ChapterOutcomeEngine` 对 `completionCondition.success/failure` 的空值判断不严。
  - `null` 会被当成一个“存在的规则节点”送进 `evaluateCondition(...)`。
  - 这会干扰第一章开场和用户输入节点的结果判定。

## 本轮处理

### 1. 收紧编排 payload

执行原则：

- 保留：
  - 最近对话
  - 当前事件序号
  - 当前事件摘要
  - 当前事件事实
  - 当前故事动态摘要
  - 角色精简参数卡
- 收缩：
  - 世界简介
  - 章节提纲
  - 用户交互节点摘录
  - 事件窗口文本
  - 角色描述文本

具体改法：

- `describeRole()` 的 compact 分支只保留：
  - 角色名
  - 性别
  - 年龄
  - 性格
  - 等级/等级描述
- `compactMode` 下：
  - 世界简介缩短
  - 章节提纲缩短
  - 用户节点缩短
  - 事件窗口只取更短窗口
- 扩大 `compactMode` 生效范围：
  - `autodl_chat`
  - `lmstudio`
  - 以及模型名里明显属于 `mini / lite / flash / r1 / minimax / deepseek`

### 2. 修复章节结束条件空值误判

把这段：

- `failureNode !== undefined`
- `successNode !== undefined`

改成：

- `failureNode != null`
- `successNode != null`

原因：

- `null` 不是一个有效结束条件节点。
- 继续把 `null` 送入 `evaluateCondition(...)`，会把“没写失败条件/成功条件”的章节错当成“写了一个条件”。

## 本轮结论

这轮不是重做设计，而是先做两刀止血：

1. 让编排师真正吃到精简 payload。
2. 让章节结束条件先回到正确判定。

## 本轮新增收口

### 3. 编排师 payloadMode 改成显式配置

之前的问题是：

- 只靠模型名猜 `compactMode`
- 配置不可见
- Web/安卓都无法明确控制

这轮已经改成：

- `storyOrchestratorModel` 支持显式 `payloadMode`
  - `compact`
  - `advanced`
- 运行时优先读取显式配置
- 只有未配置时才回退到旧的模型名推断
- Web / 安卓设置页都已同步暴露这个开关

### 4. 文本模型增加 reasoning_effort 配置

这轮已新增文本模型配置项：

- `reasoning_effort`
  - `minimal`
  - `low`
  - `medium`
  - `high`

执行规则：

- 文本模型默认 `minimal`
- 后端配置表、接口、调用层已经接通
- Web / 安卓模型管理页都已同步暴露
- 文本调用层会在 openai-compatible 路径下透传 `reasoning_effort`

### 5. 编排运行时增加可观察性

这轮又补了运行时观测字段，编排结果里会直接返回：

- `orchestratorRuntime.modelKey`
- `orchestratorRuntime.manufacturer`
- `orchestratorRuntime.model`
- `orchestratorRuntime.reasoningEffort`
- `orchestratorRuntime.payloadMode`
- `orchestratorRuntime.payloadModeSource`

这样做的目的：

- 做 `test.V2` 回归时，不再靠模型名猜当前到底走的是 `compact` 还是 `advanced`
- 也不再需要翻后端日志确认 `reasoning_effort`
- 调试态 `/game/orchestration` 和正式会话编排结果都能直接看见当前实际生效的编排运行配置

## 后续建议

下一轮如果继续收 `test.V2`，优先顺序应该是：

1. 做一轮真实章节回归：
  - 第 1 章开场白
  - 用户输入姓名/性别/年龄
  - 第一章结束
  - 第二章静态事件生成
2. 核对 `orchestratorRuntime` 返回是否与设置页一致：
  - `payloadMode`
  - `payloadModeSource`
  - `reasoningEffort`
3. 核对 `reasoning_effort` 在各文本厂商下的真实生效情况，确认哪些厂商会忽略。
4. 观察 `compact / advanced` 两档下的 token、响应时延和首轮推进差异。
