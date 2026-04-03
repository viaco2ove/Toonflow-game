# AI 故事编排师等 Agent 3.0 任务拆分

关联文档：
- [ai故事_编排师等agent_3.0.md](ai%E6%95%85%E4%BA%8B_%E7%BC%96%E6%8E%92%E5%B8%88%E7%AD%89agent_3.0.md)
- [编排师_2_0.md](../V1_V2/%E7%BC%96%E6%8E%92%E5%B8%88_2_0.md)
- [编排师_2_0_任务拆分.md](../V1_V2/%E7%BC%96%E6%8E%92%E5%B8%88_2_0_%E4%BB%BB%E5%8A%A1%E6%8B%86%E5%88%86.md)

---

## 目标
把 3.0 方案拆成可以逐步落代码的任务，优先解决：

- 普通轮次出词太慢
- 每轮模型调用次数过多
- speaker prompt 仍然偏重
- 记忆与语音阻塞体感
- 很多轮次本可规则直出，却仍然走全链路 AI

3.0 的原则不是回退 2.0，而是在 2.0 的“章节状态机稳定”基础上继续做：

- 规则优先
- 发言分级
- 极简上下文
- 异步后处理

---

## 当前进度
- `任务 1` 已完成基础版：`streamlines` 已加入 `heartbeat`，长时间 speaker 生成时不再静默无输出
- `任务 2` 已完成一阶段：speaker 系统提示词已从 `story-main` 解耦，不再混入“总调度”人格
- `任务 2` 已完成一阶段：speaker 上下文已做第二轮压缩，当前已减少世界简介、最近对话和可见角色数量
- `任务 4` 已完成基础版：新增 `RuleOrchestrator.ts`，当前已能在“用户节点交还用户”“turnState 已明确下一位角色”“当前 phase 仅允许单一角色”三类场景下直接规则出 plan
- `任务 4` 已完成第二刀：规则命中面已继续扩大，当前章节 outline 若已明确点名单一角色，或阶段明显属于旁白过场/万能角色拱火，也会优先规则直出
- `任务 5` 已完成基础版：编排顺序已明确收成“`rule -> ai -> fallback`”；`source=rule` 已贯通到 `NarrativeOrchestrator / SessionService / orchestration`
- `任务 6` 已完成基础版：新增 `SpeakerRouteEngine.ts`，当前已能把部分旁白环境补句和万能角色起哄句路由到 `template` 档，直接跳过 speaker 模型
- `任务 6` 已完成第二刀：`speakerMode / speakerRouteReason` 已写入 narrativePlan 摘要；低风险 `template/fast` 轮次会进一步压低异步记忆刷新
- `任务 8` 已完成第一刀：`fast` 档已接入更激进的极简 speaker prompt，当前普通承接型 NPC 回合和部分关键角色的简单反应回合，可在不新增模型槽位的前提下先减少 speaker token
- `任务 8` 已完成第二刀：后端、Web、安卓的 `storyFastSpeakerModel` 模型槽位已打通；未单独配置时会自动回退到 `storySpeakerModel`
- `任务 8` 已完成第三刀：speaker AI 调用现已附带 `speakerMode / speakerRouteReason` 用量元数据，可单独观察 `fast` 档的耗时与成本收益
- `任务 8` 已完成第四刀：`SpeakerRouteEngine` 已更激进地把旁白过场、万能角色短拱火、普通 NPC 短承接句，以及关键角色的低风险短反应句路由到 `template / fast`
- 当前结论：3.0 已完成“止血层”“规则编排第一刀”“发言分级前五刀”，接下来重点进入“扩大规则命中率 + 验证独立 fast speaker 模型的实际收益”

---

## 总体分期

### P1：先把体感卡顿降下来
目标：

- 前端不再误报超时
- speaker prompt 不再人格混乱
- 语音、记忆不阻塞首屏

### P2：减少模型调用次数
目标：

- 很多轮次不再走 AI 编排师
- phase graph 能直接给出下一位 speaker
- 编排师只在“规则无法决定”时才启用

### P3：发言分级
目标：

