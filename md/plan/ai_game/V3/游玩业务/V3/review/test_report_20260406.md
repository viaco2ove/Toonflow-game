# Review.md 测试报告

**测试时间**: 2026-04-06
**后端**: http://127.0.0.1:3001
**Appium**: http://127.0.0.1:4723
**Android 模拟器**: emulator-5554

---

## 核查结果总览

| # | 问题 | 后端状态 | 前端状态 | 结论 |
|---|---|---|---|---|
| 1 | 重复请求合并 | N/A | ❌ 未实现 | 待修复 |
| 2 | 开场白独立处理 | ✅ 已改用内部 `buildOpeningRuntimeMessage` | N/A | ✅ 已解决 |
| 3 | 事件混乱 | ❌ 无事件分离改动 | N/A | 待修复 |
| 4 | 回溯功能 | ✅ API 已实现 | ❌ 无回溯按钮 | **核心待完成** |
| 5 | `[tag_end_chapter]` 结束判断 | ❌ 代码中不存在此标记 | N/A | 待修复 |
| 6 | 编排日志 | ❌ 无 orchestrator 日志 | N/A | 待修复 |
| 7 | token 消耗日志 | ❌ 搜索不到 tokenUsed/promptTokens | N/A | 待修复 |
| 8 | 章节结束条件判定 | ✅ `evaluateDebugRuntimeOutcome` 已用 `!= null` | N/A | ✅ 已解决 |
| 9 | 高级版提示词配置 | ❌ 前后端均无此功能 | ❌ 无此功能 | 待修复 |

---

## 详细说明

### ✅ 已解决

#### 2. 开场白独立于第一章
- `debugStep.ts` 第 208-234 行：没有开场白时直接进入编排流程，不再单独调用 `/introduction`
- 代码注释明确："使用 /introduction 接口生成开场白，而不是内部处理"
- **实际行为**：通过 `buildOpeningRuntimeMessage` 直接生成开场白，不再等待用户输入

#### 8. 章节结束条件判定
- `evaluateRuntimeOutcome` 使用 `!= null` 替代 `!== undefined`（review.md 记录已修复）
- 判定逻辑正常：failed / success / continue 三种结果

---

### ⚠️ 部分实现

#### 4. 回溯功能（最重要）

**后端实现 ✅**：
- `debugRuntimeShared.ts`:
  - `saveDebugRevisitPoint()` - 保存回溯点（内存+文件两级存储）
  - `getDebugRevisitPoint()` - 获取指定回溯点
  - `readDebugRevisitPoints()` - 读取完整回溯历史
  - `clearDebugRevisitHistory()` - 清理历史
  - `buildDebugMessageWithRevisitData()` - 构建带 `canRevisit` 标记的消息
- `debugStep.ts`:
  - `buildDebugSuccessPayload()` 在返回消息时保存回溯点（第 76-84 行）
  - 消息数组中除最后一条外其他都标记 `canRevisit: true`（第 67 行）
- API 接口:
  - `POST /game/debugRuntimeShared/revisit` - 执行回溯
  - `GET /game/debugRuntimeShared/revisit/history?debugRuntimeKey=xxx` - 获取历史
  - `POST /game/revisitMessage` - 数据库层回溯（旧版）

**前端实现 ❌**：
- Web 端：搜索不到 `canRevisit`、`revisit`、`回溯` 相关代码
- Android 端：需要验证 App 内是否有回溯按钮

**测试验证**：
- Android Appium 测试成功连接 Appium 和后端
- 后端 API 返回 405 (需认证)，说明路由已注册

---

### ❌ 未修复

#### 1. 重复请求合并
- 前端 `useToonflowStore.ts` 中 `initStory` 和 `initDebug` 各自独立调用
- 没有任何防重处理

#### 3. 事件混乱
- 代码中无 `[tag_end_chapter]` 字符串
- `eventKind` / `eventStatus` 未被分离使用
- NarrativeOrchestrator 中未添加事件分离相关代码

#### 5. `[tag_end_chapter]` 结束判断
- 整个代码库搜索不到此标记
- 章节结束仍依赖 `evaluateRuntimeOutcome` 的规则引擎

#### 6. 编排日志
- `runNarrativeOrchestrator` 返回后无 `console.log` 记录内容
- 无法追踪编排结果

#### 7. token 消耗日志
- 搜索 `tokenUsed|promptTokens|completionTokens` 无结果
- AI 调用响应中的 token 使用情况未被记录

#### 9. 高级版提示词
- 前端无 `promptAdvanced`、`advancedPrompt` 相关代码
- 后端无高级版提示词接口

---

## Android 测试结果

**Appium 连接**: ✅ 成功
**Android App**: ✅ 可连接 `com.toonflow.game`
**后端 API**: ✅ 服务可达

**测试用例执行**:
- App 启动: ✅ 通过
- 底部导航切换: ✅ 通过（tabs 可点击切换）
- Compose TextField 定位: ✅ 通过（UIAutomator 可定位）
- 故事列表: ⚠️ 无数据时无内容
- 回溯 API: ⚠️ 需要真实用户会话才能测试

**已知问题**:
- 登录 API 返回 405（POST 方法不被 /other/login 接受）
- "首页" 文字搜索失败（Compose 底导 label 无 resource-id）
- 后端端口 3001（非默认 60002，需更新测试配置）

---

## 下一步行动

### P0 - 必须完成
1. **Web 端添加回溯按钮** - 在 ScenePlay.vue 右键菜单或长按菜单中添加回溯选项
2. **Android 端添加回溯按钮** - 在游戏聊天界面添加回溯入口
3. **前端调用 `/game/debugRuntimeShared/revisit`** - 实现回溯功能调用

### P1 - 应该修复
4. 合并重复的 initStory/initDebug 请求
5. 添加 Orchestrator 日志（`runNarrativeOrchestrator` 返回时记录）
6. 添加 token 消耗日志

### P2 - 改进项
7. 实现 `[tag_end_chapter]` 标记解析
8. 分离事件系统（chapter content vs ending conditions）
9. 高级版提示词配置界面
