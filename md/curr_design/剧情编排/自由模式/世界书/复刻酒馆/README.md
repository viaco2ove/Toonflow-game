# 世界书 · 《谁让这个山大王修仙的！》

> 基于 SillyTavern 世界书（Lorebook / World Info）规范的 Markdown 适配版。
> 核心思想：**关键词触发 → 动态注入上下文**。提到才进，不提不进。
>
> 适配目标：Toonflow 编排师上下文构建器（`buildOrchestratorPromptPayload`）。
> 本文件为人类可读规范，运行时由注入器解析为 `WorldKnowledgeEntry` 数据结构。

---

## 目录结构

```
worldbook/
├── README.md              ← 本文件（索引/规范/元数据）
├── _constants.md          ← 常驻条目（永远生效，无关键词）
├── _system.md             ← 修仙界系统规则（等级/属性/财气眼）
├── world.md               ← 世界地理/势力/势力NPC
├── locations.md           ← 地点条目
├── characters.md          ← 角色条目
├── factions.md            ← 势力/宗门/山寨
├── items.md               ← 物品/法宝/秘籍
├── events.md              ← 事件/阴谋/主线剧情线索
└── random.md              ← 概率触发条目（随机事件/奇遇）
```

---

## 条目格式规范

每条目以二级标题 `##` 开头，字段顺序固定，便于注入器解析：

```markdown
## <条目标题>

- **Keys（关键词）**: `["关键词1", "关键词2", "/正则/"]`
- **Constant（常驻）**: `false`
- **Probability（概率%）**: `100`
- **Order（插入顺序）**: `100`
- **Group（互斥组）**: `null`
- **Selective Logic**: `null`
- **Content（正文）**:

> 正文。必须独立自描述——因为 Keys/标题不进入 AI 上下文。
> 推荐用 [条目名] 开头明确指代对象。
```

### 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `Keys` | 是（Constant 条目除外） | 逗号分隔。纯文本默认不区分大小写；用 `/.../` 包裹视为 JS 正则 |
| `Constant` | 否 | `true` 表示常驻，每次都注入；不写或 `false` 表示关键词触发 |
| `Probability` | 否 | 0~100，触发后再加一层概率（用于随机事件）；默认 100 |
| `Order` | 是 | 数字越大越靠后注入；常驻条目建议 10000+ |
| `Group` | 否 | 同组多条同时触发时，按 Group Weight 随机只留一条 |
| `Selective Logic` | 否 | `AND ANY` / `AND ALL` / `NOT ANY` / `NOT ALL` |
| `Content` | 是 | 注入到 AI 上下文的正文，必须自描述 |

---

## 注入策略

- **常驻（Constant）**：每轮对话必注入，受 token 预算约束
- **关键词触发**：扫描最近 N 条消息（推荐 5）→ 命中则激活
- **插入位置**：当前项目建议插在 `buildOrchestratorPromptPayload` 的 `worldKnowledge` 字段，位于角色卡之后、当前事件上下文之前
- **Token 预算**：默认 2000 token，超出按 Order 升序截断

---

## 扫描深度

- `worldConstants` → 全局常驻，不扫描
- `worldSystem` → 全局常驻，不扫描
- `worldEvents` → 扫描深度 10（覆盖更长对话历史，因为阴谋线索触发慢）
- `worldRandom` → 扫描深度 5
- 其余分类 → 扫描深度 5

---

## 备注

- 本世界书共约 25~30 条目，覆盖：主角金手指、世界规则、黑风寨、5 个主要角色、4 个地点、3 类物品、3 条主线阴谋、2 个随机事件
- 角色「某女子/某男子」为万能配角，无独立世界书条目
- `冷素心`、`苍山道人`、`红缥缈` 在 chapter_1 之前不应激活（用 `Selective Logic` 中的"章节数 >= X"约束，本版先用简化的"概率 0"控制后期登场）

---

*最后更新：2026-07-22*
