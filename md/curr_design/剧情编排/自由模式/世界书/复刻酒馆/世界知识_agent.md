# 世界知识 与agent
## agents
[agent.aigame.list.csv](../../../../%E6%B8%B8%E7%8E%A9%E4%B8%9A%E5%8A%A1_ai_agent/agent.aigame.list.csv)

## 世界知识如何增加到上下文
世界知识的 agentlist 字段。然后默认为全部agent ，可多选。 不然只发送给指定的agent。

发送的给agent 的内容为条目的 `content` 字段（正文内容）。`title`、`keys`、`category`、`order` 等字段不发给模型，只用于匹配筛选和前端展示。

每个 Agent 收到的 `worldContext.worldKnowledge` 内容形式如下：

| Agent                          | 注入位置（prompt 中的标题/标签） | 内容形式 |
|--------------------------------|------|------|
| 剧情编排师                          | `【世界知识】` section（第 1735-1736 行） | `worldKnowledge.join("\n\n")` 多条目内容用双换行拼接 |
| 角色发言器                          | `[世界知识]` 行（第 2799-2800 行） | 同上，双换行拼接 |
| 记忆管理器                          | `【世界知识】` 行（第 3043-3044 行） | 同上，双换行拼接；提示词注明仅参考、不照抄进 summary/facts |
| 任务编排师（TaskDirector）            | `【世界知识】` 行（SessionService.ts 第 1472 行，`buildWorldKnowledgeText`） | 同上，`buildWorldKnowledgeText()` 返回拼接字符串 |
| 任务发言器（TaskSpeaker）             | 同 TaskDirector 的 `taskWorldKnowledge` 复用（SessionService.ts 预存） | 同上 |
| agent.aigame.list.csv 的其他agent | `【世界知识】` | 同上，双换行拼接 |

