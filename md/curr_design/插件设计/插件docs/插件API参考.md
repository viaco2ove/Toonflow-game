# 插件 API 参考

> `ctx`、`plugin`、`api` 所有接口的完整类型定义。
> 与现有代码完全对齐：`useToonflowStore.ts`、`ScenePlay.vue`、`MiniGameController.ts`、`gameEngine.ts`。
> 最后更新：2026-09-21

---

## 一、ctx — 插件运行时上下文（前端注入）

`ctx` 是 Toonflow 前端注入给 `entry.js` 的沙箱 API 对象。

```typescript
interface PluginContext {
  // ================================================================
  // 基础信息
  // ================================================================
  /** 插件唯一标识（与 manifest.json.id 一致） */
  pluginId: string;

  /** 插件版本 */
  pluginVersion: string;

  /** Toonflow 版本 */
  toonflowVersion: string;

  /** 当前会话 ID */
  sessionId: string;

  /** 当前用户 ID */
  userId: number;

  /** 当前世界/剧本 ID */
  worldId: number;

  // ================================================================
  // 状态访问（只读）
  // ================================================================
  /** 当前会话状态快照（来自 sessionDetail.state） */
  state: SessionState;

  /** 当前运行时状态（来自 sessionDetail.latestSnapshot.state） */
  runtimeState: RuntimeState;

  /** 当前小游戏状态（来自 runtimeState.miniGame） */
  miniGame: MiniGameRoot | null;

  /** 角色参数卡（来自 state.player.parameterCardJson） */
  playerCard: RoleParameterCard;

  /** 物品栏 */
  inventory: InventoryItem[];

  /** 当前世界的 NPC 列表 */
  npcs: Record<string, RuntimeNpc>;

  /** 世界书内容 */
  worldBook: WorldBookEntry[];

  // ================================================================
  // 变量读写
  // ================================================================
  /** 读取会话变量（通过 setVariable 设置的值） */
  variables: Record<string, unknown>;

  /** 设置会话变量（仅内存，下次请求失效；实际持久化走 writeback） */
  setVariable(path: string, value: unknown): void;

  /** 读取会话变量 */
  getVariable(path: string): unknown;

  // ================================================================
  // API 调用
  // ================================================================
  /** Toonflow API 集合（对齐 useToonflowStore.ts） */
  api: ToonflowAPI;

  // ================================================================
  // 事件总线
  // ================================================================
  /** 插件间通信总线 */
  bus: EventBus;

  // ================================================================
  // 资源解析
  // ================================================================
  /** 解析插件内资源 URL（相对路径 → 完整 URL） */
  resolvePluginUrl(relativePath: string): string;

  // ================================================================
  // 插件生命周期
  // ================================================================
  /** 通知 Toonflow 插件已加载 */
  ready(): void;

  /** 通知 Toonflow 插件关闭 */
  close(): void;

  /** 通知 Toonflow 插件出错 */
  error(message: string, details?: unknown): void;
}

// ================================================================
// 详细类型定义
// ================================================================

interface SessionState {
  player: {
    id: string;
    name: string;
    roleType: "player";
    avatarUrl?: string;
    parameterCardJson: RoleParameterCard;
  };
  narrator: {
    id: string;
    name: string;
    roleType: "narrator";
  };
  npcs: Record<string, RuntimeNpc>;
  inventory: InventoryItem[];
  worldClock: {
    timeOfDay: string;       // "dawn" | "morning" | "noon" | "afternoon" | "dusk" | "night"
    day: number;
    weather: string;
    timeMode: "auto" | "manual";
  };
  miniGame?: MiniGameRoot;
  turnState?: Record<string, unknown>;
  vars?: Record<string, unknown>;
  // ... 其他字段
}

interface RuntimeNpc {
  id: string;
  name: string;
  roleType: string;
  avatarUrl?: string;
  parameterCardJson?: RoleParameterCard;
  [key: string]: unknown;
}

interface RoleParameterCard {
  level?: number;
  exp?: number;
  next_level_exp?: number;
  hp?: number;
  max_hp?: number;
  mp?: number;
  max_mp?: number;
  atk?: number;
  def?: number;
  money?: number;
  skills?: string[];
  items?: string[];
  equipment?: string[];
  methods?: string[];
  cultivationMethods?: string[];
  // ... 其他自定义字段
  [key: string]: unknown;
}

interface InventoryItem {
  id?: string;
  name: string;
  itemName?: string;
  title?: string;
  kind?: string;     // "loot" | "quest" | "consumable" | "equipment"
  rarity?: string;    // "normal" | "rare" | "epic" | "legendary"
  [key: string]: unknown;
}

interface MiniGameRoot {
  session: MiniGameSession;
  ui: MiniGameUi;
  rulebook: MiniGameRulebook;
  actionLog: MiniGameActionLogItem[];
  writeback: Record<string, unknown>;
  memorySummary: string;
  passiveReentrySuppressed: boolean;
}

interface MiniGameSession {
  game_type: string;
  status: MiniGameStatus;
  phase: string;
  round: number;
  entry_source?: string;
  player_id?: string;
  npc_ids?: string[];
  difficulty?: string;
  public_state: Record<string, unknown>;
}

type MiniGameStatus =
  | "idle"
  | "preparing"
  | "active"
  | "settling"
  | "finished"
  | "aborted"
  | "suspended";

interface MiniGameUi {
  phase_label?: string;
  narration?: string;
  rule_summary?: string;
  state_items?: Array<{ key: string; value: string; label?: string }>;
  input_hint?: string;
  accepts_text_input?: boolean;
  [key: string]: unknown;
}

interface MiniGameRulebook {
  displayName: string;
  version: string;
  goal: string;
  phaseOrder: string[];
  ruleSummary: string;
  [key: string]: unknown;
}

interface MiniGameActionLogItem {
  action_id: string;
  timestamp: number;
  params?: Record<string, unknown>;
  result?: string;
}
```

