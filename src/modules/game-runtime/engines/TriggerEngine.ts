import {
  evaluateCondition,
  getValueByPath,
  normalizeActionList,
  setValueByPath,
} from "@/lib/gameEngine";
import {
  ApplyRuntimeActionInput,
  AppliedDelta,
  AttributeChangeInput,
  RuntimeActionExecutionResult,
  TriggerExecutionInput,
  TriggerExecutionResult,
  TriggerHit,
} from "@/modules/game-runtime/types/runtime";

function resolvePath(change: AttributeChangeInput): { path: string; entityType: string; entityId: string; field: string } | null {
  const fieldRaw = String(change.field || "").trim();
  if (!fieldRaw) return null;

  const entityType = String(change.entityType || "player").trim().toLowerCase();
  const entityId = String(change.entityId || "").trim();
  if (fieldRaw.startsWith("state.")) {
    const purePath = fieldRaw.replace(/^state\./, "");
    return { path: purePath, entityType, entityId: entityId || "state", field: purePath };
  }

  if (entityType === "player") {
    const path = fieldRaw.startsWith("player.") ? fieldRaw : `player.attributes.${fieldRaw}`;
    return { path, entityType: "player", entityId: entityId || "player", field: fieldRaw };
  }

  if (entityType === "narrator") {
    const path = fieldRaw.startsWith("narrator.") ? fieldRaw : `narrator.attributes.${fieldRaw}`;
    return { path, entityType: "narrator", entityId: entityId || "narrator", field: fieldRaw };
  }

  if (entityType === "npc") {
    const npcId = entityId || "unknown";
    const path = fieldRaw.startsWith("npcs.") ? fieldRaw : `npcs.${npcId}.attributes.${fieldRaw}`;
    return { path, entityType: "npc", entityId: npcId, field: fieldRaw };
  }

  if (entityType === "vars" || entityType === "var") {
    const path = fieldRaw.startsWith("vars.") ? fieldRaw : `vars.${fieldRaw}`;
    return { path, entityType: "vars", entityId: "vars", field: fieldRaw };
  }

  if (entityType === "flags" || entityType === "flag") {
    const path = fieldRaw.startsWith("flags.") ? fieldRaw : `flags.${fieldRaw}`;
    return { path, entityType: "flags", entityId: "flags", field: fieldRaw };
  }

  return { path: fieldRaw, entityType, entityId: entityId || entityType || "state", field: fieldRaw };
}

export function applyAttributeChanges(state: Record<string, any>, attrChanges: AttributeChangeInput[]): AppliedDelta[] {
  const deltas: AppliedDelta[] = [];
  for (const rawChange of attrChanges) {
    const resolved = resolvePath(rawChange);
    if (!resolved) continue;

    const oldValue = getValueByPath(state, resolved.path);
    setValueByPath(state, resolved.path, rawChange.value);
    deltas.push({
      entityType: resolved.entityType,
      entityId: resolved.entityId,
      field: resolved.field,
      oldValue,
      newValue: rawChange.value,
      source: String(rawChange.source || "message_attr_change"),
    });
  }
  return deltas;
}

