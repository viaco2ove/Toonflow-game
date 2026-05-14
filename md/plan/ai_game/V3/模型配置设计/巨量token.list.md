最容易产生巨量 token 的主要是这几类，按风险从高到低说：
                                                                                                                                                                                                                                    
  1. 故事游玩主链                                                                                                                                                                                                                   
     最重。一次“用户发一句话”，不一定只打一次模型，常常是：                                                                                                                                                                         
                                                                                                                                                                                                                                    
  - 先调 storyOrchestratorModel 编排谁说话 src/modules/game-runtime/engines/NarrativeOrchestrator.ts:1527                                                                                                                           
  - 再调 storySpeakerModel 生成实际台词 src/modules/game-runtime/engines/NarrativeOrchestrator.ts:1754                                                                                                                              
  - 然后可能再异步调 storyMemoryModel 做记忆刷新 src/modules/game-runtime/services/SessionService.ts:847                                                                                                                            
    而且编排 prompt 里会带：                                                                                                                                                                                                        
  - 章节提纲摘录                                                                                                                                                                                                                    
  - 用户交互节点                                                                                                                                                                                                                    
  - 当前故事状态摘要                                                                                                                                                                                                                
  - 最近对话                                                                                                                                                                                                                        
    见 src/modules/game-runtime/engines/NarrativeOrchestrator.ts:1547                                                                                                                                                               
                                                                                                                                                                                                                                    
  2. 调试模式 / 自动推进                                                                                                                                                                                                            
     这个比正式游玩还容易烧，因为它会连续自动跑多轮，不是“一次输入一次输出”。                                                                                                                                                       
     核心是：                                                                                                                                                                                                                       
                                                                                                                                                                                                                                    
  - advanceNarrativeUntilPlayerTurn() 自动推进
  - debugStep
  - streamlines
  - continueSessionNarrative
    这些路径都会多次触发编排师和角色发言。见：
  - src/modules/game-runtime/services/SessionService.ts:740
  - src/modules/game-runtime/services/SessionService.ts:927
  - src/routes/game/debugStep.ts:223
  - src/routes/game/streamlines.ts:228

  3. 记忆管理后台 worker
     这个很隐蔽，因为不是你点一下就直接看到，但它会后台轮询会话并刷新记忆。
     当前 worker 会抓最近 20 条消息，再调 storyMemoryModel。见：

  - src/modules/game-runtime/services/SessionMemoryWorker.ts:80
  - src/modules/game-runtime/engines/NarrativeOrchestrator.ts:1788
    如果会话多、轮询频繁，这块会悄悄持续烧。                                                                                                                                                                                        
                                                                                                                                                                                                                                    
  4. 发布/预生成角色参数卡                                                                                                                                                                                                          
     这个不是最高频，但如果故事角色很多，会一次性打很多次模型。                                                                                                                                                                     
     每个角色都可能走一次 AI 参数卡生成，模型优先用 storyMemoryModel，其次 storyOrchestratorModel。见：                                                                                                                             
                                                                                                                                                                                                                                    
  - src/lib/roleParameterCard.ts:140                                                                                                                                                                                                
  - src/lib/roleParameterCard.ts:152                                                                                                                                                                                                
                                                                                                                                                                                                                                    
  5. 分镜/故事板聊天                                                                                                                                                                                                                
     如果你最近在用分镜聊天，这块也可能非常烧，因为历史会保留很长。                                                                                                                                                                 
  - src/routes/storyboard/chatStoryboard.ts:72
  - src/routes/storyboard/chatStoryboard.ts:74

  一句话总结：

  - 游戏侧最烧的是 编排师 + 角色发言 + 记忆管理 这一整条链
  - 真正可能“突然很贵”的，通常是 调试模式自动推进 和 后台记忆 worker
  - 如果是单次大额，也要怀疑 角色参数卡批量预生成 或 分镜聊天长历史

  如果你要，我下一步可以直接帮你把这几条链的“每次调用 prompt 长度 / 模型名 / 会话ID / 触发来源”日志补出来，这样以后看账单能直接对时间点定位是哪条业务烧的。
  [统计与日志.md](../%E7%BB%9F%E8%AE%A1%E4%B8%8E%E6%97%A5%E5%BF%97/%E7%BB%9F%E8%AE%A1%E4%B8%8E%E6%97%A5%E5%BF%97.md)