---

## 二、api — Toonflow API 集合

```typescript
interface ToonflowAPI {
  // ================================================================
  // 会话消息
  // ================================================================

  /**
   * 添加消息到会话
   * 对应 routes/game/addMessage.ts
   *
   * 示例：
   * await api.addMessage({
   *   role: "narrator",
   *   roleType: "narrator",
   *   content: "第3波开始了！",
   *   meta: { eventType: "mini_game_narration" }
   * });
   */
  addMessage(input: {
    role: string;
    roleType: string;
    content: string;
    meta?: Record<string, unknown>;
  }): Promise<{ ok: boolean; messageId?: number }>;

  /**
   * 获取会话消息列表
   * 对应 routes/game/getMessage.ts
   */
  getMessages(params: {
    sessionId: string;
    offset?: number;
    limit?: number;
  }): Promise<{ messages: MessageItem[]; total: number }>;

  // ================================================================
  // 小游戏动作
  // ================================================================

  /**
   * 小游戏动作/物品操作
   * 对应 routes/game/miniGameInventoryAction.ts
   *
   * 示例：
   * await api.miniGameInventoryAction({
   *   action_id: "attack",
   *   params: { target: "enemy_0" },
   *   game_type: "field_survival",
   * });
   */
  miniGameInventoryAction(input: {
    action_id: string;
    params?: Record<string, unknown>;
    game_type?: string;
  }): Promise<MiniGameActionResult>;

  /**
   * 查询商城（shop 游戏类型）
   * 对应 routes/game/miniGameShopQuery.ts
   */
  miniGameShopQuery(params: {
    sessionId: string;
    shopId?: string;
  }): Promise<ShopQueryResult>;

  /**
   * 商城购买（shop 游戏类型）
   * 对应 routes/game/miniGameShopPurchase.ts
   */
  miniGameShopPurchase(input: {
    sessionId: string;
    itemId: string;
    quantity?: number;
  }): Promise<PurchaseResult>;

  // ================================================================
  // 叙事编排
  // ================================================================

  /**
   * 提交叙事回合（发送用户输入，触发 AI 编排）
   * 对应 routes/game/commitNarrativeTurn.ts
   *
   * 示例：
   * await api.commitNarrativeTurn({
   *   message: "我想去野外探险",
   * });
   */
  commitNarrativeTurn(input: {
    message: string;
    mode?: "session" | "debug";
  }): Promise<{ ok: boolean }>;

  /**
   * 继续会话（AI 继续上次未完成的叙述）
   * 对应 routes/game/continueSession.ts
   */
  continueSession(params: {
    sessionId: string;
  }): Promise<{ ok: boolean }>;

  // ================================================================
  // 会话管理
  // ================================================================

  /**
   * 获取会话元信息
   * 对应 routes/game/getSessionMeta.ts
   */
  getSessionMeta(params: {
    sessionId: string;
  }): Promise<SessionMeta>;

  /**
   * 获取会话完整信息（含状态快照）
   * 对应 routes/game/getSession.ts
   */
  getSession(params: {
    sessionId: string;
  }): Promise<SessionDetail>;

  // ================================================================
  // AI 图像生成
  // ================================================================

  /**
   * 生成角色立绘/场景图
   * 对应 routes/game/generateImage.ts
   */
  generateImage(input: {
    prompt: string;
    sessionId?: string;
    roleId?: string;
    type?: "avatar" | "scene" | "item";
  }): Promise<{ imageUrl: string; taskId: string }>;
}

// ================================================================
// API 返回类型
// ================================================================

interface MiniGameActionResult {
  ok: boolean;
  error?: string;
  session?: MiniGameSession;       // 更新后的小游戏 session
  ui?: MiniGameUi;                 // 更新后的 UI 状态
  public_state?: Record<string, unknown>;  // 更新后的 public_state
  writeback?: Record<string, unknown>;
  narration?: string;
  state_items?: Array<{ key: string; value: string }>;
  pending_narrative_plan?: {
    role: string;
    roleType: string;
    eventType: string;
    content: string;
  };
}

interface ShopQueryResult {
  ok: boolean;
  shop: {
    id: string;
    name: string;
    items: ShopItem[];
  };
}

interface ShopItem {
  id: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  stock: number;
  rarity: string;
}

interface PurchaseResult {
  ok: boolean;
  item?: InventoryItem;
  remaining_money?: number;
  error?: string;
}

interface SessionMeta {
  sessionId: string;
  worldId: number;
  status: string;
  chapterId?: number;
  createdAt: number;
  updatedAt: number;
}

interface SessionDetail extends SessionMeta {
  world: World;
  chapter?: Chapter;
  state: SessionState;
  latestSnapshot: {
    state: SessionState;
    timestamp: number;
  };
  messages: MessageItem[];
}

interface MessageItem {
  id: number;
  role: string;
  roleType: string;
  content: string;
  status: string;
  meta?: Record<string, unknown>;
  createdAt: number;
}
```

