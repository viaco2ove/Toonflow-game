/**
 * 记录后端所有 debug 日志 tag。
 *
 * 用途：
 * - 作为 `debugLogConfig.ts` 黑/白名单可配置的合法取值参考；
 * - 让新增 / 删除日志 tag 时有单一登记处，避免 tag 散落在各文件后无人知晓全貌；
 * - 复合 tag（如 `[story:event_progress:runtime][stage][buildRecentMessages]`）只登记基础 tag
 *   `story:event_progress:runtime`，配合「前缀匹配」即可覆盖其所有子变体。
 *
 * 说明：
 * - 这里登记的是受 `LOG_LEVEL=DEBUG` 控制的、带冒号分层结构的后端 tag；
 * - 不收录 `[npm:err]` 这类系统噪音，也不收录前端 `WebDebugLogUtil` / 安卓 `AndroidDebugLogUtil` 的 tag；
 * - 数组本身只做登记与 IDE 补全参考，运行期黑/白名单元素类型仍是 `string`，
 *   新增未登记的 tag 不会因类型报错而阻断。
 */
export const logTagList = [
  "debug:common",
  // ===== 编排器 / 叙事 =====
  "story:orchestrator", // 编排器通用
  "story:orchestrator:runtime", // 编排师运行态日志（是否走到模型、走大模型编排等）
  "story:orchestrator:stats", // 编排师 token 统计
  "story:orchestrator:result", // 编排结果
  "story:orchestrator:minigame", // 小游戏编排接口结果
  "story:orchestrate_options:stats", // 编排候选 stats
  "story:next_plan:stats", // 下一轮编排计划 held / 延迟提升

  // ===== 章节判定 =====
  "story:chapter_ending_check:runtime", // AI 故事-章节判定运行态日志
  "story:chapter_ending_check:stats", // AI 故事-章节判定 token 统计
  "story:chapter_ending_check:skip", // 章节判定跳过

  // ===== 编排关键节点 =====
  "game:orchestrator:key_nodes", // game/orchestration 请求关键节点，记录编排流程

  // ===== 角色发言器 / 流式台词 =====
  "story:streamlines:runtime", // 角色发言器运行态日志
  "story:streamlines:stats", // 角色发言器 token 统计
  "story:streamlines:debug", // 流式台词调试
  "story:speaker", // 角色发言
  "speaker:route", // 角色发言路由选择（fast / standard / template）

  // ===== 事件进度检测 =====
  "story:event_progress:runtime", // AI 故事-事件进度检测运行态日志（含 [stage] 复合变体）
  "story:event_progress:stats", // AI 故事-事件进度检测 token 统计

  // ===== 记忆管理 =====
  "story:memory", // 记忆管理通用
  "story:memory:runtime", // AI 故事-记忆管理 agent 运行态日志
  "story:memory:stats", // AI 故事-记忆管理 agent token 统计
  "story:memory_directive:stats", // 显式 @记忆管理 参数卡写回日志

  // ===== 小游戏 =====
  "story:mini_game:agent", // 小游戏 agent 日志（识别 / 拦截 / 退出状态）
  "story:mini_game:agent:error", // 小游戏 agent 异常
  "story:mini_game:runtime", // 小游戏运行态日志
  "story:mini_game:stats", // 小游戏 token 统计（参考 story:orchestrator:stats）
  "story:mini_game:speech:error", // 小游戏发言异常
  "mini_game:rule_book", // 规则说明回合
  "mini_game:user:enter", // 用户进入小游戏回合
  "mini_game:user_turn", // 用户回合
  "mini_game:user_abort", // 小游戏退出回合
  "mini_game:mentor_turn", // 陪练回合
  "mini_game:narration", // 播报回合
  "mini_game:enemy_turn", // 敌方攻击回合
  "mini_game:settling", // 小游戏结算回合

  // ===== 任务系统 =====
  "story:mini_game:task", // 任务系统业务日志（创建/推进/结算/退出）
  "story:mini_game:task:orchestrator:runtime", // 任务剧情编排师请求/响应
  "story:mini_game:task:orchestrator:stats", // 任务剧情编排师统计
  "story:mini_game:task:progress:runtime", // 任务推进判定器请求/响应
  "story:mini_game:task:progress:stats", // 任务推进判定统计
  "story:mini_game:task:streamlines:runtime", // 任务角色发言器请求/响应
  "story:mini_game:task:streamlines:stats", // 任务角色发言统计
  "story:mini_game:task:completion:runtime", // 任务完成评估器日志
  "story:mini_game:task:completion:stats", // 任务完成评估 token 统计
  "story:free_task:activated", // 自由章节任务激活
  "story:free_task:blueprint:error", // 自由章节任务蓝图异常
  "story:free_task:resolution:error", // 自由章节任务结算异常

  // ===== 意图分析 =====
  "story:intent:analysis", // 意图分析相关日志
  "story:intent:analysis:runtime", // 意图分析请求/响应日志
  "story:intent:analysis:stats", // 意图分析统计

  // ===== 玩法提示 / 介绍 =====
  "story:play_tip:runtime", // 玩法提示运行态
  "story:play_tip:stats", // 玩法提示统计
  "story:introduction:plan", // 开场介绍编排
  "story:introduction:error", // 开场介绍异常

  // ===== 回溯 =====
  "story:revisit:debug", // 台词回溯调试日志
  "debug:revisit", // 回溯相关
  "debug:revisit:not_found", // 回溯失败
  "debug:revisit:hit", // 回溯命中
  "debug:revisit:error", // 回溯异常
  "debug:revisit:history:error", // 回溯历史异常
  "debug:mini-game", // 小游戏调试日志

  // ===== 事件 / 完整性 / 规则 =====
  "event:advance:decision", // 事件推进决策
  "event:completeness:check", // 事件完整性检查
  "stage:advance", // 阶段推进
  "rule:orchestrator", // 规则编排

  // ===== 语音 =====
  "voice:preview:ref_check", // 语音参考音频检查
  "voice:preview:aliyun_ref_url", // 交给阿里的参考音频 URL
  "voice:preview:custom_voice", // 自定义音色
  "voice:polish", // 语音提示词润色
  "voice:polish:agent", // 语音润色 agent

  // ===== 视频 / 头像 =====
  "game:avatar_video:runtime", // 头像视频运行态
  "video:kieai", // kieai 视频
  "video:qingyuntop", // qingyuntop 视频
  "video:t8star", // t8star 视频
] as const;

/** 后端登记的 debug 日志 tag 类型（用于 IDE 补全与文档参考）。 */
export type DebugLogTag = typeof logTagList[number];
