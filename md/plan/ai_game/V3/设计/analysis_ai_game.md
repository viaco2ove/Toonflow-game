# Toonflow 改造为 AI 游戏方案（task3）

## 1. 结论先行
当前 Toonflow 已有“创作引擎”基础（角色/剧本/分镜/语音/TTS/视频），但还不是“可持续游玩”的 AI 游戏系统。最优路线不是推倒重做，而是：
- 保留现有 `Toonflow-game-web`（创作端）与 `toonflow-game-app`（服务端）能力。
- 新增一层 **Game Brain（游戏编排层）** 负责状态机、任务树、触发器、章节事件检测。
- 新建 **Android 游玩端**（推荐 Flutter）承载沉浸式剧情互动与语音输入。

## 2. 现状能力盘点（基于代码）

### 已有能力
1. 创作型数据模型已具备：项目/大纲/剧本/分镜/素材/视频配置。  
   证据：`/mnt/d/Users/viaco/tools/Toonflow-game/toonflow-game-app/src/lib/initDB.ts`
2. 后端已存在完整创作路由：`/outline/*`、`/script/*`、`/storyboard/*`、`/video/*`、`/voice/*`。  
   证据：`/mnt/d/Users/viaco/tools/Toonflow-game/toonflow-game-app/src/router.ts`
3. 前端已有创作工作台（项目、大纲、剧本、资产管理）。  
   证据：`/mnt/d/Users/viaco/tools/Toonflow-game/Toonflow-game-web/src/views/projectDetail/index.vue`
4. 已有桌面安装能力（Electron + electron-builder）。  
   证据：`/mnt/d/Users/viaco/tools/Toonflow-game/toonflow-game-app/electron-builder.yml`

### 缺失能力（你任务里提到的）
1. 语音识别（ASR）缺失：当前是 TTS/音色查询/音频上传，没有转写路由。  
   证据：`/mnt/d/Users/viaco/tools/Toonflow-game/toonflow-game-app/src/routes/voice/preview.ts`、`getVoices.ts`、`uploadAudio.ts`
2. 游戏故事创建编辑模型缺失：当前是剧本生产流程，不是“可玩剧情状态机”。
3. Android 客户端缺失：目前只有桌面壳（Electron）。
4. 固有角色（用户+旁白）机制缺失：未见系统角色约束层。
5. 存档/聊天记录/属性变化体系缺失：缺少 session + state diff 模型。
6. 章节任务树、触发器、章节完成检测缺失：未见规则引擎与事件检测表。

## 3. 目标架构（建议）

### 架构分层
1. **Creator Studio（PC 网页）**
- 用于：角色设定、世界观、章节树、任务节点、触发器配置、剧情测试。
- 继续使用现有 Vue3 技术栈。

2. **Game Brain（新增服务层）**
- 用于：对话生成编排、角色调配、事件检测、状态推进。
- 以现有 Node/TS 服务为基底新增模块，不影响现有创作接口。

3. **Player App（Android）**
- 用于：沉浸式对话游玩、按住说话、回看、分支选择、存档。
- 和 Game Brain 用 HTTP + WebSocket 通信。

4. **Data Layer（SQLite 可平滑升级 PostgreSQL）**
- 当前可先沿用 SQLite（快速迭代）。
- 若要上线多人并发，迁移 PostgreSQL。

## 4. 缺失功能的实现方案

### 4.1 语音识别（ASR）
新增：`POST /voice/transcribe`
- 输入：`audioBase64 | audioPath`、`lang`、`sessionId`
- 输出：`text`、`segments`、`confidence`

实现建议：
1. 先对接兼容 OpenAI Whisper / FunASR / 火山语音识别接口。
2. 与现有 `voice` 模块并列，不改动现有 TTS 路径。
3. 前端采用“按住说话 -> 本地降噪 -> 上传 -> 回填文本框”。

### 4.2 游戏故事创建与编辑
新增核心实体：
- `story_world`（世界观）
- `story_chapter`（章节）
- `chapter_task`（任务树）
- `chapter_trigger`（触发器）

关键点：
1. 章节不是纯文案，必须有 `entry_condition` 与 `completion_condition`。
2. 任务树节点支持：主线/支线/隐藏。
3. 触发器采用“条件表达式 + 动作”结构（如属性变更、分支跳转、解锁角色）。

### 4.3 固有角色：用户 + 旁白
新增系统角色类型：
- `role_type = player | narrator | npc`

规则：
1. 每个故事必须唯一 `player` 与 `narrator`。
2. 旁白内容由 Game Brain 可控生成，优先承担“环境推进 + 规则提示”。
3. NPC 才允许被动态调配出场。

### 4.4 存档、聊天记录、属性变化
新增实体：
- `game_session`（一次游玩）
- `session_message`（对话日志）
- `session_state_snapshot`（关键帧存档）
- `entity_state_delta`（角色/玩家属性变化）

