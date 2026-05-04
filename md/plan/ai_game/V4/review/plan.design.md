# 小游戏战斗流程重构设计文?
> 依据：[@md/plan/ai_game/V4/review/review.md:40-120]
> 目标：删除硬编码旁白台词，让战斗播报走完整编排通道（orchestration ?streamlines ?streamvoice?
---

## 一、现状分?
### 1.1 当前旁白播报的问?
**错误流程（当前）**?```
用户输入 ?battleStep() ?直接返回旁白台词（narration?         ?addMessage 拦截 ?直接把旁白台词插?t_sessionMessage
         ?前端直接显示台词，无语音播放
```

**问题**?- `battleStep()` 直接返回 `narration: string`，塞?`message.content`
- `addMessage` 把它当普通消息插入数据库
- 前端拿到消息直接显示?*不走 orchestration ?streamlines ?streamvoice 通道**
- 结果：旁白播?**没有语音播放**

### 1.2 正常台词的正确流?
**正确流程（参考普通剧情）**?```
编排器（/game/orchestration?  ?返回 pendingNarrativePlan { role, roleType, motive, presetContent }
streamlines?game/streamlines?  ?根据 presetContent ?AI 生成台词
streamvoice?game/streamvoice?  ?播放语音
前端显示台词
```

---

## 二、设计方?
### 2.1 核心思路

**让战斗旁白播报走编排通道**?- `battleStep()` **不再直接返回 narration 字符?*
- 改为返回 `pendingNarrativePlan`，让编排器去处理
- 编排器拿?`pendingNarrativePlan` 后，?`streamlines ?streamvoice`

### 2.2 数据流设?
```
用户输入
  ?handleMiniGameTurn() ?battleStep()
  ?battleStep() 返回?{
  pendingNarrativePlan: {
    role: "旁白",
    roleType: "narrator",
    motive: "战斗播报：异天施展技能命中萧炎，造成?44 点伤害。敌人：萧炎(HP 56)?,
    presetContent: "异天施展技能命中萧炎，造成?44 点伤害。敌人：萧炎(HP 56)?,
    awaitUser: false,  // 播报后还有敌方回?    nextNarrativePlan: {  // 链式：旁白播??敌方回合
      role: "萧炎",
      roleType: "enemy",
      motive: "敌方回合",
      awaitUser: false,
      nextNarrativePlan: {  // 链式：敌方回??用户回合
        role: "旁白",
        roleType: "narrator",
        nextRole: "用户",
        nextRoleType: "player",
        awaitUser: true
      }
    }
  }
}
  ?addMessage 拦截?pendingNarrativePlan
  ?写入 session.pendingNarrativePlan
  ?前端拿到 plan，自动触发：
  orchestration（拿?plan?    ?streamlines（生?使用 presetContent?    ?streamvoice（播放语音）
  ?commitSessionNarrativeTurn() 提交本轮
  ?检测到 nextNarrativePlan，提升为新的 pendingNarrativePlan
  ?自动继续下一轮编排（敌方回合?```

---

## 三、具体改?
### 3.1 `MiniGameController.ts` ?第一步：扩展返回结构

#### 3.1.1 扩展 `MiniGameStepResult` 接口

**文件**：`src/modules/game-runtime/engines/MiniGameController.ts`

```typescript
// 当前（第 69-85 行）
interface MiniGameStepResult {
  narration: string;
  speakerRole?: string;
  speakerRoleType?: string;
  mentorSpeech?: MiniGameMentorSpeechRequest;
  messages?: Array<{ role: string; roleType: string; eventType: string; content: string; }>;
  resultTags?: string[];
  rngUsed?: number[];
  rewardSummary?: JsonRecord;
  writeback?: JsonRecord;
  memorySummary?: string;
}

// 改为?interface MiniGameStepResult {
  narration?: string;  // 改为可选，走编排通道后不再直接使?  speakerRole?: string;
  speakerRoleType?: string;
  mentorSpeech?: MiniGameMentorSpeechRequest;
  messages?: Array<{ role: string; roleType: string; eventType: string; content: string; }>;
  resultTags?: string[];
  rngUsed?: number[];
  rewardSummary?: JsonRecord;
  writeback?: JsonRecord;
  memorySummary?: string;
  /** 旁白播报/敌方回合的编排计划，?orchestration ?streamlines ?streamvoice */
  pendingNarrativePlan?: {
    role: string;
    roleType: string;
    motive: string;
    presetContent?: string;
    awaitUser: boolean;
    nextRole?: string;
    nextRoleType?: string;
    eventType?: string;
    source?: string;
    triggerMemoryAgent?: boolean;
    eventAdjustMode?: string;
    eventStatus?: string;
    nextNarrativePlan?: any;  // 链式计划
  };
}
```

