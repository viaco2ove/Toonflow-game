# 会话「重玩」功能：重新生成角色卡 + 删档重新开局

## Context

「聊过」列表的会话只能继续/观看，没有"从头再来"的入口。需求：卡片上加「重玩」按钮，二次确认（输入"重玩"两个字）后**重新生成角色卡等动态数据**、删除旧进度、重新开局游玩。

已探明的关键事实：
- 会话动态数据分布在 6 张表：`t_gameSession`（主行，动态态全在 stateJson）、`t_sessionMessage`、`t_sessionStateSnapshot`、`t_entityStateDelta`、`t_role_memory`、`t_plugin_session_data`。现有 `deleteSession` 只删前 3 张（孤儿数据问题），重玩要删全 6 张
- 角色卡是**世界级**数据（`t_storyWorld.playerRole/narratorRole/settings.roles`，内嵌 parameterCardJson）；`ensureWorldRolesWithAiParameterCards({persist:true, forceRefresh:true})`（src/lib/roleParameterCard.ts:418）可 LLM 全量重生成并写回世界（发布时同款逻辑 worldPublish.ts:219）；卡变更会自动使开局快照缓存失效（hash 含角色卡 JSON）
- 前端已有完整开局链路 `startFromWorld(world, "")`（initStory→introduction→流式开场白→orchestration），SceneHistory.vue 的 `restartFromBeginning`（L94-115）已示范"删档+重新开局"
- **方案：后端接口只做「重生成角色卡 + 删旧会话数据」，新会话由前端现有 `startFromWorld` 链路创建**——零复制 initStory/开场白逻辑，新 sessionId 天然规避并发锁/revisit 缓存/后台回调竞态（回调有行存在性守卫）

## 后端（toonflow-game-app）

### 1. 新路由 `src/routes/game/replaySession.ts`
照 `deleteSession.ts` 套路（zod 校验 + userId 隔离 + success/error）：
1. 读旧会话 `t_gameSession` where `{sessionId, userId}` → 404；取 `worldId`
2. 读 `t_storyWorld` → `ensureWorldRolesWithAiParameterCards({ userId, world, persist: true, forceRefresh: true })`（重新生成全部角色卡写回世界；LLM 失败函数内部静默回退静态卡，不阻塞）
3. `withSessionLock(sessionId, () => db.transaction(删 6 表))`：照 deleteSession 事务 + 补删 `t_role_memory`、`t_entityStateDelta`、`t_plugin_session_data`
4. 事务外 `clearSessionRevisitCache(sessionId)`（SessionService.ts:174 已导出）
5. 返回 `success({ worldId })`

### 2. `src/modules/game-runtime/services/SessionService.ts`
`withSessionLock`（L126）加 `export`（当前模块私有），供路由在删除前排队等待在途编排完成。

### 3. `src/router.ts` 注册 route190：`/game/replaySession`

## 前端（Toonflow-game-web）

### 4. `src/api/toonflow.ts`
`replaySession(sessionId)` → POST `/game/replaySession`，返回 `{ worldId }`（axios 无超时限制，LLM 长调用不受影响）

### 5. `src/composables/useToonflowStore.ts`
新 action `replaySession(sessionId)`：
```
api.replaySession → refreshSessionListState()（旧会话出列表）
→ 从 state.worlds 找 worldId 对应 world（找不到 throw）
→ await startFromWorld(world, "")（现有完整开局链路，自动切到 play 页）
```
导出加入 apiFacade。

### 6. `src/components/SceneHistory.vue`
- `.history-card-actions` 内「世界书」与删除图标之间加「重玩」按钮（`.history-card-btn` 样式，`@click.stop`）
- 确认弹窗：仿「故事已更新」modal（L201-231 结构 + scoped 样式复用 `.story-update-*`），内容：会话名、警告文案（删除当前进度、重新生成角色卡、重新开局）、输入框（placeholder「输入 重玩 以确认」）+ danger 确认按钮（`v-model` 值严格 `=== "重玩"` 时才 enabled）、busy 态（按钮文案「正在重新生成角色卡…」，禁用关闭）
- 确认链路：`store.replaySession(item.sessionId)` → 成功自动进入新开局；失败 `store.state.notice`（项目惯例）

## 验证

1. 后端 `yarn lint`；起 `yarn local`，用 python urllib（UTF-8，避免 Git Bash curl 乱码）实测：取 admin 本地一个已发布世界的会话 → 调 replaySession → 断言：返回 worldId、`t_storyWorld` 角色卡 JSON 已更新、6 张表旧会话数据清零、重生成后再调 `/game/initStory` 能建新会话
2. 前端 `yarn type-check`；`yarn dev` + `yarn local` 浏览器走查：聊过页重玩按钮 → 弹窗（输入错字按钮 disabled）→ 输入"重玩"→ busy 文案 → 自动进入游戏新开局（开场白流式）→ 会话列表刷新为新会话
3. 测试数据清理（删除测试产生的会话/世界数据恢复原状）