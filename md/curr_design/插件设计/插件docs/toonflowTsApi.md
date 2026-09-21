# Toonflow TS API

> 参考 [TavoJS API](https://docs.tavoai.dev/cn/guides/javascript-api/) 设计，面向 Toonflow 互动故事游戏的后端 Python 插件接口。

---

## 一、概述

Toonflow TS API 是 Toonflow 插件系统的后端 TypeScript API，供插件的 `entry.ts` 使用。每个插件的 `entry.py` 提供游戏逻辑、数据处理、AI 能力扩展等功能，与前端 minigame iframe 协同工作。

### 1.1 入口文件约定

插件根目录下必须有 `entry.ts`（编译为 `entry.js`），其中定义以下**可选**的钩子函数：

| 钩子函数 | 说明 | 调用时机 |
|---------|------|---------|
| `on_install(plugin_id, version)` | 安装插件时调用 | 用户安装插件后执行一次 |
| `on_enable(plugin_id, version)` | 启用插件时调用 | 用户开启插件时执行 |
| `on_disable(plugin_id)` | 禁用插件时调用 | 用户关闭插件时执行 |
| `handle_action(action, params, state, context)` | **核心入口**，处理前端插件的请求 | 每次插件操作时调用 |

### 1.2 handle_action 签名

```python
async def handle_action(
    action: str,      # 操作类型，如 'init' / 'attack' / 'end_game'
    params: Dict,     # 前端传入的参数
    state: Dict,      # 当前游戏会话状态（session 级别）
    context: Dict     # 执行上下文（session_id, user_id, plugin_id 等）
) -> Dict:
```

**返回值规范**：

```python
// 成功
return { code: 0, message: "ok", state: newState, response: "...", actions: ["..."] }

// 失败
return { code: 1, message: "错误信息", state }
```

> ⚠️ **注意**：`code` 字段必须为 `0` 表示成功，其他值为失败。

---

## 二、context 参数详解

`handle_action` 的 `context` 参数包含完整的执行上下文：

```python
{
    'session_id': 'sess_abc123',     # 当前游戏会话 ID
    'user_id': 1,                     # 当前用户 ID（数字）
    'plugin_id': 'com.toonflow.xxx', # 插件唯一标识
    'plugin_version': '1.0.0',       # 插件版本
    'chapter_id': 'ch_001',          # 当前章节 ID
    'world_id': 'world_001',         # 当前世界 ID
}
```

**示例**：

```typescript
const userId = context['user_id'] ?? 1;
const sessionId = context['session_id'] ?? '';
const pluginId = context['pluginId'];
const pluginDir = context['pluginDir'];
const manifest = context['manifest'];
```

---

## 三、state 参数详解

`state` 是插件在当前会话中的持久化状态字典，**由系统自动管理**。插件可以在 `state` 中存储任意数据，下次调用时会自动恢复。

```typescript
if (action === 'init') {
  // 初始化游戏状态
  state['hp'] = 100;
  state['score'] = 0;
  state['enemies'] = [];
  return { code: 0, message: 'ok', state };
} else if (action === 'attack') {
  // 读取状态
  const hp = (state['hp'] as number) ?? 100;
  // 修改状态
  state['hp'] = hp - 10;
  // 返回结果
  return { code: 0, message: 'ok', state, response: `攻击！HP 变为 ${state['hp']}` };
}
```

> 📌 **状态持久化**：修改 `state` 字典后，系统会自动保存。下一次 `handle_action` 调用时，会传入上次修改后的 `state`。

---

## 四、生命周期钩子

### 4.1 生命周期钩子（已废弃）

> ⚠️ `on_install` / `on_enable` / `on_disable` 钩子在当前 Toonflow 实现中**不再调用**。插件激活流程由 `MiniGameController.detectGameTrigger` 统一处理。

如需在插件加载时做初始化，请直接在 `handle_action('init')` 中处理。

---

## 五、插件开发规范

### 5.1 标准目录结构

```
my-plugin-1.0.0.tpg (zip 压缩包)
├── manifest.json       # 插件元数据（必须）
├── entry.js            # 前端入口（minigame 必须）
├── entry.ts            # 后端入口（插件小游戏必须）
└── ui/
    └── game.html       # 小游戏 HTML（iframe 入口）
```

### 5.2 entry.py 编写模板

```python
# entry.ts - 插件后端入口
// TypeScript 版本，编译为 entry.js 后由 PluginExecutor 加载

interface PluginGameContext {
  pluginId: string;
  pluginDir: string;
  manifest: any;
}

// ============================================================
# 主入口
// ============================================================

export async function handle_action(
  action: string,
  params: Record<string, unknown>,
  state: Record<string, unknown>,
  _context: PluginGameContext,
): Promise<{
  code: number;
  message: string;
  state: Record<string, unknown>;
  response?: string;
  actions?: string[];
}> {
  switch (action) {
    case 'init': {
      state['hp'] = 100;
      state['score'] = 0;
      return {
        code: 0, message: 'ok', state,
        response: '游戏开始！',
        actions: ['攻击', '防御', '寻找食物', '寻找水源'],
      };
    }
    case 'attack': {
      const hp = (state['hp'] as number) ?? 100;
      state['hp'] = hp - 10;
      return { code: 0, message: 'ok', state, response: '攻击！', actions: ['攻击', '防御'] };
    }
    default:
      return { code: 0, message: 'ok', state };
  }
}
```

---

## 六、完整插件示例：野外生存

### 6.1 entry.py 核心结构

> 完整代码见 `toonflow-game-plugins/plugins/toonflow-field-survival/entry.ts`

```typescript
// handle_action 签名
export async function handle_action(
  action: string,
  params: Record<string, unknown>,
  state: Record<string, unknown>,
  _context: PluginGameContext,
): Promise<{
  code: number;
  message: string;
  state: Record<string, unknown>;
  response?: string;
  actions?: string[];
}> {
  switch (action) {
    case 'init':   // 初始化
    case 'find_food':  // 寻找食物
    case 'find_water': // 寻找水源
    case 'search':     // 搜索周围
    case 'attack':     // 攻击
    case 'defend':     // 防御
    case 'exit':       // 退出
      return { code: 0, message: 'ok', state, response: '...', actions: ['...'] };
  }
}
```

### 6.2 action 处理示例

```typescript
case 'init': {
  const fresh = emptyState();
  fresh.wave = 1;
  fresh.enemies = buildEnemies(1);
  fresh.events.push(`第 1 波来袭！出现了 ${fresh.enemies.length} 只野兽！`);
  fresh.score += 10;
  return {
    code: 0,
    message: 'ok',
    state: fresh,
    response: `野外生存开始！你有 100 点生命值。野兽出现了！`,
    actions: ['寻找食物', '寻找水源', '搜索周围', '攻击', '防御'],
  };
}

case 'attack': {
  tickSurvival(s);
  const aliveEnemies = s.enemies.filter(e => e.hp > 0);
  const enemy = aliveEnemies[0];
  const myDmg = 15 + Math.floor(Math.random() * 10);
  enemy.hp -= myDmg;
  s.events.push(`对 ${enemy.name} 造成 ${myDmg} 点伤害！`);
  s.score += enemy.hp <= 0 ? 20 : 5;
  // 敌人反击...
  return { code: 0, message: 'ok', state: s, response: s.events[s.events.length - 1], actions: ['...'] };
}
```

### 6.3 奖励发放逻辑

```typescript
// 野外生存状态更新逻辑（TS 实现）
function tickSurvival(state: FieldSurvivalState): void {
  state.hunger = clamp(state.hunger - 3, 0, 100);
  state.thirst = clamp(state.thirst - 5, 0, 100);
  if (state.hunger === 0 || state.thirst === 0) {
    state.hp = clamp(state.hp - 10, 0, 100);
  }
  if (state.hp <= 0) state.alive = false;
}

function buildEnemies(wave: number): Enemy[] {
  const count = Math.min(1 + Math.floor(wave / 2), 4);
  return Array.from({ length: count }, (_, i) => ({
    id: `enemy_${wave}_${i}`,
    name: wave >= 3 && i === 0 ? '荒野巨兽' : `野兽 ${i + 1}`,
    hp: 30 + wave * 10,
    maxHp: 30 + wave * 10,
    attack: 5 + wave * 3,
    type: wave >= 3 && i === 0 ? 'boss' : 'beast',
  }));
}
```

---

## 七、前后端交互协议

### 7.1 前端 → 后端

前端 minigame 通过 `fetch` 调用后端 API：

```javascript
// 前端发起请求（通过后端 MiniGameController 路由）
const response = await fetch('/api/miniGame/action', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    pluginId: 'com.toonflow.minigame-field-survival',
    action: 'init',
    params: {},
    sessionId: currentSessionId
  })
})
const result = await response.json()
// result = { code: 0, state: { hp: 100, ... }, response: '野外生存开始！', actions: ['寻找食物', ...] }
```

### 7.2 后端返回格式

```typescript
// 成功
{ code: 0, message: 'ok', state: {...}, response: '...', actions: ['...'] }

// 失败
{ code: 1, message: '参数错误', state: {...} }
```

### 7.3 典型交互流程

```
iframe minigame            后端 PluginExecutor         Toonflow 引擎
     │                           │                          │
     │  POST /api/miniGame/action│                          │
     │ ──────────────────────────>│                          │
     │                           │                          │
     │                           │ executePluginAction()     │
     │                           │ import(entry.js)         │
     │                           │ handle_action()          │
     │                           │                          │
     │     {code:0, state:{...}} │                          │
     │ <──────────────────────────│                          │
     │                           │         写入 session.state│
     │                           │                          │
```

---

## 八、TypeScript / JavaScript 标准能力

Toonflow 插件后端运行在 Node.js ESM 环境中，**允许使用以下标准能力**：

| 能力 | 用途 |
|------|------|
| `Math.*` | 数学运算 |
| `Date` / `Intl` | 日期时间处理 |
| `JSON.stringify/parse` | JSON 序列化 |
| `crypto.randomUUID()` | UUID 生成 |
| `async/await` | 异步编程 |
| `console.log` | 日志（用于调试） |

**禁止使用**（安全限制）：
- `fs` / `path`（文件系统访问）
- `http` / `https` / `fetch`（直接网络请求）
- `child_process`（命令执行）
- `eval` / `new Function`（动态代码执行）

---

## 九、调试与测试

### 9.1 本地测试入口

在 `entry.ts` 中直接运行（需要 ts-node 或编译后运行）：

```typescript
// entry.ts 底部
if (typeof process !== 'undefined' && process.argv[1]?.includes('entry.ts')) {
  (async () => {
    const state = {};
    const ctx = { pluginId: 'test', pluginDir: __dirname, manifest: {} };
    const result = await handle_action('init', {}, state, ctx as any);
    console.log(JSON.stringify(result, null, 2));
  })();
}
```

编译并运行：

```bash
cd plugins/toonflow-field-survival
tsc -p tsconfig.json
node entry.js
```

### 9.2 通过后端 PluginExecutor 调试

查看已扫描的命令：

```typescript
import { getAllPluginCommands, scanPluginCommands } from '@/lib/PluginExecutor';

await scanPluginCommands(userId);
console.log('已扫描命令:', getAllPluginCommands());
```

---

## 十、常见问题

### Q: handle_action 中抛出异常会怎样？

异常会被捕获并返回 `{ code: 1, message: '...' }`，不会影响 Toonflow 主进程。

### Q: state 的大小有限制吗？

state 存储在 session 状态中，建议单个插件的 state 总大小不超过 1MB。

### Q: 如何在插件间共享数据？

插件间数据隔离，不支持直接共享。如需共享，可通过 Toonflow 游戏状态作为中转。

### Q: handle_action 是同步还是异步的？

`handle_action` 是 `async function`，支持 `await` 异步调用。PluginExecutor 会等待其返回后再处理结果。

### Q: entry.ts 和 entry.js 是什么关系？

`entry.ts` 是插件源码（TypeScript），通过 `tsc -p tsconfig.json` 编译为 `entry.js`（ESM）。后端 `PluginExecutor` 加载 `entry.js`。

### Q: entry.py 还能用吗？

已废弃。`PluginExecutor` 只加载 `entry.js`，不再调用 `entry.py`。旧插件如需迁移，请将 `entry.py` 改写为 `entry.ts`。

---

## 9. 命令注册与扫描机制

> ⚠️ 此章节内容已迁移到 `插件设计.md` §8.6。本节仅保留 FAQ。

### 设计目标

实现"插件动态注册游戏命令"机制，让插件可声明自己的 `#命令`，运行时被扫描识别并触发对应的插件 minigame，**完全避免硬编码游戏名**。

### 命令声明

插件在 `manifest.json` 的 `contributes.sidebar` 数组中声明命令：

```json
{
  "id": "com.toonflow.minigame-field-survival",
  "name": "野外生存",
  "contributes": {
    "minigame": {
      "type": "field_survival",
      "title": "野外生存",
      "width": 480,
      "height": 640,
      "entry": "ui/game.html"
    },
    "sidebar": [
      {
        "id": "field-survival-cmd",
        "label": "野外生存",
        "command": "#野外生存"
      }
    ]
  }
}
```

- `command` 必须以 `#` 开头
- 用户在聊天框输入 `#野外生存` 时会被识别为插件命令
- `minigame.entry` 是 iframe 入口（前端使用）

### 运行时扫描

后端在 `MiniGameController.detectGameTrigger()` 中：

1. 先扫内置 `RULEBOOKS` 的 `triggerTags`（如 `#战斗`、`#钓鱼`）
2. 未命中时调 `PluginExecutor.scanPluginCommands(userId)` 扫所有**已启用插件**的 `contributes.sidebar[].command`
3. 命中则返回 `{ gameType: 'plugin', pluginId, pluginType, source: 'plugin' }`

`PluginExecutor` 内部缓存 `command → PluginGameContext` 映射，避免重复扫描。

### 插件 minigame rulebook

`RULEBOOKS.plugin` 是内置的"通杀"rulebook，所有插件 minigame 共用：

```typescript
RULEBOOKS.plugin = {
  gameType: 'plugin',
  displayName: '插件小游戏',
  setup: (ctx, sessionId) => ({
    session_id: sessionId,
    game_type: 'plugin',
    plugin_id: ctx.pluginId,
    plugin_type: ctx.pluginType,
    public_state: {
      plugin_id: ctx.pluginId,
      entry: ctx.manifest.contributes.minigame.entry,
      title: ctx.manifest.contributes.minigame.title,
      width: ctx.manifest.contributes.minigame.width,
      height: ctx.manifest.contributes.minigame.height,
    },
    status: 'active',
    can_quit: true,
  }),
};
```

- `setup` 上下文从 `root._pluginManifest` 取（detectGameTrigger 写入）
- `public_state.plugin_type` 写入 manifest 的 `contributes.minigame.type`，前端用此识别插件入口

### entry.ts 标准契约

插件必须导出：

```typescript
export async function handle_action(
  action: string,           // 'init' | 'find_food' | 'attack' | ...
  params: Record<string, any>,
  state: Record<string, any>,    // 上一次返回的 state（自动持久化）
  context: { pluginId: string; pluginDir: string; manifest: any }
): Promise<{
  code: number;            // 0=成功，非0=失败
  message: string;
  state: Record<string, any>;    // 必须返回，下次调用会传入
  response?: string;       // 给前端的纯文本回复（旁白/日志）
  actions?: string[];      // 当前可选动作列表
}>;
```

### 数据流

```
用户输入 "#野外生存"
  ↓
MiniGameController.handleMiniGameTurn
  ↓
detectGameTrigger (扫插件命令 → 命中)
  ↓
RULEBOOKS.plugin.setup (写入 public_state.plugin_type = "field_survival")
  ↓
前端 ScenePlay 收到 meta.miniGame.publicState
  ↓
pluginMinigameView.iframeUrl = pluginAssetUrl(pluginId, entry)
  ↓
iframe 加载 ui/game.html
  ↓
iframe 内游戏 → postMessage → 后端 (TODO: postMessage 协议)
```

### Q: 已禁用的插件的命令还能触发吗？

不能。`scanPluginCommands` 只扫 `enabled && status === 'installed'` 的插件。禁用后命令自动失效。

### Q: 多个插件声明同一个命令怎么办？

后端**先到先得**：先扫到的插件命令会覆盖后扫到的同名命令。建议插件作者避免命令冲突。

### Q: 如何调试扫描结果？

`PluginExecutor.getAllPluginCommands()` 返回所有已扫命令数组，可用于日志输出。
