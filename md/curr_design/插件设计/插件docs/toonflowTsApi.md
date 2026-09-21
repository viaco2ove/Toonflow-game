# ToonflowPy API

> 参考 [TavoJS API](https://docs.tavoai.dev/cn/guides/javascript-api/) 设计，面向 Toonflow 互动故事游戏的后端 Python 插件接口。

---

## 一、概述

ToonflowPy 是 Toonflow 插件系统的后端 Python API，供插件的 `entry.py` 使用。每个插件的 `entry.py` 提供游戏逻辑、数据处理、AI 能力扩展等功能，与前端 minigame iframe 协同工作。

### 1.1 入口文件约定

插件根目录下必须有 `entry.py`，其中定义以下**可选**的钩子函数：

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
# 成功
return {'code': 0, 'data': {...}}

# 失败
return {'code': 400, 'error': '错误信息'}
# 或
return {'error': '错误信息', 'code': 500}
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

```python
async def handle_action(action, params, state, context):
    user_id = context.get('user_id')
    session_id = context.get('session_id')
    plugin_id = context.get('plugin_id')
    # 根据用户 ID 加载对应数据
```

---

## 三、state 参数详解

`state` 是插件在当前会话中的持久化状态字典，**由系统自动管理**。插件可以在 `state` 中存储任意数据，下次调用时会自动恢复。

```python
async def handle_action(action, params, state, context):
    if action == 'init':
        # 初始化游戏状态
        state['hp'] = 100
        state['score'] = 0
        state['enemies'] = []
        return {'code': 0, 'data': {'initialized': True}}

    elif action == 'attack':
        # 读取状态
        hp = state.get('hp', 100)
        # 修改状态
        state['hp'] = hp - 10
        # 返回结果
        return {'code': 0, 'data': {'hp': state['hp']}}
```

> 📌 **状态持久化**：修改 `state` 字典后，系统会自动保存。下一次 `handle_action` 调用时，会传入上次修改后的 `state`。

---

## 四、生命周期钩子

### 4.1 on_install

插件安装时调用，用于初始化插件所需的数据库表、资源等。

```python
def on_install(plugin_id: str, version: str) -> Dict:
    """
    plugin_id: 插件唯一标识
    version: 插件版本号
    """
    # 初始化插件资源
    return {'code': 0, 'data': {'message': '安装成功'}}
```

### 4.2 on_enable

插件启用时调用，用于开启插件功能（如注册 Agent、创建定时任务等）。

```python
def on_enable(plugin_id: str, version: str) -> Dict:
    """
    插件启用时调用
    """
    return {'code': 0, 'data': {'enabled': True}}
```

### 4.3 on_disable

插件禁用时调用，用于清理插件开启的资源（如注销 Agent、停止定时任务等）。

```python
def on_disable(plugin_id: str) -> Dict:
    """
    插件禁用时调用
    """
    return {'code': 0, 'data': {'disabled': True}}
```

---

## 五、插件开发规范

### 5.1 标准目录结构

```
my-plugin-1.0.0.tpg (zip 压缩包)
├── manifest.json       # 插件元数据（必须）
├── entry.js            # 前端入口（minigame 必须）
├── entry.py            # 后端入口（可选）
└── ui/
    └── game.html       # 小游戏 HTML
```

### 5.2 entry.py 编写模板

```python
# entry.py - 插件后端入口
import json
from typing import Dict, Any

# ============================================================
# 生命周期钩子（可选）
# ============================================================

def on_install(plugin_id: str, version: str) -> Dict:
    """插件安装时调用"""
    return {'code': 0, 'data': {'message': '安装成功'}}


def on_enable(plugin_id: str, version: str) -> Dict:
    """插件启用时调用"""
    return {'code': 0, 'data': {'enabled': True}}


def on_disable(plugin_id: str) -> Dict:
    """插件禁用时调用"""
    return {'code': 0, 'data': {'disabled': True}}


# ============================================================
# 主入口
# ============================================================

async def handle_action(action: str, params: Dict, state: Dict, context: Dict) -> Dict:
    """
    统一入口：处理前端插件的所有请求

    参数：
        action: 操作类型（必填）
        params: 请求参数
        state:  游戏状态（session 级别，自动持久化）
        context: 执行上下文

    返回：
        {'code': 0, 'data': {...}} 成功
        {'code': 非0, 'error': '...'} 失败
    """
    handlers = {
        'init': handle_init,
        'play': handle_play,
        'end': handle_end,
    }

    handler = handlers.get(action)
    if not handler:
        return {'code': 400, 'error': f'Unknown action: {action}'}

    try:
        return await handler(action, params, state, context)
    except Exception as e:
        return {'code': 500, 'error': str(e)}


# ============================================================
# 业务逻辑处理器
# ============================================================

async def handle_init(action: str, params: Dict, state: Dict, context: Dict) -> Dict:
    """初始化游戏"""
    # 读取参数
    difficulty = params.get('difficulty', '普通')

    # 初始化 state
    state['hp'] = 100
    state['score'] = 0
    state['difficulty'] = difficulty

    return {'code': 0, 'data': {
        'hp': state['hp'],
        'difficulty': difficulty
    }}


async def handle_play(action: str, params: Dict, state: Dict, context: Dict) -> Dict:
    """处理游戏操作"""
    op = params.get('operation')

    if op == 'attack':
        damage = params.get('damage', 10)
        enemy_hp = state.get('enemy_hp', 100)
        state['enemy_hp'] = enemy_hp - damage
        return {'code': 0, 'data': {'enemy_hp': state['enemy_hp']}}

    return {'code': 400, 'error': 'Unknown operation'}


async def handle_end(action: str, params: Dict, state: Dict, context: Dict) -> Dict:
    """结束游戏"""
    score = state.get('score', 0)
    # 计算最终奖励
    return {'code': 0, 'data': {
        'final_score': score,
        'rewards': {'exp': 50, 'gold': 100}
    }}
```

---

## 六、完整插件示例：野外生存

### 6.1 entry.py 核心结构

> 完整代码见 `toonflow-game-plugins/plugins/toonflow-field-survival/entry.py`

```python
# 难度配置
DIFFICULTY_CONFIG = {
    '简单': {'enemy_hp_mult': 0.7, 'enemy_atk_mult': 0.6, 'reward_mult': 1.3, 'wave_count': 3},
    '普通': {'enemy_hp_mult': 1.0, 'enemy_atk_mult': 1.0, 'reward_mult': 1.0, 'wave_count': 5},
    '困难': {'enemy_hp_mult': 1.5, 'enemy_atk_mult': 1.4, 'reward_mult': 0.8, 'wave_count': 7}
}

# 主入口
async def handle_action(action: str, params: Dict, state: Dict, context: Dict) -> Dict:
    handlers = {
        'init': handle_init,
        'spawn_wave': handle_spawn_wave,
        'apply_rewards': handle_apply_rewards,
        'end_game': handle_end_game,
        'get_character_stats': handle_get_character_stats
    }
    handler = handlers.get(action)
    if not handler:
        return {'code': 400, 'error': f'Unknown action: {action}'}
    try:
        return await handler(action, params, state, context)
    except Exception as e:
        return {'code': 500, 'error': str(e)}
```

### 6.2 action 处理示例

```python
async def handle_init(action: str, params: Dict, state: Dict, context: Dict) -> Dict:
    """游戏初始化：生成敌人波次、计算难度系数"""
    party = params.get('party', [])
    difficulty = params.get('difficulty', '普通')

    # 计算角色战斗属性
    party_stats = {}
    for char_id in party:
        char_data = state.get(f'char_{char_id}', {
            '等级': 1, '经验': 0, '金钱': 0,
            '属性': {'生命值': 100, '攻击力': 20, '防御力': 10}
        })
        party_stats[char_id] = calc_character_stats(char_data, difficulty)

    # 生成第一波敌人
    enemies = generate_enemies(party, difficulty, wave=1)
    diff_cfg = DIFFICULTY_CONFIG[difficulty]

    return {
        'code': 0,
        'data': {
            'partyStats': party_stats,
            'enemies': enemies,
            'waveCount': diff_cfg['wave_count'],
        }
    }


async def handle_apply_rewards(action: str, params: Dict, state: Dict, context: Dict) -> Dict:
    """发放奖励到角色参数卡"""
    rewards = params.get('rewards', {})
    character_ids = params.get('characterIds', [])

    results = {}
    for char_id in character_ids:
        char_key = f'char_{char_id}'
        char_data = state.get(char_key, {})
        updated = apply_rewards_to_character(char_data, rewards)
        state[char_key] = updated  # 持久化到 state
        results[char_id] = updated

    return {'code': 0, 'data': {'updated': results}}
```

### 6.3 奖励发放逻辑

```python
def apply_rewards_to_character(character_data: Dict, rewards: Dict) -> Dict:
    """将奖励写入角色参数卡"""
    updated = dict(character_data)

    # 更新金钱和经验
    updated['金钱'] = updated.get('金钱', 0) + rewards.get('gold', 0)
    new_exp = updated.get('经验', 0) + rewards.get('exp', 0)
    updated['经验'] = new_exp

    # 检查升级
    exp_to_next = updated.get('升级经验', 100)
    level = updated.get('等级', 1)
    leveled_up = False

    while new_exp >= exp_to_next:
        new_exp -= exp_to_next
        level += 1
        exp_to_next = math.floor(exp_to_next * 1.5)
        leveled_up = True

    updated['经验'] = new_exp
    updated['等级'] = level
    updated['升级经验'] = exp_to_next

    # 升级加成属性
    if leveled_up:
        attrs = updated.get('属性', {})
        attrs['生命值'] = attrs.get('生命值', 100) + 10
        attrs['攻击力'] = attrs.get('攻击力', 20) + 3
        attrs['防御力'] = attrs.get('防御力', 10) + 2
        updated['属性'] = attrs

    # 记录获得物品
    if rewards.get('items'):
        inventory = updated.get('背包', [])
        inventory.extend(rewards['items'])
        updated['背包'] = inventory

    return updated
```

---

## 七、前后端交互协议

### 7.1 前端 → 后端

前端 minigame 通过 `fetch` 调用后端 API：

```javascript
// 前端发起请求
const response = await fetch('/plugin/execute', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    pluginId: 'com.toonflow.minigame-field-survival',
    action: 'init',
    params: { party: ['char_1'], difficulty: '普通' },
    sessionId: currentSessionId
  })
})
const result = await response.json()
// result = { code: 0, data: { enemies: [...], waveCount: 5 } }
```

### 7.2 后端返回格式

```python
# 成功
{'code': 0, 'data': {...}}

# 失败
{'code': 400, 'error': '参数错误'}
{'code': 500, 'error': '服务器内部错误'}
```

### 7.3 典型交互流程

```
前端 minigame              后端 entry.py              Toonflow 引擎
     │                           │                          │
     │  handle_action('init')    │                          │
     │ ─────────────────────────>│                          │
     │                           │                          │
     │     {code:0, data:{...}}  │                          │
     │ <─────────────────────────│                          │
     │                           │                          │
     │  toonflow.minigame.done() │                          │
     │ ───────────────────────────────────────────────────> │
     │                           │         写入 state        │
     │                           │                          │
```

---

## 八、Python 内置模块使用

Toonflow 插件后端运行在隔离的 Python 环境中，**允许使用以下标准库**：

| 模块 | 用途 |
|------|------|
| `json` | JSON 序列化/反序列化 |
| `random` | 随机数生成 |
| `math` | 数学运算 |
| `datetime` | 日期时间处理 |
| `re` | 正则表达式 |
| `typing` | 类型注解 |
| `asyncio` | 异步编程 |
| `hashlib` | 哈希计算 |
| `uuid` | UUID 生成 |

**禁止使用**（安全限制）：
- `os`（文件系统访问）
- `urllib` / `requests`（网络请求）
- `subprocess`（命令执行）
- `importlib` 动态加载外部模块

---

## 九、调试与测试

### 9.1 本地测试入口

在 `entry.py` 中添加 `if __name__ == '__main__':` 块：

```python
if __name__ == '__main__':
    import asyncio

    # 模拟调用
    async def test():
        state = {}
        context = {'session_id': 'test', 'user_id': 1, 'plugin_id': 'test'}
        result = await handle_action('init', {'difficulty': '普通'}, state, context)
        print(json.dumps(result, ensure_ascii=False, indent=2))

    asyncio.run(test())
```

运行：

```bash
cd toonflow-game-plugins/plugins/toonflow-field-survival
python entry.py
```

### 9.2 使用 toon_plugins CLI 测试

```bash
# 列出已安装插件
python -m toon_plugins plugins

# 打包插件
python -m toon_plugins plugins --install-all --no-tpg

# 上传到 Toonflow 后端
python -m toon_plugins plugins -i com.toonflow.minigame-field-survival
```

---

## 十、常见问题

### Q: handle_action 中抛出异常会怎样？

异常会被捕获并返回 `{'code': 500, 'error': str(e)}`，不会影响 Toonflow 主进程。

### Q: state 的大小有限制吗？

state 存储在 SQLite 中，建议单个插件的 state 总大小不超过 1MB。

### Q: 如何在插件间共享数据？

插件间数据隔离，不支持直接共享。如需共享，可通过 Toonflow 游戏状态（`toonflow.gameState`）作为中转。

### Q: handle_action 是同步还是异步的？

`handle_action` 是 `async def`，支持 `await` 异步调用。系统会等待其返回后再处理结果。

### Q: state 是每个用户独立的吗？

是的，`state` 按 `(user_id, session_id)` 隔离，不同用户的状态互不影响。

### Q: 如何处理长时间运行的任务？

将任务拆分为多个 `action`，前端通过轮询或 WebSocket 分段获取结果。插件后端禁止执行超过 30 秒的同步计算。

---

## 9. 命令注册与扫描机制（v2）

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