#### 3.1.2 修改 `battleStep()` ?返回旁白播报?`pendingNarrativePlan`

**文件**：`src/modules/game-runtime/engines/MiniGameController.ts`（约?1871-1973 行）

**当前问题**：`battleStep()` 直接返回 `narration: string`，然?`addMessage` 直接插入数据库?
**改动**?
```typescript
// 约第 1956-1972 行（battleStep 末尾，ongoing 情况?// 当前代码?const battleReport = `${narrations.join("")}${battleEnemySummary(session)}`;
return {
  narration: battleReport,
  speakerRole: scalarText(ctx.world?.narratorRole?.name) || "旁白",
  speakerRoleType: "narrator",
  messages: [
    {
      role: scalarText(ctx.world?.narratorRole?.name) || "旁白",
      roleType: "narrator",
      eventType: "on_mini_game",
      content: battleReport,
    },
  ],
  resultTags: ["ongoing", "battle_round"],
  // ...
};

// 改为：构建旁白播报的 pendingNarrativePlan
const battleReport = `${narrations.join("")}${battleEnemySummary(session)}`;
const narratorName = scalarText(ctx.world?.narratorRole?.name) || "旁白";
const hasAliveEnemies = aliveBattleEnemies(session).length > 0;

// 构建敌方回合?plan（如果有存活敌人?const enemyTurnPlan = hasAliveEnemies ? {
  role: aliveBattleEnemies(session)[0]?.name || "敌人",
  roleType: "enemy",
  motive: "敌方回合",
  awaitUser: false,
  nextNarrativePlan: {
    role: narratorName,
    roleType: "narrator",
    nextRole: scalarText(ctx.world?.playerRole?.name) || "用户",
    nextRoleType: "player",
    awaitUser: true,
    source: "rule",
    eventType: "on_mini_game",
    eventAdjustMode: "keep",
    eventStatus: "active",
  }
} : null;

return {
  narration: battleReport,  // 保留，用于日?调试
  speakerRole: narratorName,
  speakerRoleType: "narrator",
  pendingNarrativePlan: {
    role: narratorName,
    roleType: "narrator",
    motive: `战斗播报?{battleReport}`,
    presetContent: battleReport,
    awaitUser: !hasAliveEnemies,  // 没有敌人了就直接交还用户
    nextNarrativePlan: hasAliveEnemies ? {
      ...enemyTurnPlan!,
      // 敌方回合结束后，链接回用户回?    } : null,
    source: "rule",
    eventType: "on_mini_game",
    eventAdjustMode: "keep",
    eventStatus: "active",
  },
  resultTags: ["ongoing", "battle_round"],
  // messages 不再直接返回，让编排器处?  // messages: [...],  // 删除
};
```

#### 3.1.3 修改 `finalizeBattleVictory()` ?`finalizeBattleDefeat()`

**文件**：`src/modules/game-runtime/engines/MiniGameController.ts`（约?1806-1860 行）

```typescript
// 当前（finalizeBattleVictory 约第 1806 行）?function finalizeBattleVictory(session: JsonRecord): MiniGameStepResult {
  // ... 计算奖励 ...
  return {
    narration: `战斗胜利?{rewardText}`,
    speakerRole: "旁白",
    speakerRoleType: "narrator",
    messages: [{ role: "旁白", roleType: "narrator", eventType: "on_mini_game_finish", content: `战斗胜利?{rewardText}` }],
    // ...
  };
}

// 改为：返?pendingNarrativePlan，结束战?function finalizeBattleVictory(session: JsonRecord, ctx?: MiniGameControllerInput): MiniGameStepResult {
  // ... 计算奖励 ...
  const narratorName = scalarText(ctx?.world?.narratorRole?.name) || "旁白";
  const victoryText = `战斗胜利?{rewardText}`;
  return {
    narration: victoryText,
    speakerRole: narratorName,
    speakerRoleType: "narrator",
    pendingNarrativePlan: {
      role: narratorName,
      roleType: "narrator",
      motive: `战斗结算?{victoryText}`,
      presetContent: victoryText,
      awaitUser: true,  // 战斗结束，交还用?      nextNarrativePlan: null,
      source: "rule",
      eventType: "on_mini_game_finish",
      eventAdjustMode: "keep",
      eventStatus: "finished",
    },
    // messages 删除，走编排通道
  };
}
```

