import { NextFunction, Request, Response } from "express";
import u from "@/utils";

const PROJECT_SCOPED_PREFIXES = ["/assets/", "/novel/", "/outline/", "/script/", "/storyboard/", "/video/", "/game/", "/task/"];

const NON_PROJECT_SCOPED_PATHS = new Set<string>([
  "/video/getManufacturer",
  "/video/getVideoModel",
  "/setting/getAiModelList",
  "/setting/getVideoModelDetail",
  "/setting/getLog",
  "/index",
  "/prompt/getPrompts",
  "/prompt/updatePrompt",
  "/voice/getVoices",
  "/voice/audioProxy",
  "/voice/preview",
  "/voice/generateBindingVoice",
  "/voice/transcribe",
  "/voice/polishPrompt",
  "/voice/uploadAudio",
  "/video/uploadAudio",
  "/task/getTaskApi",
  "/game/listSession",
  "/game/listWorlds",
  "/game/uploadImage",
  "/game/convertAvatarVideoToGif",
  "/game/convertAvatarVideoToGif/status",
  "/game/separateRoleAvatar",
  "/game/separateRoleAvatar/status",
  "/game/debugStep",
  "/game/streamvoice",
  "/game/initDebug",
  "/game/initStory",
  "/game/listImportableRoles",
  "/game/importWorldRole",
  "/game/debugRuntimeShared/revisit",
  "/game/debugRuntimeShared/revisit/history",
]);

function toPositiveInt(value: any): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function normalizeIdList(...input: any[]): number[] {
  const list: number[] = [];
  for (const item of input) {
    if (Array.isArray(item)) {
      for (const v of item) {
        const n = toPositiveInt(v);
        if (n) list.push(n);
      }
      continue;
    }
    const n = toPositiveInt(item);
    if (n) list.push(n);
  }
  return Array.from(new Set(list));
}

async function projectIdFromScript(scriptId: number): Promise<number | null> {
  const row = await u.db("t_script").where({ id: scriptId }).first("projectId");
  return toPositiveInt(row?.projectId);
}

async function projectIdFromOutline(outlineId: number): Promise<number | null> {
  const row = await u.db("t_outline").where({ id: outlineId }).first("projectId");
  return toPositiveInt(row?.projectId);
}

async function projectIdFromNovel(novelId: number): Promise<number | null> {
  const row = await u.db("t_novel").where({ id: novelId }).first("projectId");
  return toPositiveInt(row?.projectId);
}

async function projectIdFromStoryWorld(worldId: number): Promise<number | null> {
  const row = await u.db("t_storyWorld").where({ id: worldId }).first("projectId");
  return toPositiveInt(row?.projectId);
}

async function projectIdFromChapter(chapterId: number): Promise<number | null> {
  const chapter = await u.db("t_storyChapter").where({ id: chapterId }).first("worldId");
  const worldId = toPositiveInt(chapter?.worldId);
  if (!worldId) return null;
  return await projectIdFromStoryWorld(worldId);
}

async function projectIdFromChapterTask(taskId: number): Promise<number | null> {
  const row = await u.db("t_chapterTask").where({ id: taskId }).first("chapterId");
  const chapterId = toPositiveInt(row?.chapterId);
  if (!chapterId) return null;
  return await projectIdFromChapter(chapterId);
}

async function projectIdFromChapterTrigger(triggerId: number): Promise<number | null> {
  const row = await u.db("t_chapterTrigger").where({ id: triggerId }).first("chapterId");
  const chapterId = toPositiveInt(row?.chapterId);
  if (!chapterId) return null;
  return await projectIdFromChapter(chapterId);
}

async function projectIdFromSession(sessionId: string): Promise<number | null> {
  const row = await u.db("t_gameSession").where({ sessionId }).first("projectId");
  return toPositiveInt(row?.projectId);
}

/**
 * 正式游玩会话属于当前登录用户的私有资源。
 * 故事大厅允许游玩其他用户发布的故事，因此进入会话后不应该再按源故事项目归属拦截，
 * 而应该直接校验 session 是否归当前用户所有。
 */
async function ensureSessionOwned(sessionId: string, userId: number): Promise<boolean> {
  const row = await u.db("t_gameSession").where({ sessionId, userId }).first("id");
  return !!row;
}

async function projectIdFromAsset(assetId: number): Promise<number | null> {
  const row = await u.db("t_assets").where({ id: assetId }).first("projectId");
  return toPositiveInt(row?.projectId);
}

