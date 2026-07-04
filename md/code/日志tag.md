# 安卓端
[tag_vue] 模拟浏览器输出日志和变量
[tag_vue] [runtime_chat]
[tag_vue] [story_flow]
[tag_vue] [network]
[tag_vue] [layout]
[tag_vue] [network] [orchestrator]
[tag_vue] [voice]

[listWorlds] 故事加载相关

# 后端
```
if (DebugLogUtil.isDebugLogEnabled()) {
    console.log("[story:orchestrator:runtime]", JSON.stringify(runtimeLog));
...
}
```
## logtag list
[logTagList.ts](../../src/utils/logTagList.ts)
## LOG_LEVEL=DEBUG 时 输出的日志】
[DEBUG] 通用debug 日志
[story:orchestrator:runtime] :编排师日志
[story:orchestrator:stats]: 编排师日志 token 统计 
[story:orchestrator:runtime] ended ms： 编排请求耗时


[tag_api]:请求日志
[tag_end_chapter]:章节结束判断。{章节}{条件}{为什么判断结束}

[story:chapter_ending_check:runtime]:AI故事-章节判定日志
[story:chapter_ending_check:stats]: I故事-章节判定日志 token 统计

[game:orchestrator:key_nodes]:game/orchestration 请求的关键节点打印,记录编排流程的日志
[orchestration] 打印编排请求关键节点日志

[story:streamlines:runtime] 角色发言器日志。当前会打印 speakerMode、speakerModelKey、requestChars、tokenUsage、buildMs/invokeMs/totalMs
[story:streamlines:stats]: 角色发言器 token 统计。当前会打印 speaker_mode、speaker_model_key、prompt 体积估算、返回内容摘要、实际推理消耗

[speaker:route] 角色发言路由选择日志。用于判断当前这轮走 fast / standard / template 哪条角色发言路径

[story:event_progress:runtime]: AI故事-事件进度检测日志
[story:event_progress:stats]: AI故事-事件进度检测 token 统计
[story:event_progress:runtime][stage]:AI故事-事件进度的日志
[story:event_progress:runtime][stage][stageIndex]:AI故事-事件进度的索引日志
[story:event_progress:runtime][stage][buildRecentMessages]:AI故事-事件进度的索引日志
[story:event_progress:runtime][stage][advanceNarrativeUntilPlayerTurn]:AI故事-事件进度的索引日志
[story:event_progress:runtime][stage][buildEventProgressInputSnapshot]:AI故事-事件进度的索引日志

[story:memory:runtime]: AI故事-记忆管理agent日志,trigger_memory_agent 是是否触发了AI故事-记忆管理
[story:memory:stats]: AI故事-忆管理agent token 统计
[story:memory_directive:stats]: 显式 @记忆管理 参数卡写回日志。打印是否命中，以及新增的技能/物品/装备/其他
[story:memory:runtime] triggerMemoryAgent
[story:memory:storyInfo] 获取故事信息接口时的日志

[story:mini_game:agent]: AI故事-小游戏agent 日志
[story:mini_game:stats]: AI故事-小游戏agent token 统计（参考[story:orchestrator:stats]）
[story:mini_game:agent] 识别到小游戏
[voice-preview] 语音生成相关

[story:intent:analysis]: AI故事-意图分析相关日志
  - 命令快路径命中：path=command, intent=create_task/exit_task/...
  - 进入 AI 分类通道：调用前的上下文
  - AI 分类完成：path=ai-sdk/qwen060, intent, confidence, reasoning, latencyMs
  - JSON 解析失败 / 输出格式校验失败 / 未配置模型
  - qwen060 推理完成：rawTextLength, rawTextPreview, latencyMs

[story:mini_game:task]: AI故事-任务系统相关日志
  - 命令触发任务创建：taskDescription
  - AI 触发任务创建：confidence, reasoning, taskDescription
  - AI 触发退出任务（T4.x 待实现）
- AI 触发查询进度（T4.x 待实现）

[story:intent:analysis:runtime]: 意图分析请求/响应日志
  - request: manufacturer, model, messagePreview, activeTaskId, systemPromptChars, userPromptChars
  - response / qwen060_response / qwen060_classification_result: path, intent, confidence, reasoning, latencyMs
[story:intent:analysis:stats]: 意图分析统计
  - path=ai-sdk/qwen060 intent=xxx confidence=x latency_ms=x
  - status=skipped/json_not_found/parse_error/schema_error/exception

[story:mini_game:task:orchestrator:runtime]: 任务剧情编排师请求/响应日志
  - request: userId, progressLevel, objective, processPreview, npcCount, messagePreview
  - response: rawTextPreview, latencyMs
[story:mini_game:task:orchestrator:stats]: 任务编排师统计
  - speaker=xxx taskType=xxx latency_ms=x
  - status=json_not_found/parse_error/schema_error