同理修改 `finalizeBattleDefeat()`?
```typescript
// 当前（约?1837 行）?function finalizeBattleDefeat(session: JsonRecord): MiniGameStepResult {
  // ... 计算撤退 ...
  return {
    narration: "旁白播报战报：你在这场战斗中被彻底压制，只能暂时撤退?..",
    speakerRole: "旁白",
    speakerRoleType: "narrator",
    messages: [{ role: "旁白", roleType: "narrator", eventType: "on_mini_game_finish", content: "..." }],
    // ...
  };
}

// 改为：返?pendingNarrativePlan，战斗失败结?function finalizeBattleDefeat(session: JsonRecord, ctx?: MiniGameControllerInput): MiniGameStepResult {
  const publicState = asRecord(session.public_state);
  const safeHp = Math.max(1, Math.floor(Number(publicState.user_max_hp || 100) * 0.4));
  const safeMp = Math.max(0, Math.floor(Number(publicState.user_max_mp || 0) * 0.4));
  session.status = "finished";
  session.phase = "settling";
  session.result = "failed";
  session.finish_reason = "用户在战斗中败退";
  publicState.user_hp = safeHp;
  publicState.user_mp = safeMp;
  publicState.last_result = "战斗失利，已暂时撤退?;
  session.public_state = publicState;
  const narratorName = scalarText(ctx?.world?.narratorRole?.name) || "旁白";
  const defeatText = "你在这场战斗中被彻底压制，只能暂时撤退。为了避免主线中断，你已经强行调息，恢复了部分气血与法力，随时可以重新规划下一步行动?;
  return {
    narration: defeatText,
    speakerRole: narratorName,
    speakerRoleType: "narrator",
    pendingNarrativePlan: {
      role: narratorName,
      roleType: "narrator",
      motive: `战斗结算?{defeatText}`,
      presetContent: defeatText,
      awaitUser: true,  // 战斗结束，交还用?      nextNarrativePlan: null,
      source: "rule",
      eventType: "on_mini_game_finish",
      eventAdjustMode: "keep",
      eventStatus: "finished",
    },
    resultTags: ["failed", "battle_defeat"],
    rewardSummary: { retreat: true },
    writeback: {
      playerParameterPatch: { hp: safeHp, mp: safeMp },
      memoryAdd: ["一次战斗失利后被迫撤退"],
    },
    memorySummary: "战斗失利，暂时撤退",
    // messages 删除，走编排通道
  };
}
```

---

### 3.2 `MiniGameController.ts` ?第二步：透传 `pendingNarrativePlan` 到外?
#### 3.2.1 扩展 `MiniGameControllerResult`

**文件**：`src/modules/game-runtime/engines/MiniGameController.ts`（约?34-50 行）

```typescript
// 当前
export interface MiniGameControllerResult {
  intercepted: boolean;
  runtime: JsonRecord;
  message?: { role: string; roleType: string; eventType: string; content: string; meta?: any };
  messages?: Array<{ role: string; roleType: string; eventType: string; content: string; meta?: any }>;
}

// 改为：新?pendingNarrativePlan
export interface MiniGameControllerResult {
  intercepted: boolean;
  runtime: JsonRecord;
  message?: { role: string; roleType: string; eventType: string; content: string; meta?: any };
  messages?: Array<{ role: string; roleType: string; eventType: string; content: string; meta?: any }>;
  /** 小游戏动作产生的编排计划（旁白播?敌方回合等） */
  pendingNarrativePlan?: MiniGameStepResult["pendingNarrativePlan"];
}
```

