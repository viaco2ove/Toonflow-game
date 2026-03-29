import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import {
  getGameDb,
  normalizeChapterOutput,
  normalizeRolePair,
  normalizeSessionState,
} from "@/lib/gameEngine";
import {
  applyPlayerProfileFromMessageToState,
  runStorySpeakerContent,
  RuntimeMessageInput,
  runtimeStoryRoles,
} from "@/modules/game-runtime/engines/NarrativeOrchestrator";
import {
  asDebugMessage,
  buildDebugRecentMessages,
  debugMessageSchema,
  loadCachedDebugRuntimeState,
} from "./debugRuntimeShared";
import u from "@/utils";

const router = express.Router();

function writeStreamLine(res: express.Response, payload: Record<string, unknown>) {
  res.write(`${JSON.stringify(payload)}\n`);
}

function splitTextIntoChunks(text: string): string[] {
  const normalized = String(text || "").replace(/\r/g, "").trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let buffer = "";
  for (const char of normalized) {
    buffer += char;
    if (/[。！？!?；;\n]/.test(char) || buffer.length >= 18) {
      chunks.push(buffer);
      buffer = "";
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

function collectSentenceEvents(buffer: string, chunk: string) {
  const sentences: string[] = [];
  let nextBuffer = `${buffer}${chunk}`;
  while (/[。！？!?；;\n]/.test(nextBuffer)) {
    const matched = nextBuffer.match(/^[\s\S]*?[。！？!?；;\n]/);
    if (!matched) break;
    const sentence = matched[0].trim();
    nextBuffer = nextBuffer.slice(matched[0].length);
    if (sentence) {
      sentences.push(sentence);
    }
  }
  return {
    buffer: nextBuffer,
    sentences,
  };
}

export default router.post(
  "/",
  validateFields({
    worldId: z.number(),
    chapterId: z.number().optional().nullable(),
    playerContent: z.string().optional().nullable(),
    state: z.any().optional().nullable(),
    messages: z.array(debugMessageSchema).optional().nullable(),
    plan: z.object({
      role: z.string().optional().nullable(),
      roleType: z.string().optional().nullable(),
      motive: z.string().optional().nullable(),
      eventType: z.string().optional().nullable(),
      presetContent: z.string().optional().nullable(),
    }).passthrough(),
  }),
  async (req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    try {
      const db = getGameDb();
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        res.status(401);
        writeStreamLine(res, { type: "error", data: { message: "用户未登录" } });
        return;
      }

      const worldId = Number(req.body.worldId || 0);
      const chapterId = Number(req.body.chapterId || 0);
      const playerContent = String(req.body.playerContent || "").trim();
      const plan = (req.body.plan || {}) as Record<string, unknown>;
      const inputMessages = (Array.isArray(req.body.messages) ? req.body.messages : []) as RuntimeMessageInput[];

      const world = await db("t_storyWorld as w")
        .leftJoin("t_project as p", "w.projectId", "p.id")
        .where("w.id", worldId)
        .where("p.userId", userId)
        .select("w.*")
        .first();
      if (!world) {
        res.status(404);
        writeStreamLine(res, { type: "error", data: { message: "未找到故事" } });
        return;
      }

      let chapter: any = null;
      if (chapterId > 0) {
        chapter = await db("t_storyChapter").where({ id: chapterId, worldId }).first();
      }
      if (!chapter) {
        chapter = await db("t_storyChapter").where({ worldId }).orderBy("sort", "asc").orderBy("id", "asc").first();
      }
      chapter = normalizeChapterOutput(chapter);
      if (!chapter) {
        res.status(404);
        writeStreamLine(res, { type: "error", data: { message: "当前没有章节可调试" } });
        return;
      }

      const rolePair = normalizeRolePair(world.playerRole, world.narratorRole);
      const cachedRuntimeState = loadCachedDebugRuntimeState(req.body.state, userId, worldId);
      const state = normalizeSessionState(
        cachedRuntimeState || req.body.state,
        worldId,
        Number(chapter.id || 0),
        rolePair,
      );
      if (playerContent) {
        applyPlayerProfileFromMessageToState(state, world, playerContent);
      }
      const messages = inputMessages.map((item) => ({
        role: String(item.role || ""),
        roleType: String(item.roleType || ""),
        eventType: String(item.eventType || ""),
        content: String(item.content || ""),
        createTime: Number(item.createTime || 0),
      }));
      const recentMessages = buildDebugRecentMessages(messages, String(state.player?.name || rolePair.playerRole.name || "用户"), playerContent);
      const roleName = String(plan.role || "").trim();
      const roleType = String(plan.roleType || "").trim() || "narrator";
      const eventType = String(plan.eventType || "on_orchestrated_reply").trim() || "on_orchestrated_reply";
      const presetContent = String(plan.presetContent || "").trim();

      writeStreamLine(res, {
        type: "start",
        data: {
          role: roleName,
          roleType,
          eventType,
        },
      });

      let content = presetContent;
      if (!content) {
        const roles = runtimeStoryRoles(world, state);
        const currentRole = roles.find((item) => item.name === roleName)
          || roles.find((item) => item.roleType === roleType && roleType !== "player")
          || null;
        if (!currentRole) {
          throw new Error("当前流式发言角色不存在");
        }
        content = await runStorySpeakerContent({
          userId,
          world,
          chapter,
          state,
          recentMessages,
          playerMessage: playerContent,
          currentRole,
          motive: String(plan.motive || "").trim(),
        });
      }

      const chunks = splitTextIntoChunks(content);
      let sentenceBuffer = "";
      for (const chunk of chunks) {
        writeStreamLine(res, { type: "delta", data: { text: chunk } });
        const collected = collectSentenceEvents(sentenceBuffer, chunk);
        sentenceBuffer = collected.buffer;
        for (const sentence of collected.sentences) {
          writeStreamLine(res, { type: "sentence", data: { text: sentence } });
        }
      }
      const tailSentence = sentenceBuffer.trim();
      if (tailSentence) {
        writeStreamLine(res, { type: "sentence", data: { text: tailSentence } });
      }

      writeStreamLine(res, {
        type: "done",
        data: {
          content,
          message: asDebugMessage({
            role: roleName || "旁白",
            roleType,
            eventType,
            content,
          }),
        },
      });
    } catch (err) {
      writeStreamLine(res, {
        type: "error",
        data: {
          message: u.error(err).message,
        },
      });
    } finally {
      res.end();
    }
  },
);
