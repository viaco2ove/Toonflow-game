# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

Toonflow Game 是一个 AI 故事游戏后端，使用 Node.js + Express + TypeScript 开发。

## 常用命令

```bash
yarn dev          # 开发模式运行（热重载）
yarn lint         # TypeScript 类型检查 (tsc --noEmit)
yarn build        # 编译到 build/
yarn test         # 运行编译后的应用 (node build/app.js)
yarn dist:win     # 打包 Windows 桌面应用
```

## 项目结构

```
src/
├── routes/           # API 路由，按领域组织
│   ├── game/          # 核心游戏 API
│   │   ├── orchestration/    # 编排逻辑（调试/会话）
│   │   ├── streamlines.ts  # 流式台词生成
│   │   ├── debugRuntimeShared.ts  # 调试回溯共享
│   │   └── minigame.ts     # 小游戏编排接口
│   └── voice/, video/, storyboard/...
├── modules/game-runtime/    # 核心游戏引擎
│   ├── engines/
│   │   ├── NarrativeOrchestrator.ts   # 叙事编排器（核心）
│   │   ├── MiniGameController.ts      # 小游戏控制器（战斗/挖矿/炼药等）
│   │   ├── ChapterProgressEngine.ts   # 章节进度引擎
│   │   └── SpeakerRouteEngine.ts     # 发言路由引擎
│   └── services/
│       ├── SessionService.ts          # 会话服务
│       ├── ChapterRuntimeService.ts    # 章节运行服务
│       └── MiniGameIntentService.ts    # 小游戏意图识别
├── lib/             # 游戏引擎核心函数
├── utils/          # 工具函数
└── middleware/     # 中间件
```

## 核心架构

### 游戏模式

1. **调试模式 (debugMode)**: 章节调试时使用，无 sessionId，走 `/orchestration` → `/streamlines` 流程
2. **会话模式 (session)**: 正式游玩时使用，有 sessionId，走 `/game/addMessage` →编排→ `/streamlines` 流程

### 小游戏系统

小游戏（挖矿/战斗/炼药/钓鱼等）由 `MiniGameController.ts` 管理，通过 `handleMiniGameTurn()` 拦截玩家输入。小游戏结果通过 `pendingNarrativePlan` 走编排通道生成旁白台词。

### 回溯机制

调试模式回溯使用 `saveDebugRevisitPoint()` 保存到临时文件，会话模式回溯使用 `persistSessionMessageRevisitData()` 保存到数据库 `t_sessionMessage.revisitData` 字段。

### 关键流程

```
玩家输入 → orchestrateDebug/addMessage
  → handleMiniGameTurn (小游戏拦截)
  → runNarrativePlan / applyDebugUserMessageProgress (章节判定)
  → 返回 plan
  → streamlines 生成具体台词 → saveDebugRevisitPoint
```

## 代码规范

- 文件命名: camelCase (如 `getVideoConfigs.ts`)
- 函数/变量: camelCase
- 类型/接口: PascalCase
- 导入使用 `@/` 别名指向 `src/`
- 严格模式 TypeScript (`strict: true`)
- 每个函数需添加注释说明用途
- 复杂代码行需添加注释

## 不允许修改的文件

- 含有 `@no_modify` 标记的文件
- `scripts/web/index.html` (构建后的文件，不允许直接修改)
- `review_xxx.md` 文件（用户验证文件）

# 系统环境配置
[system.yml](system/system.yml)

## 前端开发

前端代码在 `Toonflow-game-web` 仓库，开发时直接运行 `yarn dev` 即可查看效果，不需要在当前仓库执行 `yarn build`。

## 数据库

- 开发使用 `db.sqlite` (已 gitignore)
- 相关表: `t_gameSession`, `t_sessionMessage`, `t_storyWorld`, `t_storyChapter`

## 技能要求
.claude/mmx.conf 
当 `mmx_enable=true` 时可用，使用 MiniMax MMX CLI（mmx） 实现多种 AI 能力。
其中特别是图像理解能力

## output-styles
你的行为要符合设置的output-styles

## 处理问题的方式
- 表查询出错的第一件事应该是去看看这个表的结构
- 看到一个报错或者问题应该去看看根源问题是什么。而不是暴力解决

## 一个非常重点的事情-ai agent
这个项目实际是更多是个ai agent 项目，所以尽量不要写硬编码。
用ai agent 去实现各种功能！！！！