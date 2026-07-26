# 世界书 阶段1：条目存储 + CRUD + 编辑弹窗

## 目标
在故事创建/编辑页加「世界书」按钮，弹出 modal 显示条目列表，支持增删改查 + 导入导出 JSON。条目用方案1 全集字段，存独立表 t_worldBook。

**阶段1 只做"容器+录入"，不做注入引擎**（注入是阶段2，等 P1 跑完看需求再说）。

## 设计决策（已与用户确认）
1. **存储**：独立表 `t_worldBook`，每条目一行，外键 worldId 关联 t_storyWorld。不挂 settings。
2. **字段**：方案1 全集--id/title/category/keys/constant/probability/order/group/selectiveLogic/selectiveKeys/content。
3. **UI**：弹窗 modal，在 SceneCreate.vue 内，照现有"角色导入弹窗"模式。点[编辑]内联展开表单。
4. **导入导出**：兼容 worldbook.json 格式（42 条示例能直接导入）。

## 字段定义（t_worldBook 列）
| 列 | 类型 | 说明 |
|---|---|---|
| id | integer PK auto | 自增主键 |
| worldId | integer | 外键 t_storyWorld.id |
| entryId | text | 条目逻辑id（如 "entry_000_constants"，导入时带，本地新建留空） |
| title | text | 标题 |
| category | text | constants/locations/characters/factions/items/events/world/random |
| keys | text | JSON 数组字符串，如 `["铁匠铺","老王"]` |
| constant | integer | 0/1 布尔 |
| probability | integer | 0-100，默认 100 |
| order | integer | 注入排序，默认 100 |
| group | text | 互斥组，可空 |
| selectiveLogic | text | AND ANY/AND ALL/NOT ANY/NOT ALL，可空 |
| selectiveKeys | text | JSON 数组字符串，可空 |
| content | text | 注入正文 |
| sort | integer | 列表排序，默认 0 |
| createTime | integer | 时间戳 |
| updateTime | integer | 时间戳 |

## 改动清单

### 后端（toonflow-game-app）

#### 1. 建表 `src/lib/initDB.ts`
在 tables 数组（t_storyWorld 后，~1672 行）加 t_worldBook 定义，照 t_storyChapter 范式：
```typescript
{
  name: "t_worldBook",
  builder: (table) => {
    table.increments("id").primary();  // 自增主键
    table.integer("worldId");
    table.text("entryId");
    table.text("title");
    table.text("category");
    table.text("keys");           // JSON 数组字符串
    table.integer("constant");
    table.integer("probability");
    table.integer("order");
    table.text("group");
    table.text("selectiveLogic");
    table.text("selectiveKeys");  // JSON 数组字符串
    table.text("content");
    table.integer("sort");
    table.integer("createTime");
    table.integer("updateTime");
  },
},
```

#### 2. 增量建表 `src/lib/fixDB.ts`
在 ensureTable 调用区（~505 行后）加：
```typescript
await ensureTable("t_worldBook", (table) => {
  table.increments("id").primary();
  table.integer("worldId");
  table.text("entryId");
  table.text("title");
  table.text("category");
  table.text("keys");
  table.integer("constant");
  table.integer("probability");
  table.integer("order");
  table.text("group");
  table.text("selectiveLogic");
  table.text("selectiveKeys");
  table.text("content");
  table.integer("sort");
  table.integer("createTime");
  table.integer("updateTime");
});
```
两处都加是为了：initDB 全新库建表 + fixDB 老库增量补表。

#### 3. 归一化工具 `src/lib/gameEngine.ts`
新增 `normalizeWorldBookEntry(raw)` / `normalizeWorldBookOutput(rows)`：
- keys/selectiveKeys：parseJsonSafe 成 string[]，null 安全
- constant：转 0/1 -> boolean
- probability/order/sort：转 number，默认 100/100/0
- content/title/category：trim string
- 输出给前端的条目对象（布尔/数组/数字都归一化好）

#### 4. CRUD 路由（4 个独立文件，照现有一职责一文件风格）
现有 46 个路由都是单文件单职责（getChapter/saveChapter/deleteChapter 分开），世界书照此风格：
- `src/routes/game/listWorldBook.ts` -- POST { worldId } -> 条目数组
- `src/routes/game/saveWorldBookEntry.ts` -- POST { worldId, entry } -> 新建或更新（entry 有 id 更新/无 id 新建）
- `src/routes/game/deleteWorldBookEntry.ts` -- POST { id } -> 删除
- `src/routes/game/importWorldBook.ts` -- POST { worldId, entries[] } -> 批量导入（替换 or 合并）
- 导出走前端纯客户端（Blob 下载），不需后端路由

鉴权：每个路由复制 getWorld 的 `currentUserId` + worldId -> t_storyWorld -> t_project -> userId 权限链路校验。参照 importWorldRole.ts 的 `leftJoin t_project where p.userId` 写法。

