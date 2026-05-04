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

### 3.5 小游戏的面板显示隐藏和退出的问题


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
