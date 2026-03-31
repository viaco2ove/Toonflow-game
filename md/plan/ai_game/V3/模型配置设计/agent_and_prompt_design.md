# AI 故事 Agent 与提示词设计

## 0. 说明
当前已经找到真实源码目录：`src\agents`。下面的分析以该源码为准，再结合 task3 提供的设计文档做补充。结论不变：`AI 故事` 这套系统必须与 `ai漫剧` 完全隔离，不能共用业务 prompt、资源和 agent 状态。

## 1. 现有 Agent 机制复原
从源码可直接确认，`ai漫剧` 的 agent 体系不是单一大模型，而是“职责拆分 + 统一调度”的结构。典型链路如下：

1. `Agent Registry`：按职责注册 agent，例如编排、记忆、审查、工具类。
2. `Prompt Template`：每个 agent 绑定独立 system prompt、输入 schema、输出 schema。
3. `Model Resolver`：按任务选择对应模型，不同 agent 可用不同模型。
4. `Context Builder`：把当前状态、历史摘要、角色参数、工具结果拼成上下文。
5. `Tool Loop`：agent 可以触发工具调用或写回状态，形成多轮执行。
6. `Output Normalizer`：把模型输出统一收敛成结构化 JSON，再交给业务层。
7. `Audit Log`：记录 prompt、模型版本、输入摘要、输出摘要，便于调试和回放。

这类实现的关键不是“模型会写剧情”，而是“每个 agent 只做一件事，并且输出可校验”。

### 1.2 源码里的真实模式
当前源码里最清晰的两个实现是：

1. `outlineScript/index.ts`：主 agent + 三个子代理 `AI1 / AI2 / director`。
2. `storyboard/index.ts`：主 agent + 两个子代理 `segmentAgent / shotAgent`。

这两个模块都遵循同一套路：

1. 从 `t_prompts` 读取主 prompt 和子 prompt。
2. 从 `t_setting.languageModel` / `t_aiModelMap` 读取当前用户选中的模型配置。
3. 把项目环境、历史对话、当前任务拼成上下文。
4. 用 `u.ai.text.stream(...)` 调用模型，并挂载 tools。
5. 由子代理实际执行写库、更新分镜、保存大纲等操作。
6. 用 `EventEmitter` 把流式输出、工具调用、完成事件同步给前端。

### 1.1 复原出的调用链
更贴近实际的调用顺序应是：

1. 读取 `game_run` 当前快照。
2. 拉取角色参数卡、章节配置、世界观配置。
3. 交给 `story_orchestrator` 生成本轮剧情动作。
4. 若触发记忆更新，再交给 `memory_manager` 压缩和打标。
5. 若达到章节边界，再交给 `chapter_judge` 判定。
6. 若触发小游戏，再切到 `mini_game_agent` 独立运行。
7. 最后把结果写回 `snapshot / event / memory / summary`。

这个链路说明：agent 不是“自由对话”，而是“状态机驱动的编排器”。

## 2. AI 故事专用 Agent 架构
建议单独建立 `src/agents/story/`，不要复用 `ai漫剧` 的 prompt 与资源。

```txt
src/agents/story/
  orchestrator/
  memory_manager/
  chapter_judge/
  mini_game/
  safety/
  prompt/
  schema/
```

建议再加一层资源隔离：

```txt
src/story_runtime/
  prompts/
  templates/
  schemas/
  states/
  adapters/
```

这样可以把“故事业务”与“模型调用”拆开，避免 prompt 彼此串味。

### 2.1 结合现有源码的落地方式
如果要在现有框架里实现 `AI 故事`，最稳妥的是延续当前模式：

1. 维持一个 `main agent` 负责调度。
2. 为故事业务拆出独立的 prompt code，例如 `story-main`、`story-orchestrator`、`story-memory`、`story-chapter`、`story-mini-game`。
3. 模型配置单独走新的 `t_aiModelMap` key，不复用 `storyboardAgent`、`outlineScriptAgent`。
4. 所有状态都写入独立业务表或独立 JSON snapshot。

推荐职责如下：

1. `story_orchestrator`：主编排师，负责剧情推进、角色轮次、台词生成、下一步动作。
2. `memory_manager`：记忆管理，抽取短/中/长期记忆，生成索引和摘要。
3. `chapter_judge`：章节判定，判断成功、失败、继续、进入下一章。
4. `mini_game_agent`：小游戏控制器，处理狼人杀、钓鱼、修炼、炼药等独立状态。
5. `safety_agent`：边界检查和输出约束，防止 prompt 注入和剧情乱飞。