async function projectIdFromScriptSegment(segmentId: number): Promise<number | null> {
  const row = await u.db("t_scriptSegment").where({ id: segmentId }).first("projectId", "scriptId");
  const projectId = toPositiveInt(row?.projectId);
  if (projectId) return projectId;
  const scriptId = toPositiveInt(row?.scriptId);
  if (!scriptId) return null;
  return await projectIdFromScript(scriptId);
}

async function projectIdFromVideo(videoId: number): Promise<number | null> {
  const row = await u.db("t_video").where({ id: videoId }).first("scriptId");
  const scriptId = toPositiveInt(row?.scriptId);
  if (!scriptId) return null;
  return await projectIdFromScript(scriptId);
}

async function projectIdFromVideoConfig(videoConfigId: number): Promise<number | null> {
  const row = await u.db("t_videoConfig").where({ id: videoConfigId }).first("projectId", "scriptId");
  const projectId = toPositiveInt(row?.projectId);
  if (projectId) return projectId;
  const scriptId = toPositiveInt(row?.scriptId);
  if (!scriptId) return null;
  return await projectIdFromScript(scriptId);
}

async function projectIdFromImage(imageId: number): Promise<number | null> {
  const row = await u.db("t_image").where({ id: imageId }).first("projectId", "assetsId", "scriptId", "videoId");
  const projectId = toPositiveInt(row?.projectId);
  if (projectId) return projectId;

  const assetsId = toPositiveInt(row?.assetsId);
  if (assetsId) {
    const p = await projectIdFromAsset(assetsId);
    if (p) return p;
  }
  const scriptId = toPositiveInt(row?.scriptId);
  if (scriptId) {
    const p = await projectIdFromScript(scriptId);
    if (p) return p;
  }
  const videoId = toPositiveInt(row?.videoId);
  if (videoId) {
    const p = await projectIdFromVideo(videoId);
    if (p) return p;
  }
  return null;
}

async function projectIdsFromTask(taskId: number): Promise<number[]> {
  const row = await u.db("t_taskList").where({ id: taskId }).first("projectName");
  const projectId = toPositiveInt(row?.projectName);
  return projectId ? [projectId] : [];
}

async function ensureConfigOwned(configId: number, userId: number, type?: string): Promise<boolean> {
  let query = u.db("t_config").where({ id: configId, userId });
  if (type) {
    query = query.where({ type });
  }
  const row = await query.first("id");
  return !!row;
}

