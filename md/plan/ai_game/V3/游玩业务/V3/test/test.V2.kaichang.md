关键发现！在第 2032-2063 行，有一个 `resolveRuleNarrativePlan` 函数，它在 AI 调用之前就决定好了叙事计划。如果 `ruleDecision.resolved` 为 true，就会直接返回，不会调用 AI！

让我看 `resolveRuleNarrativePlan` 的实现，这是问题的关键。
关键！第 2032-2063 行有个 **规则优先决策**——如果 `resolveRuleNarrativePlan` 命中，直接返回，不会调用 AI。让我看这个规则引擎：

找到了关键！第 136 行：

```typescript
if (input.turnState.canPlayerSpeak || input.phase?.kind === "user" || progress.userNodeStatus === "waiting_input") {
  return {
    resolved: true,
    reason: "await_user_phase",
    plan: buildAwaitUserPlan(userDisplayName),
  };
}
```

这个条件判断会直接返回"等待用户"的计划。有三种情况会触发：
1. `turnState.canPlayerSpeak = true`
2. `phase.kind === "user"`
3. `progress.userNodeStatus === "waiting_input"`

让我看 `canPlayerSpeak` 的逻辑，以及 `turnState` 是怎么设置的。
找到了！**第 136 行**：如果 `canPlayerSpeak` 为 true，直接跳过开场白进用户发言。让我看 `canPlayerSpeak` 的设置逻辑：

奇怪。让我搜索 `canPlayerSpeak` 在整个项目中的位置。
让我用 grep 的方式搜索。
我需要看 `readRuntimeTurnState` 函数是如何计算 `canPlayerSpeak` 的。
让我看 `readRuntimeTurnState` 函数——它决定 `canPlayerSpeak` 的值：

找到了！**第 1211 行**：

```typescript
canPlayerSpeak: raw.canPlayerSpeak !== false,
```

这意味着 `canPlayerSpeak` **默认为 true**！只有当 `state.turnState.canPlayerSpeak === false` 时才是 false。

关键问题：章节开始时，`state.turnState` 可能没有正确设置 `canPlayerSpeak = false`，导致开场白被跳过。

让我看看章节开始时是怎么设置 `turnState` 的。
找到了！**第 1211 行**：

```typescript
canPlayerSpeak: raw.canPlayerSpeak !== false,  // ← 默认 true！
```

这就是根因！让我看章节开始时如何设置 `turnState`：

让我搜索 `canPlayerSpeak` 的赋值。
搜索不到。让我试试搜索 `can_player_speak` 或者 `canSpeak`。
让我直接读 `setRuntimeTurnState` 看看它的调用方。
奇怪，grep 也搜不到。让我用 search_content 工具。
让我用 execute_command 尝试不同的方法。
找到了！在第 1381 行有调用 `setRuntimeTurnState`。让我看这段代码，特别是 `allowPlayerTurn` 函数。
找到了！让我看 `allowPlayerTurn` 函数（第 1389 行）：

现在让我看章节开始时是怎么初始化 turnState 的。关键问题：章节开始时，`state.turnState.canPlayerSpeak` 没有被设置为 `false`，所以默认是 `true`，导致 `resolveRuleNarrativePlan` 直接返回 "await_user_phase"，跳过开场白。

让我找章节开始的地方。
让我看章节开始时如何初始化 `turnState`：

很好！现在我需要看 `debugStep.ts` 中初始化章节的地方，特别是第 167 行。让我看这段代码。
现在我看到了完整的流程！让我理解问题所在：

1. **章节开始时**（第 185-204 行）：
   - `buildOpeningRuntimeMessage` 创建开场白消息
   - `setRuntimeTurnState` 设置 `canPlayerSpeak: false`
   - 返回开场白消息给前端
   - **前端显示开场白**

2. **前端收到开场白后**，会再次调用 `debugStep` 接口获取下一步（这是关键）

3. **再次调用时**（第 206-216 行）：
   - 如果 `canPlayerSpeakNow(state, world)` 返回 `true`，直接返回空消息
   - 然后调用 `runNarrativeOrchestrator` 让 AI 决定下一步

4. **问题出现了**：在 `doRunNarrativePlan` 中：
   - `readRuntimeTurnState` 读取 `state.turnState.canPlayerSpeak`
   - 如果没正确读取到 `false`，就会默认变成 `true`
   - 然后 `resolveRuleNarrativePlan` 的条件 `input.turnState.canPlayerSpeak` 为 `true`
   - 直接返回 `await_user_phase`，跳过开场白

