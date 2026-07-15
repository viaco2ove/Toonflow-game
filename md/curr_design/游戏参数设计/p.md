我先快速核实方案中几个关键论断（章节内容实时读取、contentVersion 当前用途、session state 结构），再做评估。
已经核实清楚了。让我先看下今天的工作日志，然后给你一份完整的评估。
下面是对这份"故事版本设计"方案的完整评估。

---

## 一、关键事实核查（先校准方案中的论断）

方案文档里存在**前后矛盾的论断**——上半部分（第 25 行）说"旧 session 读到的是旧版本内容"，下半部分（第 56 行起"当前隐患"）又说"读到的其实是新内容"。代码核实结果如下：

| # | 方案论断 | 实际情况 | 结论 |
|---|---------|---------|------|
| 1 | `contentVersion` 是 world+chapter 的 hash，运行时用来对比版本 | 字段存在但 hash 输入是 14 个字段（`sessionInitialSnapshot.ts:58-82`）；**运行时根本不读它**，仅 `listSession.ts:157` 返回给前端展示 | ❌ 部分属实 |
| 2 | 旧 session 编排时读 session 创建时的章节版本 | `SessionService.ts:3857-3859` 每轮编排都 `db("t_storyChapter").where({id})` 实时拉最新内容；stateJson 里**不含 chapter.content** | ❌ **不属实**（方案自己下半段纠正了） |
| 3 | session stateJson 是独立快照（不存章节正文） | 属实。state 只存进度指针（`chapterId/phaseId/eventIndex` 等）+ 角色 + 小游戏 + 变量 | ✅ 属实 |
| 4 | 发布仅改 publishStatus + 预热快照，无版本号/发布时间/历史 | `worldPublish.ts:59-67` 的 `updateWorldPublishState` 只更新 5 个字段，确实无版本相关字段 | ✅ 完全属实 |
| 5 | t_storyWorld / t_storyChapter 无版本号字段 | `initDB.ts:1656-1696` 确认无 `publishedVersion/publishedAt/version`；章节表甚至是 `status` 而非 `publishStatus` | ✅ 完全属实 |

**核心结论**：方案作者最终是搞清楚真相的（"静默错位"那段分析正确），但文档早期论断没删干净。**真正隐患不是"读不到新内容"，而是"读到新内容但进度状态还指着旧结构"——这比方案上半段描述的更严重**：作者删一个 `##` 标题，旧 session 的 phaseId 立刻悬空，编排师找不到对应 phase → 静默错位。

---

## 二、设计合理性评估

### 2.1 第一步（版本标记 + 检测）—— 合理，但治标

| 维度 | 评估 |
|------|------|
| 设计思路 | 加 `publishedVersion`/`publishedAt`/`worldVersion`，session 与 world 对比版本，前端给提示 |
| 合理性 | ✅ 思路正确，最小改动 |
| 致命缺陷 | **不解决"静默错位"**——只给用户一个"继续旧版/重新开始"的选项。但当前架构下"继续旧版"根本做不到（内容是实时读的，没有旧版可继续） |
| 隐含前置 | 要让"继续旧版"真正生效，必须先做第二步（发布快照表）。否则第一步的"继续旧版"按钮是骗用户的——点了照样读到新内容 |

**建议**：第一步**不能独立上线**，必须和第二步绑定，否则用户点了"继续旧版"却看到新内容，体验更糟。

### 2.2 第二步（独立发布表 + BLOB）—— 方向对，但 BLOB 方案选型有坑

| 维度 | 评估 |
|------|------|
| 核心价值 | ✅ 真正解决"作者编辑草稿影响在运行 session"的根因 |
| 表设计 | ✅ `t_storyWorld_published(id, worldId, version, content BLOB, publishedAt, publishedBy)` 字段合理，`UNIQUE(worldId, version)` 保证版本唯一 |
| **BLOB 一坨 vs 章节独立表** | ⚠️ 方案最后选了"先用一个 BLOB"，但低估了 runtime 改造成本 |
| runtime 改造量 | 🔴 **巨大**。`SessionService.ts` 里至少 8 处 `db("t_storyChapter").where({id})`（3659/3697/3815/3838/3858/4251/4345/4474/4608 行）全部要改为"按 session.worldPublishId 查 _published 表 → 解压 BLOB → 找对应章节" |
| 性能风险 | ⚠️ 每轮编排解压整个 world BLOB 不现实。需要**内存缓存层**（session 创建时解压一次缓存到内存，生命周期跟 session 一致） |
| 章节内容大小 | 单章 `content + runtimeOutline` 通常几十 KB；一个世界 N 章 + 角色 + 触发器，gzip 后估计 100KB-1MB 量级，BLOB 字段没问题 |

**BLOB 方案的真问题**不是存储，而是**读取路径**：
- 原本：`db("t_storyChapter").where({id})` 一次单行查询
- 改后：`db("t_storyWorld_published").where({id})` 查整行 → 解压 gzip → JSON.parse → 在内存里按 chapterId 找

如果不做缓存层，每轮编排都解压一次，CPU 和内存都会爆。**建议加一层 `PublishedContentCache`（session 级内存缓存）**。

### 2.3 存档迁移 —— 三层方案设计思路对，但漏了关键场景