#### 3.2.2 修改 `handleMiniGameTurn()` 返回 `pendingNarrativePlan`

**文件**：`src/modules/game-runtime/engines/MiniGameController.ts`（约?952-960 行）

```typescript
// handleMiniGameTurn 返回结果时，透传 pendingNarrativePlan
// 约第 954-970 ?const controllerResult: MiniGameControllerResult = {
  intercepted: true,
  runtime: root,
  message: stepResult.message,
  messages: stepResult.messages,
  pendingNarrativePlan: stepResult.pendingNarrativePlan,  // 新增
};
return controllerResult;
```

---

### 3.3 `SessionService.ts` ?第三步：拦截处理 `pendingNarrativePlan`

#### 3.3.1 `addMessage` 中检测小游戏 `pendingNarrativePlan`

**文件**：`src/modules/game-runtime/services/SessionService.ts`（约?1420-1450 行）

```typescript
// 当前代码（约?1432-1434 行）?if (miniGameResult?.intercepted) {
  allowPlayerTurn(state, world, ...);
  // 插入 miniGame messages ...
}

// 改为：检?pendingNarrativePlan
if (miniGameResult?.intercepted) {
  const pendingPlan = miniGameResult.pendingNarrativePlan;
  if (pendingPlan) {
    // 有编排计划：写入 session state，不插入消息
    setPendingSessionNarrativePlan(state, {
      role: pendingPlan.role,
      roleType: pendingPlan.roleType,
      motive: pendingPlan.motive,
      presetContent: pendingPlan.presetContent,
      awaitUser: pendingPlan.awaitUser,
      nextRole: pendingPlan.nextRole,
      nextRoleType: pendingPlan.nextRoleType,
      source: pendingPlan.source || "rule",
      eventType: pendingPlan.eventType,
      eventAdjustMode: pendingPlan.eventAdjustMode || "keep",
      eventStatus: pendingPlan.eventStatus || "active",
      nextNarrativePlan: pendingPlan.nextNarrativePlan
        ? JSON.parse(JSON.stringify(pendingPlan.nextNarrativePlan))
        : null,
    });
    // 交还用户输入权（因为编排器会接管?    allowPlayerTurn(state, world, pendingPlan.roleType, pendingPlan.role);
  } else {
    // 没有编排计划：走原有逻辑
    allowPlayerTurn(state, world, ...);
    // 插入 miniGame messages ...
  }
}
```

#### 3.3.2 `commitSessionNarrativeTurn` 处理链式 `nextNarrativePlan`

**文件**：`src/modules/game-runtime/services/SessionService.ts`（约?2900-2910 行）

当前代码已经处理?`nextNarrativePlan` 的提升，需要确认它能正常工作：

```typescript
// 约第 2900 行，commitSessionNarrativeTurn 末尾
const currentPlan = getPendingSessionNarrativePlan(state);
if (currentPlan?.nextNarrativePlan) {
  // 提升 nextNarrativePlan 为新?pendingNarrativePlan
  setPendingSessionNarrativePlan(state, currentPlan.nextNarrativePlan);
}
```

---

### 3.4 前端修改 ?第四步：自动触发编排通道

#### 3.4.1 `useToonflowStore.ts` ?检?`pendingNarrativePlan`

**文件**：`Toonflow-game-web/src/composables/useToonflowStore.ts`

?`sendMessage()` ?`handleMiniGameMessage()` 中，检测到 `pendingNarrativePlan` 后自动触发编排：

```typescript
// 发送消息后，检查返回结果中是否?pendingNarrativePlan
const result = await sendMessageAPI(payload);

if (result.narrativePlan) {
  // 有编排计划，?orchestration ?streamlines ?streamvoice
  const plan = result.narrativePlan;
  if (plan.roleType === "narrator") {
    // 旁白播报：直接走 streamlines（使?presetContent?    await streamSessionPlan(plan);
  } else if (plan.roleType === "enemy") {
    // 敌方回合：orchestration ?streamlines ?streamvoice
    await orchestrationAndStream(plan);
  }
  
  // 检查是否还?nextNarrativePlan，自动继?  if (plan.nextNarrativePlan && !plan.nextNarrativePlan.awaitUser) {
    await continueWithNextPlan(plan.nextNarrativePlan);
  }
}
```

