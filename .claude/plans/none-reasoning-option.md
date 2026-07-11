# 给模型配置新增 `none` 思考强度选项

## 背景与语义

当前 `reasoningEffort` 仅支持 `minimal | low | medium | high`。
MiniMax M3 的 readme 说明：`/v1/responses` 用 `reasoning.effort: "none"` 可完全关闭思考（台词生成推荐）。
OpenAI 的 ai-sdk 类型 `reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"` 也原生支持 `"none"`。

新增 `none` = **完全关闭思考**，语义与 OpenAI/MiniMax 官方 `none` 一致：
- OpenAI 兼容厂商（volcengine/doubao/openai/aliyun 等）：`providerOptions.openai.reasoningEffort = "none"` 直接透传。
- MiniMax：`thinking.type = "disabled"`（关闭思考）。保持现有 `minimal -> disabled`、`low/medium/high -> adaptive` 不变，`none` 也映射到 `disabled`（等价于关闭），无回归。

> 用户明确指示：MiniMax 的 `none` 直接对应 readme 的 `reasoning.effort: "none"` 关闭语义，"直接发送就好"。所以后端把 `none` 当作与 `minimal` 等价的"关闭思考"处理，但保留为独立选项值（透传给 OpenAI 兼容厂商时是真实的 `none`，而非 `minimal`）。

## 改动清单

### A. 后端 `toonflow-game-app`（`src/`）

#### A1. 类型定义 — `src/lib/modelConfigType.ts`
- `ModelReasoningEffort`：`"none" | "minimal" | "low" | "medium" | "high"`
- `normalizeReasoningEffort(input)`：`none/minimal/low/medium/high` 直接返回；其余兜底为 `"minimal"`（保持现有默认行为不变，避免老数据回填逻辑变化）。

#### A2. 路由 Zod 校验（4 处，加 `"none"`）
- `src/routes/setting/addModel.ts`：`reasoningEffort: z.enum(["none","minimal","low","medium","high"]).optional()`
- `src/routes/setting/updateModel.ts`：同上
- `src/routes/setting/updeteModel.ts`：同上（与 updateModel 重复存在的旧文件，一并改，保持一致）
- `src/routes/other/testAI.ts`：同上

#### A3. 文本调用核心 — `src/utils/ai/text/index.ts`
- `AIConfig.reasoningEffort`：`"none" | "minimal" | "low" | "medium" | "high"`
- `minimaxThinking` 映射：`none | minimal -> { thinking: { type: "disabled" } }`，其余 `-> { thinking: { type: "adaptive" } }`。
  - 即把 `config.reasoningEffort === "minimal"` 的判断改为 `config.reasoningEffort === "none" || config.reasoningEffort === "minimal"`。
- OpenAI 兼容厂商分支（`providerOptions.openai.reasoningEffort`）：`none` 原样透传（ai-sdk 支持）。该分支当前条件 `config.reasoningEffort && openAICompatible && !isMinimaxManufacturer`，`none` 是 truthy 字符串，自然进入，无需额外改动。

#### A4. `src/utils/getPromptAi.ts`
- `AiConfig.reasoningEffort`：`"none" | "minimal" | "low" | "medium" | "high"`

#### A5. 编排/会话运行期类型与归一化（4 处 inline guard，加 `none`）
- `src/modules/game-runtime/engines/NarrativeOrchestrator.ts`
  - `NarrativeRuntimeMeta.reasoningEffort` 类型加 `"none"`
  - 第 2860、4324、4360、5242 行的三元判断：`value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" ? value : ""`
- `src/modules/game-runtime/services/SessionService.ts`
  - 第 288 行类型加 `"none"`
  - 第 1119 行归一化判断加 `"none"`
- `src/modules/game-runtime/services/ChapterRuntimeService.ts` / `EventProgressRuntimeService.ts`：这两处 `reasoningEffort` 仅作 `string` 透传展示（`normalizeScalarText(...)`），无枚举校验，**无需改动**（已确认）。

#### A6. 数据库迁移 — `src/lib/fixDB.ts`
- 第 156-158 行的回填逻辑：将 `reasoningEffort` 为空的旧 text 配置回填为 `"minimal"`。**保持不变**（不改为 `none`，避免悄悄改变存量配置行为；`none` 仅作为新可选项）。`t_config.reasoningEffort` 列已是 `text`，无需 schema 变更。

> `src/types/database.d.ts` 的 `reasoningEffort?: string | null` 是宽字符串类型，无需改动。

### B. 前端 `Toonflow-game-web`（`D:\Users\viaco\tools\Toonflow-game\Toonflow-game-web`）

#### B1. 下拉选项 — `src/components/SettingsModelManagerDialog.vue`
- `reasoningEffortOptions`（第 222-227 行）：在数组首位加 `{ value: "none", label: "none" }`。
- `form.reasoningEffort` 类型注解（第 238 行）与两处 `as` 断言（第 848、5091(useToonflowStore) 行）补 `"none"`。
  - 默认值保持 `"minimal"`（不改变新配置默认，避免存量行为变化）。
- 列表展示行（第 1060 行 `推理：{{ row.reasoningEffort || 'minimal' }}`）无需改，`none` 会自然显示。

#### B2. 类型 — `src/types/toonflow.ts`
- 第 324、541、558 行的 `reasoningEffort` 联合类型加 `"none"`。

#### B3. `src/composables/useToonflowStore.ts`
- 第 5091 行 `as "minimal" | "low" | "medium" | "high"` 断言补 `"none"`。

#### B4. `src/api/toonflow.ts`
- 第 736 行 `testTextModel` 的 `reasoningEffort` 类型补 `"none"`。

#### B5. `src/components/ScenePlay.vue`
- 第 270 行归一化判断加 `"none"`（与后端 SessionService 对齐，否则前端会把 `none` 丢成 `""`）。

#### B6. 构建部署
- 前端改动后需在 web 项目执行 `yarn build`（`vite build && node scripts/inline-dist-assets.mjs`），产物会更新该项目的 `dist/`；再按现有流程同步到 app 仓库的 `scripts/web/`（app 仓库 `scripts/web/` 为构建产物，gitignore 忽略，不在本次代码改动范围内，由前端构建流程产出）。

## 不改动 / 已确认无需改动
- `src/modules/game-runtime/services/ChapterRuntimeService.ts`、`EventProgressRuntimeService.ts`：`reasoningEffort` 仅字符串透传。
- `src/lib/fixDB.ts` 回填默认值：保持 `minimal`。
- `src/types/database.d.ts`：已是宽字符串类型。
- 后端 `build/` 镜像目录：由 `yarn build` 重新生成，不手动改。

## 验证
1. `yarn lint`（`tsc --noEmit`）在 app 仓库通过。
2. 前端 web 项目 `yarn type-check` 通过。
3. 配置一个 MiniMax-M3 文本模型，思考强度选 `none`，测试连通性；确认请求体含 `thinking.type: "disabled"`（可开 `AI_TEXT_DEBUG_HTTP=1` 观察）。
4. 配置一个 volcengine/doubao 模型选 `none`，确认请求体 `reasoning_effort: "none"` 透传成功、模型不进入思考。
5. 存量配置（`minimal`）行为不变。