策略：
1. 聊天记录与状态变化分离存储，便于回放与回滚。
2. 每 N 轮自动快照，异常时可恢复。
3. 属性变化必须有来源事件 ID，支持审计和调试。

### 4.5 AI 对话生成、角色调配、事件检测
新增引擎：
1. **Dialogue Director**：根据章节目标、当前状态、角色关系生成回复。
2. **Role Scheduler**：决定“当前应由谁说话”。
3. **Event Detector**：识别“章节目标是否完成”（关键词 + 结构化判断 + LLM 裁决三层）。

建议流程：
`用户输入 -> ASR(可选) -> 状态更新 -> 触发器匹配 -> 角色调度 -> LLM生成 -> 输出文本/TTS -> 写入日志`

### 4.6 章节任务树与触发器
任务树节点字段建议：
- `task_id`、`chapter_id`、`parent_task_id`
- `goal_type`（对话/收集/战斗/到达）
- `success_condition`、`fail_condition`
- `reward_action`

触发器字段建议：
- `trigger_event`（on_message/on_enter_chapter/on_attr_change/...）
- `condition_expr`（JSON Logic）
- `action_expr`（set_state/add_item/switch_chapter/...）

## 5. 界面技术建议

### 5.1 PC 创作端（推荐：继续 Vue3）
推荐保留当前 `Vue3 + Vite + Pinia`，新增模块：
1. 角色关系编辑器（图谱）
2. 章节任务树编辑器（节点式）
3. 触发器规则编辑器（可视化条件）
4. 手机预览模拟器（右侧实时预览）

节点编辑器可选：
- `LogicFlow`（中文生态较友好）
- 或 `Vue Flow`

### 5.2 Android 游玩端（推荐：Flutter）
推荐 `Flutter` 原因：
1. 对沉浸式聊天流、动画、音频录制播放体验更稳定。
2. Android 打包与上架链路成熟（AAB/APK）。
3. 后续预留 2.5D 时可先嵌轻交互（Rive/Flame），不阻塞当前版本。

备选（短期极快上线）：
- `Capacitor + 现有 H5`：2-4 周可出包，但音视频与复杂交互上限较低。

## 6. App 安装与分发技术方案

### 6.1 Android 打包
1. 使用 Flutter 产物：`APK`（测试分发）+ `AAB`（应用市场）。
2. 配置签名：`keystore` + CI 注入。
3. 版本策略：`versionCode` 单调递增，`versionName` 语义化。

### 6.2 更新机制
1. 应用市场渠道：Google Play / 国内应用商店（推荐）。
2. 私有渠道：下载页 + 应用内版本检查。
3. 强制更新策略：仅安全修复与协议升级时启用。

### 6.3 后端部署与网关
1. 先维持现有 Node 服务。
2. 增加 API 网关层（鉴权、限流、灰度）。
3. WebSocket 用于实时剧情推送与打字流。

## 7. 2.5D 冒险预留（暂不实现，但现在就要做的）
1. 将“剧情状态机”与“渲染表现层”彻底解耦。
2. 任务/触发器/章节事件统一走数据驱动，不写死在 UI。
3. 资源统一抽象为 `asset_ref`（图/音/立绘/动画），后续可挂 Unity 客户端。

## 8. 分阶段落地计划

### Phase 1（2-3 周，MVP）
1. 补 ASR 接口与移动端按住说话。
2. 新增 session 存档 + 聊天日志 + 属性变化表。
3. 增加固定角色（用户/旁白）机制。
4. 上线最小触发器（章节完成检测 + 跳转）。

### Phase 2（3-5 周，Beta）
1. 上线可视化任务树/触发器编辑器。
2. 增加角色调度策略与事件检测多层判定。
3. Android 首版发布（内测包 + 渠道包）。

### Phase 3（后续）
1. 优化剧情一致性与长对话记忆。
2. 加入商业化能力（会员章节、付费道具、创作者分润）。
3. 评估 2.5D 客户端（Unity）接入可行性。

## 9. 风险与避坑
1. 不要把“创作数据”和“游玩状态”混到同一张表，否则后续必炸。
2. 触发器不要直接写代码字符串，必须结构化（JSON Logic）并可审计。
3. 语音链路要有超时与降级（ASR失败时回退文字输入）。
4. 先做单人高质量剧情闭环，再扩展多人或复杂战斗系统。

## 10. 你这个项目的技术选型建议（最终）
1. **PC 界面技术**：继续 `Vue3 + Pinia + TDesign`，加节点编辑器（LogicFlow/Vue Flow）。
2. **游戏编排技术**：在现有 `Node + Express + SQLite` 基础上新增 Game Brain 模块。
3. **App 技术**：`Flutter(Android 优先)`。
4. **安装分发技术**：`AAB/APK + 应用市场发布 + 应用内版本检测更新`。