| 方案 | 评估 |
|------|------|
| 不改 | ✅ 最稳，用户继续用旧 published 版本玩，零风险 |
| 硬编码（phase 映射表） | ✅ `migrateSessionProgress` 函数思路对：phase 映射 → chapterProgress → dynamicEvents → recentEvents → turnState |
| AI Agent | 🔴 成本极高（设计 prompt + 调用链 + 错误兜底），ROI 低，建议暂缓 |

**漏掉的关键场景**：`migrateSessionProgress` 里说"角色属性卡、状态变量原样迁移"，但**如果新版删除了某个 NPC 或改了某个变量名**，原样迁移会产生悬空引用：
- `npcs` 里有个 `李四`，新版章节里没有这个 NPC 了 → 编排师读到不存在的角色
- `flags.questA = true`，新版触发的条件改成 `questB` → 触发器永远不触发

**建议**：迁移时增加"悬空引用清理"步骤，或至少在 `migrationReport.notes` 里标记出来让用户知道。

---

## 三、开发难度评估

| 阶段 | 改动范围 | 难度 | 工时估算 | 风险点 |
|------|---------|------|---------|--------|
| **第一步** 版本字段 + 检测 | initDB 加 3 字段、fixDB 迁移、`publishWorldSynchronously` 加 `publishedVersion++`、listSession 返回版本对比、前端加"故事已更新"提示 | 低 | 1-2 天 | 低 |
| **第二步** 独立发布表 + BLOB | 新建表、发布逻辑改造（草稿→压缩→写 _published）、**runtime 链路大改**（8+ 处 DB 查询改路径）、session 关联 `worldPublishId`、内存缓存层、删除级联 | 中-高 | 5-8 天 | runtime 链路遗漏某处没改 → 静默 bug |
| **第三步** 存档迁移（硬编码） | `migrateSessionProgress` 函数 + 前端迁移报告 UI + 悬空引用清理 | 中 | 3 天 | 中（phase 映射不全 → 进度错乱） |
| **第三步** AI Agent 迁移 | Agent prompt 设计 + 调用链 + 错误兜底 + 测试 | 高 | 7-10 天 | 高（AI 推断错误难复现） |

**总计**：完整三步 + AI Agent 迁移 ≈ 16-23 天；只做前两步 + 硬编码迁移 ≈ 9-13 天。

---

## 四、开发收益评估

| 收益项 | 价值 | 说明 |
|--------|------|------|
| 解决"作者编辑草稿静默影响在运行 session" | 🔴 高 | 这是当前架构的**真 bug**，会随作者增多而暴露 |
| 用户感知"故事已更新" | 🟡 中 | 体验改善，但非核心痛点 |
| 支持版本回滚（保留历史 published 行） | 🟡 中 | 方案没设计作者侧回滚 UI，潜在价值未兑现 |
| 存档迁移平滑升级 | 🟢 低 | "作者改已发布故事"是低频场景，迁移使用率低 |
| AI Agent 迁移 | 🟢 低 | ROI 极低，建议砍掉 |

**核心收益集中在第二步**：彻底分离草稿与发布态，让作者编辑和用户游玩互不干扰。这是架构层面的正本清源。

---

## 五、综合建议

### 建议做的事（按优先级）

1. **第一步 + 第二步一起做**（9-13 天）——这是"草稿/发布分离"的最小完整版本。第一步的"继续旧版"按钮才有意义。
2. **第二步必须加内存缓存层**——`PublishedContentCache`，session 级生命周期，避免每轮编排解压 BLOB。
3. **第三步只做"不改"和"硬编码"两层**——AI Agent 砍掉，等业务规模起来再说。
4. **迁移函数补"悬空引用清理"**——至少在 `migrationReport.notes` 里标记。

### 建议不做/缓做的事

- ❌ **AI Agent 存档迁移器**：ROI 太低，工程复杂度高，建议直接砍。
- ⚠️ **`t_storyChapter_published` 独立表**：方案最后选了 BLOB 一坨，先这样。如果未来发现单章读取性能问题或需要章节级回滚，再拆表。

### 文档建议

1. **删掉方案第 25 行的错误论断**（"旧 session 看不到新内容"）——会和第 56 行的真相自相矛盾，误导读者。
2. **明确"作者编辑哪张表"**：方案没写清楚。建议明确——作者编辑的是 `t_storyWorld`（草稿），发布时复制到 `t_storyWorld_published`。草稿和发布是同一张表的两个阶段，不是两张表。
3. **补"草稿-发布"边界图**：当前方案的图（第 118-135 行）画的是"作者编辑区→玩家游玩区"两张表，但实际还是 `t_storyWorld` 一张表 + 新增 `_published` 表。

---

## 总结

| 维度 | 评分 | 说明 |
|------|------|------|
| 方案合理性 | 7/10 | 方向对，但第一步不能独立上线；BLOB 方案需补缓存层；存档迁移漏悬空引用 |
| 开发难度 | 中-高 | 主要难点在第二步的 runtime 链路改造（8+ 处 DB 查询改路径） |
| 开发收益 | 中-高 | 核心收益在第二步（草稿/发布分离），第一步和第三步收益偏低 |
| 风险 | 中 | runtime 改造遗漏某处会静默 bug；存档迁移 phase 映射不全会进度错乱 |
| ROI（完整版 vs 精简版） | 精简版更优 | 砍掉 AI Agent 迁移，工时从 16-23 天降到 9-13 天，收益损失 <10% |

**一句话**：方案抓住了真问题（静默错位），但执行路径有改进空间——第一步必须和第二步绑定，第二步必须加缓存层，第三步砍掉 AI Agent。