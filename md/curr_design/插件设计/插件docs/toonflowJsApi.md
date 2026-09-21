# ToonflowJS API

> 参考 [TavoJS API](https://docs.tavoai.dev/cn/guides/javascript-api/) 设计，面向 Toonflow 互动故事游戏的 JavaScript 插件接口。

---

## 一、概述

ToonflowJS API 是面向插件开发者提供的一套 JavaScript 接口，允许插件在前端运行时中读写游戏状态、注入命令面板、挂载小游戏 UI。

### 1.1 运行环境

| 环境 | 说明 |
|------|------|
| **minigame iframe** | 小游戏插件的入口脚本运行在独立 iframe 中，可使用完整 `window` API |
| **sidebar 命令脚本** | 侧边栏插件脚本运行在主页面沙箱中，仅限调用 `toonflow.*` 接口 |

> ⚠️ **与 Tavo 的主要区别**：Toonflow 是互动故事引擎，不是聊天应用。角色/预设/世界书等 Tavo 特有概念对应 Toonflow 的 World/Chapter/Session。

### 1.2 全局对象

插件入口脚本可访问以下全局对象：

| 对象 | 说明 |
|------|------|
| `toonflow` | 插件上下文主对象，提供状态、命令、UI 能力 |
| `toon` | `toonflow` 的别名，与 TavoJS 命名对齐，兼容迁移 |
| `plugin` | 当前插件元信息 `{ id, name, version }` |
| `console` | 标准 console（minigame 环境），sidebar 环境受限 |

### 1.3 生命周期钩子

```js
// 入口脚本必须导出以下函数，Tovo runtime 会自动调用

function onLoad(ctx) {
  // 插件加载时调用，ctx = toonflow 实例
  // 返回插件实例对象，会在 onUnload 时调用 .cleanup()
}

function onUnload(instance) {
  // 插件卸载时调用，执行清理
  if (instance?.cleanup) instance.cleanup()
}
```

**示例**（minigame 插件）：

```js
class MyGame {
  constructor(ctx) { this.ctx = ctx }
  render() { return '<h1>Hello Toonflow!</h1>' }
  cleanup() { /* 清理资源 */ }
}

function onLoad(ctx) {
  return new MyGame(ctx)
}

function onUnload(instance) {
  if (instance?.cleanup) instance.cleanup()
}
```

---

## 二、toonflow / toon 对象

### 2.1 变量（gameState）

类似 TavoJS 的 `tavo.get/set`，但作用域基于 Toonflow 游戏状态。

#### 获取变量

```js
toonflow.gameState.get(<key>)
toonflow.gameState.get(<key>, <defaultValue>)
toon.gameState.get('hp')            // 获取 hp，undefined 则返回 undefined
toon.gameState.get('hp', 100)       // 获取 hp，不存在则返回 100
toon.gameState.get('inventory.sword') // 支持点号路径（待实现）
```

#### 设置变量

```js
toonflow.gameState.set(<key>, <value>)
toon.gameState.set('hp', 80)                    // 设置 hp = 80
toon.gameState.set('player', { hp: 80, mp: 50 }) // 设置对象
```

#### 更新变量（部分更新）

```js
toonflow.gameState.update(<key>, <partialValue>)
toon.gameState.update('player', { hp: 70 })      // player.hp → 70，mp 保留
```

#### 删除变量

```js
toonflow.gameState.unset(<key>)
toon.gameState.unset('temp_flag')               // 删除变量
```

#### 变量路径（待实现）

```js
// 未来版本支持路径形式
toon.gameState.get('player.hp')    // 获取 player 对象的 hp 属性
toon.gameState.set('player.hp', 50) // 设置 player.hp
```

> **变量持久化**：游戏存档时会一并保存，重启后可通过 `get` 恢复。

---

### 2.2 会话信息

#### 获取当前游戏状态

```js
await toonflow.session.current()
```

返回：

```js
{
  sessionId: 'sess_xxx',     // 会话 ID
  worldId: 'world_xxx',      // 世界 ID
  chapterId: 'ch_xxx',       // 当前章节 ID
  phaseId: 'phase_xxx',      // 当前阶段 ID
  eventIndex: 0,             // 当前事件索引
  worldName: '奇幻大陆',     // 世界名称
  chapterName: '第一章',     // 章节名称
  userName: 'V',             // 用户名称
  // ... 其他上下文字段
}
```

#### 获取当前用户输入（最后一条）

```js
await toonflow.session.lastInput()
```

返回用户最近一次发送的文本或选择的命令。

---

### 2.3 消息（待实现）

> 📌 **状态**：消息 API 正在规划中。

```js
// 查找消息（规划中）
await toonflow.message.find(<indexRange>, <filter>)
await toonflow.message.get(<messageId>)
await toonflow.message.count()

// 追加消息（规划中）
await toonflow.message.append({ content: '...', role: 'assistant' })

// 更新消息（规划中）
await toonflow.message.update({ id: 123, content: '新内容' })

// 删除消息（规划中）
await toonflow.message.delete(<messageId>)
```

---

### 2.4 命令（Command）

向 Toonflow 命令面板注入自定义命令项。

#### 获取命令列表

```js
await toonflow.command.list()
```

返回当前所有可用命令。

#### 触发命令（自动执行）

```js
toonflow.command.trigger(<commandId>)
toonflow.command.trigger('guess-number-start')
```

触发后，Toonflow 会执行对应插件的 minigame 或 action。

#### 注册自定义命令（minigame 插件自动注册）

minigame 插件的 `manifest.json` 中声明 `contributes.minigame` 后，系统会自动注册对应命令，无需手动调用 `register`。

---

### 2.5 小游戏（Minigame）

小游戏是 Toonflow 插件的核心能力，通过 iframe 嵌入游戏界面。

#### 获取小游戏配置

```js
toonflow.minigame.getConfig()
```

返回当前小游戏的 manifest 配置：

```js
{
  type: 'puzzle',
  title: '猜数字',
  width: 320,
  height: 480,
  entry: 'ui/game.html',
  fullscreen: false
}
```

#### 通知游戏结束

```js
toonflow.minigame.done(<result>)
toonflow.minigame.done({ score: 85, won: true, message: '恭喜通关！' })
```

调用后，iframe 关闭，结果通过 `toonflow.gameState.update` 写入状态，并触发游戏继续。

#### 通知游戏中途退出

```js
toonflow.minigame.abort()
```

关闭 iframe，放弃当前小游戏，不写入结果。

#### 切换全屏模式

```js
toonflow.minigame.setFullscreen(<enabled>)
toonflow.minigame.setFullscreen(true)   // 进入全屏，iframe 撑满视口
toonflow.minigame.setFullscreen(false)  // 退出全屏，恢复面板默认尺寸
```

插件启动时（`manifest.json` 的 `fullscreen: true`）是静态配置，此 API 允许运行时**动态切换**。

底层原理：向父窗口 postMessage `{ type: "tf_plugin_fullscreen", fullscreen: <bool> }`，前端宿主接收后给 `<section class="play-plugin-minigame-panel--fullscreen">` 挂 class，CSS 将面板升级为 `position: fixed; inset: 0; z-index: 9999` 覆盖全屏，iframe 随之撑满。

退出全屏：插件再次调用 `setFullscreen(false)`，或用户点击面板右上角 ✕ 按钮。

---

### 2.6 资产（Assets）

获取插件内置资源的访问路径。

#### 获取资源 URL

```js
toonflow.assets.get(<path>)
toonflow.assets.get('ui/game.html')     // 返回插件资源路径
toonflow.assets.get('assets/icon.png')  // 返回图标路径
```

#### 获取全部资源映射（待实现）

```js
toonflow.assets.list()
```

返回插件所有资源文件路径列表。

---

### 2.7 设置（Settings）

访问用户为插件配置的个人设置。

#### 获取设置项

```js
toonflow.settings.get(<key>)
toonflow.settings.get(<key>, <default>)
toonflow.settings.get('difficulty', 'normal') // 获取难度，未设置则默认 'normal'
```

#### 获取全部设置

```js
toonflow.settings.all()
```

返回用户设置对象 `Record<string, any>`。

---

### 2.8 工具（Utils）

#### Toast 提示

```js
toonflow.utils.toast(<message>)
toonflow.utils.toast('操作成功！', 'success')  // 类型：info | success | error
```

#### 打开外部链接

```js
toonflow.utils.openUrl(<url>)
toonflow.utils.openUrl('https://example.com')
```

---

## 三、插件 manifest 中 contributes 的前端字段

### 3.1 minigame

```json
{
  "contributes": {
    "minigame": {
      "type": "guess_number",
      "title": "猜数字",
      "width": 320,
      "height": 400,
      "fullscreen": false,
      "entry": "ui/game.html"
    }
  }
}
```

- `type`：小游戏类型标识，任意字符串
- `title`：在命令面板和标题栏显示的名称
- `width` / `height`：iframe 尺寸（px）
- `fullscreen`：是否全屏显示
- `entry`：小游戏 HTML 入口路径（相对于插件根目录）

### 3.2 sidebar

```json
{
  "contributes": {
    "sidebar": [
      {
        "id": "my-game-start",
        "label": "🎮 开始游戏",
        "icon": "gamepad"
      }
    ]
  }
}
```

侧边栏项会注入到游戏界面的命令面板中。点击后：
- 若插件声明了 `minigame`：打开 minigame iframe 容器
- 若插件声明了 `action`：执行对应 action（待实现）

### 3.3 panel（待实现）

```json
{
  "contributes": {
    "panel": {
      "src": "ui/panel.html",
      "mount": "#app-sidebar"
    }
  }
}
```

通过 `mount` 选择器挂载 HTML 面板到页面指定位置。

---

## 四、Toonflow 与 TavoJS 能力对照

| TavoJS 模块 | ToonflowJS 等价 | 状态 |
|------------|----------------|------|
| `tavo.get/set/update/unset` | `toonflow.gameState.*` | ✅ 已实现 |
| `tavo.message.*` | `toonflow.message.*` | 🔜 规划中 |
| `tavo.chat.current/update` | `toonflow.session.current` | ✅ 已实现 |
| `tavo.character.*` | — | 🔜 规划中（角色卡管理） |
| `tavo.persona.*` | — | ❌ 不适用（Toonflow 无用户身份卡） |
| `tavo.preset.*` | — | ❌ 不适用（Toonflow 使用 Chapter） |
| `tavo.lorebook.*` | — | ❌ 不适用（Toonflow 使用 World） |
| `tavo.memory.*` | — | 🔜 规划中 |
| `tavo.generate` | `toonflow.ai.generate` | 🔜 规划中 |
| `tavo.image.generate` | `toonflow.image.generate` | 🔜 规划中 |
| `tavo.tts.play` | `toonflow.voice.play` | 🔜 规划中 |
| `tavo.file.*` | `toonflow.assets.*` | 🔜 规划中 |
| `tavo.input.*` | `toonflow.command.*` | ✅ 部分实现 |
| `tavo.utils.*` | `toonflow.utils.*` | ✅ 已实现 |
| `tavo.theme.*` | — | ❌ 不适用 |
| `tavo.regex.*` | — | ❌ 不适用 |
| `tavo.app.*` | `plugin` 全局对象 | ✅ 已实现 |

---

## 五、minigame 插件完整示例

### 5.1 目录结构

```
toonflow-field-survival/
├── manifest.json
├── entry.js
└── ui/
    └── game.html
```

### 5.2 manifest.json

```json
{
  "specVersion": 1,
  "id": "com.toonflow.minigame-field-survival",
  "name": { "fallback": "野外生存" },
  "version": "1.0.0",
  "author": "Toonflow",
  "description": { "fallback": "荒野求生小游戏，测试你的生存技能！" },
  "entry": "entry.js",
  "permissions": ["game_state", "ui"],
  "contributes": {
    "minigame": {
      "type": "survival",
      "title": "野外生存",
      "width": 400,
      "height": 600,
      "fullscreen": false,       // 静态默认值；插件运行时可通过 toonflow.minigame.setFullscreen(true) 动态切换全屏
      "entry": "ui/game.html"
    },
    "sidebar": [
      {
        "id": "field-survival-start",
        "label": "🎮 野外生存",
        "icon": "gamepad"
      }
    ]
  }
}
```

### 5.3 entry.js

```js
class FieldSurvivalGame {
  constructor(ctx) {
    this.ctx = ctx
    this.state = {
      hp: 100,
      hunger: 100,
      day: 1,
      items: []
    }
  }

  render() {
    return `
      <div class="survival-game">
        <h3>🏕️ 野外生存 - 第 ${this.state.day} 天</h3>
        <div class="stats">
          <div>❤️ HP: ${this.state.hp}</div>
          <div>🍖 饥饿: ${this.state.hunger}</div>
        </div>
        <div class="actions">
          <button onclick="game.search()">🔍 搜索物资</button>
          <button onclick="game.eat()">🍎 吃东西</button>
          <button onclick="game.rest()">💤 休息</button>
          <button onclick="game.quit()">❌ 退出</button>
        </div>
        <div id="log" class="log"></div>
      </div>
    `
  }

  search() {
    const found = ['树果', '蘑菇', '石头', '树枝'][Math.floor(Math.random() * 4)]
    this.state.items.push(found)
    this.state.hunger -= 5
    this.log(`找到了 ${found}！剩余饥饿 ${this.state.hunger}`)
  }

  eat() {
    if (this.state.items.length === 0) {
      this.log('没有食物可吃！')
      return
    }
    const item = this.state.items.pop()
    this.state.hunger = Math.min(100, this.state.hunger + 20)
    this.log(`吃了 ${item}，饥饿度 +20`)
  }

  rest() {
    this.state.hp = Math.min(100, this.state.hp + 10)
    this.state.day++
    this.log(`休息了一晚，HP +10，进入第 ${this.state.day} 天`)
  }

  quit() {
    this.ctx.minigame.done({
      survived: this.state.day,
      score: this.state.hp + this.state.hunger + this.state.items.length * 10
    })
  }

  log(msg) {
    const el = document.getElementById('log')
    if (el) el.innerHTML += `<p>${msg}</p>`
  }

  cleanup() {
    // 清理定时器、事件监听器等
  }
}

function onLoad(ctx) {
  return new FieldSurvivalGame(ctx)
}

function onUnload(instance) {
  if (instance?.cleanup) instance.cleanup()
}
```

### 5.4 ui/game.html

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: sans-serif; padding: 16px; background: #1a1a2e; color: #fff; }
    .survival-game { text-align: center; }
    .stats { font-size: 18px; margin: 16px 0; }
    .actions button { display: block; width: 100%; padding: 12px; margin: 8px 0;
      background: #4a4a8a; color: #fff; border: none; border-radius: 8px; cursor: pointer; }
    .actions button:hover { background: #6a6aaa; }
    .log { height: 120px; overflow-y: auto; text-align: left; margin-top: 16px;
      padding: 8px; background: #0f0f1e; border-radius: 8px; font-size: 14px; }
    .log p { margin: 4px 0; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script>
    // 等待 toonflow 全局对象就绪
    window.addEventListener('DOMContentLoaded', async () => {
      const config = toonflow.minigame.getConfig()
      document.title = config.title || '小游戏'

      // 等待 toonflow.minigame.done 可用
      let ready = false
      const check = () => {
        if (toonflow && toonflow.minigame && typeof toonflow.minigame.done === 'function') {
          initGame()
        } else {
          setTimeout(check, 100)
        }
      }
      check()

      function initGame() {
        // 模拟游戏逻辑
        const app = document.getElementById('app')
        app.innerHTML = `
          <h3>🏕️ 野外生存</h3>
          <p>点击下方按钮开始生存挑战！</p>
          <button onclick="toonflow.minigame.done({score: 100, won: true})">完成游戏</button>
        `
      }
    })
  </script>
</body>
</html>
```

---

## 六、常见问题

### Q: 如何获取当前游戏的状态（HP、金币等）？

```js
const hp = toonflow.gameState.get('hp', 100)
```

### Q: 小游戏完成后如何通知主游戏？

```js
toonflow.minigame.done({ score: 85, won: true })
```

### Q: 插件在哪个环境运行？

- **minigame**：独立 iframe，可使用完整 `window` API
- **sidebar 命令**：主页面沙箱，仅通过 `toonflow` 对象通信

### Q: 如何访问插件的静态资源？

```js
const imgUrl = toonflow.assets.get('assets/icon.png')
```

### Q: 变量会不会在游戏存档后丢失？

不会。`toonflow.gameState` 的数据会随游戏会话一起持久化。
