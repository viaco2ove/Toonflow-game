/**
 * RoleMemoryService —— 角色长期记忆池（L2）的写入与查询
 *
 * # 这张表是干嘛的
 *
 * 它是【每个角色各自的长期私人笔记本】，用来补两个洞：
 *
 *   state.memoryFacts 只有 8 条、全员共享一本账 ——
 *     · 洞一（容量）：新事实进来就把旧事实挤出去，NPC 几十轮后必然失忆；
 *     · 洞二（隔离）：张三的秘密李四也读得到，角色认知没法区分。
 *
 * t_role_memory 就是被挤出去之后仍能按角色各自索回来的那部分。
 *
 * # 一行记什么（唯一判据）
 *
 *   一个角色在毫无上下文的情况下读到这句话，
 *   能不能明白「我知道了一件什么事」？
 *
 *   能 → 记。不能 → 不记。
 *
 * | ✅ 该记（脱离上下文仍成立） | ❌ 不该记（依赖上下文 / 不是事实） |
 * |---|---|
 * | 赤眉老人答应替白锦儿担保 | 他点了点头 |
 * | 白锦儿已炼化第三层火种 | 更新全部人的当前行为 |
 * | 用户持有玄铁重剑 | 状态更新：「xxx」 |
 * | 黑风寨与云火月结下梁子 | 那个东西拿走了 |
 *
 * 关键区别在于【主体】与【可理解性】：
 * - 必须带明确主体（谁对谁做了什么），不能是"他""它""那个东西"；
 * - 必须是已发生过的事，不是元指令、不是操作请求、不是对话片段。
 *
 * # 内容由谁产出
 *
 * 一律由记忆管理器 AI 凝练产出（`scheduleSessionMemoryRefresh` →
 * `onResolved` → `persistRoleMemoryFacts`）。
 * 代码侧【不许】用关键词穷举拼句子往里写 —— 那样既丢了语境，也不成事实。
 * 历史上这么干过，产出过 `状态更新：「更新全部人的当前行为」` 这种谁都看不懂的记录。
 *
 * # 归属判定（按角色名匹配事实句）
 *   - fact 含用户角色名 → subjectType=user, subjectId='user'（谁都能读）
 *   - fact 含某 NPC 名   → subjectType=npc_self, subjectId=角色名（仅本人可读）
 *   - 谁的名字都没有     → subjectType=world, subjectId='__world__'（世界共享）
 *
 *   ⚠️ 空串曾被用来表示"世界共享"，但它同时也是"归属判定失败"的兜底值，
 *      两者共用同一个值导致漏判记录对全体角色广播。现统一用 __world__ 显式占位，
 *      读取侧绝不放行空串。
 *
 * # 查询纪律（防串戏）
 *   发言器只取 subjectId IN (说话人名, 'user', '__world__') 的记忆，
 *   且限制 sourceTurn <= lastMessageId（回溯截止线），防止读到回溯点之后的事。
 */

import { getGameDb } from "@/lib/gameEngine";

export interface RoleMemoryRow {
  id?: number;
  sessionId: string;
  storyId: string;
  chapterId?: string | null;
  subjectType: "npc_self" | "user" | "world" | "relation" | string;
  subjectId: string;
  content: string;
  importance?: number;
  sourceTurn?: number | null;
  createdAt?: number;
  lastHitAt?: number;
  hitCount?: number;
  // ★ P2: m3e-small 512d float32 BLOB（VARBINARY(2048)）
  vec?: Buffer | Buffer[] | null;
}

const MAX_CONTENT_LEN = 80;
const MAX_WRITE_PER_TURN = 3;

/**
 * 世界级主体的显式占位符。
 *
 * 不能再用空字符串标识"世界事实"：读取条件 whereIn("subjectId", [角色名, "user", ""])
 * 里空串既表示"世界共享"，又可能表示"漏判兜底"，两者语义完全不同却共用同一个值，
 * 导致任何一条归属判定失败的事实都会自动广播给全体角色 —— 这跟防串戏的初衷相悖。
 */