export function applyRuntimeAction(input: ApplyRuntimeActionInput): RuntimeActionExecutionResult {
  const {
    state,
    action,
    sourceTag,
    appliedDeltas,
    nextChapterId,
    sessionStatus,
  } = input;

  const actionType = String(action.type || action.action || "").trim().toLowerCase();
  let nextChapter = nextChapterId;
  let nextStatus = sessionStatus;

  if (actionType === "set_state") {
    const path = String(action.path || action.field || "").trim();
    if (!path) return { nextChapterId: nextChapter, sessionStatus: nextStatus };
    const oldValue = getValueByPath(state, path);
    setValueByPath(state, path, action.value);
    appliedDeltas.push({
      entityType: "state",
      entityId: "state",
      field: path,
      oldValue,
      newValue: action.value,
      source: sourceTag,
    });
    return { nextChapterId: nextChapter, sessionStatus: nextStatus };
  }

  if (actionType === "add_item") {
    const item = action.item ?? action.value;
    const inventory = Array.isArray(state.inventory) ? state.inventory : [];
    inventory.push(item);
    state.inventory = inventory;
    return { nextChapterId: nextChapter, sessionStatus: nextStatus };
  }

  if (actionType === "switch_chapter") {
    const chapterValue = Number(action.chapterId ?? action.targetChapterId);
    if (Number.isFinite(chapterValue) && chapterValue > 0) {
      nextChapter = chapterValue;
      state.chapterId = chapterValue;
    }
    return { nextChapterId: nextChapter, sessionStatus: nextStatus };
  }

  if (actionType === "complete_chapter") {
    setValueByPath(state, "flags.chapterCompleted", true);
    nextStatus = "chapter_completed";
    const chapterValue = Number(action.nextChapterId || action.chapterId || 0);
    if (Number.isFinite(chapterValue) && chapterValue > 0) {
      nextChapter = chapterValue;
      state.chapterId = chapterValue;
      nextStatus = "active";
    }
    return { nextChapterId: nextChapter, sessionStatus: nextStatus };
  }

  if (actionType === "unlock_role") {
    const roleId = String(action.roleId || action.id || "").trim();
    if (!roleId) return { nextChapterId: nextChapter, sessionStatus: nextStatus };
    const roleList = Array.isArray(state.unlockedRoles) ? state.unlockedRoles : [];
    if (!roleList.includes(roleId)) roleList.push(roleId);
    state.unlockedRoles = roleList;
    return { nextChapterId: nextChapter, sessionStatus: nextStatus };
  }

  if (actionType === "add_state") {
    const path = String(action.path || action.field || "").trim();
    const amount = Number(action.amount ?? action.value ?? 0);
    if (!path || !Number.isFinite(amount)) return { nextChapterId: nextChapter, sessionStatus: nextStatus };
    const oldValue = Number(getValueByPath(state, path) || 0);
    const newValue = oldValue + amount;
    setValueByPath(state, path, newValue);
    appliedDeltas.push({
      entityType: "state",
      entityId: "state",
      field: path,
      oldValue,
      newValue,
      source: sourceTag,
    });
    return { nextChapterId: nextChapter, sessionStatus: nextStatus };
  }

  return { nextChapterId: nextChapter, sessionStatus: nextStatus };
}

export async function runTriggerEngine(input: TriggerExecutionInput): Promise<TriggerExecutionResult> {
  const {
    db,
    chapterId,
    state,
    messageContent,
    eventType,
    meta,
    initialStatus,
  } = input;

  const appliedDeltas: AppliedDelta[] = [];
  const triggerHits: TriggerHit[] = [];
  let sessionStatus = initialStatus;
  let nextChapterId = Number(state.chapterId || chapterId || 0) || null;

  const currentChapter = nextChapterId ? await db("t_storyChapter").where({ id: nextChapterId }).first() : null;
  const triggerRows = currentChapter
    ? await db("t_chapterTrigger")
      .where({ chapterId: Number(currentChapter.id), enabled: 1 })
      .orderBy("sort", "asc")
      .orderBy("id", "asc")
    : [];

  for (const trigger of triggerRows) {
    const triggerEvent = String(trigger.triggerEvent || "on_message").trim().toLowerCase();
    const eventLower = eventType.toLowerCase();
    if (!["*", "all", eventLower].includes(triggerEvent)) {
      continue;
    }

    const matched = evaluateCondition(trigger.conditionExpr, {
      state,
      messageContent,
      eventType,
      meta,
    });
    if (!matched) continue;

    const actions = normalizeActionList(trigger.actionExpr);
    for (const action of actions) {
      const actionResult = applyRuntimeAction({
        state,
        action,
        sourceTag: `trigger:${trigger.id}`,
        appliedDeltas,
        nextChapterId,
        sessionStatus,
      });
      nextChapterId = actionResult.nextChapterId;
      sessionStatus = actionResult.sessionStatus;
    }

    triggerHits.push({
      triggerId: Number(trigger.id),
      name: String(trigger.name || "未命名触发器"),
      eventType: String(trigger.triggerEvent || "on_message"),
      actionCount: actions.length,
    });
  }

  return {
    appliedDeltas,
    triggerHits,
    nextChapterId,
    sessionStatus,
  };
}
