# 回溯功能存储方案

**更新时间:** 2026-04-06  
**状态:** 已实现后端，待完善前端

---

## 一、章节调试模式

### 存储方案：内存 + 临时文件

**实现文件:** `src/routes/game/debugRuntimeShared.ts`

#### 1. 内存层（热数据）
```typescript
const DEBUG_REVISIT_HOT_SIZE = 5; // 内存保留最近 5 条

const DEBUG_REVISIT_HOT = new Map<string, DebugRevisitPoint[]>();

interface DebugRevisitPoint {
  debugRuntimeKey: string;    // 调试会话唯一标识
  messageCount: number;       // 消息序号
  state: Record<string, any>; // 运行状态
  round: number;              // 轮次
  chapterId: number | null;   // 章节ID
  createdAt: number;          // 创建时间
}
```

**特点：**
- 快速访问，无 I/O 延迟
- 自动淘汰旧数据（保留最近 5 条）
- 进程内共享，不同请求可直接命中

#### 2. 文件层（冷数据）
```typescript
function getRevisitFilePath(debugRuntimeKey: string): string {
  const dir = getTmpDebugRevisitDir(); // 临时目录
  return path.join(dir, `${sanitizeKey(debugRuntimeKey)}.json`);
}
```

**特点：**
- 无限量存储（受磁盘空间限制）
- 按需加载，命中后返回
- 进程重启后自动清空

#### 3. 读取流程
```typescript
export function getDebugRevisitPoint(
  debugRuntimeKey: string,
  messageCount: number
): DebugRevisitPoint | null {
  // 1. 先查内存
  const hot = DEBUG_REVISIT_HOT.get(debugRuntimeKey) || [];
  const hotHit = hot.find(p => p.messageCount === messageCount);
  if (hotHit) return hotHit;

  // 2. 再查文件
  const filePoints = readRevisitFile(debugRuntimeKey);
  return filePoints.find(p => p.messageCount === messageCount) || null;
}
```

#### 4. 写入流程
```typescript
export function saveDebugRevisitPoint(
  debugRuntimeKey: string,
  state: Record<string, any>,
  messages: RuntimeMessageInput[],
  chapterId: number | null
): void {
  // 1. 更新内存层
  const hot = DEBUG_REVISIT_HOT.get(debugRuntimeKey) || [];
  const deduped = hot.filter(p => p.messageCount !== newPoint.messageCount);
  deduped.push(newPoint);
  deduped.sort((a, b) => a.messageCount - b.messageCount);

  if (deduped.length <= DEBUG_REVISIT_HOT_SIZE) {
    // 全部放内存
    DEBUG_REVISIT_HOT.set(debugRuntimeKey, deduped);
  } else {
    // 2. 溢出到文件层
    const hot_kept = deduped.slice(-DEBUG_REVISIT_HOT_SIZE);
    const spill = deduped.slice(0, deduped.length - DEBUG_REVISIT_HOT_SIZE);
    DEBUG_REVISIT_HOT.set(debugRuntimeKey, hot_kept);

    // 追加到文件（合并去重）
    const existing = readRevisitFile(debugRuntimeKey);
    const merged = [...existing, ...spill]...
    writeRevisitFile(debugRuntimeKey, merged);
  }
}
```

#### 5. 销毁机制
```typescript
// 主动销毁（用户退出调试模式时）
export function clearDebugRevisitHistory(debugRuntimeKey: string): void {
  DEBUG_REVISIT_HOT.delete(debugRuntimeKey);
  deleteRevisitFile(debugRuntimeKey);
}

// 全局清空（进程退出或启动初始化时）
export function clearAllDebugRevisitTmpFiles(): void {
  // 清空整个 tmp 目录下的 .json 文件
  // 清空内存缓存
  DEBUG_REVISIT_HOT.clear();
}
```

---

## 二、游玩模式

### 存储方案：内存 + 持久化字段

**实现文件:** 
- `src/modules/game-runtime/services/SessionService.ts`
- `src/routes/game/revisitMessage.ts`

#### 1. 内存层（运行时缓存）
- **未实现独立的内存缓存层**
- 依赖数据库缓存和查询优化

#### 2. 持久化层（数据库字段）
```typescript
// 数据库表：t_sessionMessage
{
  id: number,
  sessionId: string,
  revisitData: string | null, // JSON 字符串
  // ... 其他字段
}

// 数据结构
export interface SessionMessageRevisitData {
  v: 1;                      // 版本号
  c: number | null;          // chapterId
  s: string;                 // status
  r: number;                 // round
  t: number;                 // capturedAt (时间戳)
  st: Record<string, any>;   // state
}
```

#### 3. 写入流程（消息落库时）
```typescript
// SessionService.ts 第 1740 行
await persistSessionMessageRevisitData({
  db,
  rows: insertedRows,  // 新插入的消息
  state,
  chapterId: nextChapterId,
  status: sessionStatus,
  capturedAt: now,
});

// 实现逻辑
async function persistSessionMessageRevisitData(params: {
  db: Knex;
  rows: any[];
  state: Record<string, any>;
  chapterId: number | null;
  status: string;
  capturedAt: number;
}): Promise<void> {
  const revisitData = buildSessionMessageRevisitData({
    state: params.state,
    chapterId: params.chapterId,
    status: params.status,
    capturedAt: params.capturedAt,
  });

  // 批量更新消息的 revisitData 字段
  for (const row of params.rows) {
    await db("t_sessionMessage")
      .where({ sessionId: row.sessionId, id: row.id })
      .update({ revisitData: toJsonText(revisitData, {}) });
  }
}
```

