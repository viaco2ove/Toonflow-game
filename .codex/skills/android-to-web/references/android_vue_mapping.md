# Android to Vue mapping

## Core mapping
- `Activity / Fragment` -> Vue page
- `Dialog / BottomSheet` -> Vue modal, drawer, or panel
- `RecyclerView / Adapter` -> `v-for` list + item component
- `ViewModel / LiveData / StateFlow` -> `composable` + `ref`/`reactive` + store
- `SharedPreferences` / local file cache -> local storage or IndexedDB
- Android navigation / intent -> Vue router or store-driven navigation
- Retrofit / repository -> API module + repository wrapper

## Migration order
1. 数据模型
2. 持久化
3. 页面状态
4. 交互流程
5. 样式细节

## Required parity checks
- 新建故事不是改旧缓存。
- 草稿、已发布、调试态分离。
- 账号资源和故事资源分离。
- 角色头像、封面、章节背景、音色都按各自作用域存储。
- 游玩页、编辑页、调试页使用同一数据源，不各自造假数据。

## Anti-patterns
- 单个大 `App.vue` 塞所有逻辑。
- 先做好看页面，后补真实数据。
- 用静态 mock 代替持久化。
- 让同一字段同时承担账号、故事、角色三种含义。