## 3. Agent 脚本设计
### 3.1 主编排师
输入：
1. `game_run snapshot`
2. 最近短期消息
3. 中期记忆摘要
4. 当前章节规则
5. 当前角色参数卡

输出建议：
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

### 3.1.1 真实源码对应关系
现有 `outlineScript` 主 agent 的行为，基本就是上面这个 `story_orchestrator` 的雏形，只是它目前服务的是“小说 -> 故事线 -> 大纲”流程，不是“AI 故事运行时”。它已经具备这些能力：

1. 自己拉上下文。
2. 自己发起子代理调用。
3. 子代理自己写库。
4. 主代理只做调度，不直接产出最终业务结果。

### 3.2 记忆管理
职责：把聊天全文压缩成可索引的事实，避免上下文爆炸。

建议输出：
```json
{
  "add": [],
  "update": [],
  "delete": [],
  "summary": "",
  "index_tags": []
}
```

### 3.3 章节判定
职责：判断当前章节是否满足结束条件，是否进入下一章，是否成功或失败。

建议输出：
```json
{
  "chapter_id": "",
  "should_end": false,
  "result": "continue|success|fail",
  "next_chapter_id": "",
  "reason": ""
}
```

### 3.4 小游戏控制
职责：只处理小游戏内部状态，不允许改写主线剧情。

必须缓存：
1. 小游戏名称。
2. 当前轮次。
3. 身份/队伍/资源。
4. 输赢状态。
5. 奖励/惩罚。

### 3.5 安全审查
职责：在内容落库前做最终约束，主要检查：

1. 是否越权修改未解锁剧情。
2. 是否泄漏系统提示词或内部状态。
3. 是否把小游戏内容写回主线。
4. 是否出现与设定冲突的人设漂移。

### 3.6 现有会话与状态持久化
源码里已经有一套会话持久化雏形，核心是 `storyboardChatSessionStore.ts` 和 `chatHistoryManager.ts`：

1. `t_chatHistory` 里按 `storyboardAgent:sessions` 存会话元数据。
2. `t_chatHistory` 里按 `storyboardAgent:session:<id>` 存单会话的详细数据。
3. 会话里不只存 history，还存 `shots`、`shotIdCounter`、`videoDraft`、`pendingStoryboardPlan`。
4. 这说明现有系统已经把“对话状态”和“业务状态”分开存了，只是 `AI 故事` 还需要再细分一层运行态快照。

## 4. 提示词设计原则
1. `AI 故事` 的 prompt 不能共享 `ai漫剧` 业务语义。
2. 所有 agent 都必须输出结构化 JSON。
3. 每个 agent 的输入字段固定，不允许把整份历史全部塞进去。
4. 章节结束、小游戏切换、记忆抽取都必须由独立 agent 处理。
5. 角色参数卡、游戏参数、小游戏状态必须分层存储，不能混成一坨。
6. Prompt 中的“系统设定”与“章节正文”分离，便于 admin 单独编辑。
7. 所有可变配置放模型配置中心，禁止硬编码在 prompt 内。

## 5. 推荐 Prompt 模板
### 5.1 编排师
System Prompt 核心要求：
1. 你是剧情编排师，不是单纯聊天模型。
2. 你必须结合角色参数卡、运行时状态和记忆摘要组织剧情。
3. 你必须输出可解析 JSON，不要输出散文式回答。
4. 你必须判断是否进入章节结束、小游戏或分支。

建议输入模板：

```json
{
  "chapter_id": "ch_001",
  "scene_id": "scene_003",
  "role_cards": [],
  "snapshot": {},
  "recent_dialogue": [],
  "memory_summary": {},
  "chapter_rule": {},
  "allowed_actions": ["speak", "ask", "branch", "mini_game"]
}
```

### 5.2 记忆管理
System Prompt 核心要求：
1. 只抽取事实，不复述全文。
2. 只保留对后续剧情有用的信息。
3. 区分短期、中期、长期记忆。
4. 为每条记忆生成索引标签。

建议输出字段补充：

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

### 5.3 章节判定
System Prompt 核心要求：
1. 只做判定，不生成剧情正文。
2. 必须根据章节条件、事件条件、任务树判断。
3. 结果必须包含 `continue/success/fail` 与原因。

建议输入字段：

```json
{
  "chapter_id": "",
  "chapter_condition": {},
  "state_snapshot": {},
  "task_progress": {},
  "trigger_events": []
}
```

### 5.4 小游戏
System Prompt 核心要求：
1. 只处理小游戏内部逻辑。
2. 不得泄漏主线未解锁信息。
3. 必须维护局内轮次、身份、胜负和奖励。