---

## 三、bus — 事件总线

```typescript
/**
 * 插件间通信事件总线
 * 对齐 Tavo 插件的 PluginBus / Toonflow 内部事件系统
 */
interface EventBus {
  /**
   * 监听事件
   * @param event    事件名（建议格式："plugin:event" 或 "game:event"）
   * @param handler  处理函数
   * @returns 取消监听的函数
   */
  on(event: string, handler: (payload: unknown) => void): () => void;

  /**
   * 监听一次性事件
   */
  once(event: string, handler: (payload: unknown) => void): void;

  /**
   * 广播事件
   */
  emit(event: string, payload?: unknown): void;

  /**
   * 移除监听
   */
  off(event: string, handler?: (payload: unknown) => void): void;
}

// ================================================================
// 预定义事件名
// ================================================================
const PluginEvents = {
  // 插件生命周期
  PLUGIN_READY:    "plugin:ready",
  PLUGIN_CLOSE:     "plugin:close",
  PLUGIN_ERROR:    "plugin:error",
  PLUGIN_CANCEL:   "plugin:cancel",

  // 游戏状态
  GAME_STATE_UPDATE: "game:state_update",
  GAME_NARRATION:   "game:narration",
  GAME_ENEMY_TURN:   "game:enemy_turn",
  GAME_WAVE_CLEAR:   "game:wave_clear",
  GAME_FINISHED:     "game:finished",

  // 角色状态
  ROLE_HP_CHANGED:   "role:hp_changed",
  ROLE_MP_CHANGED:   "role:mp_changed",
  ROLE_DEAD:         "role:dead",
  ROLE_LEVEL_UP:     "role:level_up",

  // 物品
  ITEM_ACQUIRED:     "item:acquired",
  ITEM_USED:         "item:used",
  ITEM_DROPPED:      "item:dropped",

  // 会话
  SESSION_MESSAGE:    "session:message",
  SESSION_END:       "session:end",
};
```

