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

[story:event_progress:runtime]: AI故事-事件进度检测日志
[story:event_progress:stats]: AI故事-事件进度检测 token 统计

[story:memory:runtime]: AI故事-记忆管理agent日志,trigger_memory_agent 是是否触发了AI故事-记忆管理
[story:memory:stats]: AI故事-忆管理agent token 统计
[story:memory_directive:stats]: 显式 @记忆管理 参数卡写回日志。打印是否命中，以及新增的技能/物品/装备/其他
[story:memory:runtime] triggerMemoryAgent
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
编排流程文件生成命令： yarn debug:event-chain logs/app-2026-04-13.log 

## 小游戏日志摘要生成
yarn debug:mini-game logs/app-2026-04-16.log 