- 模板直出覆盖旁白、万能角色、路人、功能性过场
- 普通 NPC 使用 fast speaker
- 关键角色和关键时刻使用 premium speaker

### P4：动态上下文缓存
目标：

- 不牺牲动态背景和动态参数
- 但不再每轮全量重塞上下文

---

## P1 总目标

P1 完成标准：

- `streamlines` 在长生成时持续有事件输出
- speaker 不再混入总调度人格
- speaker 平均 prompt 长度明显下降
- 语音和记忆都不阻塞“先看到字”

当前状态：

- 前两项已完成基础版
- 后两项仍需继续推进

---

## 任务 1：流式心跳与前端空闲超时对齐

### 目标
解决“前端先报超时，后端稍后才成功”的状态错位问题。

### 已完成
- 后端 [`streamlines.ts`](../../../../../../src/routes/game/streamlines.ts) 已在 speaker 生成期间发 `heartbeat`

### 还要继续的部分
- Web 侧把 `heartbeat` 明确识别成“仍在生成”
- Android 侧把 `heartbeat` 明确识别成“仍在生成”
- 把 `15s` 的空闲超时改成配置化，而不是写死

### 要改的文件
- `src/routes/game/streamlines.ts`
- `Toonflow-game-web/src/api/toonflow.ts`
- `Toonflow-game-android/app/src/main/java/com/toonflow/game/data/GameRepository.kt`

### 验收
- 远程模型生成超过 15 秒时，前端不再先报错
- `heartbeat` 不会污染消息正文

---

## 任务 2：speaker 提示词彻底去“总调度人格”

### 目标
保证角色发言器只做一件事：把既定 `speaker + motive` 写成正文。

### 已完成
- [`NarrativeOrchestrator.ts`](../../../../../../src/modules/game-runtime/engines/NarrativeOrchestrator.ts) 中 `buildSpeakerSystemPrompt()` 已不再拼接 `story-main`

### 还要继续的部分
- 数据库默认 prompt 结构要重定义职责：
  - `story-main`：全局通用约束
  - `story-orchestrator`：只给编排师
  - `story-speaker`：只给发言器
  - `story-memory`：只给记忆管理器
- 避免后台默认 prompt 初始化仍把 `story-main` 写成“你是 AI 故事总调度”

### 要改的文件
- `src/lib/initDB.ts`
- `src/lib/fixDB.ts`
- `src/routes/prompt/updatePrompt.ts`

### 验收
- 后台新建/修复默认 prompt 后，speaker 与 orchestrator 的系统角色清晰分离

---

## 任务 3：speaker payload 再瘦一轮

### 目标
让角色发言器只吃当前轮真正必要的信息。

### 现状
当前已压缩到：

- 精简世界简介
- 精简角色资料
- 3~5 条最近对话
- 3~4 个其他角色

但仍然偏重。

### 目标结构
speaker 最终输入只保留：

```txt
[speaker]
[phase]
[motive]
[recent]
[player]
```

### 要做的事
- 新增 `buildSpeakerLiteContext()`
- `speakerProfile` 从参数卡摘要改成固定 `roleLiteProfile`
- `storyState` 从长摘要改成 1~2 行 `turnFocus`
- `otherRoles` 默认不传，只有必要时才传

### 要改的文件
- `src/modules/game-runtime/engines/NarrativeOrchestrator.ts`

### 验收
- 普通轮次 speaker `prompt_tokens` 继续下降
- 不影响角色口吻稳定性

---

## 任务 4：规则编排器基础版

### 目标
不是每轮都问 AI 编排师，而是先看规则能不能直接决定下一位 speaker。

### 新增模块
- `src/modules/game-runtime/engines/RuleOrchestrator.ts`

### 第一版职责
输入：

- 当前 phase
- `chapterProgress`
- `turnState`
- 最近一条/两条消息

输出：

```json
{
  "resolved": true,
  "plan": {
    "role": "",
    "roleType": "",
    "motive": "",
    "awaitUser": false,
    "nextRole": "",
    "nextRoleType": "",
    "decisionSource": "rule"
  }
}
```

### 规则优先覆盖场景
- 当前 phase 只有一个允许角色
- 当前 phase 是纯旁白氛围过渡
- 当前 phase 是固定万能角色/路人挑衅
- 当前已进入用户节点，必须 `awaitUser=true`