### 3.5 小游戏的面板显示/隐藏和退出问题

#### 问题现象

用户反馈：
> 为什么编排会导致小游戏面板被隐藏，小游戏会被退出。看上去退出了。但是聊着聊着又突然进入小游戏。

#### 根本原因分析

**错误链路**（当前实现）：

```
战斗播报走编排通道：
  orchestration（拿到 pendingNarrativePlan）
    ↓
  streamlines（生成/使用 presetContent，插入 t_sessionMessage）
    ↓
  streamvoice（播放语音）
    ↓
  commitSessionNarrativeTurn（提交本轮，更新 state）
    ↓
  前端 applySessionNarrativeResult(state)
    ↓
  mergeVisibleMiniGameState() + shouldForceClearMiniGameStateFromMessages()
    ↓
  问题点 1：编排生成的新消息可能包含"当前没有进行中的小游戏"
  → shouldForceClearMiniGameStateFromMessages = true
  → clearVisibleMiniGameState() 被调用，面板被强制隐藏！

  问题点 2：commitSessionNarrativeTurn 更新 state 时
  → 如果 pendingNarrativePlan 还没被前端处理完，state.miniGame 可能变成旧值
  → mergeVisibleMiniGameState 判断失误，面板消失
```

**关键错误代码**：

`useToonflowStore.ts` 中的 `applySessionNarrativeResult`：
```typescript
function applySessionNarrativeResult(incoming: SessionNarrativeResult, options?: { forceClearMiniGame?: boolean }) {
  let nextState = mergeVisibleMiniGameState(
    (incoming.state || null) as Record<string, unknown> | null,
    (state.sessionDetail?.state || null) as Record<string, unknown> | null,
  );

  // 问题：这里检查消息内容，但编排通道可能生成"当前没有进行中的小游戏"
  const shouldForceClearMiniGame = options?.forceClearMiniGame === true
    || shouldForceClearMiniGameStateFromMessages(incoming.messages)
    || isMiniGameSessionFinished(nextState);

  if (shouldForceClearMiniGame) {
    nextState = clearVisibleMiniGameState(nextState);  // ← 面板被隐藏
  }
}
```

`shouldForceClearMiniGameStateFromMessages` 检测逻辑：
```typescript
function shouldForceClearMiniGameStateFromMessages(messages: MessageItem[] | null | undefined): boolean {
  return messages.some((message) => String(message.content || "").includes("当前没有进行中的小游戏"));
  // ↑ 编排通道生成的旁白消息可能包含这类内容（系统的兜底回复）
}
```

#### 解决方案

**方案核心**：编排通道进行时（pendingNarrativePlan 存在），**禁止清除小游戏面板**。

##### 修改点 1：`hasActiveMiniGameInCurrentSession()` 增加编排状态检测

**文件**：`Toonflow-game-web/src/composables/useToonflowStore.ts`（约第 2672 行）

```typescript
function hasActiveMiniGameInCurrentSession(): boolean {
  if (hasActiveMiniGameInRuntimeState((state.sessionDetail?.state || {}) as Record<string, unknown>)) {
    return true;
  }
  // 新增：检测当前是否有未完成的小游戏编排计划
  const plan = state.narrativePlan;
  if (plan && plan.eventType && plan.eventType.startsWith("on_mini_game")) {
    return true;  // 编排通道进行中，必须保持面板
  }
  return false;
}
```

##### 修改点 2：`applySessionNarrativeResult` 增加编排通道豁免

**文件**：`Toonflow-game-web/src/composables/useToonflowStore.ts`（约第 2440-2460 行）

```typescript
function applySessionNarrativeResult(incoming: SessionNarrativeResult, options?: { forceClearMiniGame?: boolean }) {
  let nextState = mergeVisibleMiniGameState(
    (incoming.state || null) as Record<string, unknown> | null,
    (state.sessionDetail?.state || null) as Record<string, unknown> | null,
  );

  // 修改：增加豁免条件 —— 编排通道进行中时，不清除面板
  const isInOrchestration = Boolean(
    incoming.narrativePlan
    && incoming.narrativePlan.eventType
    && incoming.narrativePlan.eventType.startsWith("on_mini_game")
  );

  const shouldForceClearMiniGame = !isInOrchestration && (
    options?.forceClearMiniGame === true
    || shouldForceClearMiniGameStateFromMessages(incoming.messages)
    || isMiniGameSessionFinished(nextState)
  );

  if (shouldForceClearMiniGame) {
    nextState = clearVisibleMiniGameState(nextState);
  }
  // ...
}
```

