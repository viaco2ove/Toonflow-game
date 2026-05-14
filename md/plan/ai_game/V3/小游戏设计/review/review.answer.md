# 小游戏 Review 回答

## 结论

本轮已按 `review.md` 的 4 个问题完成整改，当前小游戏统一改成：

- 通过聊天框输入推进
- 面板默认折叠，只展示状态
- `#退出` 强制退出
- `#小游戏` 目录台词简化

---

## 1. 都不要展开这个小游戏面板

### 已修改

- Web：
  - [/mnt/d/users/viaco/tools/Toonflow-game/toonflow-game-web/src/components/ScenePlay.vue](/mnt/d/users/viaco/tools/Toonflow-game/toonflow-game-web/src/components/ScenePlay.vue)
- 安卓：
  - [/mnt/d/users/viaco/tools/Toonflow-game/toonflow-game-android/app/src/main/java/com/toonflow/game/MainActivity.kt](/mnt/d/users/viaco/tools/Toonflow-game/toonflow-game-android/app/src/main/java/com/toonflow/game/MainActivity.kt)

### 当前行为

- 小游戏状态面板默认折叠
- 只显示标题和展开入口
- 不再默认展开成操作面板

### 验证点

1. 进入任意小游戏后，面板默认是收起状态。
2. 点击“展开”后，只能看到状态、规则、最近播报。
3. 面板中不再出现操作按钮列表。

---

## 2. 小游戏的聊天流程

### 已修改

- 后端：
  - [/mnt/d/users/viaco/tools/toonflow-game/toonflow-game-app/src/modules/game-runtime/engines/MiniGameController.ts](/mnt/d/users/viaco/tools/toonflow-game/toonflow-game-app/src/modules/game-runtime/engines/MiniGameController.ts)
- Web：
  - [/mnt/d/users/viaco/tools/Toonflow-game/toonflow-game-web/src/components/ScenePlay.vue](/mnt/d/users/viaco/tools/Toonflow-game/toonflow-game-web/src/components/ScenePlay.vue)
- 安卓：
  - [/mnt/d/users/viaco/tools/Toonflow-game/toonflow-game-android/app/src/main/java/com/toonflow/game/viewmodel/MainViewModel.kt](/mnt/d/users/viaco/tools/Toonflow-game/toonflow-game-android/app/src/main/java/com/toonflow/game/viewmodel/MainViewModel.kt)
  - [/mnt/d/users/viaco/tools/Toonflow-game/toonflow-game-android/app/src/main/java/com/toonflow/game/MainActivity.kt](/mnt/d/users/viaco/tools/Toonflow-game/toonflow-game-android/app/src/main/java/com/toonflow/game/MainActivity.kt)

### 当前行为

- 小游戏统一通过聊天框输入推进
- 后端不再向前端下发 `player_options` 按钮动作
- `battle / werewolf / fishing / cultivation / mining` 都支持文本动作
- `research_skill / alchemy / upgrade_equipment` 本来就是自由文本输入

### 当前支持的典型输入

- `#战斗 暴风狼`
  - `攻击暴风狼`
  - `施展灭魔步攻击`
  - `防御`
  - `调息回气`
- `#钓鱼`
  - `抛竿`
  - `收杆`
  - `继续钓鱼`
- `#修炼`
  - `吐纳`
  - `观想`
  - `稳息`
  - `服丹`
  - `冲关`
  - `收功`
- `#挖矿`
  - `勘探`
  - `开采`
  - `精挖`
  - `支护`
  - `撤离`
- `#狼人杀`
  - `发言`
  - `进入投票`
  - `投票萧炎`
  - `查验美杜莎`
  - `救萧炎`

### 额外处理

- 已加入文本归一化，下面这类口语输入也能更容易命中：
  - `我想先抛竿试试`
  - `帮我投票萧炎`
  - `先稳息一下`
  - `让我看看状态`

---

## 3. 主动退出小游戏

### 已修改

- 后端：
  - [/mnt/d/users/viaco/tools/toonflow-game/toonflow-game-app/src/modules/game-runtime/engines/MiniGameController.ts](/mnt/d/users/viaco/tools/toonflow-game/toonflow-game-app/src/modules/game-runtime/engines/MiniGameController.ts)
- Web / 安卓提示文案已同步改成 `#退出`

### 当前行为

- 用户输入 `#退出`
- 立即强制退出当前小游戏
- 不再依赖“申请退出/确认退出”的双层按钮流程

### 验证点

1. 进入任意小游戏。
2. 输入 `#退出`。
3. 应立即结束小游戏并回到主线。

---

## 4. `#小游戏` 的台词过于复杂

### 已修改

- 后端：
  - [/mnt/d/users/viaco/tools/toonflow-game/toonflow-game-app/src/modules/game-runtime/engines/MiniGameController.ts](/mnt/d/users/viaco/tools/toonflow-game/toonflow-game-app/src/modules/game-runtime/engines/MiniGameController.ts)

### 当前文案

> （输入 #狼人杀 / #钓鱼 / #修炼 / #研发技能 / #炼药 / #挖矿 / #升级装备 / #战斗 进入小游戏。  
> 游戏中 #退出 可以强制退出小游戏）请输入 #+小游戏名称，如 #钓鱼。

说明：

- 这里额外保留了 `#战斗`
- 因为本轮已经把战斗小游戏也纳入了统一小游戏入口

---

## 补充说明

### 已完成的技术收口

- 后端运行态 UI 不再返回按钮动作数组
- Web 不再依赖 `player_options`
- 安卓也已经删除无效的 `playerOptions / controlOptions / onMiniGameAction`

### 当前边界

- 现在是“聊天框输入 + 规则归一化匹配”
- 不是大模型自由理解
- 所以更自然的句子虽然支持面已经扩大，但仍然是受控解析，不是任意表达都能识别

---

## 建议验收顺序

1. `#小游戏`
   - 检查目录文案是否简化
2. `#钓鱼`
   - 验证 `抛竿 / 收杆 / 继续钓鱼 / #退出`
3. `#修炼`
   - 验证 `吐纳 / 观想 / 稳息 / 冲关`
4. `#挖矿`
   - 验证 `勘探 / 开采 / 支护 / 撤离`
5. `#狼人杀`
   - 验证 `发言 / 进入投票 / 投票某人 / 查验某人`
6. `#战斗`
   - 验证 `攻击 / 技能攻击 / 防御 / 调息回气`

---

## 日志验证

如果需要确认聊天框输入到底命中了什么动作，打开 `LOG_LEVEL=DEBUG` 后查看：

- `story:mini_game:stats`

日志里会直接打印：

- `gameType`
- `phase`
- `status`
- `input`
- `normalizedInput`
- `controlAction`
- `actionId`
- `battleActionId`
- `resultTags`

### 预期示例

- `#钓鱼` 后输入 `我想先抛竿试试`
  - `normalizedInput` 应接近 `抛竿`
  - `actionId` 应命中 `cast`

- `#狼人杀` 后输入 `帮我投票萧炎`
  - `normalizedInput` 应接近 `投票萧炎`
  - `actionId` 应命中 `vote:...`

- `#修炼` 后输入 `先稳息一下`
  - `normalizedInput` 应接近 `稳息`
  - `actionId` 应命中 `steady`
