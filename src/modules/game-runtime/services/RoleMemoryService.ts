/**
 * RoleMemoryService —— 角色专属记忆的写入与查询（P1）
 *
 * 问题背景：
 *   memoryFacts 存在 session state JSON 里，12 条硬截断、全员共享同一本账：
 *   - 旧事实被新事实挤出，NPC 几十轮后“失忆”；
 *   - 张三的隐私李四也读得到，角色认知无法隔离。
 *
 * 方案：
 *   建表 t_role_memory（见 src/migrations/20260909_000001_add_role_memory_table.js），
 *   记忆凝练完成后（scheduleSessionMemoryRefresh.onResolved）异步写入，
 *   角色发言（NarrativeOrchestrator.buildSpeakerUserPrompt 组装 payload 时）
 *   按 storyId + speakerName 过滤查询，注入「角色专属记忆」块。
 *
 * 归属判定（按角色名匹配事实句）：
 *   - fact 含某角色名 → subjectType=npc_self, subjectId=角色名
 *   - fact 含用户角色名/「用户」→ subjectType=user, subjectId='user'
 *   - 其余 → subjectType=world, subjectId=''（全局共享）
 *
 * 查询纪律（防串戏）：
 *   发言器只取 subjectId IN (说话人名, 'user', '') 的记忆，
 *   且按 importance DESC + createdAt DESC 排序，limit 8。
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
  const hit = roleNames.find((name) => name && text.includes(name));
  if (hit) {
    return { subjectType: "npc_self", subjectId: hit };
  }
  return { subjectType: "world", subjectId: "" };
}

/**
 * 记忆凝练完成后调用：把事实句写入 t_role_memory（带去重）。
 * 任何失败只打日志，绝不影响主链路。
 */
export async function persistRoleMemoryFacts(params: {
  sessionId: string;
  storyId: string | number;
  chapterId?: string | number | null;
  roleNames: string[];
  playerRoleName: string;
  memoryFacts: string[];
  sourceTurn?: number | null;
}): Promise<number> {
  let written = 0;
  try {
    const db = getGameDb();
    const storyId = String(params.storyId || "");
    if (!storyId || !db) return 0;
    const facts = (params.memoryFacts || [])
      .map((f) => String(f || "").trim())
      .filter(Boolean)
      .slice(0, MAX_WRITE_PER_TURN);
    if (!facts.length) return 0;

    const now = Date.now();
    for (const fact of facts) {
      const content = fact.length > MAX_CONTENT_LEN ? fact.slice(0, MAX_CONTENT_LEN) : fact;
      const { subjectType, subjectId } = detectSubject(content, params.roleNames, params.playerRoleName);
      // 同 storyId + subjectId + content 已存在则跳过，防止 worker 每 30s 重复写
      const exists = await db("t_role_memory")
        .where({ storyId, subjectId, content })
        .first()
        .catch(() => null);
      if (exists) continue;
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
      written += 1;
    }
  } catch (err) {
    console.warn("[role-memory] persist failed:", (err as any)?.message || String(err));
  }
  return written;
}

/**
 * 发言器读取：说话人可见的记忆 = 自己的 + 关于用户的 + 全局的。
 * 返回带命中信息（P2 向量召回可复用同一出口）。
 */
export async function loadRoleMemoriesForSpeaker(params: {
  storyId: string | number;
  speakerName: string;
  limit?: number;
}): Promise<RoleMemoryRow[]> {
  try {
    const db = getGameDb();
    const storyId = String(params.storyId || "");
    if (!storyId || !db || !params.speakerName) return [];
    const limit = Math.min(Math.max(Number(params.limit || 8), 1), 12);
    const rows: RoleMemoryRow[] = await db("t_role_memory")
      .where({ storyId })
      .whereIn("subjectId", [params.speakerName, "user", ""])
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
 * 2. 扫全表（storyId 下所有有 vec 的行）
 * 3. score = 0.5*cos + 0.3*importance/5 + 0.2*timeDecay（timeDecay = 0.5^(Δturn/50)）
 * 4. 取 top N，按 subjectId 过滤（防串戏），上限 3 条/最高 200 token
 * 5. 失败时降级回 SQL 排序
 *
 * @param recallQueries  召回查询语句（多个则 max pooling）
 * @param speakerName    当前说话人角色名
 * @param currentTurn    当前 eventIndex（算时间衰减）
 * @param topK           取 topN（默认 3）
 * @param tokenBudget    最高 token 预算（默认 200，约 3 条 x ~60 字）
 */
export async function recallRoleMemories(params: {
  storyId: string | number;
  recallQueries: string[];
  speakerName: string;
  currentTurn?: number | null;
  limit?: number;
  tokenBudget?: number;
}): Promise<RoleMemoryRow[]> {
  const {
    storyId,
    recallQueries,
    speakerName,
    currentTurn = 0,
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

    // 2. 拉全表向量数据（只看有 vec 的行）
    const allRows: RoleMemoryRow[] = await db("t_role_memory")
      .where({ storyId: sid })
      .whereIn("subjectId", [speakerName, "user", ""])
      .whereNotNull("vec")
      .select("*");

    if (!allRows.length) return [];

    // 3. 暴力扫描，计算加权分
    const now = Date.now();
    const scored = allRows
      .map((row) => {
        const vec = blobToVector(row.vec as unknown as Buffer);
        if (!vec) return null;
        const cos = cosineScore(queryVec!, vec);
        const importance = (row.importance ?? 3) / 5;
        const turnDelta = Math.abs((row.sourceTurn ?? 0) - (currentTurn ?? 0));
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