##### 修改点 3：`isMiniGameSessionFinished` 函数（新增）

**文件**：`Toonflow-game-web/src/composables/useToonflowStore.ts`（放在 `hasActiveMiniGameInRuntimeState` 旁边）

```typescript
/**
 * 检测小游戏 session 是否已经结束（finished/aborted）
 * 用途：编排通道结束后，正确清除面板
 */
function isMiniGameSessionFinished(runtimeState: Record<string, unknown> | null | undefined): boolean {
  const root = asMiniRecord(asMiniRecord(runtimeState).miniGame);
  const miniGameSession = asMiniRecord(root.session);
  const status = scalarText(miniGameSession.status);
  return status === "finished" || status === "aborted";
}
```

##### 修改点 4：前端 `sendMessage` 中 `pendingNarrativePlan` 优先处理

**文件**：`Toonflow-game-web/src/composables/useToonflowStore.ts` 的 `sendMessage()`

```typescript
// sendMessage() 中（约 6700 行附近）
const result = await sendMessageAPI(payload);

// 检测是否有小游戏编排计划
const hasMiniGamePlan = result.narrativePlan
  && result.narrativePlan.eventType
  && result.narrativePlan.eventType.startsWith("on_mini_game");

if (hasMiniGamePlan) {
  // 有编排计划：先走编排，面板保持显示
  WebDebugLogUtil.log("[aiGame][miniGame] 编排通道进行中，保持面板", {
    eventType: result.narrativePlan.eventType,
  });
  await streamSessionPlan(result.narrativePlan);
  return;  // 不清除面板
}

// 没有编排计划：正常处理
if (hasActiveMiniGameInCurrentSession()) {
  const shouldClear = isMiniGameSessionFinished(state.sessionDetail?.state || {});
  if (shouldClear) {
    state.sessionDetail.state = clearVisibleMiniGameState((state.sessionDetail?.state || {}) as Record<string, unknown>);
  }
}
```

#### 为什么"聊着聊着又突然进入小游戏"

**原因**：面板被错误清除后，前端认为小游戏已经结束。但当下一轮用户发送消息时：
1. `addMessage` 后端检测到小游戏还在进行中（`session.status === "active"`）
2. 后端继续返回小游戏响应
3. 前端收到响应后，又重新显示小游戏面板

**修复后**：编排通道进行中时，面板始终显示，不会出现"闪退又闪进"的现象。

#### 3.6 后端 `addMessage` 的联动修改

**文件**：`src/modules/game-runtime/services/SessionService.ts`（约第 1432-1500 行）

当 `pendingNarrativePlan` 存在时，`addMessage` 应该：
1. 不插入小游戏消息到 `t_sessionMessage`（编排器会处理）
2. 写入 `session.pendingNarrativePlan`
3. 保持 `session` 的小游戏状态不变

```typescript
if (miniGameResult?.intercepted) {
  const pendingPlan = miniGameResult.pendingNarrativePlan;
  if (pendingPlan) {
    // 有编排计划：写入 state，不插入消息
    setPendingSessionNarrativePlan(state, {
      role: pendingPlan.role,
      roleType: pendingPlan.roleType,
      motive: pendingPlan.motive || "",
      presetContent: pendingPlan.presetContent || "",
      awaitUser: pendingPlan.awaitUser || false,
      nextRole: pendingPlan.nextRole,
      nextRoleType: pendingPlan.nextRoleType,
      source: pendingPlan.source || "rule",
      eventType: pendingPlan.eventType || "on_mini_game",
      eventAdjustMode: pendingPlan.eventAdjustMode || "keep",
      eventStatus: pendingPlan.eventStatus || "active",
      nextNarrativePlan: pendingPlan.nextNarrativePlan
        ? JSON.parse(JSON.stringify(pendingPlan.nextNarrativePlan))
        : null,
    });
    // 交还用户输入权（编排器会接管）
    allowPlayerTurn(state, world, pendingPlan.roleType, pendingPlan.role);
  } else {
    // 没有编排计划：走原有逻辑
    allowPlayerTurn(state, world, ...);
    // 插入 miniGame messages ...
  }
}
```