---

## 四、plugin — 插件元数据对象

```typescript
/**
 * 插件元数据（entry.js 中声明）
 * 对齐 manifest.json 结构
 */
interface PluginManifest {
  /** 插件唯一标识（必需，唯一） */
  id: string;

  /** 插件显示名称（必需） */
  name: string;

  /** 版本号（必需，semver） */
  version: string;

  /** 作者 */
  author?: string;

  /** 插件类型 */
  type: PluginType;

  /** 小游戏类型（type=minigame 时必需，与 MiniGameStateManager.gameType 对应） */
  gameType?: string;

  /** 显示类型标签 */
  displayType?: string;

  /** 描述 */
  description?: string;

  /** 缩略图 URL */
  thumbnail?: string;

  /** 标签（搜索用） */
  tags?: string[];

  /** 最低 Toonflow 版本 */
  minToonflowVersion?: string;

  /** 挂载配置 */
  mount?: {
    mode: "overlay" | "fullscreen" | "tab";
    target?: string;    // CSS 选择器，默认 "#mini-game-panel"
    zIndex?: number;
  };

  /** 权限声明 */
  permissions?: PluginPermission[];
}

type PluginType =
  | "minigame"   // 小游戏（挂载到会话界面小游戏面板）
  | "panel"      // 浮层面板
  | "standalone" // 独立页面
  | "tool";      // 工具类（无 UI）

type PluginPermission =
  | "state:read"           // 读取会话状态
  | "state:write"          // 修改会话状态（通过 writeback）
  | "inventory:read"       // 读取物品栏
  | "inventory:write"      // 修改物品栏
  | "player:read"          // 读取角色参数卡
  | "player:write"         // 修改角色参数卡
  | "worldbook:read"       // 读取世界书
  | "message:send"         // 发送消息
  | "orchestration:trigger" // 触发 AI 编排
  | "network:fetch"        // 访问外部网络
  | "storage:local";       // 本地存储
```

---

## 五、entry.py 后端 API

