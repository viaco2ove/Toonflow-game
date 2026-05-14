# 小游戏战斗流程修复 & 日志改进 开发计划

> 依据：[@md/plan/ai_game/V4/review/review.md:38-120]
> 状态：进行中

---

## 已完成

### ✅ [story:mini_game:stats] 日志改进 (review.md:38)
- [x] `logMiniGameActionResolution` 新增 `tokenUsage`/`timing` 参数，打印真实 token 统计
- [x] `resolveBattleActionByAgent` 返回 `logMeta`，将 token 数据透传到调用点
- [x] `generateMiniGameActionSummaryMarkdown` 解析并展示 token 统计
- [x] TypeScript 类型检查通过

---

## 待完成

### 🔴 [fail] 流程问题修改 (review.md:40-75)

**目标**：删除硬编码的旁白台词，让战斗播报走编排通道。

#### 任务 1：删除硬编码旁白台词
- [ ] 删除 `MiniGameController.ts` 中的 `counterSpeech` 硬编码代码（review.md:44-50）
- [ ] 删除 `counterAttackLines.push(...)` 相关代码（review.md:70）
- [ ] 验证战斗播报不再包含"你还不配在这里放肆"等硬编码台词

#### 任务 2：旁白播报走编排通道 (review.md:76-98)
**核心方案**：`addMessage` 不再直接生成旁白台词，改为构建 `pendingNarrativePlan`，走完整编排通道：
`orchestration → streamlines → streamvoice`

**子任务**：
- [ ] `battleStep()` 返回旁白播报时，构建 `pendingNarrativePlan`（roleType: "narrator", presetContent: 播报内容）
- [ ] 播报回合：`pendingNarrativePlan` → 编排 agent → 发言 agent → 语音播放
- [ ] 敌人回合：`nextNarrativePlan` 链式编排，自动接续敌人发言
- [ ] 用户回合：循环直到战斗结束
- [ ] 战斗结束（胜利/失败）：`pendingNarrativePlan` 带 `awaitUser: true`，交还用户

**涉及文件**：
- `src/modules/game-runtime/engines/MiniGameController.ts` - battleStep 返回 plan
- `src/modules/game-runtime/services/SessionService.ts` - addMessage 拦截处理 narrator plan
- `src/modules/game-runtime/engines/NarrativeOrchestrator.ts` - 编排器支持 narrator plan
- `src/routes/game/streamlines.ts` - 旁白台词生成
- `src/routes/game/streamvoice.ts` - 旁白语音播放

---

### 🔴 [fail] 小游戏全链路打tag (review.md:104-120)

**目标**：Web/Android 两端正确输出所有 debug log tags。

#### 任务 3：Web 端 logtag 修正
- [ ] `[aiGame][miniGame] 进入小游戏{小游戏名称}` - 进入时打 tag
- [ ] `[aiGame][miniGame] 用户发送了信息：` - 用户输入时打 tag
- [ ] `[aiGame][miniGame] 旁白播报-台词` - 旁白播报时打 tag（走编排通道后）
- [ ] `[aiGame][miniGame] 旁白播报-台词-语音播放` - 语音播放时打 tag
- [ ] `[aiGame][miniGame] 敌方回合-编排` - 敌方回合编排时打 tag
- [ ] `[aiGame][miniGame] 敌方回合-台词` - 敌方台词生成时打 tag
- [ ] `[aiGame][miniGame] 敌方回合-语音播放` - 敌方语音播放时打 tag
- [ ] `[aiGame][miniGame] 退出小游戏{小游戏名称}` - 退出时打 tag
- [ ] 陪练类（狼人杀、挖矿等）角色回合相关 tags

**涉及文件**：
- `Toonflow-game-web/src/composables/useToonflowStore.ts`
- `Toonflow-game-web/src/utils/WebDebugLogUtil.ts`

#### 任务 4：Android 端 logtag 修正
- [ ] 同上 11 个 tags 在 Android 端正确输出

**涉及文件**：
- `Toonflow-game-android/app/src/main/java/com/toonflow/game/viewmodel/MainViewModel.kt`
- `Toonflow-game-android/app/src/main/java/com/toonflow/game/utils/AndroidDebugLogUtil.kt`

---

### 🔴 [fail] 机制推广到全部小游戏 (review.md:120 之后)

**目标**：将战斗小游戏的 narrator plan 编排机制推广到所有小游戏类型。

#### 任务 5：统一小游戏编排出口
- [ ] `research_skill` 小游戏：旁白播报走编排通道
- [ ] `alchemy` 小游戏：旁白播报走编排通道
- [ ] `equipment` 小游戏：旁白播报走编排通道
- [ ] 其他小游戏类型检查并统一

---

## 验收标准

1. **战斗流程**：无硬编码旁白台词，播报通过编排通道生成并播放语音
2. **日志统计**：`[story:mini_game:stats]` 包含真实 token 统计（已完成）
3. **全链路 tags**：Web/Android 两端 11 个 debug tags 正确输出
4. **类型安全**：`yarn lint` 通过
5. **功能验证**：战斗小游戏完整流程（进入 → 多回合 → 胜利/失败）可正常运行

---

## 参考文档

- 评审文档：[@md/plan/ai_game/V4/review/review.md]
- Web logtag 规范：[@md/plan/ai_game/code/logtag.web.md]
- Android logtag 规范：[@md/plan/ai_game/code/logtag.android.md]
- 代码规范：[@CODEBUDDY.md]