---

## 四、日?tags 设计

### 4.1 全链?tags（Web + Android?
参?`[@md/plan/ai_game/code/logtag.web.md]` ?`logtag.android.md`?
| 场景 | Web tag | Android tag |
|------|---------|------------|
| 进入小游?| `[aiGame][miniGame] 进入小游戏{名称}` | 同上 |
| 用户输入 | `[aiGame][miniGame] 用户发送了信息：` | 同上 |
| 旁白播报-编排 | `[aiGame][miniGame] 旁白播报-编排` | 同上 |
| 旁白播报-台词 | `[aiGame][miniGame] 旁白播报-台词` | 同上 |
| 旁白播报-语音 | `[aiGame][miniGame] 旁白播报-台词-语音播放` | 同上 |
| 敌方回合-编排 | `[aiGame][miniGame] 敌方回合-编排` | 同上 |
| 敌方回合-台词 | `[aiGame][miniGame] 敌方回合-台词` | 同上 |
| 敌方回合-语音 | `[aiGame][miniGame] 敌方回合-语音播放` | 同上 |
| 退出小游戏 | `[aiGame][miniGame] 退出小游戏{名称}` | 同上 |
| 陪练-编排 | `[aiGame][miniGame] 陪练(狼人杀?角色回合-编排` | 同上 |
| 陪练-台词 | `[aiGame][miniGame] 陪练(狼人杀?角色回合-台词` | 同上 |
| 陪练-语音 | `[aiGame][miniGame] 陪练(狼人杀?角色回合-语音播放` | 同上 |

### 4.2 ?tag 位置

**Web ?*（Toonflow-game-web）：
- `useToonflowStore.ts`：`sendMessage()`、`streamSessionPlan()`、`handleMiniGameMessage()`
- `WebDebugLogUtil.ts`：封装打 tag 方法

**Android ?*（Toonflow-game-android）：
- `MainViewModel.kt`：对应的消息处理位置
- `AndroidDebugLogUtil.kt`：封装打 tag 方法

---

## 五、验收标?
### 5.1 功能验收

1. **删除硬编?*：`counterSpeech`、`counterAttackLines` 代码已删除，战斗播报不再包含"你还不配在这里放?等硬编码台词
2. **旁白播报走编排通道**：旁白播报通过 `orchestration ?streamlines ?streamvoice` 播放语音
3. **敌方回合自动接续**：旁白播报完成后，敌方回合自动触发编?4. **战斗结束正确**：胜?失败播报走编排通道，之后交还用户输入权
5. **全链?tags**：Web/Android 两端 11 ?debug tags 正确输出

### 5.2 代码验收

1. `yarn lint` 通过（TypeScript 类型检查）
2. 没有修改 `@no_modify` 文件
3. 没有修改 `router.ts`、`scripts/web/index.html`
4. 代码有注释，符合 SonarQube 要求

---

## 六、实施步骤（建议顺序?
1. ?**已完?*：`[story:mini_game:stats]` 日志改进
2. **步骤 1**：扩?`MiniGameStepResult`，新?`pendingNarrativePlan` 字段
3. **步骤 2**：修?`battleStep()`，返回旁白播报的 `pendingNarrativePlan`
4. **步骤 3**：修?`finalizeBattleVictory/Defeat()`，返回战斗结束的 `pendingNarrativePlan`
5. **步骤 4**：扩?`MiniGameControllerResult`，透传 `pendingNarrativePlan`
6. **步骤 5**：修?`SessionService.ts` `addMessage`，拦截处?`pendingNarrativePlan`
7. **步骤 6**：前端自动触发编排通道（Web + Android?8. **步骤 7**：全链路?tags（Web + Android?9. **步骤 8**：删除硬编码 `counterSpeech`/`counterAttackLines`（如果还有残留）
10. **步骤 9**：测试验?+ `yarn lint`
