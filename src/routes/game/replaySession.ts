import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { getGameDb } from "@/lib/gameEngine";
import { ensureWorldRolesWithAiParameterCards } from "@/lib/roleParameterCard";
import { clearSessionRevisitCache, withSessionLock } from "@/modules/game-runtime/services/SessionService";
const router = express.Router();

/**
 * 重玩会话：重新生成角色卡等动态数据，删除旧会话进度，然后由前端走既有
 * initStory → introduction → orchestration 开局链路创建全新会话。
 * - 角色卡是世界级数据（t_storyWorld），forceRefresh 全量重生成并 persist 写回，
 *   与发布时的逻辑一致（worldPublish）；开局快照缓存 hash 含角色卡 JSON，会自动失效。
 * - 删除范围照 deleteSession 事务，并补删 t_role_memory / t_entityStateDelta /
 *   t_plugin_session_data（deleteSession 未清理的孤儿数据）。
 * - withSessionLock 排队等待该会话在途编排完成后再删，避免竞态；后台任务回调
 *   均有会话行存在性守卫，删除后自然 no-op。
 */
export default router.post(
  "/",
  validateFields({
    sessionId: z.string(),
  }),
  async (req, res) => {
    try {
      const userId = Number((req as any)?.user?.id || 0);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(401).send(error("用户未登录"));
      }

      const sessionId = String(req.body.sessionId || "").trim();
      if (!sessionId) {
        return res.status(400).send(error("sessionId 不能为空"));
      }

      const db = getGameDb();
      const session = await db("t_gameSession")
        .where({ sessionId, userId })
        .select("id", "sessionId", "worldId")
        .first();
      if (!session) {
        return res.status(404).send(error("未找到会话"));
      }

      const worldId = Number(session.worldId || 0);
      if (!worldId) {
        return res.status(400).send(error("会话缺少故事信息，无法重玩"));
      }

      // 1. 重新生成角色卡（player/narrator/全部 NPC）并写回世界；LLM 失败时函数内部
      //    会回退静态卡不抛错，流程继续不阻塞重玩。
      //    归属保护：只有世界属于当前用户（通过项目归属判断）才允许重生成并写回，
      //    避免重玩"他人已发布故事"的会话时篡改别人世界的角色卡；他人的世界只删档重开。
      const world = await db("t_storyWorld").where({ id: worldId }).first();
      if (world) {
        const worldProject = world.projectId
          ? await db("t_project").where({ id: Number(world.projectId) }).first("userId")
          : null;
        const ownsWorld = Boolean(worldProject && Number(worldProject.userId || 0) === userId);
        if (ownsWorld) {
          await ensureWorldRolesWithAiParameterCards({
            userId,
            world,
            persist: true,
            forceRefresh: true,
          });
        }
      }

      // 2. 排队等在途编排结束后，事务内删除该会话的全部动态数据
      await withSessionLock(sessionId, async () => {
        await db.transaction(async (trx: any) => {
          await trx("t_sessionMessage").where({ sessionId }).delete();
          await trx("t_sessionStateSnapshot").where({ sessionId }).delete();
          await trx("t_entityStateDelta").where({ sessionId }).delete();
          await trx("t_role_memory").where({ sessionId }).delete();
          await trx("t_plugin_session_data").where({ sessionId }).delete();
          await trx("t_gameSession").where({ sessionId, userId }).delete();
        });
      });
      clearSessionRevisitCache(sessionId);

      return res.status(200).send(success({ worldId }, "重玩数据已重置，可重新开局"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || "重玩失败");
      console.error("[game:replaySession:error]", err);
      return res.status(500).send(error(message));
    }
  },
);
