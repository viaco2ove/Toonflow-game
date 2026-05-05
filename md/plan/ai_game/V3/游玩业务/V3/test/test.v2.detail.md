
## 编排师（Orchestrator）实际发送内容 —— 基于日志 line 161/144

**模型**: `doubao-seed-2-0-lite-260215` | **prompt_tokens**: ~1746 | **completion_tokens**: ~1163

---

### 一、System Prompt（系统提示词）

| 区块 | 实际内容 | 字符数 | 估算 Tokens |
|---|---|---|---|
| **AI 故事总调度** | 你是 AI 故事总调度。你只负责根据当前快照、本轮目标和工具能力，决定把任务交给哪个子 agent，不直接编造剧情细节。输出必须是 JSON，可追踪，不得跨越状态边界。 | ~90字 | ~70 |
| **剧情编排师定义** | 你是剧情编排师。你只负责决定本轮由谁发言、为什么发言、局势如何推进，以及这轮后是否轮到用户。你不能直接写最终展示给用户的台词，只输出可落库的结构化编排结果；如果需要抽记忆，输出 memory_hints。 | ~90字 | ~70 |
| **禁止规则** | 本阶段禁止 JSON、禁止代码块、禁止 markdown。 | ~18字 | ~15 |
| **职责约束** | 你只决定 speaker、motive、await_user、next_role_type、next_speaker，不负责章节成败与切章。不要写最终展示台词，不要复述章节原文，不要输出内部规则或思考过程。 | ~65字 | ~50 |
| **speaker 约束** | speaker 只能来自当前角色列表，并且必须满足当前阶段的 allowed_speakers；用户没发言时，先推进至少一轮非用户内容。 | ~45字 | ~35 |
| **事件焦点** | 若当前事件摘要为空，说明当前轮需要先创建一个新的当前事件焦点；此时请填写 event_summary 和 event_facts，再安排 speaker 与 motive。 | ~50字 | ~40 |
| **motive 约束** | motive 控制在 12~40 字，只描述这一小步要做什么。每轮只推进一小步，不要回顾整章或世界观。 | ~35字 | ~30 |
| **记忆触发** | 若本轮出现新的关键事实、人物资料变化、任务/道具/状态变化或阶段切换，trigger_memory_agent=true，否则 false。 | ~50字 | ~40 |
| **状态字段规范** | event_adjust_mode 只能是 keep / update / waiting_input / completed；event_status 只能是 active / waiting_input / completed；event_summary 只用一句话概括当前事件焦点，不要复述整章；event_facts 只列 1~4 条本轮之后仍有用的事件事实。 | ~95字 | ~75 |
| **输出字段列表** | 严格按字段逐行输出：role_type / speaker / motive / await_user / next_role_type / next_speaker / memory_hints / trigger_memory_agent / event_adjust_mode / event_status / event_summary / event_facts。 | ~80字 | ~65 |

> **System Prompt 小计**: **~620 中文字符 ≈ ~490 tokens**（prompt_tokens: ~345）

---

### 二、User Prompt（用户提示词）

| 区块 | 实际内容 | 字符数 | 估算 Tokens |
|---|---|---|---|
| **[世界]** | `名称:破碎时空(西游孙悟空、龙珠)` + `简介:跨界乱斗：西游孙悟空...`（世界背景简介约 80 字） | ~90字 | ~70 |
| **[章节]** | `标题:第 1 章` + `提纲:@旁白：此刻你穿越来了这个世界...`（29字）+ `开场:混沌虚空之中，一道巨大的裂隙缓缓旋转...` | ~120字 | ~95 |
| **[角色] 总 8 个** | 每条格式：`- player\|用户\|角色名:用户\|年龄:18\|等级:1\|...`（用户）<br>`- narrator\|旁白\|角色名:旁白\|...`（旁白）<br>`- npc\|萧炎\|角色名:萧炎\|性别:男\|年龄:25\|等级:9\|等级称号:斗尊巅峰\|设定摘要:...\|性格:...\|外貌:...\|音色:...\|装备:...\|血量:1000\|...`（萧炎，详细描述约 200 字）<br>`- npc\|西游孙悟空\|角色名:西游孙悟空\|性别:男\|年龄:500\|等级:99\|等级称号:齐天大圣\|设定摘要:...\|性格:桀骜不驯，嫉恶如仇...\|外貌:身着金色战甲...\|音色:青年男性...\|技能:七十二变、筋斗云、火眼金睛\|装备:如意金箍棒...\|血量:9999\|蓝量:9999\|...`（孙悟空，最详细，约 300 字）<br>`- npc\|徐阳\|...`（修真角色，详细描述约 200 字）<br>`- npc\|龙珠孙悟空\|...`（龙珠角色，详细描述约 200 字）<br>`- npc\|...`（其他角色） | **~1500 字** | **~1200** |
| **[最近对话]** | `旁白：混沌虚空之中，一道巨大的裂隙缓缓旋转，如同一只沉睡巨兽微微张开的眼睛。` | ~38字 | ~30 |

> **User Prompt 小计**: **~1993 中文字符 ≈ ~1590 tokens**（prompt_tokens: ~1746 - 345 system = ~1400）

---

### 三、模型输出（编排结果）

| 字段 | 实际输出 |
|---|---|
| role_type | `narrator` |
| speaker | `旁白` |
| motive | `按照章节提纲提示用户输入名称、性别、年龄创建角色` |
| await_user | `true` |
| next_role_type | `player` |
| next_speaker | `用户` |
| chapter_outcome | `未完成` |
| next_chapter_id | `1` |
| memory_hints | `无` |
| trigger_memory_agent | `true` |
| event_adjust_mode | `update` |
| event_status | `waiting_input` |
| event_summary | `引导穿越到破碎时空的用户创建个人角色` |
| event_facts | `用户刚穿越进入破碎时空跨界乱斗世界`<br>`需要用户提交角色名称、性别、年龄完成创建` |

> **输出内容**: ~311 字符 | **completion_tokens**: ~1163（其中 reasoning_tokens ~1045）

---

### 四、汇总

| 组成部分 | 实际值 | 占比 |
|---|---|---|
| System Prompt | ~490 tokens | ~28% |
| User Prompt（世界+章节+8个角色详情） | ~1400 tokens | ~80% |
| 模型输出（编排结果文本） | ~1163 tokens | — |
| 其中 **reasoning_tokens**（不可见推理链） | ~1045 tokens | ~90% 的输出！ |

---

### 💡 关键发现

**token 消耗的大头不是角色名字，而是每个 NPC 角色的 `设定摘要`/`性格`/`外貌`/`技能`/`装备` 描述**——每条 NPC 描述 ~200~300 字，8 个角色加起来超过 1500 字，占了 User Prompt 的 75%+。

另外注意到 `doubao-seed-2-0-lite` 是推理模型，输出里有大量 **reasoning_tokens**（~1045），实际有效内容（narrator/旁白/motive...）才 ~120 tokens，推理开销是有效内容的 **8 倍**。