### 要接入的地方
- `src/modules/game-runtime/engines/NarrativeOrchestrator.ts`
- `src/modules/game-runtime/services/SessionService.ts`

### 验收
- 命中规则路径时，不再调用 `storyOrchestratorModel`
- 日志里能明确区分 `decisionSource=rule`

---

## 任务 5：编排师降级为“规则失败后的兜底”

### 目标
把 AI 编排师从“默认每轮必跑”改成“规则无法决定时才跑”。

### 设计
编排顺序变成：

1. `RuleOrchestrator`
2. 若未命中规则，才 `runNarrativePlan()`
3. 若模型异常，再走 `fallback`

### 要改的文件
- `src/modules/game-runtime/engines/NarrativeOrchestrator.ts`
- `src/modules/game-runtime/services/SessionService.ts`
- `src/routes/game/orchestration.ts`

### 验收
- 大量普通轮次不再有 `/game/orchestration` 的真实模型请求
- 日志里能看到 `rule / ai / fallback` 三种来源

---

## 任务 6：发言分级路由器

### 目标
不是所有台词都走同一档模型。

### 新增模块
- `src/modules/game-runtime/engines/SpeakerRouteEngine.ts`

### 输出
```json
{
  "mode": "template | fast | premium",
  "reason": "",
  "voiceMode": "skip | async | immediate",
  "memoryMode": "skip | async"
}
```

### 第一版分流规则
- `template`
  - 旁白环境补句
  - 万能角色/路人起哄
  - 功能性过场
- `fast`
  - 普通 NPC
  - 泛旁白
- `premium`
  - 萧炎、纳兰嫣然、薰儿等关键角色
  - 关键冲突
  - 用户首次建立关系

### 要改的文件
- `src/modules/game-runtime/engines/NarrativeOrchestrator.ts`
- `src/modules/game-runtime/services/SessionService.ts`

### 验收
- 可在日志中看到每轮发言模式
- 多数旁白/路人/万能角色轮次不再走 premium

---

## 任务 7：模板直出引擎

### 目标
让大量功能性轮次无需大模型，接近秒回。

### 新增模块
- `src/modules/game-runtime/engines/TemplateSpeakerEngine.ts`

### 第一版模板覆盖
- 旁白环境反应
- 旁白氛围压句
- 某男子/某男士/某女士等万能角色挑衅句
- 练武场、街市、山林等场景通用补句

### 输入
- `speaker`
- `motive`
- `phase.label`
- `currentTurnFocus`

### 输出
- 一段可直接落库的正文

### 验收
- 模板命中轮次可在 50~200ms 内出结果
- 输出仍符合展示格式规则（动作括号、正文在外）

---

## 任务 8：fast speaker

### 目标
给普通 NPC 和普通旁白提供低成本、低延迟发言模式。

### 原则
- 严格短上下文
- 不开强推理
- 低延迟模型优先

### 要做的事
- 新增 `fastSpeakerModel`
- 若未配置，回退到 `storySpeakerModel`
- `fast` 模式下进一步限制：
  - 最多 2~3 条最近对话
  - 不带长故事摘要
  - 不带完整角色压缩卡

### 要改的文件
- `src/lib/initDB.ts`
- `src/lib/fixDB.ts`
- `src/modules/game-runtime/engines/NarrativeOrchestrator.ts`
- 模型设置前后端

### 验收
- `fast` 模式平均时延显著低于 `premium`

---

## 任务 9：premium speaker

### 目标
保留高质量关键角色表达，但不阻塞大多数轮次。

### 适用场景
- 萧炎、纳兰嫣然、薰儿等关键角色
- 关键关系建立
- 章节重大冲突

### 要做的事
- `premium` 模式允许更丰富的角色资料
- 但仍然只走精简版动态上下文，不回退到 1.0/2.0 的大包输入

### 验收
- 关键角色质量保留
- 普通轮次不被 premium 拖慢

---

## 任务 10：动态上下文缓存三层化

### 目标
既保留动态背景，又不每轮全量重塞。

### 新增结构

