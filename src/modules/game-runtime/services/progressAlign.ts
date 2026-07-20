/**
 * 方向2：发布后进度对齐（确定性，非迁移）。
 *
 * 单版本覆盖下，作者发布新版后旧 session 下次编排会自动落到新 outline。
 * 这里把 session state 里"引用旧 phase 结构"的字段对齐到新 outline，
 * 其余动态数据（facts/flags/vars/npcs/memory）一字不改。
 *
 * 零 token、幂等、纯本地。对齐报告返回前端作为"聊过"面板弹框预览。
 */
import { ChapterProgressState, ChapterRuntimeOutline } from "@/lib/gameEngine";

export interface ProgressAlignReport {
  mapped: Array<{ from: string; to: string; reason: "exact" | "name" | "nearby" }>;
  fallback: Array<{ from: string; to: string }>;
  dropped: string[];
  /** 是否存在 phase 改名无法精确匹配（前端据此显示"智能对齐"按钮） */
  hasUnmatchedRename: boolean;
}

export interface ProgressAlignInput {
  /** 旧 outline 的 phase id 列表（按顺序）。可为空数组（旧 session 无记录时）。 */
  oldPhaseIds: string[];
  /** 新 published outline */
  newOutline: ChapterRuntimeOutline;
  /** session state（会被原地修改并返回） */
  state: Record<string, any>;
}

export interface ProgressAlignResult {
  state: Record<string, any>;
  report: ProgressAlignReport;
}

/** 取 outline 的 phase id 列表（按顺序）。 */
function extractPhaseIds(outline: ChapterRuntimeOutline | null | undefined): string[] {
  if (!outline || !Array.isArray(outline.phases)) return [];
  return outline.phases.map((p: any) => String(p?.id || "")).filter(Boolean);
}

/**
 * 构建 phase 映射：oldPhaseId -> newPhaseId。
 * 优先级：精确 id 匹配 -> 相近索引就近 -> 都不行返回 null（回退首 phase）。
 *
 * 注：设计文档里的"同名/改名语义匹配"在单版本覆盖下确定性不可行--
 * 旧 outline 已被新版覆盖，旧 phase 的 label 无从获取（state 里只存了 phaseId，没存 label）。
 * 因此改名匹配交给可选的 AI 路径（见 ai_agent_版本更新存档升级助手.md），
 * 确定性对齐只做精确 id + 索引兜底，并把"索引兜底"标为 hasUnmatchedRename 供前端弹"智能对齐"按钮。
 */
function buildPhaseMapping(
  oldPhaseIds: string[],
  newOutline: ChapterRuntimeOutline,
): { mapping: Map<string, string>; report: ProgressAlignReport } {
  const newPhaseIds = extractPhaseIds(newOutline);

  const mapping = new Map<string, string>();
  const mapped: ProgressAlignReport["mapped"] = [];
  const fallback: ProgressAlignReport["fallback"] = [];
  const dropped: string[] = [];
  let hasUnmatchedRename = false;

  oldPhaseIds.forEach((oldId, index) => {
    // 1. 精确 id 匹配
    if (newPhaseIds.includes(oldId)) {
      mapping.set(oldId, oldId);
      mapped.push({ from: oldId, to: oldId, reason: "exact" });
      return;
    }
    // 2. 相近索引就近（确定性兜底；改名场景标 hasUnmatchedRename 供前端走 AI 智能对齐）
    const nearbyNewId = newPhaseIds[index] || newPhaseIds[Math.min(index, newPhaseIds.length - 1)];
    if (nearbyNewId) {
      mapping.set(oldId, nearbyNewId);
      mapped.push({ from: oldId, to: nearbyNewId, reason: "nearby" });
      hasUnmatchedRename = true;
      return;
    }
    // 都不行：丢弃
    dropped.push(oldId);
  });

  return {
    mapping,
    report: { mapped, fallback, dropped, hasUnmatchedRename },
  };
}

/** 映射一个 phaseId；无映射则回退到新 outline 首个 phase。 */
function resolvePhaseId(
  oldPhaseId: string,
  mapping: Map<string, string>,
  newPhaseIds: string[],
  report: ProgressAlignReport,
): string {
  const mapped = mapping.get(oldPhaseId);
  if (mapped) return mapped;
  // 回退首 phase
  const first = newPhaseIds[0] || "";
  if (first && oldPhaseId) {
    report.fallback.push({ from: oldPhaseId, to: first });
  }
  return first;
}