让我仔细看 `readRuntimeTurnState` 的逻辑：

```typescript
export function readRuntimeTurnState(state: JsonRecord, world: any): RuntimeTurnState {
  const raw = asRecord(state.turnState);
  // ...
  return {
    canPlayerSpeak: raw.canPlayerSpeak !== false,
    // ...
  };
}
```

如果 `state.turnState` 是 `null` 或 `undefined`，`asRecord` 会返回什么？让我检查 `asRecord` 的实现。
让我检查 `asRecord` 函数——它决定 `raw` 的值：

让我搜索 `asRecord`。
让我看 NarrativeOrchestrator.ts 中 asRecord 的定义。
让我看 asRecord 的定义。
好的，现在我明白了：

1. `asRecord` 使用 `parseJsonSafe`，它会解析 JSON 字符串或返回默认值 `{}`
2. 如果 `state.turnState` 是 `null` 或 `undefined`，`asRecord` 返回 `{}`
3. 在 `readRuntimeTurnState` 中：
   ```typescript
   const raw = asRecord(state.turnState);  // 返回 {} 如果 turnState 是 null/undefined
   return {
     canPlayerSpeak: raw.canPlayerSpeak !== false,  // raw.canPlayerSpeak === undefined
     // ...
   };
   ```
   - `raw.canPlayerSpeak` 是 `undefined`
   - `undefined !== false` 是 `true`
   - 所以 `canPlayerSpeak` 默认是 `true`！

问题的根源是：**如果 `state.turnState` 为 `null`/`undefined`/`{}`，`canPlayerSpeak` 会默认为 `true`**，导致开场白被跳过。

让我看看 `debugStep.ts` 中设置 `turnState` 的地方——它是否真的设置了 `state.turnState`？
现在我找到问题了！让我看 `setRuntimeTurnState` 的实现，确认它是否正确更新了 `state`：

好的，现在我明白了整个流程。让我总结一下"开场白后直接进入用户发言阶段"的问题：**流程分析**：
1. 章节开始时，`debugStep.ts` 调用 `setRuntimeTurnState(state, world, { canPlayerSpeak: false, ... })`
2. 这会设置 `state.turnState = { canPlayerSpeak: false, ... }`
3. 返回开场白消息给前端
4. **前端应该再次调用 `debugStep` 获取下一步**

但问题可能出在：
1. 前端收到开场白后没有正确再次调用
2. 或者前端调用后，`state` 没有被正确传递（`state` 是引用传递，但可能有副本问题）

让我看看 `debugStep.ts` 中 `runNarrativeOrchestrator` 之前发生了什么，特别是第 206 行的检查。
现在我明白了。让我验证前端调用流程：

现在我完全理解了！让我总结问题：

**问题根源**：`canPlayerSpeakNow` 检查的是 `state.turnState.canPlayerSpeak`，但在章节初始化后，如果 `state` 没有被正确更新（比如前端传递的状态是旧的），`turnState` 可能还是空的 `{}`，导致 `canPlayerSpeak` 默认变成 `true`。

**触发条件**：
1. 第 206 行：`if (canPlayerSpeakNow(state, world))` 返回 `true`
2. 直接返回空消息，不调用 `runNarrativeOrchestrator`
3. 前端收到空消息后，再次轮询
4. 但由于 `state` 没有变化（返回的 `state` 有更新，但前端下次请求时传的可能是旧状态），继续返回空消息

等等，让我再看看。如果 `canPlayerSpeakNow` 返回 `true`（第 206 行），会直接返回空消息。但返回的 `state` 中包含正确的 `turnState`（`canPlayerSpeak: false`）。

问题可能是：**前端在收到开场白后，下一次请求时传递的 `state` 没有包含更新后的 `turnState`**。

让我看前端如何处理 state。
问题找到了！**第 206 行**：如果 `canPlayerSpeakNow` 返回 `true`（`canPlayerSpeak` 默认是 `true`），直接返回空消息。

但关键问题可能是：章节开始时 `turnState` 的初始化。让我看 `syncDebugChapterRuntime` 是否初始化了 `turnState`：

让我看 `syncDebugChapterRuntime` 的实现，看看它如何处理 `turnState`。
让我用 grep。
让我看 `syncDebugChapterRuntime` 的完整实现。
现在让我看看 `initializeChapterProgressForState`，看看它是否初始化了 `turnState`。
让我搜索 `initializeChapterProgressForState` 的定义。
让我直接搜索。
奇怪。让我搜索 ChapterProgress。
让我直接搜索 debugRuntimeShared 的导入。
`initializeChapterProgressForState` 来自 `ChapterProgressEngine`。让我看这个函数是否初始化了 `turnState`。
让我看这个函数。
我看到了！第 582 行：```typescript
const shouldWaitForUser = activePhase?.kind === "user" && readCanPlayerSpeak(state);
```