[story:mini_game:task:progress:runtime]: 任务推进判定器请求/响应日志
  - request: userId, intent, objective, progressPreview, messagePreview, systemPromptChars, userPromptChars
  - response: rawTextPreview, latencyMs
[story:mini_game:task:progress:stats]: 任务推进判定统计
  - level=xxx tier=xxx action=xxx latency_ms=x
  - status=json_not_found/parse_error/schema_error/exception

[story:mini_game:task:streamlines:runtime]: 任务角色发言器请求/响应日志
  - request: userId, speaker, taskType, motive
  - response: rawTextPreview, latencyMs
[story:mini_game:task:streamlines:stats]: 任务角色发言统计
  - speaker=xxx content_chars=x latency_ms=x
  - status=empty/exception

[story:mini_game:task:completion:runtime]: 任务完成评估器日志
[story:mini_game:task:completion:stats]: 任务完成评估 token 统计

## 后端通用tag
[debug:revisit:not_found]: 回溯失败
[debug:revisit]: 回溯相关
[voice:preview:aliyun_ref_url]：把实际交给阿里的参考音频 URL 打出来
[debug:mini-game]: 小游戏调试日志
[debug:revisit:*]: 台词回溯调试日志

# 事件链分析
把日志里的编排流程过滤出来生成下面模版格式的md 文件，放到：logs/event_log/
日志过滤后模版如下
```
- 编排,current_event: 1 ,@旁白，饰演日程空间戒指：戒指内部空间辽阔，但是目前基本啥也没有，只有炼炎决（炎帝的早期功法），一把灭魔尺，一本灭魔尺法，灭魔步，10颗五行回复丹。100个斗
  - sesesion_id: dbg_1776231669453_925mbed7
  - chapterTitle: 第 2 章
  - 本轮动机，带异天前往萧家大厅，途中介绍萧家情况 | 18
  - 台词： (抬步转过雕花影壁，远处朱红大门已经隐约可见，他侧过头看向身侧的你，声音依旧平稳)萧家上下三百余口，族中子弟大多修习斗气，接下来你便先在族中落脚，有什么需要都可以先和我说。
  - 事件阶段：event_status=completed，ended=true，progress_summary=异天完成角色绑定后，萧炎已带领异天前往萧家大厅，当前事件目标已完成
  - 章节判定：result=success，reason=用户已提供完整的姓名、性别、年龄信息，满足本章完成条件，成功达成事件目标，guide_summary=
  sessionStatus：
  nextChapterId：
```
编排流程文件生成命令： 
yarn debug:event-chain logs/app-2026-05-21.log 

## 小游戏日志摘要生成
yarn debug:mini-game logs/app-2026-05-08.log 
模板参考[debug-mini-game.md](template/debug-mini-game.md)
打上log tag 输出 用户进入小游戏回合， 规则说明回合。用户回合，陪练回合,
  播报回合，敌方攻击回合，小游戏规程性退出回合，小游戏#退出回合。

## 任务模型日志摘要生成
yarn debug:mini-game:task logs/app-2026-06-18.log
模板参考[debug-mini-game-task.md](template/debug-mini-game-task.md)

**Log Tag 图例：**

| Tag | 含义 |
|-----|------|
| `[task:addMessage:entry]` | addMessage 入口时的任务状态 |
| `[task:created]` | 任务已创建（applyFreeChapterTaskBlueprintToState 写入） |
| `[task:minigame:intercept]` | 小游戏拦截路径（handleMiniGameTurn） |
| `[task:orchestration:entry]` | tryBuildTaskModePlan 编排入口 |
| `[task:orchestration:result]` | 编排返回结果 |
| `[task:intent]` | Intent Agent 结果 |
| `[task:progress]` | Progress Agent 推进判定结果 |
| `[task:director]` | Director Agent 编排结果 |
| `[task:speaker]` | Speaker / Streamlines 执行记录 |
| `[task:completion]` | Completion Agent 任务完成评估 |
| `[task:revisit]` | 回溯操作记录 |
| `[task:memory:patch]` | 记忆补丁写入 player.parameterCardJson |

**输出内容：**
- 用户如何进入任务模式
- 每个回合：用户说了什么、角色说了什么、旁白说了什么
- 调用了哪些 Agent（Intent → Progress → Director → Speaker）
- 任务进度变化
- 任务成功/失败/主动退出
- 任务结算旁白
- 回溯时状态是否正确保留

## @记忆管理 日志
如 @记忆管理 睡觉恢复


## 前端 debug 日志
import { WebDebugLogUtil } from "../../utils/WebDebugLogUtil";
WebDebugLogUtil.log("resolveRuntimeVoiceUrl cached", cached);
or
if (WebDebugLogUtil.isEnabled()) {
  console.log("resolveRuntimeVoiceUrl");
}

## web logtag list
[logTagList.ts](../../../Toonflow-game-web/src/utils/logTagList.ts)