export const WORLD_SUBJECT_ID = "__world__";

/**
 * 写入准入阀：判断一句话值不值得作为"角色长期记忆"存下来。
 *
 * t_role_memory 的定位是【角色的长期私人笔记本】——每一行都必须是
 * 脱离上下文后仍能独立成立的叙事事实。判据只有一条：
 *
 *   角色在毫无上下文的情况下读到这句话，能不能明白"我知道了一件什么事"？
 *
 * 以下三类一律拒收：
 *   1. 元操作指令 —— 用户在 @记忆管理 后面写的"更新全部人的当前行为""刷新面板"，
 *      这不是发生过的事，是对系统的操作请求，写进记忆等于污染。
 *   2. 过短碎片 —— 低于 6 字的残句（多为 AI 截断或列表符号），语义不成立。
 *   3. 结构垃圾 —— 含字段名、JSON 括号等机器格式，说明上游没解析干净。
 *
 * 正则里的宾语部分必须【必选】。写成「清理\s+(记忆|缓存|数据)?」会让量词把整个分组
 * 变成可选，正则退化成裸的单词匹配，把"负责清理藏书阁的杂役"这类正常叙事也一并误杀。
 */
const META_OPERATION_PATTERNS = [
  /@\s*记忆管理/,
  /(更新|刷新|重置|同步|重算)\s*(一下|一次|下)?\s*(全部|所有|全体)?\s*(人|角色|人员|NPC|npc|面板|状态|记忆|数据)/,
  /(重置|清理)\s*(一下|一次|下)?\s*(面板|状态|记忆|数据|缓存)/,
  /重新\s*(计算|生成|统计|整理|汇总)/,
  /^\s*(刷新|重置|同步)\s*$/,
];

