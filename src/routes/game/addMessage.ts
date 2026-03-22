import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  evaluateCondition,
  getGameDb,
  getValueByPath,
  normalizeActionList,
  normalizeMessageOutput,
  normalizeRolePair,
  normalizeSessionState,
  nowTs,
  parseJsonSafe,
  setValueByPath,
  toJsonText,
} from "@/lib/gameEngine";
import u from "@/utils";

interface AttributeChangeInput {
  entityType?: string | null;
  entityId?: string | null;
  field?: string | null;
  value?: unknown;
  source?: string | null;
}

interface AppliedDelta {
  entityType: string;
  entityId: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  source: string;
}

interface TriggerHit {
  triggerId: number;
  name: string;
  eventType: string;
  actionCount: number;
}

const router = express.Router();

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

function pushRecentEvent(state: Record<string, any>, event: Record<string, any>) {
  const current = Array.isArray(state.recentEvents) ? state.recentEvents : [];
  current.push(event);
  state.recentEvents = current.slice(-20);
}

function parseJsonMaybe(input: unknown): Record<string, any> {
  return parseJsonSafe<Record<string, any>>(input, {});
}

export default router.post(
  "/",
  validateFields({
    sessionId: z.string(),
    roleType: z.enum(["player", "narrator", "npc", "system"]).optional().nullable(),
    role: z.string().optional().nullable(),
    content: z.string(),
    eventType: z.string().optional().nullable(),
    meta: z.any().optional().nullable(),
    attrChanges: z
      .array(
        z.object({
          entityType: z.string().optional().nullable(),
          entityId: z.string().optional().nullable(),
          field: z.string().optional().nullable(),
          value: z.any().optional(),
          source: z.string().optional().nullable(),
        }),
      )
      .optional()
      .nullable(),
    saveSnapshot: z.boolean().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const {
        sessionId,
        roleType,
        role,
        content,
        eventType,
        meta,
        attrChanges,
        saveSnapshot,
      } = req.body;

      const db = getGameDb();
      const now = nowTs();
      const sessionIdValue = String(sessionId || "").trim();
      if (!sessionIdValue) {
        return res.status(400).send(error("sessionId 不能为空"));
      }

      const sessionRow = await db("t_gameSession").where({ sessionId: sessionIdValue }).first();
      if (!sessionRow) {
        return res.status(404).send(error("会话不存在"));
      }

      const world = await db("t_storyWorld").where({ id: Number(sessionRow.worldId || 0) }).first();
      const rolePair = normalizeRolePair(world?.playerRole, world?.narratorRole);
      const prevChapterId = Number(sessionRow.chapterId || 0) || null;
      const prevStatus = String(sessionRow.status || "active");

      let state = normalizeSessionState(sessionRow.stateJson, Number(sessionRow.worldId || 0), prevChapterId, rolePair);
      state.round = Number(state.round || 0) + 1;

      const roleTypeValue = String(roleType || "player").trim();
      const roleValue = String(role || (roleTypeValue === "player" ? state.player?.name || "玩家" : "系统")).trim();
      const eventTypeValue = String(eventType || "on_message").trim() || "on_message";
      const metaObj = parseJsonMaybe(meta);

      const insertMessageResult = await db("t_sessionMessage").insert({
        sessionId: sessionIdValue,
        role: roleValue,
        roleType: roleTypeValue,
        content: String(content || ""),
        eventType: eventTypeValue,
        meta: toJsonText(metaObj, {}),
        createTime: now,
      });
      const messageId = Number(Array.isArray(insertMessageResult) ? insertMessageResult[0] : insertMessageResult);

      const appliedDeltas: AppliedDelta[] = [];
      const attrChangeList = Array.isArray(attrChanges) ? attrChanges : [];
      for (const rawChange of attrChangeList) {
        const change = rawChange as AttributeChangeInput;
        const resolved = resolvePath(change);
        if (!resolved) continue;

        const oldValue = getValueByPath(state, resolved.path);
        setValueByPath(state, resolved.path, change.value);
        const delta: AppliedDelta = {
          entityType: resolved.entityType,
          entityId: resolved.entityId,
          field: resolved.field,
          oldValue,
          newValue: change.value,
          source: String(change.source || "message_attr_change"),
        };
        appliedDeltas.push(delta);
      }

      const triggerHits: TriggerHit[] = [];
      let sessionStatus = prevStatus;
      let nextChapterId = Number(state.chapterId || prevChapterId || 0) || null;
      const currentChapter = nextChapterId ? await db("t_storyChapter").where({ id: nextChapterId }).first() : null;

      const triggerRows = currentChapter
        ? await db("t_chapterTrigger").where({ chapterId: Number(currentChapter.id), enabled: 1 }).orderBy("sort", "asc").orderBy("id", "asc")
        : [];

      for (const trigger of triggerRows) {
        const triggerEvent = String(trigger.triggerEvent || "on_message").trim().toLowerCase();
        const eventLower = eventTypeValue.toLowerCase();
        if (!["*", "all", eventLower].includes(triggerEvent)) {
          continue;
        }

        const matched = evaluateCondition(trigger.conditionExpr, {
          state,
          messageContent: String(content || ""),
          eventType: eventTypeValue,
          meta: metaObj,
        });
        if (!matched) continue;

        const actions = normalizeActionList(trigger.actionExpr);
        for (const action of actions) {
          const actionType = String(action.type || action.action || "").trim().toLowerCase();

          if (actionType === "set_state") {
            const path = String(action.path || action.field || "").trim();
            if (!path) continue;
            const oldValue = getValueByPath(state, path);
            setValueByPath(state, path, action.value);
            appliedDeltas.push({
              entityType: "state",
              entityId: "state",
              field: path,
              oldValue,
              newValue: action.value,
              source: `trigger:${trigger.id}`,
            });
            continue;
          }

          if (actionType === "add_item") {
            const item = action.item ?? action.value;
            const inventory = Array.isArray(state.inventory) ? state.inventory : [];
            inventory.push(item);
            state.inventory = inventory;
            continue;
          }

          if (actionType === "switch_chapter") {
            const chapterValue = Number(action.chapterId ?? action.targetChapterId);
            if (Number.isFinite(chapterValue) && chapterValue > 0) {
              nextChapterId = chapterValue;
              state.chapterId = chapterValue;
            }
            continue;
          }

          if (actionType === "complete_chapter") {
            setValueByPath(state, "flags.chapterCompleted", true);
            sessionStatus = "chapter_completed";
            const chapterValue = Number(action.nextChapterId || action.chapterId || 0);
            if (Number.isFinite(chapterValue) && chapterValue > 0) {
              nextChapterId = chapterValue;
              state.chapterId = chapterValue;
              sessionStatus = "active";
            }
            continue;
          }

          if (actionType === "unlock_role") {
            const roleId = String(action.roleId || action.id || "").trim();
            if (!roleId) continue;
            const roleList = Array.isArray(state.unlockedRoles) ? state.unlockedRoles : [];
            if (!roleList.includes(roleId)) roleList.push(roleId);
            state.unlockedRoles = roleList;
            continue;
          }

          if (actionType === "add_state") {
            const path = String(action.path || action.field || "").trim();
            const amount = Number(action.amount ?? action.value ?? 0);
            if (!path || !Number.isFinite(amount)) continue;
            const oldValue = Number(getValueByPath(state, path) || 0);
            const newValue = oldValue + amount;
            setValueByPath(state, path, newValue);
            appliedDeltas.push({
              entityType: "state",
              entityId: "state",
              field: path,
              oldValue,
              newValue,
              source: `trigger:${trigger.id}`,
            });
            continue;
          }
        }

        triggerHits.push({
          triggerId: Number(trigger.id),
          name: String(trigger.name || "未命名触发器"),
          eventType: String(trigger.triggerEvent || "on_message"),
          actionCount: actions.length,
        });
      }

      const chapterToCheck = nextChapterId
        ? await db("t_storyChapter").where({ id: nextChapterId }).first()
        : null;
      if (chapterToCheck?.completionCondition) {
        const chapterDone = evaluateCondition(chapterToCheck.completionCondition, {
          state,
          messageContent: String(content || ""),
          eventType: eventTypeValue,
          meta: metaObj,
        });
        if (chapterDone) {
          setValueByPath(state, "flags.chapterCompleted", true);
          sessionStatus = "chapter_completed";
          triggerHits.push({
            triggerId: 0,
            name: "章节完成检测",
            eventType: "chapter_completion",
            actionCount: 1,
          });
        }
      }

      pushRecentEvent(state, {
        messageId,
        eventType: eventTypeValue,
        roleType: roleTypeValue,
        contentPreview: String(content || "").slice(0, 120),
        time: now,
      });

      const stateJson = toJsonText(state, {});
      await db("t_gameSession")
        .where({ sessionId: sessionIdValue })
        .update({
          stateJson,
          chapterId: nextChapterId,
          status: sessionStatus,
          updateTime: now,
        });

      for (const delta of appliedDeltas) {
        await db("t_entityStateDelta").insert({
          sessionId: sessionIdValue,
          eventId: `message:${messageId}`,
          entityType: delta.entityType,
          entityId: delta.entityId,
          field: delta.field,
          oldValue: toJsonText(delta.oldValue, null),
          newValue: toJsonText(delta.newValue, null),
          source: delta.source,
          createTime: now,
        });
      }

      let chapterSwitchMessage: any = null;
      if (nextChapterId && nextChapterId !== prevChapterId) {
        const switchedChapter = await db("t_storyChapter").where({ id: nextChapterId }).first();
        if (switchedChapter) {
          const inserted = await db("t_sessionMessage").insert({
            sessionId: sessionIdValue,
            role: String(state.narrator?.name || "旁白"),
            roleType: "narrator",
            content: `进入章节《${String(switchedChapter.title || "未命名章节")}》`,
            eventType: "on_enter_chapter",
            meta: toJsonText({ chapterId: Number(switchedChapter.id) }, {}),
            createTime: now,
          });
          const switchMessageId = Number(Array.isArray(inserted) ? inserted[0] : inserted);
          chapterSwitchMessage = await db("t_sessionMessage").where({ id: switchMessageId }).first();
        }
      }

      const snapshotReason = saveSnapshot
        ? "manual"
        : nextChapterId !== prevChapterId
          ? "chapter_switched"
          : sessionStatus !== prevStatus
            ? "status_changed"
            : Number(state.round || 0) % 5 === 0
              ? "auto_round"
              : "";

      let snapshotSaved = false;
      if (snapshotReason) {
        await db("t_sessionStateSnapshot").insert({
          sessionId: sessionIdValue,
          stateJson,
          reason: snapshotReason,
          round: Number(state.round || 0),
          createTime: now,
        });
        snapshotSaved = true;
      }

      const messageRow = await db("t_sessionMessage").where({ id: messageId }).first();
      res.status(200).send(
        success({
          sessionId: sessionIdValue,
          status: sessionStatus,
          chapterId: nextChapterId,
          state,
          message: normalizeMessageOutput(messageRow),
          chapterSwitchMessage: normalizeMessageOutput(chapterSwitchMessage),
          triggered: triggerHits,
          deltas: appliedDeltas,
          snapshotSaved,
        }),
      );
    } catch (err) {
      res.status(500).send(error(u.error(err).message));
    }
  },
);