#### `roleLiteProfile`
每个角色的最小资料：

```json
{
  "name": "萧炎",
  "roleType": "npc",
  "traits": ["隐忍", "少年心性强", "重尊严"],
  "speechStyle": "压抑、克制、锋利"
}
```

#### `sessionDynamicDigest`
会话级动态摘要：

- 当前关系
- 当前任务
- 当前阵营
- 当前重要道具

#### `currentTurnFocus`
当前轮焦点：

- 当前冲突
- 当前目标
- 当前 speaker 真正关心的对象/动作

### 要改的文件
- `src/lib/gameEngine.ts`
- `src/modules/game-runtime/services/SessionService.ts`
- `src/modules/game-runtime/engines/NarrativeOrchestrator.ts`

### 验收
- speaker 不再需要长 `storyState`
- 动态状态仍能正确影响台词

---

## 任务 11：记忆管理改为事件触发

### 目标
降低 token 和请求次数。

### 只在这些情况触发
- 新关系建立/破裂
- 新任务出现
- 新关键道具变化
- 阶段切换
- 用户关键选择
- 章节成功/失败

### 不触发的情况
- 普通对喷
- 普通场景补句
- 纯氛围旁白

### 要改的文件
- `src/modules/game-runtime/engines/NarrativeOrchestrator.ts`
- `src/modules/game-runtime/services/SessionService.ts`
- `src/modules/game-runtime/services/SessionMemoryWorker.ts`

### 验收
- 普通轮次不再默认触发记忆刷新
- 关键节点仍会刷新

---

## 任务 12：语音彻底异步化

### 目标
用户先看到字，再决定是否等语音。

### 要做的事
- 正文提交与语音生成完全解耦
- 模板直出/fast 模式优先走标准预设音色
- premium 才考虑复杂克隆链

### 要改的文件
- Android / Web 播放链
- `src/routes/voice/*`
- `SessionService` 里与消息落库后联动的部分

### 验收
- 语音失败不阻塞正文
- 语音延迟不影响“先看到字”

---

## 任务 13：统计与日志支持 3.0

### 目标
让 3.0 的效果可观测。

### 要记录的维度
- `decisionSource: rule / ai / fallback`
- `speakerMode: template / fast / premium`
- `memoryMode: skip / async`
- `voiceMode: skip / async / immediate`

### 要改的文件
- `src/lib/aiTokenUsageLog.ts`
- `src/utils/ai/text/index.ts`
- 设置页统计展示

### 验收
- 能看出哪类轮次最烧钱
- 能明确判断 3.0 是否真的减少了模型调用

---

## 建议实施顺序

### 第一批：先止血
1. 任务 1：流式心跳与超时对齐
2. 任务 2：speaker 人格解耦
3. 任务 3：speaker payload 再瘦一轮

### 第二批：先省一半模型
4. 任务 4：规则编排器基础版
5. 任务 5：编排师降为兜底

### 第三批：做秒回主体
6. 任务 6：发言分级路由器
7. 任务 7：模板直出引擎
8. 任务 8：fast speaker
9. 任务 9：premium speaker

### 第四批：做动态能力与成本收口
10. 任务 10：动态上下文缓存三层化
11. 任务 11：记忆管理事件触发
12. 任务 12：语音彻底异步化
13. 任务 13：统计与日志支持 3.0

---

## 完成标准

### 体感
- 大多数普通轮次 1~3 秒内看到正文
- 关键角色轮次尽量控制在 3~6 秒
- 不再频繁出现前端先报错、后端后成功

### 成本
- 普通轮次不再固定烧编排师 + speaker + memory 三次
- 旁白/万能角色/路人多数轮次不再走 premium

### 质量
- 保持 2.0 的章节稳定性
- 不抢用户回合
- 不脱离阶段
- 不丢动态背景和动态参数

---

## 当前结论

3.0 的真正核心不是“把 prompt 再压 10%”，而是：

- **减少不必要的模型调用**
- **把普通轮次从 AI 生成改成规则/模板/轻量模型**
- **让高质量模型只服务真正值得慢一点的时刻**

只有这样，才可能既保住质量，又真正接近秒回。