#### 4. 读取流程（回溯时）
```typescript
// revisitMessage.ts 第 40 行
const revisitData = readSessionMessageRevisitData(targetMessage.revisitData);
if (!revisitData) {
  return res.status(409).send(error("当前台词暂不支持回溯"));
}

const restoredState = revisitData.st;
const restoredChapterId = revisitData.c;
const restoredStatus = revisitData.s;
const restoredRound = revisitData.r;
```

#### 5. 回溯操作
```typescript
// revisitMessage.ts 第 51-103 行
await db.transaction(async (trx) => {
  // 1. 删除目标消息之后的所有消息
  await trx("t_sessionMessage")
    .where({ sessionId })
    .andWhere("id", ">", messageId)
    .delete();

  // 2. 删除目标消息之后的状态快照
  await trx("t_sessionStateSnapshot")
    .where({ sessionId })
    .andWhere("round", ">", restoredRound)
    .delete();

  // 3. 删除目标消息之后的状态增量
  await trx("t_entityStateDelta")
    .where({ sessionId })
    .andWhereRaw("...messageId > ?", [messageId])
    .delete();

  // 4. 恢复会话状态
  await trx("t_gameSession")
    .where({ sessionId, userId })
    .update({
      stateJson: toJsonText(restoredState, {}),
      chapterId: restoredChapterId,
      status: restoredStatus,
      updateTime: now,
    });

  // 5. 创建新的回溯点快照
  await trx("t_sessionStateSnapshot").insert({...});
});
```

---

## 三、方案对比

| 特性 | 章节调试模式 | 游玩模式 |
|-----|-----------|---------|
| **内存层** | ✅ 最近 5 条热数据 | ❌ 未实现 |
| **持久化层** | ✅ 临时文件（无限量） | ✅ 数据库字段（永久） |
| **读取速度** | 内存 > 文件 > 数据库 | 数据库查询 |
| **容量限制** | 磁盘空间 | 数据库容量 |
| **生命周期** | 进程会话期间 | 永久保存 |
| **适用场景** | 临时调试 | 正式游玩 |

---

## 四、优化建议

### 1. 章节调试模式（已完善）

✅ **优点：**
- 两级存储，性能优异
- 自动溢出机制
- 清理机制完善

💡 **改进空间：**
- 可考虑增加内存层大小（5 → 10）
- 可考虑 LRU 缓存策略替代 FIFO

### 2. 游玩模式（待优化）

❌ **问题：**
- 缺少内存层，每次回溯都需要查询数据库
- 所有消息都保存 revisitData，可能占用大量存储空间

💡 **优化方案：**

#### 方案 A：添加内存层（推荐）
```typescript
// 新增：游玩模式内存缓存
const SESSION_REVISIT_CACHE = new Map<string, SessionMessageRevisitData>();

// 在消息落库后，写入内存缓存
function cacheSessionRevisitData(
  sessionId: string,
  messageId: number,
  data: SessionMessageRevisitData
): void {
  const key = `${sessionId}:${messageId}`;
  SESSION_REVISIT_CACHE.set(key, data);
  
  // 限制缓存大小（例如最近 100 条）
  if (SESSION_REVISIT_CACHE.size > 100) {
    const firstKey = SESSION_REVISIT_CACHE.keys().next().value;
    SESSION_REVISIT_CACHE.delete(firstKey);
  }
}

// 读取时优先内存
function getSessionRevisitData(
  sessionId: string,
  messageId: number
): SessionMessageRevisitData | null {
  const key = `${sessionId}:${messageId}`;
  const cached = SESSION_REVISIT_CACHE.get(key);
  if (cached) return cached;

  // 回退到数据库
  const message = await db("t_sessionMessage")
    .where({ sessionId, id: messageId })
    .first();
  return readSessionMessageRevisitData(message.revisitData);
}
```

#### 方案 B：选择性保存 revisitData
```typescript
// 只在特定条件下保存 revisitData
function shouldSaveRevisitData(message: MessageItem): boolean {
  // 1. 用户发言：总是保存
  if (message.roleType === "player") return true;
  
  // 2. 重要事件：保存
  if (message.eventType?.startsWith("on_chapter_")) return true;
  
  // 3. 每 5 条保存一次
  if (message.id % 5 === 0) return true;
  
  return false;
}
```

---

## 五、前端集成

### 1. 回溯按钮显示条件

**章节调试模式：**
- 所有台词都显示回溯按钮（内存 + 临时文件保证可用）

**游玩模式：**
- 检查 `message.canRevisit` 字段
- `true`：显示回溯按钮
- `false`：显示"缺少台词记忆"提示

### 2. 前端调用流程

```typescript
// Web 端：右键菜单 → 回溯选项
async function handleRevisitMessage(messageId: number) {
  if (debugMode) {
    // 调试模式：从内存/临时文件恢复
    const result = await api.revisitDebug({
      debugRuntimeKey: state.debugRuntimeKey,
      messageCount: messageId
    });
  } else {
    // 游玩模式：从数据库恢复
    const result = await api.revisitSession({
      sessionId: state.currentSessionId,
      messageId: messageId
    });
  }
  
  // 刷新消息列表
  await loadMessages();
}
```

### 3. 错误处理

```typescript
try {
  await handleRevisitMessage(messageId);
} catch (error) {
  if (error.message.includes("暂不支持回溯")) {
    showToast("缺少台词记忆，无法回溯");
  } else {
    showToast(`回溯失败：${error.message}`);
  }
}
```

---

## 六、总结

### 已实现
- ✅ 章节调试模式：内存 + 临时文件两级存储
- ✅ 游玩模式：数据库持久化存储
- ✅ 后端回溯接口

### 待完成
- ⏳ 游玩模式：添加内存层优化（方案 A）
- ⏳ 前端：添加回溯按钮到右键菜单
- ⏳ 前端：实现"缺少台词记忆"提示
- ⏳ 测试：验证回溯功能的完整性