让我看 `readCanPlayerSpeak` 的实现。
让我看 `readCanPlayerSpeak` 的实现。
找到了！`readCanPlayerSpeak` 同样使用 `!== false` 的逻辑，**默认返回 true**！

现在让我总结"开场白后直接进入用户发言阶段"的问题：## 根因分析

### 问题现象
章节开始时：
1. 返回开场白消息（NPC/旁白发言）
2. 但下一次调用时直接进入用户发言阶段，跳过了 NPC 的正常对话

### 问题根源

**两个地方都存在 `canPlayerSpeak` 默认 `true` 的问题**：

1. **`ChapterProgressEngine.ts` 第 35 行**：
   ```typescript
   function readCanPlayerSpeak(state: JsonRecord): boolean {
     const turnState = asRecord(state.turnState);
     return turnState.canPlayerSpeak !== false;  // 默认 true！
   }
   ```

2. **`NarrativeOrchestrator.ts` 第 1211 行**：
   ```typescript
   canPlayerSpeak: raw.canPlayerSpeak !== false,  // 默认 true！
   ```

### 触发条件

在 `debugStep.ts` 第 185-204 行，章节开始时会：
1. 调用 `syncDebugChapterRuntime`（内部调用 `initializeChapterProgressForState`）


2. 创建开场白消息
3. 调用 `setRuntimeTurnState(state, world, { canPlayerSpeak: false, ... })`
4. 返回开场白

但如果 `state` 是新创建的或 `turnState` 未初始化，`setRuntimeTurnState` 可能无法正确设置 `canPlayerSpeak: false`。问题出在 `readRuntimeTurnState` 中，如果 `state.turnState` 为空对象或未定义，它会回退到默认值 true。

`parseJsonSafe` 的实现表明，当输入不是字符串时会直接返回默认空对象，这导致 `state.turnState` 变成 `{}`。在这个空对象上检查 `canPlayerSpeak` 属性时，返回 `undefined !== false` 为真，从而 `canPlayerSpeak` 被错误地设置为 true。`setRuntimeTurnState` 随后会正确写入 `{ canPlayerSpeak: false }`，但初始化阶段的问题已经被触发了。

关键在于理解这个"直接进入用户发言"的时机——是在开场白返回后，还是在后续的 `runNarrativeOrchestrator` 调用中。在 `doRunNarrativePlan` 的 `resolveRuleNarrativePlan` 里，有个条件会优先返回"await_user_phase"结果，这可能导致了意外的流程跳转。

具体来说，如果 `input.turnState.canPlayerSpeak` 为 true，或者 `phase.kind` 等于 "user"，或者 `progress.userNodeStatus` 是 "waiting_input"，就会直接进入用户发言阶段。这三个条件中至少有一个被满足了，导致跳过了后续的 AI 编排逻辑。

当 `canPlayerSpeak` 被设置为 false 后，这个条件就不成立了，应该会继续执行到 AI 调用。但如果这个字段没有被正确初始化或者被重置为 true，就会触发这个问题。我需要追踪 `canPlayerSpeak` 在什么时候可能被改回 true。

在 `RuleNarrativePlanResult` 中这个值默认为 false，所以我怀疑问题可能不在规则层面，而是 AI 模型本身的输出有问题。
让我看 `doRunNarrativePlan` 在 AI 调用后的处理：

我看到了！AI 调用后会解析 `awaitUser` 字段。如果 AI 模型返回的 `awaitUser` 为 `true`，那么 `eventAdjustMode` 会被设置为 `waiting_input`，用户可以直接发言。

但这不是问题的根源。问题应该是：
1. 开场白返回后，AI 应该决定下一个发言者2. 如果 AI 模型没有正确理解"开场白后应该 NPC 继续发言"，可能会返回 `awaitUser: true`

让我看 orchestrator 的 system prompt，了解它如何理解"开场白"和"等待用户"的。
让我看编排师的 system prompt，了解 AI 如何理解开场白后应该等待：