建议输出字段：

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

## 6. 模型配置
`AI 故事` 的模型配置必须和 `ai漫剧` 完全独立。建议至少拆成：

1. `编排师`：文本模型。
2. `记忆管理`：文本模型。
3. `章节判定`：文本模型。
4. `小游戏提示词`：文本模型。
5. `AI 生图`：图片模型。
6. `语音生成`：语音模型。
7. `语音识别`：语音模型。

### 6.1 现有模型选择机制
源码中的 `getPromptAi(key)` 是按用户维度读模型配置：

1. 先读 `t_setting.languageModel`。
2. 再按 key 找对应配置。
3. 找不到就回退到 `t_aiModelMap`。
4. 最终返回 `model/apiKey/baseURL/manufacturer`。

这意味着 `AI 故事` 只要新增独立的 key，就能做到模型配置隔离，不需要推翻现有框架。

## 7. 状态边界
必须把这些状态分开：

1. 静态内容：故事、章节、角色、世界观。
2. 动态运行：当前章节、当前场景、用户位置、关系值。
3. 局部模式：小游戏局内状态。
4. 记忆层：短期、中期、长期摘要。

只有分层，agent 才不会互相污染。

## 8. 实施顺序
1. 先做 `story_orchestrator` 和 `memory_manager`。
2. 再做 `chapter_judge`。
3. 再做 `mini_game_agent`。
4. 最后补 `safety_agent`、日志回放和 admin 可编辑 prompt。
5. 接着补模型配置中心，把文本模型 / 图片模型 / 语音模型彻底隔离。
6. 最后把状态快照和回放链路打通，保证每次生成可复现。

## 9. 建议 Prompt Code
为了和现有 `t_prompts` 体系兼容，建议为 `AI 故事` 单独定义以下 code：

1. `story-main`：主调度 prompt，负责总入口和工具选择。
2. `story-orchestrator`：剧情编排 prompt，生成本轮台词、动作、分支。
3. `story-memory`：记忆抽取 prompt，负责短/中/长期记忆整理。
4. `story-chapter`：章节判定 prompt，负责结束条件与章节点切换。
5. `story-mini-game`：小游戏 prompt，负责局内规则与状态更新。
6. `story-safety`：安全审查 prompt，负责越权、注入、人设漂移检查。

建议配套的模型 key 也单独区分：

1. `storyAgent`
2. `storyMemoryAgent`
3. `storyChapterAgent`
4. `storyMiniGameAgent`
5. `storySafetyAgent`

这样做的好处是：

1. 可在模型配置中心按功能单独切换。
2. Prompt 可单独编辑，不会互相污染。
3. 出错时可以精确定位到某一段链路。

## 10. 结论
`AI 故事` 的 agent 体系应该是“运行时驱动的多 agent 管线”，而不是“把所有任务都丢给一个模型”。真正可用的实现标准只有两个：输出结构化、状态可回放。只要这两点守住，后续无论接安卓端、Web 端还是小游戏，都能稳定扩展。

## 11. 建议目录结构
建议在现有工程里新增独立业务目录，不与 `ai漫剧` 共用实现：

```txt
src/story/
  agents/
    orchestrator/
    memory_manager/
    chapter_judge/
    mini_game/
    safety/
  prompts/
    story-main.md
    story-orchestrator.md
    story-memory.md
    story-chapter.md
    story-mini-game.md
    story-safety.md
  schemas/
    runtime_snapshot.ts
    role_card.ts
    chapter_rule.ts
    mini_game_state.ts
  services/
    runtime_service.ts
    memory_service.ts
    chapter_service.ts
  stores/
    story_run_store.ts
```

如果短期不拆目录，至少要把 prompt code、模型 key、状态表全部隔离。

## 12. 建议表结构
建议新增或独立前缀化这些表：

1. `t_story_run`：一次故事运行的主记录。
2. `t_story_run_snapshot`：运行时快照，存 `progress/world_state/player_state/event_pool/relationship_state/memory_state`。
3. `t_story_run_event`：事件流，记录每次 agent 输出与状态变更。
4. `t_story_run_memory`：原子记忆。
5. `t_story_run_memory_summary`：记忆摘要和索引。
6. `t_story_run_chapter_rule`：章节结束条件和判定规则。
7. `t_story_run_mini_game`：小游戏局内状态。

字段建议：

```json
{
  "id": 1,
  "project_id": 1,
  "story_id": 1,
  "run_status": "running|paused|ended",
  "current_chapter_id": "ch_001",
  "current_scene_id": "scene_003",
  "snapshot_json": {},
  "created_at": 0,
  "updated_at": 0
}
```