function isWorthyRoleMemoryFact(fact: string): boolean {
  const text = String(fact || "").trim();
  if (text.length < 6) return false;
  if (/[{}\[\]"']|\\\\|playerCardPatch|player_card_patch|summary\s*[:：]|facts\s*[:：]/.test(text)) return false;
  if (META_OPERATION_PATTERNS.some((re) => re.test(text))) return false;
  return true;
}

/** 归属判定：fact 里出现谁的名字就算谁的 */
function detectSubject(
  fact: string,
  roleNames: string[],
  playerRoleName: string,
): { subjectType: string; subjectId: string } {
  const text = String(fact || "");
  if (playerRoleName && text.includes(playerRoleName)) {
    return { subjectType: "user", subjectId: "user" };
  }
  // 长名字优先匹配，避免"云火月"里的"火月"先被短名命中导致归属错人
  const hit = [...roleNames]
    .filter((name) => name)
    .sort((a, b) => b.length - a.length)
    .find((name) => text.includes(name));
  if (hit) {
    return { subjectType: "npc_self", subjectId: hit };
  }
  return { subjectType: "world", subjectId: WORLD_SUBJECT_ID };
}

/** 一次写表的完整流水账，给上层打日志用 */
export interface RoleMemoryWriteStats {
  /** 记忆管理器 AI 产出的原始事实数 */
  received: number;
  /** 被写入准入阀拦掉的（元指令 / 碎片 / 结构垃圾） */
  rejected: number;
  /** 超过单轮上限被丢弃的 */
  truncated: number;
  /** 库里已存在、去重跳过的 */
  duplicated: number;
  /** 真正写入的 */
  written: number;
  /** 写入行的归属，看一眼就知道是落在谁头上 */
  subjects: string[];
}

/**
 * 记忆凝练完成后调用：把事实句写入 t_role_memory（带去重）。
 * 任何失败只打日志，绝不影响主链路。
 *
 * 返回流水账而不是简单的写入行数：这条链路是 fire-and-forget 的异步任务，
 * 出问题不会有任何报错，只能靠日志归因。四个计数能直接区分最关键的三种故障：
 *   received=0            → AI 压根没产出 facts（上游问题）
 *   rejected≈received     → 产出了但被准入阀全拦了（<｜hy_place▁holder▁no▁813｜>阀太严的误杀）
 *   written=0 && 其他>0   → 库里都已有 / 写入失败（DB 问题）
 */
export async function persistRoleMemoryFacts(params: {
  sessionId: string;
  storyId: string | number;
  chapterId?: string | number | null;
  roleNames: string[];
  playerRoleName: string;
  memoryFacts: string[];
  sourceTurn?: number | null;
}): Promise<RoleMemoryWriteStats> {
  const stats: RoleMemoryWriteStats = {
    received: 0,
    rejected: 0,
    truncated: 0,
    duplicated: 0,
    written: 0,
    subjects: [],
  };
  try {
    const db = getGameDb();
    const storyId = String(params.storyId || "");
    if (!storyId || !db) return stats;
    const trimmed = (params.memoryFacts || [])
      .map((f) => String(f || "").trim())
      .filter(Boolean);
      // ★ 写入准入阀：元操作指令 / 碎片 / 结构垃圾一律不落表
    const worthy = trimmed.filter(isWorthyRoleMemoryFact);
    const facts = worthy.slice(0, MAX_WRITE_PER_TURN);
    stats.received = trimmed.length;
    stats.rejected = trimmed.length - worthy.length;
    stats.truncated = worthy.length - facts.length;
    if (!facts.length) return stats;

    const now = Date.now();
    for (const fact of facts) {
      const content = fact.length > MAX_CONTENT_LEN ? fact.slice(0, MAX_CONTENT_LEN) : fact;
      const { subjectType, subjectId } = detectSubject(content, params.roleNames, params.playerRoleName);
      // 同 storyId + subjectId + content 已存在则跳过，防止 worker 每 30s 重复写
      const exists = await db("t_role_memory")
        .where({ storyId, subjectId, content })
        .first()
        .catch(() => null);
      if (exists) {
        stats.duplicated += 1;
        continue;
      }
      const [{ id: rowId }] = await db("t_role_memory").insert({
        sessionId: params.sessionId,
        storyId,
        chapterId: params.chapterId != null ? String(params.chapterId) : null,
        subjectType,
        subjectId,
        content,
        importance: 3,
        sourceTurn: params.sourceTurn ?? null,
        createdAt: now,
        lastHitAt: now,
        hitCount: 0,
      }).returning("id");
      // ★ P2: 写入后异步生成向量（失败不影响写入，vectorizeExistingRow 有 try/catch）
      void vectorizeExistingRow(Number(rowId), content);
      stats.written += 1;
      stats.subjects.push(subjectId);
    }
  } catch (err) {
    console.warn("[role-memory] persist failed:", (err as any)?.message || String(err));
  }
  return stats;
}

/**
 * 发言器读取：说话人可见的记忆 = 自己的 + 关于用户的 + 全局的。
 * sourceTurn 过滤保证回溯后只能读到回溯点之前的记忆，防止"穿越"。
 *
 * @param sourceTurnCap 全局消息 ID 上限（lastMessageId），回溯时自动还原成旧值。
 *                       undefined/null 表示无限制（自由发言等场景）。
 */
export async function loadRoleMemoriesForSpeaker(params: {
  storyId: string | number;
  speakerName: string;
  limit?: number;
  /** 全局消息 ID 上限，未定义时不限制 sourceTurn */
  sourceTurnCap?: number | null;
}): Promise<RoleMemoryRow[]> {
  try {
    const db = getGameDb();
    const storyId = String(params.storyId || "");
    if (!storyId || !db || !params.speakerName) return [];
    const limit = Math.min(Math.max(Number(params.limit || 8), 1), 12);
    // ★ 回溯保护：只读回溯点之前产生的记忆（按全局消息 ID 水位）
    // ★ 归属可见性：自己的(np) + 关于用户的(user) + 世界共享的(__world__)
    //   注意不能放行空串，否则归属判定失败的漏网记录会对全体角色广播。
    const q = db("t_role_memory")
      .where({ storyId })
      .whereIn("subjectId", [params.speakerName, "user", WORLD_SUBJECT_ID]);
    if (Number.isFinite(params.sourceTurnCap) && params.sourceTurnCap! > 0) {
      q.where("sourceTurn", "<=", params.sourceTurnCap);
    }
    const rows: RoleMemoryRow[] = await q
      .orderBy("importance", "desc")
      .orderBy("createdAt", "desc")
      .limit(limit);
    // 异步更新命中计数，不阻塞
    void db("t_role_memory")
      .whereIn("id", rows.map((r) => Number(r.id || 0)).filter(Boolean))
      .increment("hitCount", 1)
      .update({ lastHitAt: Date.now() })
      .catch(() => undefined);
    return rows;
  } catch (err) {
    console.warn("[role-memory] load failed:", (err as any)?.message || String(err));
    return [];
  }
}

// ============================================================================
// P2: 向量召回（JS 内存暴力扫描 m3e-small 512d）
// ============================================================================

/** cosine 相似度 */
function cosineScore(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const nA = Math.sqrt(normA);
  const nB = Math.sqrt(normB);
  if (nA === 0 || nB === 0) return 0;
  return dot / (nA * nB);
}

/** Blob → number[]（512d m3e-small） */
function blobToVector(blob: Buffer | Buffer[] | null | undefined): number[] | null {
  if (!blob || !Buffer.isBuffer(blob)) return null;
  if (blob.length < 512 * 4) return null;
  const vec: number[] = new Array(512);
  for (let i = 0; i < 512; i++) {
    vec[i] = blob.readFloatLE(i * 4);
  }
  return vec;
}

/**
 * P2 向量召回：
 * 1. 用 recallQueries 编码 query 向量（多个 query 取 max pooling）
 * 2. 扫全表（storyId 下所有有 vec 的行，★ sourceTurnCap 过滤回溯保护）
 * 3. score = 0.5*cos + 0.3*importance/5 + 0.2*timeDecay（timeDecay = 0.5^(Δturn/50)）
 * 4. 取 top N，按 subjectId 过滤（防串戏），上限 3 条/最高 200 token
 * 5. 失败时降级回 SQL 排序
 *
 * @param recallQueries  召回查询语句（多个则 max pooling）
 * @param speakerName    当前说话人角色名
 * @param sourceTurnCap  全局消息 ID 上限（算时间衰减 + 回溯过滤）
 * @param topK           取 topN（默认 3）
 * @param tokenBudget    最高 token 预算（默认 200，约 3 条 x ~60 字）
 */
export async function recallRoleMemories(params: {
  storyId: string | number;
  recallQueries: string[];
  speakerName: string;
  /** 全局消息 ID 上限（lastMessageId），undefined/null 表示无限制 */
  sourceTurnCap?: number | null;
  limit?: number;
  tokenBudget?: number;
}): Promise<RoleMemoryRow[]> {
  const {
    storyId,
    recallQueries,
    speakerName,
    sourceTurnCap,
    limit = 3,
    tokenBudget = 200,
  } = params;

  try {
    // 动态导入避免循环依赖（localEmbed 路径深）
    const localEmbed = await import("@/lib/localEmbed");
    const db = getGameDb();
    const sid = String(storyId || "");

    // 1. 编码 recall query（max pooling 多个 query）
    let queryVec: number[] | null = null;
    if (recallQueries.length) {
      const vectors = await Promise.all(
        recallQueries.map((q) => localEmbed.encodeTexts([q]))
      );
      // max pooling across queries
      queryVec = new Array(512).fill(-Infinity);
      for (const v of vectors) {
        if (!v || !v[0]) continue;
        for (let i = 0; i < 512; i++) {
          if (v[0][i] > queryVec[i]) queryVec[i] = v[0][i];
        }
      }
    }
    if (!queryVec) return [];

    // 2. 拉全表向量数据（只看有 vec 的行，★ 回溯保护：只读回溯点之前的记忆）
    const validCap = Number.isFinite(sourceTurnCap) && sourceTurnCap! > 0 ? sourceTurnCap! : null;
    const q = db("t_role_memory")
      .where({ storyId: sid })
      .whereIn("subjectId", [speakerName, "user", WORLD_SUBJECT_ID])
      .whereNotNull("vec");
    if (validCap !== null) {
      q.where("sourceTurn", "<=", validCap);
    }
    const allRows: RoleMemoryRow[] = await q.select("*");

    if (!allRows.length) return [];

    // 3. 暴力扫描，计算加权分
    const now = Date.now();
    const scored = allRows
      .map((row) => {
        const vec = blobToVector(row.vec as unknown as Buffer);
        if (!vec) return null;
        const cos = cosineScore(queryVec!, vec);
        const importance = (row.importance ?? 3) / 5;
        const cap = validCap ?? (row.sourceTurn ?? 0);
        const turnDelta = Math.abs((row.sourceTurn ?? 0) - cap);
        const timeDecay = Math.pow(0.5, turnDelta / 50);
        const score = 0.5 * cos + 0.3 * importance + 0.2 * timeDecay;
        return { row, score };
      })
      .filter(Boolean) as Array<{ row: RoleMemoryRow; score: number }>;

    // 4. 按 score 降序，取 top + token budget
    scored.sort((a, b) => b.score - a.score);
    const totalChars = scored.reduce((s, x) => s + (x.row.content?.length ?? 0), 0);
    let usedChars = 0;
    const picked: RoleMemoryRow[] = [];
    for (const { row } of scored) {
      const itemChars = (row.content?.length ?? 0) + 8; // "【scope】" 约 8 字符
      if (picked.length >= limit) break;
      if (usedChars + itemChars > tokenBudget) break;
      picked.push(row);
      usedChars += itemChars;
    }

    // 5. 异步更新命中
    void db("t_role_memory")
      .whereIn("id", picked.map((r) => Number(r.id || 0)).filter(Boolean))
      .increment("hitCount", 1)
      .update({ lastHitAt: now })
      .catch(() => undefined);

    return picked;
  } catch (err) {
    console.warn("[role-memory] vector recall failed, fallback to SQL:", (err as any)?.message || String(err));
    // 降级：回退 SQL 排序
    return loadRoleMemoriesForSpeaker({ storyId, speakerName, limit });
  }
}

/** 将 content 文本编码为 vec 并回写入数据库（幂等） */
export async function vectorizeExistingRow(rowId: number, content: string): Promise<void> {
  try {
    const localEmbed = await import("@/lib/localEmbed");
    const vectors = await localEmbed.encodeTexts([content]);
    if (!vectors || !vectors[0]) return;
    const buf = Buffer.alloc(512 * 4);
    for (let i = 0; i < 512; i++) {
      buf.writeFloatLE(vectors[0][i], i * 4);
    }
    const db = getGameDb();
    await db("t_role_memory")
      .where({ id: rowId })
      .update({ vec: buf });
  } catch (err) {
    console.warn(`[role-memory] vectorize row ${rowId} failed:`, (err as any)?.message || String(err));
  }
}

/** 写入一行（含异步向量化），失败返回 false */
async function insertMemoryRow(input: {
  db: any;
  sessionId: string;
  storyId: string;
  chapterId: string | null;
  subjectType: string;
  subjectId: string;
  content: string;
  importance: number;
  sourceTurn: number | null;
}): Promise<boolean> {
  const now = Date.now();
  try {
    const [{ id: rowId }] = await input.db("t_role_memory")
      .insert({
        sessionId: input.sessionId,
        storyId: input.storyId,
        chapterId: input.chapterId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        content: input.content,
        importance: input.importance,
        sourceTurn: input.sourceTurn,
        createdAt: now,
        lastHitAt: now,
        hitCount: 0,
      })
      .returning("id");
    void vectorizeExistingRow(Number(rowId), input.content);
    return true;
  } catch (err) {
    console.warn("[role-memory] insert row failed:", (err as any)?.message || String(err));
    return false;
  }
}

/** 参数卡文本清洗：去掉易变的【当前行为】段，压平换行与空白 */
function sanitizeBootstrapText(input: unknown): string {
  return String(input ?? "")
    .replace(/【当前行为】[\s\S]*$/, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function toTextList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.map((item) => String(item ?? "").trim()).filter(Boolean);
}

/**
 * 从角色参数卡合成一条冷启动事实。
 *
 * 优先级：已发生的事（技能/装备/物品/长期状态） > 身份备注。
 * 理由：参数卡里的 skills/items 记录的是"凭本事攒下来的东西"，
 * 才是真正有叙事价值的事实；身份备注在角色卡里已经有了，
 * 只在完全没有前者时才退化用它兜底（至少让这个角色不是"零记忆"）。
 */
function synthesizeBootstrapFact(name: string, card: Record<string, any>): string | null {
  if (!name || !card) return null;
  const identity = sanitizeBootstrapText(card.role_key_information || card.information);
  const acquired: string[] = [];
  const skills = toTextList(card.skills).slice(0, 2);
  const equipment = toTextList(card.equipment).slice(0, 2);
  const items = toTextList(card.items).slice(0, 3);
  const other = toTextList(card.other).slice(0, 2);
  if (skills.length) acquired.push(`掌握技能：${skills.join("、")}`);
  if (equipment.length) acquired.push(`装备着：${equipment.join("、")}`);
  if (items.length) acquired.push(`持有：${items.join("、")}`);
  if (other.length) acquired.push(`当前状况：${other.join("；")}`);

  const segments: string[] = [];
  if (acquired.length) segments.push(...acquired);
  if (identity) segments.push(identity);
  if (!segments.length) return null;

  const content = `${name}：${segments.join("；")}`;
  return content.length > MAX_CONTENT_LEN ? content.slice(0, MAX_CONTENT_LEN) : content;
}

/**
 * 冷启动兜底：给"还没有任何记忆"的在场角色补一条基础记忆。
 *
 * # 为什么要这东西
 *
 * t_role_memory 的内容一律由记忆管理器 AI 凝练产出，而凝练是【增量】的 ——
 * 它只写"本轮新发生的事"。于是：
 *
 *   - 本功能上线前就存在的会话（老存档），角色从一开始就有的已知事实
 *     （掌握什么技能、持有什么东西、是什么身份）永远不会被补写；
 *   - 这些角色的召回结果恒为空，等于整套记忆功能对老会话完全失效，
 *     而且会一直失效下去 —— 除非剧情里碰巧又发生了新事。
 *
 * # 做法
 *
 * 每次记忆刷新链路跑完兜一次底：查出当前 story 下哪些在场角色还是"零记忆"，
 * 从各自参数卡合成一条事实写进去。
 *
 * # 幂等性
 *
 * 已有记忆的角色直接跳过（按 storyId + subjectId 判断存在性），
 * 所以重复调用不会产生噪音。
 */
/** 冷启动补写的流水账，给上层打日志用 */
export interface RoleMemoryBootstrapStats {
  /** 扫到的在场角色数（含用户） */
  scanned: number;
  /** 已有记忆、跳过的 */
  skipped: number;
  /** 参数卡没内容可提炼、跳过 */
  empty: number;
  /** 实际补写的 */
  written: number;
  /** 补写了谁 */
  writtenNames: string[];
}

export async function bootstrapRoleMemoriesFromCards(params: {
  sessionId: string;
  storyId: string | number;
  chapterId?: string | number | null;
  state: Record<string, any>;
  sourceTurn?: number | null;
}): Promise<RoleMemoryBootstrapStats> {
  const stats: RoleMemoryBootstrapStats = {
    scanned: 0,
    skipped: 0,
    empty: 0,
    written: 0,
    writtenNames: [],
  };
  try {
    const db = getGameDb();
    const storyId = String(params.storyId || "");
    if (!storyId || !db) return stats;

    // 1) 收集在场角色（用户 + NPC）的「名字 → 参数卡」映射
    const candidates: Array<{ name: string; card: Record<string, any>; subjectType: string; subjectId: string }> = [];
    const player = (params.state?.player && typeof params.state.player === "object")
      ? (params.state.player as Record<string, any>)
      : {};
    const playerName = String(player?.name || "").trim();
    const playerCard = (player?.parameterCardJson && typeof player.parameterCardJson === "object")
      ? (player.parameterCardJson as Record<string, any>)
      : {};
    if (playerName) {
      candidates.push({ name: playerName, card: playerCard, subjectType: "user", subjectId: "user" });
    }
    const npcBag = (params.state?.npcs && typeof params.state.npcs === "object")
      ? (params.state.npcs as Record<string, any>)
      : {};
    for (const npc of Object.values(npcBag)) {
      const bag = (npc && typeof npc === "object") ? (npc as Record<string, any>) : {};
      const name = String(bag?.name || "").trim();
      if (!name) continue;
      const card = (bag?.parameterCardJson && typeof bag.parameterCardJson === "object")
        ? (bag.parameterCardJson as Record<string, any>)
        : {};
      candidates.push({ name, card, subjectType: "npc_self", subjectId: name });
    }
    stats.scanned = candidates.length;
    if (!candidates.length) return stats;

    // 2) 一次查清哪些主体已经有记忆了
    const existingRows: Array<{ subjectId: string }> = await db("t_role_memory")
      .where({ storyId })
      .whereIn("subjectId", candidates.map((item) => item.subjectId))
      .select("subjectId")
      .catch(() => []);
    const alreadyHave = new Set(existingRows.map((row) => String(row.subjectId || "")));

    // 3) 只有"零记忆"的角色才补写
    const chapterId = params.chapterId != null ? String(params.chapterId) : null;
    const sourceTurn = params.sourceTurn ?? null;
    for (const item of candidates) {
      if (alreadyHave.has(item.subjectId)) {
        stats.skipped += 1;
        continue;
      }
      const content = synthesizeBootstrapFact(item.name, item.card);
      if (!content) {
        stats.empty += 1;
        continue;
      }
      const ok = await insertMemoryRow({
        db,
        sessionId: params.sessionId,
        storyId,
        chapterId,
        subjectType: item.subjectType,
        subjectId: item.subjectId,
        content,
        // 冷启动事实是"常驻底噪"，重要性低于剧情事实但不为零
        importance: 2,
        sourceTurn,
      });
      if (ok) {
        stats.written += 1;
        stats.writtenNames.push(item.name);
      }
    }
  } catch (err) {
    console.warn("[role-memory] bootstrap failed:", (err as any)?.message || String(err));
  }
  return stats;
}

/** 渲染为 prompt 文本块（有内容才有块，绝不输出空标题） */
export function formatRoleMemoryBlock(rows: RoleMemoryRow[], speakerName: string): string {
  if (!rows || !rows.length) return "";
  const lines = rows.map((row) => {
    const scope = row.subjectType === "user"
      ? "关于用户"
      : row.subjectType === "npc_self" && row.subjectId === speakerName
        ? "关于自己"
        : row.subjectType === "relation"
          ? "关系"
          : "世界";
    return `【${scope}】${row.content}`;
  });
  return ["[角色专属记忆]", ...lines].join("\n");
}