```python
# ================================================================
# 必须实现的函数
# ================================================================

def setup_game(
    state: Dict,
    session_id: str,
    player_id: str,
    npc_ids: List[str],
    difficulty: str = "normal",
    entry_source: str = "user_action",
    ctx: Optional[Dict] = None,
) -> Dict:
    """
    初始化小游戏。

    返回：
        {
            "ok": True,
            "mini_game_root": MiniGameRoot,    # 写入 session.state.miniGame
            "init_narration": str,              # 开场叙事
            "mentor_speech": Optional[str],    # 陪练台词
            "pending_plan": Optional[Dict],     # 编排计划
        }
    """


def apply_action(
    state: Dict,
    action_id: str,
    params: Dict,
    ctx: Optional[Dict] = None,
) -> Dict:
    """
    处理用户动作。

    返回：
        {
            "ok": True,
            "step_result": {
                "messages": List[Dict],
                "pending_narrative_plan": Dict,
                "reward_summary": Dict,
                "writeback": Dict,
                "session_update": Dict,
                "ui_update": Dict,
                "public_state_update": Dict,
            }
        }
    """


def get_trigger_prompt(ctx: Optional[Dict] = None) -> str:
    """
    返回 AI 触发提示词。
    """


def get_intent_prompt(
    current_state: Dict,
    available_actions: List[Tuple[str, str]],
    ctx: Optional[Dict] = None,
) -> str:
    """
    返回意图解析提示词。

    available_actions: [(action_id, label), ...]
    """


def get_rule_summary(ctx: Optional[Dict] = None) -> str:
    """
    返回规则摘要（前端展示用）。
    """


# ================================================================
# 可选实现的函数
# ================================================================

def settle_game(
    state: Dict,
    result: str,
    reward_summary: Dict,
    ctx: Optional[Dict] = None,
) -> Dict:
    """
    游戏结束时发放奖励。
    result: "victory" | "defeat" | "aborted"
    """


def get_action_options(
    state: Dict,
    ctx: Optional[Dict] = None,
) -> List[Dict]:
    """
    返回当前可用的动作选项（前端 UI 按钮用）。
    返回：[{"action_id": str, "label": str, "desc": str, "enabled": bool}, ...]
    """


def on_state_change(
    old_state: Dict,
    new_state: Dict,
    ctx: Optional[Dict] = None,
) -> None:
    """
    监听小游戏状态变化（用于跨插件联动）。
    """
```

---

## 六、常用状态路径速查

| 要读取的内容 | 路径 | 示例 |
|------------|------|------|
| 玩家名称 | `state.player.name` | "小明" |
| 玩家等级 | `state.player.parameterCardJson.level` | 5 |
| 玩家 HP | `state.player.parameterCardJson.hp` | 80 |
| 玩家 MP | `state.player.parameterCardJson.mp` | 30 |
| 玩家金钱 | `state.player.parameterCardJson.money` | 150 |
| 玩家经验 | `state.player.parameterCardJson.exp` | 45 |
| 下一级经验 | `state.player.parameterCardJson.next_level_exp` | 200 |
| 玩家技能 | `state.player.parameterCardJson.skills` | ["火球术", "治疗"] |
| 玩家物品 | `state.player.parameterCardJson.items` | ["血瓶", "钥匙"] |
| 物品栏 | `state.inventory` | `[{name, kind, rarity}]` |
| 世界时间 | `state.worldClock.timeOfDay` | "afternoon" |
| 世界日期 | `state.worldClock.day` | 3 |
| 天气 | `state.worldClock.weather` | "rainy" |
| NPC 列表 | `state.npcs` | `{npc_id: Npc}` |
| NPC HP | `state.npcs[npc_id].parameterCardJson.hp` | 50 |
| 小游戏类型 | `state.miniGame.session.game_type` | "field_survival" |
| 小游戏状态 | `state.miniGame.session.status` | "active" |
| 小游戏波次 | `state.miniGame.session.public_state.current_wave` | 3 |
| 小游戏敌人 | `state.miniGame.session.public_state.enemy_list` | `[{id, name, hp, alive}]` |
| AI 叙事文本 | `state.miniGame.ui.narration` | "第3波开始了！" |
| AI 状态条目 | `state.miniGame.ui.state_items` | `[{key, value}]` |
| AI 输入提示 | `state.miniGame.ui.input_hint` | "输入指令或使用技能" |

---

## 七、action_id 命名规范

```
通用动作（所有小游戏）：
  start_game          — 开始游戏
  exit_game / abort  — 退出游戏
  watch_game          — 观战模式

战斗类：
  attack / player_attack  — 普攻
  use_skill              — 使用技能（需 params.skill）
  use_item               — 使用物品（需 params.item）
  enemy_turn             — 敌方回合（AI 触发）
  next_wave              — 下一波
  wave_start             — 开始波次

商城类：
  shop_query    — 查询商城
  shop_purchase — 购买物品
  shop_sell     — 出售物品

交互类：
  dialogue_continue — 继续对话
  choice_select    — 选择选项（需 params.choice_id）
  roll_dice        — 掷骰子
```