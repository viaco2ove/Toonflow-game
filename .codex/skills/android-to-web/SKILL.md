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
- 第一要求界面上要一致！！！！！！不要随意发挥。拿着功能点去乱飞！！！！

## Rules
- 界面要一致，交互要一致。

## Workflow
1. 定位 Android 对应页面、ViewModel、数据模型和接口。
2. 每个安卓界面都要截图， 做好web页面后再进行截图对比
3. 画出 Vue 中对应的 route / page / component / composable / store。
4. 总体页面的一致性
5. 每个按钮样式的一致性
6. 交互一致性

# 界面check
tmp/Android-to-Web/{time}
编写 ui-checklist-{time}.md
逐一比对界面差异
模版：[ui-checklist-2026-0324-0322.review.md](references/template/ui-checklist-2026-0324-0322.review.md)[ui-checklist-2026-0324-0322.review.md](references/ui-checklist-2026-0324-0322.review.md)