function isProjectScopedPath(path: string): boolean {
  return PROJECT_SCOPED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

async function collectProjectIds(req: Request): Promise<number[]> {
  const path = String(req.path || "");
  const body: any = req.body || {};
  const query: any = req.query || {};

  const projectIds = new Set<number>();
  const pushProject = (id: any) => {
    const n = toPositiveInt(id);
    if (n) projectIds.add(n);
  };

  pushProject(body.projectId);
  pushProject(query.projectId);

  const scriptId = toPositiveInt(body.scriptId ?? query.scriptId);
  if (scriptId) {
    const p = await projectIdFromScript(Math.abs(scriptId));
    if (p) projectIds.add(p);
  }

  const outlineId = toPositiveInt(body.outlineId ?? query.outlineId);
  if (outlineId) {
    const p = await projectIdFromOutline(outlineId);
    if (p) projectIds.add(p);
  }

  const novelId = toPositiveInt(body.novelId ?? query.novelId);
  if (novelId) {
    const p = await projectIdFromNovel(novelId);
    if (p) projectIds.add(p);
  }

  // 游戏侧有些请求不会直接传 worldId，而是用 sourceWorldId / excludeWorldId
  // 表示“来源故事”或“当前草稿故事”。这里统一折叠成同一条资源归属解析链，
  // 避免新接口虽然访问的是故事资源，却因为字段名不同被误判成“无法确认资源归属项目”。
  const worldId = toPositiveInt(
    body.worldId
    ?? query.worldId
    ?? body.sourceWorldId
    ?? query.sourceWorldId
    ?? body.excludeWorldId
    ?? query.excludeWorldId,
  );
  if (worldId) {
    const p = await projectIdFromStoryWorld(worldId);
    if (p) projectIds.add(p);
  }

  const chapterId = toPositiveInt(body.chapterId ?? query.chapterId);
  if (chapterId) {
    const p = await projectIdFromChapter(chapterId);
    if (p) projectIds.add(p);
  }

  if (path.startsWith("/game/")) {
    const chapterTaskId = toPositiveInt(body.taskId ?? query.taskId);
    if (chapterTaskId) {
      const p = await projectIdFromChapterTask(chapterTaskId);
      if (p) projectIds.add(p);
    }

    const chapterTriggerId = toPositiveInt(body.triggerId ?? query.triggerId);
    if (chapterTriggerId) {
      const p = await projectIdFromChapterTrigger(chapterTriggerId);
      if (p) projectIds.add(p);
    }
  }

  const sessionId = String(body.sessionId ?? query.sessionId ?? "").trim();
  if (sessionId) {
    const p = await projectIdFromSession(sessionId);
    if (p) projectIds.add(p);
  }

  const assetsId = toPositiveInt(body.assetsId ?? query.assetsId);
  if (assetsId) {
    const p = await projectIdFromAsset(assetsId);
    if (p) projectIds.add(p);
  }

  const videoId = toPositiveInt(body.videoId ?? query.videoId);
  if (videoId) {
    const p = await projectIdFromVideo(videoId);
    if (p) projectIds.add(p);
  }

  const imageId = toPositiveInt(body.imageId ?? query.imageId);
  if (imageId) {
    const p = await projectIdFromImage(imageId);
    if (p) projectIds.add(p);
  }

  const videoConfigId = toPositiveInt(body.videoConfigId ?? query.videoConfigId);
  if (videoConfigId) {
    const p = await projectIdFromVideoConfig(videoConfigId);
    if (p) projectIds.add(p);
  }

  if (path === "/project/getSingleProject" || path === "/project/updateProject" || path === "/project/delProject" || path === "/project/getProjectCount") {
    pushProject(body.id);
  }

  if (path === "/assets/delAssets" || path === "/assets/updateAssets" || path === "/assets/saveAssets" || path === "/storyboard/saveStoryboard") {
    const ids = normalizeIdList(body.id);
    for (const id of ids) {
      const p = await projectIdFromAsset(id);
      if (p) projectIds.add(p);
    }
  }

  if (path === "/storyboard/delStoryboard" || path === "/video/reviseVideoStoryboards") {
    const ids = normalizeIdList(body.storyboardId, body.id, body.ids);
    for (const id of ids) {
      const p = await projectIdFromAsset(id);
      if (p) projectIds.add(p);
    }
  }

  if (path === "/novel/delNovel" || path === "/novel/updateNovel") {
    const id = toPositiveInt(body.id);
    if (id) {
      const p = await projectIdFromNovel(id);
      if (p) projectIds.add(p);
    }
  }

  if (path === "/outline/updateOutline") {
    const id = toPositiveInt(body.id);
    if (id) {
      const p = await projectIdFromOutline(id);
      if (p) projectIds.add(p);
    }
  }

  if (path === "/outline/updateScript") {
    const id = toPositiveInt(body.id);
    if (id) {
      const p = await projectIdFromScript(id);
      if (p) projectIds.add(p);
    }
  }

  if (path === "/script/deleteScriptSegment" || path === "/script/updateScriptSegment") {
    const id = toPositiveInt(body.id);
    if (id) {
      const p = await projectIdFromScriptSegment(id);
      if (p) projectIds.add(p);
    }
  }

  if (path === "/video/saveVideo") {
    const id = toPositiveInt(body.id);
    if (id) {
      const p = await projectIdFromVideo(id);
      if (p) projectIds.add(p);
    }
  }

  if (path === "/video/generateVideo") {
    const id = toPositiveInt(body.configId);
    if (id) {
      const p = await projectIdFromVideoConfig(id);
      if (p) projectIds.add(p);
    }
  }

  if (path === "/video/generateByConfig" || path === "/video/deleteVideoConfig" || path === "/video/upDateVideoConfig") {
    const ids = normalizeIdList(body.id, body.ids, body.configId);
    for (const id of ids) {
      const p = await projectIdFromVideoConfig(id);
      if (p) projectIds.add(p);
    }
  }

  if (path === "/storyboard/keepStoryboard") {
    const items = Array.isArray(body.results) ? body.results : [];
    for (const item of items) {
      pushProject((item as any)?.projectId);
      const sid = toPositiveInt((item as any)?.scriptId);
      if (sid) {
        const p = await projectIdFromScript(sid);
        if (p) projectIds.add(p);
      }
    }
  }

  if (path === "/task/taskDetails") {
    const taskId = toPositiveInt(body.taskId);
    if (taskId) {
      const ids = await projectIdsFromTask(taskId);
      for (const id of ids) {
        projectIds.add(id);
      }
    }
  }

  if (path === "/task/getTaskApi") {
    pushProject(query.projectName);
  }

  return Array.from(projectIds);
}

export async function enforceResourceIsolation(req: Request, res: Response, next: NextFunction) {
  try {
    const path = String(req.path || "");
    // 登录 / 注册属于公开入口，资源隔离不应再要求已有登录态。
    if (path === "/other/login" || path === "/other/register") {
      return next();
    }
    const userId = toPositiveInt((req as any)?.user?.id);
    if (!userId) {
      return res.status(401).send({ message: "用户未登录" });
    }

    // 配置资源按 userId 隔离
    if (path === "/setting/updateModel" || path === "/setting/updeteModel" || path === "/setting/delModel") {
      const configId = toPositiveInt((req.body || {}).id);
      if (!configId || !(await ensureConfigOwned(configId, userId))) {
        return res.status(403).send({ message: "无权访问该模型配置" });
      }
    }
    if (path === "/setting/configurationModel") {
      const configId = toPositiveInt((req.body || {}).configId);
      if (configId && !(await ensureConfigOwned(configId, userId))) {
        return res.status(403).send({ message: "无权绑定该模型配置" });
      }
    }

    // 语音配置按 userId 隔离
    if (path === "/voice/getVoices" || path === "/voice/preview" || path === "/voice/transcribe" || path === "/game/streamvoice") {
      const configId = toPositiveInt((req.body || {}).configId);
      if (configId && !(await ensureConfigOwned(configId, userId, "voice"))) {
        return res.status(403).send({ message: "无权访问该语音模型配置" });
      }
    }

    /**
     * 这批接口虽然挂在 /game 下，但它们本身不是“按项目资源直接读写”的接口：
     * - initStory：允许从故事大厅进入其他用户已发布的故事
     * - listSession：只列当前用户自己的正式会话
     * - listWorlds：大厅数据混合“自己的故事 + 他人已发布故事”
     * - import/listImportableRoles：路由内部已按当前用户做来源故事校验
     * - initDebug：路由内部会再次按当前用户校验故事所有权
     *
     * 这些接口如果在这里继续按 projectId/worldId 做统一项目归属判断，
     * 会把“公开可游玩故事”或“未保存草稿的导入弹窗”误拦成 403。
     */
    if (NON_PROJECT_SCOPED_PATHS.has(path)) {
      return next();
    }

    /**
     * 这些接口是围绕正式会话读写的，会话创建成功后应只按 session.userId 校验。
     * 否则故事大厅里“别人已发布但当前用户已打开的故事”会在 introduction /
     * orchestration / streamlines 阶段再次被误判成“无权访问源项目”。
     */
    const sessionScopedGamePaths = new Set<string>([
      "/game/getSession",
      "/game/getMessage",
      "/game/addMessage",
      "/game/deleteMessage",
      "/game/deleteSession",
      "/game/commitNarrativeTurn",
      "/game/continueSession",
      "/game/revisitMessage",
      "/game/introduction",
      "/game/orchestration",
      "/game/streamlines",
    ]);
    const sessionId = String((req.body || {}).sessionId ?? (req.query || {}).sessionId ?? "").trim();
    if (sessionId && sessionScopedGamePaths.has(path)) {
      if (!(await ensureSessionOwned(sessionId, userId))) {
        return res.status(403).send({ message: "无权访问该会话" });
      }
      return next();
    }

    // 视频模型配置引用按 userId 隔离
    if (path === "/video/addVideoConfig" || path === "/video/generateVideo" || path === "/video/upDateVideoConfig") {
      const aiConfigId = toPositiveInt((req.body || {}).aiConfigId ?? (req.body || {}).configId);
      if (aiConfigId && path !== "/video/upDateVideoConfig") {
        if (!(await ensureConfigOwned(aiConfigId, userId))) {
          return res.status(403).send({ message: "无权访问该模型配置" });
        }
      }
      if (path === "/video/upDateVideoConfig") {
        const updateAiConfigId = toPositiveInt((req.body || {}).aiConfigId);
        if (updateAiConfigId && !(await ensureConfigOwned(updateAiConfigId, userId))) {
          return res.status(403).send({ message: "无权访问该模型配置" });
        }
      }
    }

    const projectIds = await collectProjectIds(req);
    if (projectIds.length > 0) {
      const owned = await u.db("t_project").whereIn("id", projectIds).where("userId", userId).select("id");
      if (owned.length !== projectIds.length) {
        return res.status(403).send({ message: "无权访问该项目资源" });
      }
      return next();
    }

    if (isProjectScopedPath(path) && !NON_PROJECT_SCOPED_PATHS.has(path)) {
      return res.status(403).send({ message: "无法确认资源归属项目，访问被拒绝" });
    }

    return next();
  } catch (err: any) {
    return res.status(500).send({ message: err?.message || "资源隔离校验失败" });
  }
}
