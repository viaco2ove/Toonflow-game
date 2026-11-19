# 模型组保存与快速切换功能

## Context

设置页「模型配置」卡片里有 14 个模型槽位（编排师、章节判定、事件进度检测…语音识别）+ 编排师/记忆管理运行模式。用户调一套模型组合要逐个槽位配置，希望像「存档/读档」一样：输入名称+备注把当前全部模型配置保存为一个模型组，再通过可搜索下拉框一键切换。

数据基础（已探明）：全部槽位绑定存在 `t_setting.languageModel` 的 JSON 里（`{ 槽位key: configId, ..., __storyRuntimeSettings: { 运行模式 } }`）。模型组 = 该 JSON 的快照；应用 = 覆写回去。后端 SQLite/knex、一文件一路由；前端 Vue3 + 自研 store、无 UI 库（手写 CSS）。

用户已确认：只改 Web 端（安卓不动，API 设计保持通用）；需要删除、重命名/改备注能力。

## 后端（toonflow-game-app）

### 1. 新建迁移 `src/migrations/20261120_000001_add_model_group_table.js`
- 模仿现有迁移幂等风格（`hasTable` 判断后建表）
- 表 `t_modelGroup`：`id`(PK) / `userId` / `name` / `remark`(nullable) / `languageModelJson`(text) / `createTime` / `updateTime`
- `database.d.ts` 是启动时自动生成的，不手改

### 2. 新建 5 个路由（`src/routes/setting/`，照 `addProject.ts`/`configurationModel.ts` 套路：`validateFields(zod)` + `userId = Number((req as any)?.user?.id || 0)` 隔离 + `success()/error()`）
| 文件 | 入参 | 行为 |
|---|---|---|
| `getModelGroups.ts` | `{}` | 返回该用户的组列表（不含 JSON 内容） |
| `saveModelGroup.ts` | `{ id?, name, remark? }` | 无 id=新建：快照当前 `t_setting.languageModel` 整个 JSON 存入；有 id=覆盖保存：重新快照覆写该组（校验归属）。同 userId 内重名校验 |
| `updateModelGroupInfo.ts` | `{ id, name, remark? }` | 仅改名/备注，不动快照 |
| `applyModelGroup.ts` | `{ id }` | 读组 JSON → 逐项校验 configId 在 `t_config` 存在且属于该用户（`__storyRuntimeSettings` 等非数字值跳过校验）→ 失效条目剔除 → 覆写 `t_setting.languageModel`（upsert 模式照抄 `configurationModel.ts` L94-120）→ 返回 `{ appliedCount, missingSlots }` |
| `delModelGroup.ts` | `{ id }` | 删除（`where userId` 校验归属） |

### 3. 注册 `src/router.ts`
- 尾部追加 import（route185+）与 `app.use("/setting/xxx", routeN)`
- 先用 `git log -p -- src/router.ts` 确认 `@routes-hash` 头是否有生成脚本维护；若无脚本则只追加路由、不动哈希头

## 前端（Toonflow-game-web）

### 4. 类型 + API 层
- `src/types/toonflow.ts`：加 `ModelGroupItem { id, name, remark, createTime, updateTime }`
- `src/api/toonflow.ts`：`ToonflowApi` 加 5 个 POST 方法（对应上面 5 个 endpoint）

### 5. store（`src/composables/useToonflowStore.ts`）
- state 加 `settingsModelGroups: ModelGroupItem[]`、`settingsActiveModelGroupId: number | null`（当前应用的组，「保存」按钮默认覆盖对象）
- `ensureSettingsPanelData()`（L5068）的 `Promise.all` 加拉取 `getModelGroups`
- 新 action：`saveSettingsModelGroup`（新建/覆盖，成功后刷新组列表）、`applySettingsModelGroup`（应用后 `ensureSettingsPanelData(true)` 强刷 + `state.notice` 提示「已切换到模型组 X」，missingSlots 非空时附加「N 个槽位未恢复（原配置已删除）」）、`updateSettingsModelGroupInfo`、`deleteSettingsModelGroup`（确认后删除）

### 6. 新组件 `src/components/SettingsModelGroupBar.vue`
挂在 `SceneSettings.vue` 模型配置卡片标题行（L342「模型配置」标题右侧）。包含：
- **可搜索下拉**（组合框）：input 显示当前选中组名 + 聚焦展开过滤列表；keyword 多字段过滤照抄 `SettingsModelManagerDialog.vue` 的成熟模式（L210 keyword ref + L582-592 computed 过滤）；列表项 = 名称 + 备注副行 + 两个小图标（编辑=改名/备注弹窗、删除=确认删除）；选中项立即应用
- **保存按钮**（奥森字体图标 + 文字，样式用现有 `.button primary settings-solid-btn` 体系）→ 打开保存弹窗
- **保存弹窗**（手写 modal 体系照抄 `SettingsModelManagerDialog` 编辑器 L1197-1560 的 `.modal-backdrop/.modal-panel/.field` 结构，「备注」输入框写法参考 L1528-1536）：名称（必填）+ 备注（可选）；已选中组时提供「覆盖保存到组 X / 另存为新组」选择，未选中则直接新建

### 7. 样式 `src/styles.css`
`.settings-model-group-*` 前缀新类，风格对齐现有 `.input/.button/.settings-*`

## 验证

1. 后端 `yarn lint`；`yarn local` 起后端（60002），curl 走通：新建组 → 列表 → 修改某槽位配置 → 覆盖保存 → 应用组（检查 `t_setting.languageModel` 被覆写、`__storyRuntimeSettings` 保留）→ 改名 → 删除；错误路径：重名、组不存在、删除模型配置后应用（missingSlots 剔除）
2. 前端 `yarn type-check`；`yarn dev`（5175，不 build）浏览器走查全流程：保存新组（含备注）、下拉搜索、选中即切换且模型行刷新、覆盖保存、改名、删除、切换后 notice 提示
3. 检查 `t_modelGroup` 数据与 userId 隔离（另一个 token 看不到别人的组）