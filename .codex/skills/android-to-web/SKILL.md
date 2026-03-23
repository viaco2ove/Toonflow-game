---
name: android-to-web
description: Use when converting Android app screens, flows, state, and business logic into a Vue 3 web app, especially when the goal is to preserve real functionality, persistence, data isolation, and page/field/behavior parity instead of producing a demo UI.
---

# Android to Web
根据用户的要求就行Android 到web 的同步。
要求级别:
- 全部界面一比一复制
- 部分界面的或某些功能的同步
- 最新修改功能的同步
## Goal
把 Android 项目的真实行为，按页面、状态、数据流和接口迁移到 Vue 3。
优先做功能等价，不做空壳演示。

## When to use
- 用户要求“把 Android 项目内容抄到 Vue / web”
- 用户明确要求“不要 demo”“不要大杂烩”“按真实功能做”
- 需要把 Android 页面、弹窗、表单、调试态、持久化、资源隔离迁移到 Vue
- 需要对齐账号资源、故事资源、草稿、已发布、调试缓存、音色、生图、头像、封面等业务

## Rules
- 先找 Android 源实现，再找 Vue 的页面、路由、store、API 和组件对应物。
- 一次只迁移一个明确能力，不要把所有逻辑塞进单文件。
- 先对齐状态流，再对齐样式。
- 保持数据隔离：账号资源、故事资源、草稿、已发布、调试缓存不得混用。
- 复用已有后端接口；没有接口时，先设计最小前端抽象，再补最小必要 API。
- 图片、音色、上传必须区分持久化路径、临时预览和 AI 生成结果。
- 不要用假数据填充真实页面，除非明确标注为占位且后续会替换。
- 任何时候都不要为了“快”把所有页面塞进一个大组件。
- 任何时候都不要把缓存态、草稿态、发布态混成一个状态字段。
- 任何时候都不要把账号头像、角色头像、封面图、章节背景图复用成同一个资源槽。

## Workflow
1. 定位 Android 对应页面、ViewModel、数据模型和接口。
2. 画出 Vue 中对应的 route / page / component / composable / store。
3. 迁移数据结构，保证字段、默认值、保存时机一致。
4. 先实现保存、读取、切换、发布、回收等真实流程，再补样式。
5. 用真实用例验证：新建、编辑、发布、回收、重进、切换账号、重装后回读。
6. 每个页面都要给出 Android 源位置、Vue 目标文件、字段映射和行为差异。
7. 如果一个页面无法一次迁完，先拆成最小可运行模块，再继续补齐，不要硬写完整大壳。

## Mandatory checks
- 草稿和已发布必须分开。
- 账号头像和故事内角色头像必须分开。
- AI 生图只有一个入口：无参考图是文生图，有参考图是图生图。
- 章节编辑、调试、进入游戏必须按 Android 业务逻辑一致。
- 页面不能只剩静态 demo 卡片。
- 不能用单文件把全部业务逻辑糊在一起。
- 不能把临时缓存当作持久化结果。
- 不能在没有对应 Android 依据时臆造新页面、新按钮、新状态。

## References
- 需要做 Android 页面到 Vue 页面映射时，先读 `references/android_vue_mapping.md`。
- 需要做具体资源或状态迁移时，按需读对应参考文件。
- 需要逐页验收迁移质量时，先读 `references/parity_checklist.md`。
- 迁移 Toonflow 这套项目时，先读 `references/toonflow_screen_map.md`。
- 需要控制输出形态和交付内容时，先读 `references/output_contract.md`。
- 需要开始实际迁移时，按 `references/migration_template.md` 的结构输出。
- 需要排除错误做法时，先读 `references/forbidden_patterns.md`。
- 需要逐页执行检查时，先读 `references/page_checklist.md`。

# 界面check
tmp/Android-to-Web
编写 ui-checklist-{time}.md
逐一比对界面差异