## 13. Prompt 初稿
### 13.1 `story-main`
职责：
1. 只做总调度。
2. 决定交给哪个子 agent。
3. 不直接编造剧情细节。

核心要求：
1. 输入必须包含当前快照和本轮目标。
2. 输出必须是 JSON。
3. 不能跨越状态边界。

### 13.2 `story-orchestrator`
职责：
1. 生成本轮剧情动作。
2. 决定说话角色、台词、分支、事件推进。
3. 维护和当前章节一致的人设。

核心要求：
1. 只能使用当前运行态中的角色和章节信息。
2. 只输出可落库的结构化结果。
3. 如果需要抽记忆，输出 `memory_hints`。

### 13.3 `story-memory`
职责：
1. 从对话中抽取有效事实。
2. 压缩重复表达。
3. 生成索引标签。

核心要求：
1. 只保留对后续剧情有用的信息。
2. 区分“事实”“偏好”“关系变化”“任务进度”。
3. 不生成剧情正文。

### 13.4 `story-chapter`
职责：
1. 判断章节是否结束。
2. 判断是否进入下一章。
3. 判断成功/失败/继续。

核心要求：
1. 只判定，不写剧情。
2. 结果必须可解释。
3. 判定依据必须来自章节规则和运行态。

### 13.5 `story-mini-game`
职责：
1. 只处理小游戏局内逻辑。
2. 维护轮次、身份、资源、奖励。
3. 输出小游戏状态变化。

核心要求：
1. 不得影响主线剧情结构。
2. 不得泄漏未解锁信息。
3. 退出后必须回写主线快照。

### 13.6 `story-safety`
职责：
1. 对即将落库的结果做最终审查。
2. 拦截越权修改、注入和人设漂移。
3. 发现问题时返回 `reject` 和原因。

核心要求：
1. 不能改写剧情本身。
2. 只能做约束和拦截。
3. 必须可追踪、可回放。

## 14. 字段级 Schema 草案
### 14.1 运行时快照
```json
{
  "run_id": "run_001",
  "project_id": 1,
  "story_id": 1,
  "current_chapter_id": "ch_001",
  "current_scene_id": "scene_003",
  "progress": {
    "chapter_index": 1,
    "scene_index": 3,
    "turn_index": 12
  },
  "world_state": {
    "time": "夜晚",
    "location": "客栈二楼",
    "weather": "阴"
  },
  "player_state": {
    "name": "用户",
    "role_id": "role_001",
    "hp": 100,
    "mp": 50,
    "gold": 0,
    "status_tags": ["冷静"]
  },
  "event_pool": [],
  "relationship_state": [],
  "memory_state": {
    "short_term": [],
    "mid_term": [],
    "long_term": []
  }
}
```

### 14.2 角色卡
```json
{
  "role_id": "role_001",
  "name": "用户",
  "source_name": "用户",
  "raw_setting": "来自故事设定的原始角色描述",
  "gender": "未知",
  "age": "未知",
  "personality": [],
  "appearance": [],
  "voice": "",
  "skills": [],
  "items": [],
  "equipment": [],
  "hp": 100,
  "mp": 50,
  "money": 0,
  "relationships": [],
  "behavior_rules": [],
  "speech_rules": []
}
```

### 14.3 记忆条目
```json
{
  "memory_id": "mem_001",
  "run_id": "run_001",
  "memory_type": "short|mid|long",
  "source_turn": 12,
  "subject": "用户",
  "content": "用户刚刚选择了进入故事大厅",
  "tags": ["入口", "选择", "流程"],
  "importance": 3,
  "expire_turn": 20,
  "created_at": 0
}
```

### 14.4 章节规则
```json
{
  "chapter_id": "ch_001",
  "title": "开场",
  "end_condition": {
    "type": "turn|event|task|branch",
    "value": "turn>=20"
  },
  "success_condition": {
    "all": ["拿到线索A", "完成对话B"]
  },
  "fail_condition": {
    "any": ["角色死亡", "关键对象丢失"]
  },
  "allow_mini_game": true,
  "allow_branch": true
}
```

### 14.5 小游戏状态
```json
{
  "mini_game_id": "mg_wolf_001",
  "name": "狼人杀",
  "status": "pending|running|ended",
  "round": 1,
  "phase": "night|day|vote",
  "players": [],
  "winner": "",
  "loser": "",
  "reward_delta": {},
  "state_delta": {}
}
```

### 14.6 Agent 输出统一格式
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