让我直接看 `buildOrchestratorSystemPrompt`。
让我看 `buildOrchestratorSystemPrompt` 的完整实现。
找到了关键规则！第 1702 行和第 1717 行：```
"11. 当 turnState.canPlayerSpeak=false 时，绝不能要求用户发言，也不能代替用户说台词。"
"17. 当用户尚未输入、只是刚进入章节时，必须先推进至少一轮非用户对话，不能空着内容直接把回合交给用户。"```

这些规则告诉 AI：
1. 当 `canPlayerSpeak=false` 时，不能要求用户发言
2. 用户刚进入章节时，必须先推进至少一轮非用户对话但问题可能是：AI 没有正确理解 `canPlayerSpeak=false` 的状态，或者 AI 模型没有遵循这些规则。

让我看看 user prompt 中是如何传递 `canPlayerSpeak` 信息的。
关键规则！第 1702 行和 1717 行明确要求 AI：
- `canPlayerSpeak=false` 时不能要求用户发言
- 用户刚进章节必须先推进一轮 NPC 对话

让我看 user prompt 中如何传递 `canPlayerSpeak`：

让我搜索。
让我看 `buildOrchestratorUserPrompt` 的完整实现。
关键发现！第 848 行和第 908 行：```
`player:${payload.turnState.canPlayerSpeak ? "true" : "false"} | expected:${...} | last:${...}``
`can_player_speak: ${payload.turnState.canPlayerSpeak ? "true" : "false"}`
```

在 user prompt 中，`canPlayerSpeak` 是通过 `payload.turnState.canPlayerSpeak` 传递的。这个值来自 `readRuntimeTurnState(input.state, input.world)`。

让我回顾一下问题场景：
1. 章节开始时，`debugStep.ts` 设置 `canPlayerSpeak: false`
2. 返回开场白消息
3. 前端收到开场白后，再次调用 `debugStep`（这时 `state` 应该包含 `canPlayerSpeak: false`）
4. 在 `doRunNarrativePlan` 中，`turnState.canPlayerSpeak` 应该是 `false`
5. 但如果 `state` 没有被正确传递，`turnState` 可能为 `{}`，导致 `canPlayerSpeak` 默认变成 `true`

现在我需要确认：`debugStep.ts` 中返回的 `state` 是否包含正确更新的 `turnState`？

让我看 `debugStep.ts` 返回的 `state`：
让我确认 `debugStep.ts` 返回的 `state` 是否正确包含 `turnState`：

我看到第 179 行和第 199 行返回的是 `state`，它已经被 `setRuntimeTurnState` 更新了。所以返回的 `state` 应该是正确的。

现在让我看看 `buildDebugSuccessPayload` 是否正确处理 `state`。
让我搜索。
让我看 `debugRuntimeShared.ts` 的导出。
让我看 `debugRuntimeShared.ts` 的所有导出。
让我看 `buildDebugSuccessPayload` 的实现。在 `debugStep.ts` 第 174 行和 195 行使用了它，但它是导入的。让我看导入。
让我看 `buildDebugSuccessPayload` 的导入位置。
找到了！`buildDebugSuccessPayload` 在第 47 行定义。让我看它的实现。
关键发现！第 67 行：```typescript
state: buildDebugStateSnapshot(params.state, debugRuntimeKey),
```

`state` 被 `buildDebugStateSnapshot` 处理后才返回。让我看 `buildDebugStateSnapshot` 的实现。
找到了！第 130 行：```typescript
turnState: cloneDebugRuntimeState(state.turnState || {}),
```

`turnState` 被正确包含在返回的 snapshot 中。让我看 `cloneDebugRuntimeState` 的实现。
好的，`turnState` 是通过 `JSON.parse(JSON.stringify())` 克隆的，应该正确保留了 `canPlayerSpeak: false`。

现在让我看前端请求时如何传递 `state`。在 `debugStep.ts` 中，`state` 是从 `req.body.state` 获取的。让我看这个流程。
让我看前端请求如何传递 `state`：

关键在第 118-120 行：```typescript
const cachedRuntimeState = loadCachedDebugRuntimeState(req.body.state, userId, worldId);
const state = normalizeSessionState(  cachedRuntimeState || req.body.state,  worldId,
  Number(chapter.id || 0),  // ...
);
```

`state` 的来源有两个：
1. `loadCachedDebugRuntimeState(req.body.state, ...)` - 从缓存加载
2. `req.body.state` - 直接从请求体获取

如果前端正确传递了上一次返回的 `state`，它应该包含 `turnState.canPlayerSpeak: false`。

但问题可能出在：1. 前端没有正确传递 `state`2. `loadCachedDebugRuntimeState` 从缓存加载了旧的 `state`（带有 `canPlayerSpeak: true`）让我看 `loadCachedDebugRuntimeState` 的实现。
现在我理解了整个流程。让我总结一下：

**流程分析**：
1. 章节开始时，`debugStep.ts` 返回开场白消息，**同时返回包含 `turnState.canPlayerSpeak: false` 的 `state`**
2. 前端收到响应后，**应该将返回的 `state` 保存起来**，并在下次请求时传递
3. 下次请求时，`debugStep.ts` 从 `req.body.state` 获取 `state`，然后：
   - 通过 `loadCachedDebugRuntimeState` 从缓存加载（如果 `debugRuntimeKey` 存在）
   - 或者直接使用 `req.body.state`

**可能的问题**：
1. **前端没有正确保存/传递 `state`**：如果前端没有将返回的 `state` 保存起来，下次请求时传递的 `state` 可能是空的或旧的
2. **缓存问题**：`loadCachedDebugRuntimeState` 会从缓存加载状态，如果缓存的状态是旧的（`canPlayerSpeak: true`），就会导致问题
3. **`normalizeSessionState` 可能重置 `turnState`**：让我检查这个函数

让我看 `normalizeSessionState`。
让我搜索。
让我搜索 `normalizeSessionState`。
让我直接搜索。
让我看这个函数。
找到了！**第 1616 行**：```typescript
canPlayerSpeak: typeof rawTurnState.canPlayerSpeak === "boolean" ? rawTurnState.canPlayerSpeak : true,
```

这就是问题！`normalizeSessionState` 中，如果 `rawTurnState.canPlayerSpeak` 不是布尔类型，就**默认设置为 `true`**！

**完整问题链**：
1. 章节开始时，`setRuntimeTurnState` 设置 `canPlayerSpeak: false`
2. 返回的 `state` 包含 `turnState.canPlayerSpeak: false`
3. 前端下次请求时传递这个 `state`
4. `normalizeSessionState` 被调用：
   - `rawTurnState = parseJsonSafe(state.turnState, {})` → `{ canPlayerSpeak: false, ... }`
   - `typeof rawTurnState.canPlayerSpeak === "boolean"` → `true`
   - 所以 `canPlayerSpeak` 被正确设置为 `false`
5. 接着调用 `canPlayerSpeakNow(state, world)` → 返回 `false`
6. 继续调用 `runNarrativeOrchestrator`...

等等，如果 `normalizeSessionState` 正确处理了 `canPlayerSpeak`，那问题出在哪里？让我再仔细看看。

哦，我发现了！第 1616 行的逻辑是：
```typescript
typeof rawTurnState.canPlayerSpeak === "boolean" ? rawTurnState.canPlayerSpeak : true


