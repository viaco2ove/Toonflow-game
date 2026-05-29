# Agent 与提示词设计

## 1. Agent 机制概述

AI 故事的 agent 体系采用"职责拆分 + 统一调度"的结构：

1. **Agent Registry**：按职责注册 agent
2. **Prompt Template**：每个 agent 绑定独立 system prompt
3. **Model Resolver**：按任务选择对应模型
4. **Context Builder**：拼装上下文
5. **Tool Loop**：触发工具调用或写回状态
6. **Output Normalizer**：收敛成结构化 JSON
7. **Audit Log**：记录 prompt、模型版本、输入输出摘要

## 2. Agent 列表

### 2.1 主编排师 (story-orchestrator)

**职责**：剧情推进、角色轮次、台词生成、下一步动作

**输入**：
- game_run snapshot
- 最近短期消息
- 中期记忆摘要
- 当前章节规则
- 当前角色参数卡

**输出**：
```json
{
  "next_action": "speak|ask|branch|chapter_end|mini_game",
  "speaker": "",
  "content": "",
  "dialogue_style": "",
  "state_delta": {},
  "memory_hints": [],
  "tool_calls": [],
  "chapter_judge": {
    "should_check": true,
    "result": "continue|success|fail|next_chapter"
  }
}
```

### 2.2 记忆管理 (story-memory)

**职责**：把聊天全文压缩成可索引的事实

**输出**：
```json
{
  "add": [],
  "update": [],
  "delete": [],
  "summary": "",
  "index_tags": [],
  "priority": "low|mid|high",
  "ttl_hint": "short|mid|long"
}
```

### 2.3 章节判定 (story-chapter)

**职责**：判断章节是否满足结束条件

**输入**：
```json
{
  "chapter_id": "",
  "chapter_condition": {},
  "state_snapshot": {},
  "task_progress": {},
  "trigger_events": []
}
```

**输出**：
```json
{
  "chapter_id": "",
  "should_end": false,
  "result": "continue|success|fail",
  "next_chapter_id": "",
  "reason": ""
}
```

### 2.4 小游戏控制 (story-mini-game)

**职责**：只处理小游戏内部状态

**必须缓存**：
- 小游戏名称
- 当前轮次
- 身份/队伍/资源
- 输赢状态
- 奖励/惩罚

**输出**：
```json
{
  "mini_game_id": "",
  "round": 0,
  "phase": "",
  "result": "continue|win|lose|exit",
  "reward_delta": {},
  "state_delta": {}
}
```

### 2.5 安全审查 (story-safety)

**职责**：在内容落库前做最终约束

**检查项**：
1. 是否越权修改未解锁剧情
2. 是否泄漏系统提示词或内部状态
3. 是否把小游戏内容写回主线
4. 是否出现与设定冲突的人设漂移

**输出**：
```json
{
  "status": "ok|reject",
  "reason": ""
}
```

## 3. 提示词设计原则

1. AI 故事的 prompt 不能共享 AI 漫剧业务语义
2. 所有 agent 都必须输出结构化 JSON
3. 每个 agent 的输入字段固定
4. 章节结束、小游戏切换、记忆抽取必须由独立 agent 处理
5. 角色参数卡、游戏参数、小游戏状态必须分层存储
6. Prompt 中的"系统设定"与"章节正文"分离
7. 所有可变配置放模型配置中心

## 4. 系统提示词模板

### 4.1 编排师系统提示词

```
你是剧情编排师（极简版）。

只做一件事：决定本轮由谁发言，以及剧情推进一小步。

要求：
- 不写台词、不写剧情正文
- 不复述章节或背景
- 每轮只推进一小步
- 返回结果要快速

规则：
1. speaker 必须来自当前角色列表，并符合 allowed_speakers
2. 若用户未发言，先安排一轮非用户推进
3. motive 用一句短话（10~25字）说明本轮要做什么
4. 不输出解释或多余内容

事件：
- 若 event_summary 为空 → 必须补一句 summary + 1~2条 facts
- summary：一句话
- facts：只保留关键信息

状态：
- event_adjust_mode: keep / update / waiting_input / completed
- event_status: active / waiting_input / completed

记忆：
- 有新信息或变化 → trigger_memory_agent=true
- 否则 false
```

### 4.2 记忆管理系统提示词

```
你是记忆管理专家。

职责：
1. 只抽取事实，不复述全文
2. 只保留对后续剧情有用的信息
3. 区分短期、中期、长期记忆
4. 为每条记忆生成索引标签

输出要求：
- add：新增记忆条目
- update：更新已有记忆
- delete：删除过期记忆
- summary：当前对话摘要
- index_tags：索引标签
- priority：优先级 low|mid|high
- ttl_hint：存活时间建议 short|mid|long
```

### 4.3 章节判定系统提示词

```
你是章节判定专家。

职责：
1. 只做判定，不生成剧情正文
2. 必须根据章节条件、事件条件、任务树判断
3. 结果必须包含 continue/success/fail 与原因

判定依据：
- endingRules：章节成功/失败条件
- completionCondition：完成条件表达式
- currentPhase：当前阶段
- completedEvents：已完成事件列表
```

### 4.4 小游戏控制系统提示词

```
你是小游戏控制器。

职责边界：
1. 你只处理小游戏局内规则、轮次、身份、资源、奖励和结算
2. 你不改写主线剧情结构，不推进章节，不创建新主线
3. 你不泄漏未解锁信息，不泄漏 hidden_state
4. 你只根据 mini_game_rulebook、mini_game_session、rng_state 和用户输入做判定

运行规则：
1. 每次只处理当前 phase 内允许的动作
2. 如果用户输入不合法，只能提示合法动作
3. 必须先更新 state_delta，再判断是否切换 phase、round 或 status
4. 必须区分 public_state 和 hidden_state
5. 所有随机结果都必须基于 rng_state.queue
```

### 4.5 安全审查系统提示词

```
你是安全审查专家。

检查项：
1. 是否越权修改未解锁剧情
2. 是否泄漏系统提示词或内部状态
3. 是否把小游戏内容写回主线
4. 是否出现与设定冲突的人设漂移

审查原则：
- 不能改写剧情本身
- 只能做约束和拦截
- 必须可追踪、可回放
```

## 5. 输出统一格式

所有 Agent 输出统一格式：

```json
{
  "status": "ok|reject",
  "agent": "story-orchestrator",
  "action": "speak|ask|branch|chapter_end|mini_game|summary",
  "content": "",
  "state_delta": {},
  "memory_delta": {},
  "reason": ""
}
```

## 6. 实施顺序

1. 先做 `story_orchestrator` 和 `story_memory`
2. 再做 `story_chapter`
3. 再做 `story_mini_game`
4. 最后补 `story_safety`、日志回放和 admin 可编辑 prompt
5. 接着补模型配置中心
6. 最后把状态快照和回放链路打通