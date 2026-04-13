# 安卓端
[tag_vue] 模拟浏览器输出日志和变量

# 后端
## LOG_LEVEL=DEBUG 时 输出的日志
[story:orchestrator:runtime] :编排师日志
[story:orchestrator:stats]: 编排师日志 token 统计
[tag_api]:请求日志
[tag_end_chapter]:章节结束判断。{章节}{条件}{为什么判断结束}
[story:chapter_ending_check:runtime]:AI故事-章节判定日志
[story:chapter_ending_check:stats]: I故事-章节判定日志 token 统计
[game:orchestrator:key_nodes]:game/orchestration 请求的关键节点打印,记录编排流程的日志
[orchestration] 打印编排请求关键节点日志
[story:streamlines:runtime] 角色发言器日志。当前会打印 speakerMode、speakerModelKey、requestChars、tokenUsage、buildMs/invokeMs/totalMs
[story:streamlines:stats]: 角色发言器 token 统计。当前会打印 speaker_mode、speaker_model_key、prompt 体积估算、返回内容摘要、实际推理消耗
[speaker:route] 角色发言路由选择日志。用于判断当前这轮走 fast / standard / template 哪条角色发言路径

## 后端通用tag
[debug:revisit:not_found]: 回溯失败
[debug:revisit]: 回溯相关
[voice:preview:aliyun_ref_url]：把实际交给阿里的参考音频 URL 打出来

# 事件链分析
把日志里的编排流程过滤出来生成下面模版格式的md 文件，放到：logs/event_log/
日志过滤后模版如下
```
- 编排,current_event: 1 ,旁白以日程空间戒指的身份呼唤有缘人，展示内部空间储物
  - sesesion_id: xxxx
  - 返回了，role_type: npc ↩ speaker: 药老（药尘） ↩ motive: 感知到空间探查，出声回应探查的萧炎 ↩ await_user: false ↩ next_role_type: player ↩ next_speaker: 用户 ↩ trigger_memory_agent: false ↩ event_adjust_mode: keep ↩ event_status: active ↩ event_summary: 萧炎探查日程空间戒指，发现内部存放的物品 ↩ event_facts: ["日程空间戒指存炼炎决、灭魔尺等少量物品", "萧炎已用斗之气探查戒指内部"] 
  - 本轮动机，顺着当前局势接住用户输入并继续推进剧情。 
  - 台词： (月白锦裙的少女立在坊市檐下，墨发束起，眉梢带着与生俱来的傲气，目光遥遥落在萧炎指尖那枚漆黑戒指上)这偏远乌坦城，怎会有这般品级的空间储物戒？真是奇怪。 
  - 事件阶段：已经发送了什么，接下来做什么，是否已完结
```