/**
 * 执行确定性对齐。原地修改 state，返回对齐报告。
 */
export function alignSessionProgress(input: ProgressAlignInput): ProgressAlignResult {
  const { oldPhaseIds, newOutline, state } = input;
  const newPhaseIds = extractPhaseIds(newOutline);
  const { mapping, report } = buildPhaseMapping(oldPhaseIds, newOutline);

  // 1. chapterProgress.phaseId 对齐
  const progress = state?.chapterProgress;
  if (progress && typeof progress === "object") {
    const oldPhaseId = String(progress.phaseId || "");
    if (oldPhaseId) {
      const newPhaseId = resolvePhaseId(oldPhaseId, mapping, newPhaseIds, report);
      progress.phaseId = newPhaseId;
      // phaseIndex 跟随
      const newPhaseIndex = newPhaseIds.indexOf(newPhaseId);
      if (newPhaseIndex >= 0) progress.phaseIndex = newPhaseIndex;
      // 若回退到首 phase（非精确映射），eventIndex 清零
      if (!mapping.has(oldPhaseId)) {
        progress.eventIndex = 0;
      }
    }
    // 2. completedEvents 里的 phaseId 映射
    if (Array.isArray(progress.completedEvents)) {
      progress.completedEvents = progress.completedEvents
        .map((entry: string) => {
          if (typeof entry !== "string") return entry;
          if (entry.startsWith("phase:")) {
            const oldId = entry.slice(6);
            const newId = mapping.get(oldId);
            if (newId) return `phase:${newId}`;
            // 无映射的失效引用：丢弃
            report.dropped.push(`completedEvents:${oldId}`);
            return null;
          }
          return entry;
        })
        .filter((entry: any) => entry !== null);
    }
  }

  // 3. dynamicEvents[].phaseId 跟随对齐
  if (Array.isArray(state?.dynamicEvents)) {
    for (const ev of state.dynamicEvents) {
      if (ev && typeof ev === "object") {
        const oldId = String(ev.phaseId || "");
        if (oldId) {
          const newId = mapping.get(oldId);
          if (newId) ev.phaseId = newId;
          // 无映射的保留原值（编排师自然忽略），不丢运行时事实
        }
      }
    }
  }

  // 4. recentEvents[].phaseId：能映射映射，不能的过滤
  if (Array.isArray(state?.recentEvents)) {
    state.recentEvents = state.recentEvents.filter((entry: any) => {
      if (!entry || typeof entry !== "object") return true;
      const oldId = String(entry.phaseId || "");
      if (!oldId) return true;
      if (mapping.has(oldId)) {
        entry.phaseId = mapping.get(oldId);
        return true;
      }
      // 失效引用：过滤
      report.dropped.push(`recentEvents:${oldId}`);
      return false;
    });
  }

  // 5. 其余动态数据（runtimeFacts / memoryFacts / memorySummary / flags / vars / npcs / inventory /
  //    unlockedRoles / player / narrator）原样保留，不做任何改动。

  // 6. turnState 重置为"等待玩家输入"安全态
  if (state && typeof state === "object") {
    state.turnState = {
      ...(state.turnState || {}),
      canPlayerSpeak: true,
      expectedRoleType: "player",
      expectedRole: String(state?.player?.name || "用户"),
    };
  }

  return { state, report };
}

/**
 * 从 session state 提取旧 phase id 列表（用于对齐）。
 * 优先用 chapterProgress.phaseId + completedEvents + dynamicEvents 里出现过的 phaseId。
 */
export function extractOldPhaseIdsFromState(state: Record<string, any>): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    const v = String(id || "").trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      ids.push(v);
    }
  };
  const progress = state?.chapterProgress;
  if (progress && typeof progress === "object") {
    push(progress.phaseId);
    if (Array.isArray(progress.completedEvents)) {
      for (const entry of progress.completedEvents) {
        if (typeof entry === "string" && entry.startsWith("phase:")) {
          push(entry.slice(6));
        }
      }
    }
  }
  if (Array.isArray(state?.dynamicEvents)) {
    for (const ev of state.dynamicEvents) {
      if (ev && typeof ev === "object") push(ev.phaseId);
    }
  }
  if (Array.isArray(state?.recentEvents)) {
    for (const entry of state.recentEvents) {
      if (entry && typeof entry === "object") push(entry.phaseId);
    }
  }
  return ids;
}