#### 5. 路由注册 `src/router.ts`
加 4 行 import + 4 行 app.use，照 L199 风格。

### 前端（Toonflow-game-web）

#### 6. API 层 `src/api/toonflow.ts`
ToonflowApi 类加 4 个方法：
- `listWorldBook(worldId)` -> `WorldBookEntry[]`
- `saveWorldBookEntry(worldId, entry)` -> `WorldBookEntry`
- `deleteWorldBookEntry(id)` -> `void`
- `importWorldBook(worldId, entries)` -> `{ imported: number }`
加 `WorldBookEntry` interface（全集字段）。

#### 7. 类型 + 弹窗组件
**新建 `src/components/WorldBookDialog.vue`**（独立组件，避免 SceneCreate.vue 过大）：
- props: `open: boolean`, `worldId: number`
- emits: `close`
- 内部：
  - 条目列表（title + category 标签 + [编辑][删除]）
  - 顶部 [导入JSON][导出JSON][新增条目] 按钮
  - 点[编辑]/[新增] 内联展开编辑表单（所有全集字段，keys/content 用 textarea，selectiveLogic 用 select）
  - 导入：`<input type="file" accept=".json">` + FileReader.readAsText + JSON.parse -> 调 importWorldBook
  - 导出：取当前列表 -> JSON.stringify -> new Blob -> URL.createObjectURL -> `<a download>` 点击下载
- 照现有 modal-backdrop/modal-panel 样式

#### 8. 接入 SceneCreate.vue
- 加 `showWorldBookDialog` ref
- 在世界设定区（globalBackground 附近，~1105 行）加「世界书」按钮
- 模板末尾加 `<WorldBookDialog v-if="showWorldBookDialog" :open="..." :world-id="..." @close="..." />`

#### 9. 样式 `src/styles.css`
照 .modal-backdrop / .modal-panel 现有样式，新增世界书列表/表单专用样式（条目行、标签、编辑表单布局）。

## 数据流
```
[世界书]按钮 -> WorldBookDialog 打开
  -> onMounted: api.listWorldBook(worldId) -> 渲染列表
  -> [新增/编辑] -> 表单 -> api.saveWorldBookEntry -> 刷新列表
  -> [删除] -> api.deleteWorldBookEntry -> 刷新列表
  -> [导入] -> 选 json 文件 -> parse -> api.importWorldBook -> 刷新列表
  -> [导出] -> 取列表 -> Blob 下载 worldbook.json
```

## 关键文件清单
| 用途 | 路径 |
|---|---|
| 建表 | toonflow-game-app/src/lib/initDB.ts (~1672) |
| 增量建表 | toonflow-game-app/src/lib/fixDB.ts (~505) |
| 归一化 | toonflow-game-app/src/lib/gameEngine.ts |
| CRUD 路由 | toonflow-game-app/src/routes/game/{list,save,delete,import}WorldBook*.ts |
| 路由注册 | toonflow-game-app/src/router.ts (~199) |
| 前端 API | Toonflow-game-web/src/api/toonflow.ts |
| 弹窗组件 | Toonflow-game-web/src/components/WorldBookDialog.vue (新建) |
| 接入 | Toonflow-game-web/src/components/SceneCreate.vue (~1105) |
| 样式 | Toonflow-game-web/src/styles.css |

## 边界与零回归
- 阶段1 纯数据 CRUD，不碰编排师/记忆管理器/注入逻辑，对运行时零影响
- 老库：fixDB ensureTable 自动建表，无迁移
- 全新库：initDB 自动建表
- worldId 权限校验：通过 t_storyWorld -> t_project -> userId 链路，用户只能操作自己的世界书
- 导入兼容 worldbook.json：解析时 entryId/category/keys 等字段做容错（缺字段给默认值）

## 验证
1. `npx tsc --noEmit` 后端零新增错误（基线 21）
2. `yarn type-check` 前端零错
3. 新建故事 -> 加「世界书」按钮可见 -> 弹窗能增删改条目
4. 导入 worldbook.json 42 条 -> 列表显示 -> 导出 -> 内容一致
5. 切换故事 -> 世界书隔离（worldId 过滤）
6. 跨用户 -> 无权操作他人世界书（403）

## 风险点
- **SceneCreate.vue 已很大**（1800+行）：弹窗抽成独立 WorldBookDialog.vue 组件，避免继续膨胀
- **导入数据校验**：worldbook.json 的 entries 字段名可能和列名不完全一致（如 selectiveKeys vs selective_keys），归一化层做驼峰容错
- **世界发布时世界书要不要一起发布**：阶段1 先不处理发布快照（t_storyWorld_published 不含世界书），等阶段2 注入引擎要读世界书时再决定发布策略