```

如果 `rawTurnState.canPlayerSpeak === false`（布尔值 `false`），这个条件是正确的（`typeof false === "boolean"` 为 `true`），所以 `canPlayerSpeak` 应该是 `false`。但等等，`false` 本身是布尔值，所以这个三元表达式会返回 `false`。让我重新理解这个逻辑——当 `rawTurnState.canPlayerSpeak` 是 `false` 时，类型检查通过，结果就是 `false`。

不过，我注意到在 `readRuntimeTurnState` 中有个类似的模式：`raw.canPlayerSpeak !== false`。这里的关键是，如果 `canPlayerSpeak` 是 `undefined` 或 `null`，不等于 `false` 的比较会返回 `true`。而在 `normalizeSessionState` 中，同样的值会触发默认的 `true`。这两个地方的行为不一致，可能就是导致问题的根源。

```

typescript
canPlayerSpeak: typeof rawTurnState.canPlayerSpeak === "boolean" ? rawTurnState.canPlayerSpeak : true,
```

这个逻辑只有在 `canPlayerSpeak` 确实是布尔类型时才会保留原始值，否则就默认为 `true`。相比之下，`readRuntimeTurnState` 的做法不同——它假设 `canPlayerSpeak` 存在且为真，除非明确是 `false`。这种差异可能导致在某些边界情况下（比如值是 `undefined` 或 `null`）两个函数返回不同的结果。

找到了！**第 1616 行**：`normalizeSessionState` 中：

```typescript
canPlayerSpeak: typeof rawTurnState.canPlayerSpeak === "boolean" ? rawTurnState.canPlayerSpeak : true,
```

如果 `turnState` 不是有效对象（`{}`），`rawTurnState.canPlayerSpeak` 是 `undefined`，类型检查失败，**默认设置为 `true`**！

让我看完整的 `turnState` 重建逻辑：

现在我完全理解了问题。让我总结"开场白后直接进入用户发言阶段"的根因：## 根因总结

**问题场景**：1. 章节开始，返回开场白消息2. 前端收到开场白后再次请求3. 但系统直接进入用户发言阶段，跳过了 NPC 的正常对话

**根因分析**：

### 主要原因：`normalizeSessionState` 的 `turnState` 重建逻辑

在 `gameEngine.ts` 第 1615-1623 行，`turnState` 被重建：

```typescript
turnState: {
  canPlayerSpeak: typeof rawTurnState.canPlayerSpeak === "boolean" ? rawTurnState.canPlayerSpeak : true,  // ← 问题在这里！
  expectedRoleType,
  expectedRole: ...,
  lastSpeakerRoleType: String(rawTurnState.lastSpeakerRoleType || "").trim(),
  lastSpeaker: String(rawTurnState.lastSpeaker || "").trim(),
},
```

**关键问题**：如果前端传递的 `state` 中：
- `turnState` 为 `null`/`undefined`/`{}`
- `rawTurnState.canPlayerSpeak` 是 `undefined`
- `typeof undefined === "boolean"` 为 `false`
- **`canPlayerSpeak` 被设置为 `true`！**

### 触发条件

1. **前端首次加载时**：`req.body.state` 为 `null` 或 `{}`，`loadCachedDebugRuntimeState` 返回 `null`，`rawTurnState = {}`2. 

在 `debugStep.ts` 的第 185-204 行处理完开场白后返回的 `state` 包含 `canPlayerSpeak: false`，但前端在后续请求时没有正确保存或传递这个状态，导致重新进入 `normalizeSessionState` 时 `canPlayerSpeak` 又被重置为 `true`。

可能是前端发送了旧的 `state`（缺少 `turnState`）、直接发送了 `null`/`undefined`，或者缓存机制失效了。当 `canPlayerSpeak` 被错误地设为 `true` 时，`resolveRuleNarrativePlan` 会命中 "await_user_phase" 规则，绕过 AI 编排直接进入用户发言阶段。

修复方案是确保 `turnState` 初始化时包含 `canPlayerSpeak: false`，或者在 `resolveRuleNarrativePlan` 的条件判断中增加对 `canPlayerSpeak` 为 `false` 情况的处理。
现在我找到了完整的问题！

---

## 根因找到了：「开场白后直接进入用户发言阶段」

### 问题根源

**`normalizeSessionState` 第 1616 行**：

```typescript
canPlayerSpeak: typeof rawTurnState.canPlayerSpeak === "boolean" ? rawTurnState.canPlayerSpeak : true,
// ↑ 如果不是布尔类型，默认设置为 true！
```

当 `state.turnState` 为 `null`/`undefined`/`{}` 时，`canPlayerSpeak` **默认变成 `true`**，导致 `resolveRuleNarrativePlan` 直接返回 `"await_user_phase"`，跳过 AI 编排。

### 触发条件

1. 前端首次加载章节时传递 `state = null` 或 `state = {}`
2. `loadCachedDebugRuntimeState` 返回 `null`（没有缓存的 `debugRuntimeKey`）
3. `rawTurnState = {}`（空对象）
4. `typeof {}.canPlayerSpeak === "boolean"` 为 `false`
5. **`canPlayerSpeak` 被设置为 `true`**
6. AI 编排被跳过，直接进入用户发言阶段

### 完整问题链

```
前端首次请求 (state=null)
  → loadCachedDebugRuntimeState 返回 null
  → normalizeSessionState(raw={}, ...)
    → rawTurnState = {} 
    → canPlayerSpeak = true (错误！)
  → canPlayerSpeakNow(state) = true
  → resolveRuleNarrativePlan 命中 "await_user_phase"
  → 直接返回用户发言阶段
  → 开场白被跳过！
```

### 修复方案

**方案 A**（推荐）：修改 `normalizeSessionState` 中 `canPlayerSpeak` 的默认值：

```typescript
// gameEngine.ts 第 1616 行
canPlayerSpeak: typeof rawTurnState.canPlayerSpeak === "boolean" ? rawTurnState.canPlayerSpeak : false,
//                                                                          ↑ 改成 false
```

**方案 B**：修改 `resolveRuleNarrativePlan` 的判断逻辑，在章节刚开场的 `phase.kind === "opening"` 时强制要求 NPC 先发言。

---

要我现在修复吗？