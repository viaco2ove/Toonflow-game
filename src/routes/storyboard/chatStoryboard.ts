import express from "express";
import expressWs, { Application } from "express-ws";
import Storyboard from "@/agents/storyboard";
import u from "@/utils";
import {
  createStoryboardChatSession,
  deleteStoryboardChatSession,
  ensureStoryboardChatBootstrap,
  listStoryboardChatSessions,
  loadStoryboardChatSession,
  renameStoryboardChatSession,
  saveStoryboardChatSession,
  StoryboardChatSessionMeta,
  StoryboardPendingPlan,
  StoryboardPendingPlanSnapshot,
  StoryboardVideoDraft,
  StoryboardVideoDraftConfig,
} from "@/lib/storyboardChatSessionStore";
import { createVideoTask, VideoGenerateMode } from "@/routes/video/generateVideo";

const router = express.Router();
expressWs(router as unknown as Application);
// 默认开启分镜计划确认；仅当显式设置为 0 时关闭
const STORYBOARD_PLAN_CONFIRM = (process.env.STORYBOARD_PLAN_CONFIRM || "").trim() !== "0";

const formatSessionListText = (sessions: StoryboardChatSessionMeta[], currentSessionId: string): string => {
  if (sessions.length === 0) {
    return "当前没有历史会话。可发送 /新建会话 创建。";
  }
  const lines = sessions.map((item, index) => {
    const marker = item.id === currentSessionId ? "⭐" : " ";
    const time = new Date(item.updatedAt).toLocaleString();
    const preview = item.preview ? `\n   预览：${item.preview}` : "";
    return `${marker}${index + 1}. ${item.title}（ID: ${item.id}，更新于 ${time}）${preview}`;
  });
  return `会话列表：\n${lines.join("\n")}\n\n可用命令（ID或序号都可）：\n/切换会话 <ID或序号>\n/新建会话 [标题]\n/重命名会话 <ID或序号> <新标题>\n/删除会话 <ID或序号>`;
};

router.ws("/", async (ws, req) => {
  let agent: Storyboard;

  const projectId = req.query.projectId;
  const scriptId = req.query.scriptId;
  const requestedSessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
  const requestedMode = typeof req.query.mode === "string" ? req.query.mode.toLowerCase() : "";
  const isVideoMode = requestedMode === "video";

  if (!projectId || typeof projectId !== "string" || !scriptId || typeof scriptId !== "string") {
    ws.send(JSON.stringify({ type: "error", data: "项目ID或脚本ID缺失" }));
    ws.close(500, "项目ID或脚本ID缺失");
    return;
  }

  const projectIdNum = Number(projectId);
  const scriptIdNum = Number(scriptId);
  const sessionScopeScriptId = isVideoMode ? -Math.abs(scriptIdNum) : scriptIdNum;
  agent = new Storyboard(projectIdNum, scriptIdNum);

  const send = (type: string, data: any) => {
    try {
      ws.send(JSON.stringify({ type, data }));
    } catch (err: any) {
      console.error("ws send error:", err?.message || String(err));
    }
  };
  const appendHistory = (role: "user" | "assistant", content: string) => {
    if (!isVideoMode) return;
    const text = String(content || "").trim();
    if (!text) return;
    const next = [...(Array.isArray(agent.history) ? agent.history : []), { role, content: text }];
    // 控制历史长度，避免会话无限增长
    agent.history = next.slice(-400);
  };
  // 兼容旧前端：部分版本不会展示 notice，这里同步发送 response_end 让消息进入聊天流。
  const sendNotice = (text: string) => {
    send("notice", text);
    send("response_end", text);
    appendHistory("assistant", text);
  };
  const sendSessionHistory = () => {
    send("sessionHistory", { history: agent.history || [] });
  };

  const listExactScopedSessions = async (): Promise<StoryboardChatSessionMeta[]> => {
    const all = await listStoryboardChatSessions(projectIdNum);
    return all
      .filter((item) => {
        const sid = Number(item.scriptId);
        return Number.isFinite(sid) && sid === sessionScopeScriptId;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  };
  const loadScopedSessions = async (): Promise<StoryboardChatSessionMeta[]> =>
    isVideoMode ? listExactScopedSessions() : listStoryboardChatSessions(projectIdNum, sessionScopeScriptId);

  let sessionsCache: StoryboardChatSessionMeta[] = [];
  let currentSessionId = "";
  let sessionData = {
    history: [] as any[],
    novelChapters: [] as any[],
    shots: [] as any[],
    shotIdCounter: 0,
    videoDraft: null as StoryboardVideoDraft | null,
    pendingStoryboardPlan: null as StoryboardPendingPlan | null,
  };

  if (isVideoMode) {
    sessionsCache = await loadScopedSessions();
    if (!sessionsCache.length) {
      const created = await createStoryboardChatSession({
        projectId: projectIdNum,
        scriptId: sessionScopeScriptId,
        title: "默认视频会话",
      });
      currentSessionId = created.sessionId;
      sessionsCache = await loadScopedSessions();
    } else {
      currentSessionId = sessionsCache[0].id;
    }

    if (requestedSessionId) {
      const target = sessionsCache.find((item) => item.id === requestedSessionId);
      if (target) currentSessionId = target.id;
    }

    const loaded = currentSessionId ? await loadStoryboardChatSession(projectIdNum, currentSessionId) : null;
    if (loaded) {
      sessionData = {
        history: Array.isArray(loaded.history) ? loaded.history : [],
        novelChapters: Array.isArray(loaded.novelChapters) ? loaded.novelChapters : [],
        shots: Array.isArray(loaded.shots) ? loaded.shots : [],
        shotIdCounter: Number.isFinite(loaded.shotIdCounter) ? loaded.shotIdCounter : 0,
        videoDraft: loaded.videoDraft || null,
        pendingStoryboardPlan: loaded.pendingStoryboardPlan || null,
      };
    }
  } else {
    const bootstrap = await ensureStoryboardChatBootstrap({
      projectId: projectIdNum,
      scriptId: sessionScopeScriptId,
    });

    sessionsCache = await loadScopedSessions();
    currentSessionId = bootstrap.sessionId;
    sessionData = {
      history: bootstrap.history,
      novelChapters: bootstrap.novelChapters,
      shots: bootstrap.shots,
      shotIdCounter: bootstrap.shotIdCounter,
      videoDraft: bootstrap.videoDraft || null,
      pendingStoryboardPlan: bootstrap.pendingStoryboardPlan || null,
    };

    if (requestedSessionId) {
      const target = sessionsCache.find((item) => item.id === requestedSessionId);
      if (target) {
        const loaded = await loadStoryboardChatSession(projectIdNum, requestedSessionId);
        if (loaded) {
          currentSessionId = requestedSessionId;
          sessionData = loaded;
        }
      }
    }
  }

  if (isVideoMode && (!Array.isArray(sessionData.shots) || sessionData.shots.length === 0)) {
    const sourceSessions = await listStoryboardChatSessions(projectIdNum, scriptIdNum);
    const sourceSessionId = sourceSessions[0]?.id;
    if (sourceSessionId) {
      const source = await loadStoryboardChatSession(projectIdNum, sourceSessionId);
      if (source?.shots?.length) {
        sessionData.shots = source.shots;
        sessionData.shotIdCounter = source.shotIdCounter;
      }
    }
  }

  agent.history = Array.isArray(sessionData.history) ? sessionData.history : [];
  agent.novelChapters = Array.isArray(sessionData.novelChapters) ? sessionData.novelChapters : [];
  agent.restoreShotsFromSession(sessionData.shots, sessionData.shotIdCounter);

  const getCurrentSessionTitle = () => {
    const current = sessionsCache.find((item) => item.id === currentSessionId);
    return current?.title || "未命名会话";
  };

  type VideoConfigSummary = {
    id: number;
    aiConfigId: number;
    manufacturer: string;
    model: string;
    mode: VideoGenerateMode;
    resolution: string;
    duration: number;
    prompt: string;
    audioEnabled: boolean;
  };
  type FrameItem = {
    src: string;
    prompt: string;
    shotId: number;
    segmentId: number;
    cellIndex: number;
  };
  type VideoPlanShot = {
    id: number;
    segmentId: number;
    title: string;
    x: number;
    y: number;
    cells: Array<{ id: number; prompt: string; src: string }>;
    fragmentContent: string;
    assetsTags: Array<{ text: string }>;
    aiConfigId?: number;
    manufacturer?: string;
    model?: string;
    mode?: string;
    resolution?: string;
    duration?: number;
    prompt?: string;
    audioEnabled?: boolean;
    startFrame?: VideoFrameRef | null;
    endFrame?: VideoFrameRef | null;
    images?: VideoFrameRef[];
  };
  type VideoFrameRef = {
    id: number;
    filePath: string;
    prompt: string;
  };
  type VideoConfigRow = {
    id: number;
    aiConfigId: number;
    manufacturer?: string;
    model?: string;
    mode: string;
    resolution: string;
    duration: number;
    prompt: string;
    audioEnabled: boolean;
    startFrame: VideoFrameRef | null;
    endFrame: VideoFrameRef | null;
    images: VideoFrameRef[];
  };
  let pendingStoryboardPlan: StoryboardPendingPlan | null = sessionData.pendingStoryboardPlan || null;

  let videoConfigsCache: VideoConfigSummary[] = [];
  let selectedVideoAiConfigId: number | null = null;
  let selectedVideoMode: VideoGenerateMode = "single";
  let videoFlowStep: "idle" | "selectConfig" | "selectMode" = "idle";
  let videoPlanShots: VideoPlanShot[] = [];
  let draftConfigCounter = 1;
  let videoDraftState: StoryboardVideoDraft = sessionData.videoDraft || {
    selectedAiConfigId: null,
    selectedMode: "single",
    configs: [],
    updatedAt: Date.now(),
  };
  if (videoDraftState.selectedAiConfigId) selectedVideoAiConfigId = videoDraftState.selectedAiConfigId;
  if (videoDraftState.selectedMode) selectedVideoMode = videoDraftState.selectedMode as VideoGenerateMode;

  const makeDraftId = () => `d_${Date.now()}_${draftConfigCounter++}`;
  const draftIdToVirtualId = (draftId: string): number => {
    let hash = 0;
    for (let i = 0; i < draftId.length; i++) {
      hash = (hash * 31 + draftId.charCodeAt(i)) | 0;
    }
    return -Math.max(1, Math.abs(hash));
  };
  const toVirtualConfigId = (cfg: StoryboardVideoDraftConfig): number => draftIdToVirtualId(cfg.draftId);
  const isVirtualConfigId = (id: number): boolean => Number.isFinite(id) && id < 0;
  const getDraftConfigByVirtualId = (id: number): StoryboardVideoDraftConfig | null => {
    return videoDraftState.configs.find((item) => toVirtualConfigId(item) === id) || null;
  };
  const touchVideoDraft = () => {
    videoDraftState.updatedAt = Date.now();
    videoDraftState.selectedAiConfigId = selectedVideoAiConfigId || null;
    videoDraftState.selectedMode = selectedVideoMode === "startEnd" ? "startEnd" : "single";
  };
  const createEmptyVideoDraft = (): StoryboardVideoDraft => ({
    selectedAiConfigId: selectedVideoAiConfigId || null,
    selectedMode: selectedVideoMode === "startEnd" ? "startEnd" : "single",
    configs: [],
    updatedAt: Date.now(),
  });
  const applyVideoDraftFromSession = (draft: StoryboardVideoDraft | null | undefined) => {
    videoDraftState = draft || createEmptyVideoDraft();
    const sid = Number(videoDraftState.selectedAiConfigId || 0);
    if (sid > 0) selectedVideoAiConfigId = sid;
    selectedVideoMode = videoDraftState.selectedMode === "startEnd" ? "startEnd" : "single";
  };

  const parseMode = (text: string): VideoGenerateMode | null => {
    const raw = text.trim().toLowerCase();
    if (!raw) return null;
    if (raw.includes("首尾") || raw.includes("首帧") || raw.includes("尾帧") || raw.includes("startend")) return "startEnd";
    if (raw.includes("单图") || raw.includes("单张") || raw.includes("single")) return "single";
    return null;
  };

  const loadVideoConfigs = async () => {
    const modelRows = await u
      .db("t_config")
      .where("type", "video")
      .where("userId", 1)
      .orderBy("createTime", "desc")
      .select("id", "manufacturer", "model");

    if (!modelRows.length) {
      videoConfigsCache = [];
      return videoConfigsCache;
    }

    const aiConfigIds = modelRows.map((item: any) => Number(item.id)).filter((id: number) => id > 0);
    const scriptRows =
      aiConfigIds.length > 0
        ? await u
            .db("t_videoConfig")
            .where("scriptId", scriptIdNum)
            .whereIn("aiConfigId", aiConfigIds)
            .orderBy("updateTime", "desc")
            .select("id", "aiConfigId", "mode", "resolution", "duration", "prompt", "audioEnabled", "manufacturer")
        : [];

    const latestByAiConfigId = new Map<number, any>();
    for (const row of scriptRows) {
      const key = Number(row.aiConfigId || 0);
      if (!key || latestByAiConfigId.has(key)) continue;
      latestByAiConfigId.set(key, row);
    }

    videoConfigsCache = modelRows.map((item: any) => {
      const aiConfigId = Number(item.id || 0);
      const existing = latestByAiConfigId.get(aiConfigId);
      const mode = parseMode(String(existing?.mode || "")) || "single";
      return {
        id: Number(existing?.id || 0),
        aiConfigId,
        manufacturer: String(item.manufacturer || existing?.manufacturer || ""),
        model: String(item.model || ""),
        mode,
        resolution: String(existing?.resolution || "720p"),
        duration: Number(existing?.duration || 5),
        prompt: String(existing?.prompt || ""),
        audioEnabled: Boolean(existing?.audioEnabled),
      };
    });

    return videoConfigsCache;
  };

  const listVideoConfigs = async () => {
    const list = await loadVideoConfigs();
    if (list.length === 0) {
      sendNotice("当前没有可用视频模型。请先到「设置」里添加视频模型。");
      return;
    }
    const lines = list.map((cfg, index) => {
      const marker = cfg.aiConfigId === selectedVideoAiConfigId ? "⭐" : " ";
      const modeText = cfg.mode === "startEnd" ? "首尾帧" : "单图";
      return `${marker}${index + 1}. 模型${cfg.aiConfigId} [${cfg.manufacturer || "未知厂商"} ${cfg.model || ""}] ${cfg.resolution}/${cfg.duration}s/${modeText}`;
    });
    const currentModeText = selectedVideoMode === "startEnd" ? "首尾帧（1-2,2-3串联）" : "单图（每图一个视频）";
    sendNotice(
      `可用视频模型（来自设置）：\n${lines.join(
        "\n",
      )}\n\n当前模式：${currentModeText}\n请回复模型序号或模型ID（例如：1）。\n命令：\n/选择视频模型 <序号或模型ID>\n/视频模式 <单图|首尾帧>\n/生成视频配置\n/导出视频配置\n/生成视频 <视频配置ID>`,
    );
  };

  const resolveVideoConfig = (inputId: string): VideoConfigSummary | null => {
    const raw = inputId.trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) {
      const value = Number(raw);
      const byModelId = videoConfigsCache.find((item) => item.aiConfigId === value);
      if (byModelId) return byModelId;
      const index = value - 1;
      if (index >= 0 && index < videoConfigsCache.length) return videoConfigsCache[index];
    }
    return null;
  };

  const extractConfigInputFromText = (text: string): string | null => {
    const raw = text.trim();
    if (!raw) return null;
    const direct = raw.match(/^\d+$/);
    if (direct) return direct[0];
    const named = raw.match(/^(?:#|配置|模型|第)?\s*(\d+)\s*(?:个)?$/);
    if (named) return named[1];
    return null;
  };

  const selectVideoConfig = async (inputId: string): Promise<boolean> => {
    await loadVideoConfigs();
    const target = resolveVideoConfig(inputId);
    if (!target) {
      sendNotice(`未找到视频模型：${inputId}。请先发送 /视频配置 查看列表。`);
      return false;
    }
    selectedVideoAiConfigId = target.aiConfigId;
    selectedVideoMode = target.mode === "startEnd" ? "startEnd" : "single";
    touchVideoDraft();
    sendNotice(
      `已选择视频模型 #${target.aiConfigId}（${target.manufacturer || "未知厂商"} ${target.model || ""}）。请继续选择视频模式：首尾帧 或 单图。当前默认模式：${
        selectedVideoMode === "startEnd" ? "首尾帧" : "单图"
      }。`,
    );
    return true;
  };

  const collectFrames = (onlyShotId?: number): FrameItem[] => {
    const snapshot = agent.getShotsSnapshot().shots || [];
    const sortedShots = [...snapshot].sort((a: any, b: any) => {
      const segmentDiff = Number(a?.segmentId || 0) - Number(b?.segmentId || 0);
      if (segmentDiff !== 0) return segmentDiff;
      return Number(a?.id || 0) - Number(b?.id || 0);
    });
    const frames: FrameItem[] = [];
    for (const shot of sortedShots) {
      const shotId = Number(shot?.id || 0);
      const segmentId = Number(shot?.segmentId || 0);
      if (Number.isFinite(onlyShotId) && onlyShotId! > 0) {
        const matched = onlyShotId === shotId || onlyShotId === segmentId;
        if (!matched) continue;
      }
      const cells = Array.isArray(shot?.cells) ? shot.cells : [];
      cells.forEach((cell: any, index: number) => {
        const src = String(cell?.src || "").trim();
        if (!src) return;
        frames.push({
          src,
          prompt: String(cell?.prompt || "").trim(),
          shotId,
          segmentId,
          cellIndex: index + 1,
        });
      });
    }
    return frames;
  };

  const buildAutoVideoPrompt = (first: FrameItem, second?: FrameItem): string => {
    const firstPrompt = first.prompt || `分镜${first.segmentId} 镜头${first.cellIndex}`;
    if (!second) {
      return `${firstPrompt}\n保持主体一致与构图稳定，生成自然镜头运动与细节变化。`;
    }
    const secondPrompt = second.prompt || `分镜${second.segmentId} 镜头${second.cellIndex}`;
    return `起始画面：${firstPrompt}\n结束画面：${secondPrompt}\n要求从起始到结束平滑过渡，保持角色与光影连续，动作自然。`;
  };

  const toFrameRef = (frame: FrameItem): VideoFrameRef => ({
    id: frame.shotId * 100 + frame.cellIndex,
    filePath: frame.src,
    prompt: frame.prompt || "",
  });

  const getSelectedVideoConfig = async (): Promise<VideoConfigSummary | null> => {
    if (!videoConfigsCache.length) await loadVideoConfigs();
    if (!selectedVideoAiConfigId && videoConfigsCache.length > 0) {
      selectedVideoAiConfigId = videoConfigsCache[0].aiConfigId;
      selectedVideoMode = videoConfigsCache[0].mode === "startEnd" ? "startEnd" : "single";
    }
    if (!selectedVideoAiConfigId) return null;
    const found = videoConfigsCache.find((item) => item.aiConfigId === selectedVideoAiConfigId);
    return found || null;
  };

  const buildVideoPlanShots = (mode: VideoGenerateMode): VideoPlanShot[] => {
    const frames = collectFrames();
    if (!frames.length) return [];

    const toPos = (index: number) => {
      const col = index % 3;
      const row = Math.floor(index / 3);
      return { x: 50 + col * 850, y: 50 + row * 450 };
    };

    const plans: VideoPlanShot[] = [];
    if (mode === "startEnd") {
      for (let i = 0; i < frames.length - 1; i++) {
        const first = frames[i];
        const second = frames[i + 1];
        const pos = toPos(i);
        plans.push({
          id: i + 1,
          segmentId: i + 1,
          title: `视频配置 ${i + 1}`,
          x: pos.x,
          y: pos.y,
          // AI视频画布展示“配置卡片”，不在画布中直接展示首尾帧缩略图
          cells: [{ id: 1, prompt: "", src: "" }],
          fragmentContent: `首尾帧串联：${i + 1} -> ${i + 2}`,
          assetsTags: [{ text: "视频" }, { text: "首尾帧" }],
        });
      }
      return plans;
    }

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const pos = toPos(i);
      plans.push({
        id: i + 1,
        segmentId: i + 1,
        title: `视频配置 ${i + 1}`,
        x: pos.x,
        y: pos.y,
        cells: [{ id: 1, prompt: "", src: "" }],
        fragmentContent: `单图模式：配置 ${i + 1}`,
        assetsTags: [{ text: "视频" }, { text: "单图" }],
      });
    }
    return plans;
  };

  const buildVideoPlansFromConfigRows = (configs: VideoConfigRow[]): VideoPlanShot[] => {
    const toPos = (index: number) => {
      const col = index % 3;
      const row = Math.floor(index / 3);
      return { x: 50 + col * 850, y: 50 + row * 450 };
    };

    const plans: VideoPlanShot[] = [];
    let index = 0;
    for (const cfg of configs) {
      const mode = parseMode(cfg.mode) || "single";
      const cells: Array<{ id: number; prompt: string; src: string }> = [{ id: 1, prompt: "", src: "" }];
      const pos = toPos(index++);
      const modeText = mode === "startEnd" ? "首尾帧" : mode === "multi" ? "多图" : mode === "text" ? "文本" : "单图";
      const manufacturerText = String(cfg.manufacturer || "").trim() || "未知厂商";
      const resolutionText = String(cfg.resolution || "").trim() || "720p";
      const durationText = `${Number(cfg.duration || 5)}s`;
      plans.push({
        id: cfg.id,
        segmentId: cfg.id,
        title: `视频配置 ${index}`,
        x: pos.x,
        y: pos.y,
        cells,
        fragmentContent: cfg.prompt || `模式：${modeText} ${cfg.resolution}/${cfg.duration}s`,
        assetsTags: [{ text: manufacturerText }, { text: resolutionText }, { text: durationText }, { text: modeText }],
        aiConfigId: cfg.aiConfigId,
        manufacturer: cfg.manufacturer || "",
        model: cfg.model || "",
        mode,
        resolution: cfg.resolution,
        duration: cfg.duration,
        prompt: cfg.prompt,
        audioEnabled: cfg.audioEnabled,
        startFrame: cfg.startFrame,
        endFrame: cfg.endFrame,
        images: cfg.images,
      });
    }
    return plans;
  };

  const listPersistedVideoConfigs = async (): Promise<VideoConfigRow[]> => {
    const rows = await u
      .db("t_videoConfig")
      .where({
        scriptId: scriptIdNum,
        projectId: projectIdNum,
      })
      .modify((qb) => {
        if (selectedVideoAiConfigId) qb.where("aiConfigId", selectedVideoAiConfigId);
      })
      .orderBy("id", "asc")
      .select(
        "id",
        "aiConfigId",
        "manufacturer",
        "mode",
        "resolution",
        "duration",
        "prompt",
        "audioEnabled",
        "startFrame",
        "endFrame",
        "images",
      );

    return rows.map((row: any) => {
      const parseJson = (value: any): any => {
        if (!value) return null;
        if (typeof value === "object") return value;
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      };
      return {
        id: Number(row.id || 0),
        aiConfigId: Number(row.aiConfigId || 0),
        manufacturer: String(row.manufacturer || ""),
        mode: String(row.mode || "single"),
        resolution: String(row.resolution || "720p"),
        duration: Number(row.duration || 5),
        prompt: String(row.prompt || ""),
        audioEnabled: Boolean(row.audioEnabled),
        startFrame: parseJson(row.startFrame),
        endFrame: parseJson(row.endFrame),
        images: Array.isArray(parseJson(row.images)) ? parseJson(row.images) : [],
      } as VideoConfigRow;
    });
  };

  const createVideoConfigPlans = async (): Promise<VideoConfigRow[]> => {
    const config = await getSelectedVideoConfig();
    if (!config) {
      sendNotice("请先选择视频模型。可发送 /视频模型 查看列表。");
      return [];
    }
    const mode = selectedVideoMode;
    const frames = collectFrames();
    if (!frames.length) return [];

    const existingKeySet = new Set<string>();
    for (const item of videoDraftState.configs) {
      const itemMode = parseMode(item.mode) || "single";
      if (Number(item.aiConfigId) !== Number(config.aiConfigId)) continue;
      if (itemMode !== mode) continue;
      if (itemMode === "startEnd") {
        const start = String(item.startFrame?.filePath || "").trim();
        const end = String(item.endFrame?.filePath || "").trim();
        if (start && end) existingKeySet.add(`startEnd|${start}|${end}`);
      } else {
        const start = String(item.startFrame?.filePath || "").trim();
        if (start) existingKeySet.add(`single|${start}`);
      }
    }

    const nextDrafts: StoryboardVideoDraftConfig[] = [];
    if (mode === "startEnd") {
      for (let i = 0; i < frames.length - 1; i++) {
        const first = frames[i];
        const second = frames[i + 1];
        const startFrame = toFrameRef(first);
        const endFrame = toFrameRef(second);
        const key = `startEnd|${startFrame.filePath}|${endFrame.filePath}`;
        if (existingKeySet.has(key)) continue;
        existingKeySet.add(key);
        nextDrafts.push({
          draftId: makeDraftId(),
          aiConfigId: config.aiConfigId,
          manufacturer: config.manufacturer || "",
          model: config.model || "",
          mode: "startEnd",
          resolution: config.resolution || "720p",
          duration: Number(config.duration || 5),
          prompt: buildAutoVideoPrompt(first, second),
          audioEnabled: Boolean(config.audioEnabled),
          startFrame,
          endFrame,
          images: [],
        });
      }
    } else {
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const startFrame = toFrameRef(frame);
        const key = `single|${startFrame.filePath}`;
        if (existingKeySet.has(key)) continue;
        existingKeySet.add(key);
        nextDrafts.push({
          draftId: makeDraftId(),
          aiConfigId: config.aiConfigId,
          manufacturer: config.manufacturer || "",
          model: config.model || "",
          mode: "single",
          resolution: config.resolution || "720p",
          duration: Number(config.duration || 5),
          prompt: buildAutoVideoPrompt(frame),
          audioEnabled: Boolean(config.audioEnabled),
          startFrame,
          endFrame: null,
          images: [],
        });
      }
    }

    if (nextDrafts.length > 0) {
      videoDraftState.configs = [...videoDraftState.configs, ...nextDrafts];
      touchVideoDraft();
    }
    return videoDraftState.configs.map((item) => ({
      id: toVirtualConfigId(item),
      aiConfigId: item.aiConfigId,
      manufacturer: item.manufacturer,
      model: item.model,
      mode: item.mode,
      resolution: item.resolution,
      duration: item.duration,
      prompt: item.prompt,
      audioEnabled: item.audioEnabled,
      startFrame: item.startFrame,
      endFrame: item.endFrame,
      images: item.images,
    })) as VideoConfigRow[];
  };

  const getConfigFilePaths = (config: VideoConfigRow): string[] => {
    const mode = parseMode(config.mode) || "single";
    if (mode === "startEnd") {
      const list = [config.startFrame?.filePath, config.endFrame?.filePath].filter((item) => Boolean(item && String(item).trim()));
      return list as string[];
    }
    const list = [config.startFrame?.filePath].filter((item) => Boolean(item && String(item).trim()));
    return list as string[];
  };

  const listDraftVideoConfigs = (): VideoConfigRow[] => {
    return videoDraftState.configs.map((item) => ({
      id: toVirtualConfigId(item),
      aiConfigId: item.aiConfigId,
      manufacturer: item.manufacturer,
      model: item.model,
      mode: item.mode,
      resolution: item.resolution,
      duration: item.duration,
      prompt: item.prompt,
      audioEnabled: item.audioEnabled,
      startFrame: item.startFrame,
      endFrame: item.endFrame,
      images: item.images,
    })) as VideoConfigRow[];
  };

  const listExecutableVideoConfigs = async (): Promise<VideoConfigRow[]> => {
    const draftRows = listDraftVideoConfigs();
    if (draftRows.length > 0) return draftRows;
    return listPersistedVideoConfigs();
  };

  const submitVideoTasksFromConfigs = async (input?: { configId?: number; index?: number }) => {
    const configs = await listExecutableVideoConfigs();
    if (!configs.length) {
      sendNotice("当前没有视频配置。请先发送 /生成视频配置。");
      return;
    }

    if (!input?.configId && !input?.index) {
      sendNotice("已禁用“全部生成视频”。请指定配置ID，例如：/生成视频 12，或在配置卡片中逐个点击生成。");
      return;
    }

    let targets = configs;
    if (input?.configId) {
      const byId = configs.filter((item) => item.id === input.configId);
      if (byId.length > 0) targets = byId;
      else targets = configs[input.configId - 1] ? [configs[input.configId - 1]] : [];
    } else if (input?.index && input.index > 0) {
      targets = configs[input.index - 1] ? [configs[input.index - 1]] : [];
    }

    if (!targets.length) {
      sendNotice("未找到对应的视频配置。请先发送 /生成视频配置 或检查配置序号。");
      return;
    }

    let successCount = 0;
    let failCount = 0;
    const failMessages: string[] = [];
    for (let i = 0; i < targets.length; i++) {
      const item = targets[i];
      try {
        const filePath = getConfigFilePaths(item);
        const mode = parseMode(item.mode) || selectedVideoMode;
        if (mode !== "text" && filePath.length === 0) {
          failCount++;
          if (failMessages.length < 3) failMessages.push(`配置${item.id}: 缺少可用图片`);
          continue;
        }
        if (isVirtualConfigId(item.id)) {
          await createVideoTask({
            projectId: projectIdNum,
            scriptId: scriptIdNum,
            configId: item.id,
            aiConfigId: item.aiConfigId,
            resolution: item.resolution || "720p",
            filePath,
            duration: Number(item.duration || 5),
            prompt: item.prompt || "",
            mode,
            audioEnabled: Boolean(item.audioEnabled),
          });
        } else {
          await createVideoTask({
            projectId: projectIdNum,
            scriptId: scriptIdNum,
            configId: item.id,
            aiConfigId: item.aiConfigId,
            resolution: item.resolution || "720p",
            filePath,
            duration: Number(item.duration || 5),
            prompt: item.prompt || "",
            mode,
            audioEnabled: Boolean(item.audioEnabled),
          });
        }
        successCount++;
      } catch (err: any) {
        failCount++;
        if (failMessages.length < 3) {
          failMessages.push(`配置${item.id}: ${u.error(err).message}`);
        }
      }
    }

    let summary = `已提交视频任务：成功 ${successCount} 条，失败 ${failCount} 条。`;
    if (failMessages.length) summary += `\n失败示例：\n${failMessages.join("\n")}`;
    sendNotice(summary);
  };

  const publishVideoPlanToCanvasAsync = async () => {
    if (!isVideoMode) return;
    const mode = selectedVideoMode;
    const plans = buildVideoPlanShots(mode);
    if (!plans.length) {
      send("shotsUpdated", []);
      sendNotice("当前没有可用图片，无法生成视频配置画布。请先准备分镜图片。");
      return;
    }
    videoPlanShots = plans;

    const draftConfigs = await createVideoConfigPlans();
    if (!draftConfigs.length) {
      send("shotsUpdated", plans);
      sendNotice("已整理出视频计划，但没有新增可用的视频配置。");
      return;
    }

    // 视频模式展示“视频配置画布”
    const canvasPlans = buildVideoPlansFromConfigRows(draftConfigs);
    send("shotsUpdated", canvasPlans.length ? canvasPlans : plans);
    send("refresh", "videoConfigs");
    const modeText = mode === "startEnd" ? "首尾帧（1-2,2-3串联）" : "单图（每图一个视频）";
    sendNotice(
      `已生成 ${draftConfigs.length} 条视频配置并同步到画布（模式：${modeText}）。\n下一步：请在配置卡片中逐条生成，或发送 /生成视频 <视频配置ID>。`,
    );
  };

  const syncVideoCanvasAsync = async () => {
    if (!isVideoMode) return;
    const existed = listDraftVideoConfigs();
    const canvasPlans = buildVideoPlansFromConfigRows(existed);
    if (canvasPlans.length > 0) {
      send("shotsUpdated", canvasPlans);
      send("refresh", "videoConfigs");
      return;
    }
    // AI视频画布只展示视频配置；无配置时保持空画布。
    send("shotsUpdated", []);
    send("refresh", "videoConfigs");
  };

  const exportVideoDraftConfigsToDb = async () => {
    if (!isVideoMode) return;
    if (!videoDraftState.configs.length) {
      sendNotice("当前会话没有可导出的草稿视频配置。");
      return;
    }

    const existingRows = await listPersistedVideoConfigs();
    const keyOf = (cfg: {
      aiConfigId: number;
      mode: string;
      startFrame: VideoFrameRef | null;
      endFrame: VideoFrameRef | null;
    }) => {
      const mode = parseMode(cfg.mode) || "single";
      const start = String(cfg.startFrame?.filePath || "").trim();
      const end = String(cfg.endFrame?.filePath || "").trim();
      return `${cfg.aiConfigId}|${mode}|${start}|${end}`;
    };

    const existingByKey = new Map<string, VideoConfigRow>();
    for (const row of existingRows) {
      existingByKey.set(keyOf(row), row);
    }

    const maxIdResult: any = await u.db("t_videoConfig").max("id as maxId").first();
    let nextId = Number(maxIdResult?.maxId || 0) + 1;
    const now = Date.now();
    let inserted = 0;
    let updated = 0;

    for (const draft of videoDraftState.configs) {
      const mode = parseMode(draft.mode) || "single";
      const rowLike: VideoConfigRow = {
        id: 0,
        aiConfigId: draft.aiConfigId,
        mode,
        resolution: draft.resolution || "720p",
        duration: Number(draft.duration || 5),
        prompt: draft.prompt || "",
        audioEnabled: Boolean(draft.audioEnabled),
        startFrame: draft.startFrame,
        endFrame: draft.endFrame,
        images: draft.images || [],
      };
      const key = keyOf(rowLike);
      const existing = existingByKey.get(key);

      const payload = {
        scriptId: scriptIdNum,
        projectId: projectIdNum,
        aiConfigId: draft.aiConfigId,
        manufacturer: draft.manufacturer || "",
        mode,
        startFrame: draft.startFrame ? JSON.stringify(draft.startFrame) : null,
        endFrame: draft.endFrame ? JSON.stringify(draft.endFrame) : null,
        images: draft.images?.length ? JSON.stringify(draft.images) : null,
        resolution: draft.resolution || "720p",
        duration: Number(draft.duration || 5),
        prompt: draft.prompt || "",
        audioEnabled: draft.audioEnabled ? 1 : 0,
        updateTime: now,
      };

      if (existing?.id) {
        await u.db("t_videoConfig").where({ id: existing.id }).update(payload);
        updated += 1;
      } else {
        await u.db("t_videoConfig").insert({
          id: nextId++,
          ...payload,
          selectedResultId: null,
          createTime: now,
        });
        inserted += 1;
      }
    }

    send("refresh", "videoConfigs");
    sendNotice(`视频配置导出完成：新增 ${inserted} 条，更新 ${updated} 条。`);
  };

  const ensureVideoConfigForScript = async (config: VideoConfigSummary): Promise<VideoConfigSummary> => {
    if (config.id > 0) return config;

    const existing = await u
      .db("t_videoConfig")
      .where({
        scriptId: scriptIdNum,
        projectId: projectIdNum,
        aiConfigId: config.aiConfigId,
      })
      .orderBy("updateTime", "desc")
      .first();

    if (existing) {
      const mode = parseMode(String(existing.mode || "")) || config.mode || "single";
      const merged: VideoConfigSummary = {
        ...config,
        id: Number(existing.id || 0),
        mode,
        resolution: String(existing.resolution || config.resolution || "720p"),
        duration: Number(existing.duration || config.duration || 5),
        prompt: String(existing.prompt || config.prompt || ""),
        audioEnabled: Boolean(existing.audioEnabled),
      };
      videoConfigsCache = videoConfigsCache.map((item) => (item.aiConfigId === merged.aiConfigId ? merged : item));
      return merged;
    }

    const maxIdResult: any = await u.db("t_videoConfig").max("id as maxId").first();
    const newId = Number(maxIdResult?.maxId || 0) + 1;
    const now = Date.now();
    await u.db("t_videoConfig").insert({
      id: newId,
      scriptId: scriptIdNum,
      projectId: projectIdNum,
      aiConfigId: config.aiConfigId,
      manufacturer: config.manufacturer || "",
      mode: "single",
      startFrame: null,
      endFrame: null,
      images: null,
      resolution: config.resolution || "720p",
      duration: Number(config.duration || 5),
      prompt: config.prompt || "",
      selectedResultId: null,
      createTime: now,
      updateTime: now,
      audioEnabled: config.audioEnabled ? 1 : 0,
    });

    const created: VideoConfigSummary = { ...config, id: newId };
    videoConfigsCache = videoConfigsCache.map((item) => (item.aiConfigId === created.aiConfigId ? created : item));
    return created;
  };

  const generateVideoTasks = async (frames: FrameItem[]) => {
    let config = await getSelectedVideoConfig();
    if (!config) {
      sendNotice("请先选择视频模型。可发送 /视频配置 查看，然后 /选择视频配置 <序号或模型ID>。");
      return;
    }
    config = await ensureVideoConfigForScript(config);
    if (!frames.length) {
      sendNotice("当前没有可用分镜图片，请先生成分镜图。");
      return;
    }

    const mode = selectedVideoMode;
    const tasks: Array<{ filePath: string[]; prompt: string }> = [];

    if (mode === "startEnd") {
      if (frames.length < 2) {
        sendNotice("首尾帧模式至少需要2张图片。");
        return;
      }
      for (let i = 0; i < frames.length - 1; i++) {
        const first = frames[i];
        const second = frames[i + 1];
        const prompt = first.prompt || second.prompt || config.prompt || `分镜${first.segmentId}-镜头${first.cellIndex}到分镜${second.segmentId}-镜头${second.cellIndex}`;
        tasks.push({
          filePath: [first.src, second.src],
          prompt,
        });
      }
    } else {
      for (const frame of frames) {
        const prompt = frame.prompt || config.prompt || `分镜${frame.segmentId}-镜头${frame.cellIndex}`;
        tasks.push({
          filePath: [frame.src],
          prompt,
        });
      }
    }

    const maxTasks = 80;
    const queue = tasks.slice(0, maxTasks);
    if (!queue.length) {
      sendNotice("没有可提交的视频任务。");
      return;
    }
    if (tasks.length > maxTasks) {
      sendNotice(`任务较多，已限制为前 ${maxTasks} 条，请分批生成。`);
    }

    let successCount = 0;
    let failCount = 0;
    const failMessages: string[] = [];
    for (let i = 0; i < queue.length; i++) {
      const task = queue[i];
      try {
        await createVideoTask({
          projectId: projectIdNum,
          scriptId: scriptIdNum,
          configId: config.id,
          aiConfigId: config.aiConfigId,
          resolution: config.resolution,
          filePath: task.filePath,
          duration: config.duration,
          prompt: task.prompt,
          mode,
          audioEnabled: config.audioEnabled,
        });
        successCount++;
      } catch (err: any) {
        failCount++;
        if (failMessages.length < 3) {
          failMessages.push(`第${i + 1}条: ${u.error(err).message}`);
        }
      }
    }

    const modeText = mode === "startEnd" ? "首尾帧串联" : "单图";
    let summary = `已提交视频生成任务：成功 ${successCount} 条，失败 ${failCount} 条（模式：${modeText}）。`;
    if (failMessages.length) {
      summary += `\n失败示例：\n${failMessages.join("\n")}`;
    }
    summary += "\n可到视频页面查看结果进度。";
    sendNotice(summary);
  };

  const clonePlanSnapshot = (snapshot: { shots: any[]; shotIdCounter: number }): StoryboardPendingPlanSnapshot => {
    return {
      shots: JSON.parse(JSON.stringify(Array.isArray(snapshot.shots) ? snapshot.shots : [])),
      shotIdCounter: Number.isFinite(snapshot.shotIdCounter) ? snapshot.shotIdCounter : 0,
    };
  };

  const hasShotSnapshotChanged = (before: StoryboardPendingPlanSnapshot, after: StoryboardPendingPlanSnapshot): boolean => {
    if (before.shotIdCounter !== after.shotIdCounter) return true;
    return JSON.stringify(before.shots) !== JSON.stringify(after.shots);
  };

  const buildStoryboardPlanSummary = (before: StoryboardPendingPlanSnapshot, after: StoryboardPendingPlanSnapshot): string => {
    const beforeMap = new Map<number, any>();
    for (const shot of before.shots || []) {
      const id = Number(shot?.id || 0);
      if (id > 0) beforeMap.set(id, shot);
    }
    const afterList = Array.isArray(after.shots) ? after.shots : [];
    const changed = afterList.filter((shot: any) => {
      const id = Number(shot?.id || 0);
      const prev = beforeMap.get(id);
      if (!prev) return true;
      return JSON.stringify(prev) !== JSON.stringify(shot);
    });
    const previewList = changed.length ? changed : afterList;
    const lines = previewList.slice(0, 8).map((shot: any, index: number) => {
      const segId = Number(shot?.segmentId || shot?.id || index + 1);
      const title = String(shot?.title || `分镜${segId}`).trim();
      const cellCount = Array.isArray(shot?.cells) ? shot.cells.length : 0;
      const firstPrompt = String(shot?.cells?.[0]?.prompt || "").replace(/\s+/g, " ").trim();
      const promptPreview = firstPrompt ? `，首镜头：${firstPrompt.slice(0, 40)}${firstPrompt.length > 40 ? "..." : ""}` : "";
      return `${index + 1}. 分镜${segId}《${title}》${cellCount}镜头${promptPreview}`;
    });
    const changedCount = changed.length;
    const totalAfter = afterList.length;
    const omitted = Math.max(0, (previewList.length || 0) - lines.length);
    const head = `分镜计划预览：共 ${totalAfter} 个分镜，新增/变更 ${changedCount} 个。`;
    const tail = omitted > 0 ? `\n...其余 ${omitted} 个分镜已省略预览` : "";
    return `${head}\n${lines.join("\n")}${tail}`;
  };

  const parsePositiveIdsFromText = (text: string): number[] => {
    const matches = String(text || "").match(/\d+/g) || [];
    const nums = matches.map((item) => Math.trunc(Number(item))).filter((num) => Number.isFinite(num) && num > 0);
    return Array.from(new Set(nums));
  };

  const parsePrefixedIdsFromText = (text: string, prefix: "片段" | "分镜"): number[] => {
    const raw = String(text || "");
    const ids: number[] = [];
    const single = new RegExp(`${prefix}\\s*(\\d+)`, "g");
    let match: RegExpExecArray | null = null;
    while ((match = single.exec(raw)) !== null) {
      const num = Math.trunc(Number(match[1]));
      if (Number.isFinite(num) && num > 0) ids.push(num);
    }

    const range = new RegExp(`${prefix}\\s*(\\d+)\\s*[-~到至]\\s*(\\d+)`, "g");
    while ((match = range.exec(raw)) !== null) {
      const start = Math.trunc(Number(match[1]));
      const end = Math.trunc(Number(match[2]));
      if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0) continue;
      const from = Math.min(start, end);
      const to = Math.max(start, end);
      for (let i = from; i <= to; i++) ids.push(i);
    }

    return Array.from(new Set(ids));
  };

  const isGenerateStoryboardImageCommand = (text: string): boolean => {
    const raw = String(text || "").trim();
    if (!raw) return false;
    if (/^\/?(生图|generate-shot-image)$/i.test(raw)) return true;
    const compact = raw.replace(/\s+/g, "");
    const hasAction = /(生成|重生成|重新生成|开始生成)/.test(compact);
    const hasTarget = /(分镜图|分镜图片|镜头图)/.test(compact);
    return hasAction && hasTarget;
  };

  const isCheckStoryboardImageCommand = (text: string): boolean => {
    const raw = String(text || "").trim();
    if (!raw) return false;
    if (/^\/?(检查分镜图|检查分镜图片|检查分镜生成|检查生图|查看分镜图状态|查看分镜状态|分镜图状态|分镜状态)$/i.test(raw)) {
      return true;
    }
    const compact = raw.replace(/\s+/g, "");
    const hasCheckAction = /(检查|核对|查看|状态|统计)/.test(compact);
    const hasTarget = /(分镜图|分镜图片|镜头图|生图)/.test(compact);
    return hasCheckAction && hasTarget;
  };

  const isRetryMissingStoryboardImageCommand = (text: string): boolean => {
    const raw = String(text || "").trim();
    if (!raw) return false;
    if (/^\/?(补齐分镜图|补全分镜图|重试失败分镜图|重试分镜图|补齐生图|补全生图)$/i.test(raw)) {
      return true;
    }
    const compact = raw.replace(/\s+/g, "");
    const hasRetryAction = /(补齐|补全|重试|继续生成|继续生图)/.test(compact);
    const hasTarget = /(分镜图|分镜图片|镜头图|生图)/.test(compact);
    return hasRetryAction && hasTarget;
  };

  const collectStoryboardImageStatus = () => {
    const shots = agent.getShotsSnapshot().shots || [];
    const generatingIds = new Set(agent.getGeneratingShotIds());
    const completeIds: number[] = [];
    const generating: number[] = [];
    const pendingIds: number[] = [];
    const noPromptIds: number[] = [];

    for (const shot of shots) {
      const shotId = Math.trunc(Number(shot?.id || 0));
      if (shotId <= 0) continue;
      const cells = Array.isArray(shot?.cells) ? shot.cells : [];
      const promptCells = cells.filter((cell: any) => String(cell?.prompt || "").trim().length > 0);
      const promptCount = promptCells.length;
      const imageCount = promptCells.filter((cell: any) => String(cell?.src || "").trim().length > 0).length;

      if (generatingIds.has(shotId)) {
        generating.push(shotId);
        continue;
      }
      if (promptCount === 0) {
        noPromptIds.push(shotId);
        continue;
      }
      if (imageCount < promptCount) {
        pendingIds.push(shotId);
        continue;
      }
      completeIds.push(shotId);
    }

    return {
      total: shots.length,
      completeIds,
      generating,
      pendingIds,
      noPromptIds,
    };
  };

  const reportStoryboardImageStatus = async (): Promise<void> => {
    const status = collectStoryboardImageStatus();
    if (!status.total) {
      sendNotice("当前没有分镜，请先生成分镜提示词。");
      return;
    }

    const lines: string[] = [
      `分镜图状态：共 ${status.total} 个分镜。`,
      `已完成 ${status.completeIds.length}，生成中 ${status.generating.length}，待补齐 ${status.pendingIds.length}，无提示词 ${status.noPromptIds.length}。`,
    ];

    if (status.generating.length) {
      lines.push(`生成中分镜：${status.generating.slice(0, 20).join(", ")}${status.generating.length > 20 ? " ..." : ""}`);
    }
    if (status.pendingIds.length) {
      lines.push(`待补齐分镜：${status.pendingIds.slice(0, 20).join(", ")}${status.pendingIds.length > 20 ? " ..." : ""}`);
      lines.push("可发送：/补齐分镜图（仅重试缺失分镜，不会全量重跑）。");
    }
    if (status.noPromptIds.length) {
      lines.push(`无提示词分镜：${status.noPromptIds.slice(0, 20).join(", ")}${status.noPromptIds.length > 20 ? " ..." : ""}`);
      lines.push("这些分镜需要先补提示词，再生图。");
    }
    sendNotice(lines.join("\n"));
  };

  const startMissingStoryboardImageGeneration = async (): Promise<void> => {
    const status = collectStoryboardImageStatus();
    if (!status.total) {
      sendNotice("当前没有分镜，请先生成分镜提示词。");
      return;
    }
    if (!status.pendingIds.length) {
      sendNotice("当前没有需要补齐的分镜图。");
      return;
    }
    const result = await agent.startGenerateShotImages(status.pendingIds);
    sendNotice(`${result}\n已按缺失状态重试分镜：${status.pendingIds.join(", ")}`);
  };

  const startStoryboardImageGeneration = async (inputText: string, explicitShotIds: number[] = []): Promise<void> => {
    const shots = agent.getShotsSnapshot().shots || [];
    const existingShotIds = shots.map((item: any) => Math.trunc(Number(item?.id || 0))).filter((id: number) => id > 0);
    if (!existingShotIds.length) {
      sendNotice("当前没有可生成的分镜，请先生成分镜提示词。");
      return;
    }

    const fromPayloadShotIds = Array.from(new Set((explicitShotIds || []).map((id) => Math.trunc(Number(id))).filter((id) => id > 0)));
    const segmentIdsFromText = parsePrefixedIdsFromText(inputText, "片段");
    const shotIdsFromText = parsePrefixedIdsFromText(inputText, "分镜");
    const genericIdsFromText = parsePositiveIdsFromText(inputText);

    const mapSegmentToShotIds = (segmentIds: number[]): number[] =>
      shots
        .filter((shot: any) => segmentIds.includes(Math.trunc(Number(shot?.segmentId || 0))))
        .map((shot: any) => Math.trunc(Number(shot?.id || 0)))
        .filter((id: number) => id > 0);

    const targetIdsSet = new Set<number>();
    fromPayloadShotIds.forEach((id) => targetIdsSet.add(id));
    shotIdsFromText.forEach((id) => targetIdsSet.add(id));
    mapSegmentToShotIds(segmentIdsFromText).forEach((id) => targetIdsSet.add(id));

    // 兜底：未显式写“分镜/片段”时，默认按分镜ID处理；若语句包含“片段”且未写分镜ID，则按片段ID处理
    if (targetIdsSet.size === 0 && genericIdsFromText.length > 0) {
      const text = String(inputText || "");
      const hasSegmentWord = /片段/.test(text);
      const hasShotWordWithNumber = /分镜\s*\d+/.test(text);
      const fallbackShotIds = hasSegmentWord && !hasShotWordWithNumber ? mapSegmentToShotIds(genericIdsFromText) : genericIdsFromText;
      fallbackShotIds.forEach((id) => targetIdsSet.add(id));
    }

    const targetIds = targetIdsSet.size > 0 ? Array.from(targetIdsSet) : existingShotIds;
    const result = await agent.startGenerateShotImages(targetIds);

    if (targetIdsSet.size === 0 && segmentIdsFromText.length > 0) {
      sendNotice(`未找到片段 ${segmentIdsFromText.join(", ")} 对应的分镜，已回退为全部分镜生图。\n${result}`);
      return;
    }
    if (targetIdsSet.size === 0 && (segmentIdsFromText.length > 0 || shotIdsFromText.length > 0 || genericIdsFromText.length > 0)) {
      sendNotice(`未匹配到有效分镜ID，已回退为全部分镜生图。\n${result}`);
      return;
    }
    sendNotice(result);
  };

  const shouldUseStoryboardPlanConfirm = (prompt: string): boolean => {
    if (isVideoMode || !STORYBOARD_PLAN_CONFIRM) return false;
    const text = String(prompt || "").trim();
    if (!text || text.startsWith("/")) return false;
    if (isGenerateStoryboardImageCommand(text)) return false;
    if (isCheckStoryboardImageCommand(text)) return false;
    if (isRetryMissingStoryboardImageCommand(text)) return false;
    if (pendingStoryboardPlan && /^\/?(确认|同意|应用|保存|取消|放弃|不要了)$/.test(text)) return false;
    const hasStoryboardTarget = /(片段|分镜|镜头|宫格|剧情|文戏|打斗|动作)/.test(text);
    const hasPlanningAction = /(生成|创建|重做|重生成|重新|改|调整|优化|补充|细化|拆分|合并|增加|减少|删除|规划|设计|改成|变成)/.test(text);
    return hasStoryboardTarget && hasPlanningAction;
  };

  const runStoryboardWithPlanConfirm = async (prompt: string): Promise<boolean> => {
    if (!shouldUseStoryboardPlanConfirm(prompt)) return false;
    if (pendingStoryboardPlan) {
      sendNotice("当前有待确认的分镜计划。请先发送 /确认分镜计划 或 /取消分镜计划。");
      return true;
    }

    const before = clonePlanSnapshot(agent.getShotsSnapshot());
    await agent.call(prompt);
    const after = clonePlanSnapshot(agent.getShotsSnapshot());

    if (!hasShotSnapshotChanged(before, after)) {
      return true;
    }

    const summary = buildStoryboardPlanSummary(before, after);
    pendingStoryboardPlan = {
      sourcePrompt: prompt,
      createdAt: Date.now(),
      before,
      after,
      summary,
    };

    // 回退到旧画布，等待用户确认后再应用计划。
    agent.restoreShotsFromSession(before.shots, before.shotIdCounter);
    sendNotice(`${summary}\n\n请发送 /确认分镜计划 以写入画布，或发送 /取消分镜计划 放弃本次计划。`);
    return true;
  };

  const listSessions = async () => {
    sessionsCache = await loadScopedSessions();
    sendNotice(formatSessionListText(sessionsCache, currentSessionId));
  };

  const resolveSessionId = (inputId: string): string => {
    const raw = inputId.trim();
    if (!raw) return "";
    const byId = sessionsCache.find((item) => item.id === raw);
    if (byId) return byId.id;
    if (/^\d+$/.test(raw)) {
      const index = Number(raw) - 1;
      if (index >= 0 && index < sessionsCache.length) return sessionsCache[index].id;
    }
    return raw;
  };

  const switchSession = async (sessionIdToSwitch: string) => {
    const targetId = resolveSessionId(sessionIdToSwitch);
    if (!targetId) {
      sendNotice("会话ID不能为空。");
      return;
    }
    const target = sessionsCache.find((item) => item.id === targetId);
    if (!target) {
      sendNotice(`未找到会话：${sessionIdToSwitch}。可发送 /会话 查看列表（支持ID或序号）。`);
      return;
    }
    await saveHistory();
    const loaded = await loadStoryboardChatSession(projectIdNum, targetId);
    if (!loaded) {
      sendNotice(`会话数据不存在：${targetId}。`);
      return;
    }
    currentSessionId = targetId;
    agent.history = Array.isArray(loaded.history) ? loaded.history : [];
    agent.novelChapters = Array.isArray(loaded.novelChapters) ? loaded.novelChapters : [];
    agent.restoreShotsFromSession(loaded.shots, loaded.shotIdCounter);
    if (isVideoMode) {
      pendingStoryboardPlan = null;
      applyVideoDraftFromSession(loaded.videoDraft);
    } else {
      pendingStoryboardPlan = loaded.pendingStoryboardPlan || null;
    }
    sendSessionHistory();
    if (isVideoMode) await syncVideoCanvasAsync();
    else send("shotsUpdated", agent.getShotsSnapshot().shots);
    sendNotice(`已切换到会话「${target.title}」。你可以继续提问。`);
  };

  const createAndSwitchSession = async (title?: string) => {
    await saveHistory();
    const created = await createStoryboardChatSession({
      projectId: projectIdNum,
      scriptId: sessionScopeScriptId,
      title,
    });
    sessionsCache = await loadScopedSessions();
    currentSessionId = created.sessionId;
    const snapshot = agent.getShotsSnapshot();
    agent.history = [];
    agent.novelChapters = [];
    if (isVideoMode) {
      agent.restoreShotsFromSession(snapshot.shots, snapshot.shotIdCounter);
      videoDraftState = createEmptyVideoDraft();
    } else {
      agent.restoreShotsFromSession([], 0);
      pendingStoryboardPlan = null;
    }
    sendSessionHistory();
    if (isVideoMode) await syncVideoCanvasAsync();
    else send("shotsUpdated", agent.getShotsSnapshot().shots);
    sendNotice(`已创建并切换到新会话「${getCurrentSessionTitle()}」。`);
  };

  const renameSession = async (sessionIdToRename: string, nextTitle: string) => {
    const targetId = resolveSessionId(sessionIdToRename);
    const title = nextTitle.trim();
    if (!targetId || !title) {
      sendNotice("用法：/重命名会话 <ID> <新标题>");
      return;
    }
    await renameStoryboardChatSession(projectIdNum, targetId, title);
    sessionsCache = await loadScopedSessions();
    sendNotice(`会话 ${targetId} 已重命名为「${title}」。`);
  };

  const deleteSession = async (sessionIdToDelete: string) => {
    const targetId = resolveSessionId(sessionIdToDelete);
    if (!targetId) {
      sendNotice("用法：/删除会话 <ID>");
      return;
    }

    sessionsCache = await loadScopedSessions();
    if (sessionsCache.length <= 1 && sessionsCache[0]?.id === targetId) {
      const snapshot = agent.getShotsSnapshot();
      agent.history = [];
      agent.novelChapters = [];
      if (isVideoMode) {
        agent.restoreShotsFromSession(snapshot.shots, snapshot.shotIdCounter);
        videoDraftState = createEmptyVideoDraft();
      } else {
        agent.restoreShotsFromSession([], 0);
        pendingStoryboardPlan = null;
      }
      await saveHistory();
      sendSessionHistory();
      if (isVideoMode) await syncVideoCanvasAsync();
      else send("shotsUpdated", agent.getShotsSnapshot().shots);
      sendNotice("当前只有一个会话，已清空其历史内容。");
      return;
    }

    const exists = sessionsCache.some((item) => item.id === targetId);
    if (!exists) {
      sendNotice(`未找到会话：${sessionIdToDelete}（支持ID或序号）`);
      return;
    }

    await saveHistory();
    await deleteStoryboardChatSession(projectIdNum, targetId);
    sessionsCache = await loadScopedSessions();
    if (targetId === currentSessionId) {
      const next = sessionsCache[0];
      if (next) {
        const loaded = await loadStoryboardChatSession(projectIdNum, next.id);
        currentSessionId = next.id;
        agent.history = loaded?.history ?? [];
        agent.novelChapters = loaded?.novelChapters ?? [];
        agent.restoreShotsFromSession(loaded?.shots ?? [], loaded?.shotIdCounter ?? 0);
        if (isVideoMode) {
          pendingStoryboardPlan = null;
          applyVideoDraftFromSession(loaded?.videoDraft);
        } else {
          pendingStoryboardPlan = loaded?.pendingStoryboardPlan || null;
        }
        sendSessionHistory();
        if (isVideoMode) await syncVideoCanvasAsync();
        else send("shotsUpdated", agent.getShotsSnapshot().shots);
        sendNotice(`已删除当前会话，自动切换到「${next.title}」。`);
      } else {
        await createAndSwitchSession("默认会话");
      }
    } else {
      sendNotice(`已删除会话：${targetId}`);
    }
  };

  const handleSessionCommand = async (prompt: string): Promise<boolean> => {
    const input = prompt.trim();
    if (!input) return false;

    if (!isVideoMode && /^\/?(确认分镜计划|确认计划|确认|同意|应用计划|应用|保存计划|accept-shot-plan)$/i.test(input)) {
      if (!pendingStoryboardPlan) {
        sendNotice("当前没有待确认的分镜计划。");
        return true;
      }
      agent.restoreShotsFromSession(pendingStoryboardPlan.after.shots, pendingStoryboardPlan.after.shotIdCounter);
      const summary = pendingStoryboardPlan.summary;
      pendingStoryboardPlan = null;
      sendNotice(`${summary}\n\n已确认并写入画布。`);
      return true;
    }

    if (!isVideoMode && /^\/?(取消分镜计划|取消计划|取消|放弃|不要了|discard-shot-plan)$/i.test(input)) {
      if (!pendingStoryboardPlan) {
        sendNotice("当前没有待取消的分镜计划。");
        return true;
      }
      pendingStoryboardPlan = null;
      sendNotice("已取消本次分镜计划，画布保持不变。");
      return true;
    }

    if (!isVideoMode && isRetryMissingStoryboardImageCommand(input)) {
      await startMissingStoryboardImageGeneration();
      return true;
    }

    if (!isVideoMode && isGenerateStoryboardImageCommand(input)) {
      await startStoryboardImageGeneration(input);
      return true;
    }

    if (!isVideoMode && isCheckStoryboardImageCommand(input)) {
      await reportStoryboardImageStatus();
      return true;
    }

    if (isVideoMode && /^\/?(开始|start)$/i.test(input)) {
      videoFlowStep = "selectConfig";
      await syncVideoCanvasAsync();
      await listVideoConfigs();
      return true;
    }

    if (isVideoMode && !input.startsWith("/")) {
      const configInput = extractConfigInputFromText(input);
      if (configInput && (videoFlowStep === "selectConfig" || videoFlowStep === "idle")) {
        const ok = await selectVideoConfig(configInput);
        if (ok) videoFlowStep = "selectMode";
        return true;
      }
    }

    if (/^\/?(视频配置|视频模型|查看视频配置|查看视频模型|列出视频配置|列出视频模型)$/i.test(input)) {
      videoFlowStep = "selectConfig";
      await listVideoConfigs();
      return true;
    }

    const selectVideoConfigMatch = input.match(/^\/?(选择视频配置|使用视频配置|选择视频模型|使用视频模型)\s+([^\s]+)$/i);
    if (selectVideoConfigMatch) {
      const ok = await selectVideoConfig(selectVideoConfigMatch[2]);
      if (ok) videoFlowStep = "selectMode";
      return true;
    }

    if (isVideoMode && !input.startsWith("/")) {
      const freeMode = parseMode(input);
      if (freeMode) {
        selectedVideoMode = freeMode;
        touchVideoDraft();
        videoFlowStep = "idle";
        await publishVideoPlanToCanvasAsync();
        return true;
      }
      if (videoFlowStep === "selectConfig") {
        sendNotice("请先选择视频模型：直接回复序号或模型ID（例如：1）。");
        return true;
      }
      if (videoFlowStep === "selectMode") {
        sendNotice("请回复视频模式：首尾帧 或 单图。");
        return true;
      }
    }

    const modeMatch = input.match(/^\/?(视频模式|模式)\s+(.+)$/i);
    if (modeMatch) {
      const nextMode = parseMode(modeMatch[2]);
      if (!nextMode) {
        sendNotice("视频模式仅支持：单图 或 首尾帧。");
        return true;
      }
      selectedVideoMode = nextMode;
      touchVideoDraft();
      videoFlowStep = "idle";
      await publishVideoPlanToCanvasAsync();
      return true;
    }

    if (/^\/?(生成视频配置|全部生成视频配置|批量生成视频配置|刷新视频配置|预览视频配置)$/i.test(input)) {
      await publishVideoPlanToCanvasAsync();
      return true;
    }

    if (/^\/?(导出视频配置|导出全部视频配置)$/i.test(input)) {
      await exportVideoDraftConfigsToDb();
      return true;
    }

    const batchGenerateMatch = input.match(/^\/?(全部生成视频|批量生成视频|全部生成\s*视频|批量生成\s*视频)$/i);
    if (batchGenerateMatch) {
      sendNotice("已禁用“全部生成视频”，避免批量消耗额度。请改用 /生成视频 <视频配置ID> 逐条生成。");
      return true;
    }

    const singleGenerateMatch = input.match(/^\/?(生成视频|生成分镜视频)\s*(?:分镜)?\s*(-?\d+)?$/i);
    if (singleGenerateMatch) {
      const inputId = Number(singleGenerateMatch[2] || 0);
      if (Number.isFinite(inputId) && inputId !== 0) {
        await submitVideoTasksFromConfigs({
          configId: inputId,
          index: inputId > 0 ? inputId : undefined,
        });
      } else {
        sendNotice("请指定视频配置ID。例如：/生成视频 12");
      }
      return true;
    }

    if (/^\/?(视频帮助|video-help|help-video)$/i.test(input)) {
      sendNotice(
        "视频命令：\n/视频模型（或 /视频配置）\n/选择视频模型 <序号或模型ID>\n/视频模式 <单图|首尾帧>\n/生成视频配置\n/导出视频配置\n/生成视频 <视频配置ID>\n说明：已禁用 /全部生成视频",
      );
      return true;
    }

    if (!input.startsWith("/")) return false;

    if (/^\/(会话|sessions?)$/i.test(input)) {
      await listSessions();
      return true;
    }

    const createMatch = input.match(/^\/(新建会话|newsession)(?:\s+(.+))?$/i);
    if (createMatch) {
      await createAndSwitchSession(createMatch[2]?.trim());
      return true;
    }

    const switchMatch = input.match(/^\/(切换会话|switch)\s+([^\s]+)$/i);
    if (switchMatch) {
      await switchSession(switchMatch[2]);
      return true;
    }

    const renameMatch = input.match(/^\/(重命名会话|rename)\s+([^\s]+)\s+(.+)$/i);
    if (renameMatch) {
      await renameSession(renameMatch[2], renameMatch[3]);
      return true;
    }

    const deleteMatch = input.match(/^\/(删除会话|delete)\s+([^\s]+)$/i);
    if (deleteMatch) {
      await deleteSession(deleteMatch[2]);
      return true;
    }

    if (/^\/(会话帮助|session-help|help-session)$/i.test(input)) {
      sendNotice(
        "会话命令：\n/会话\n/新建会话 [标题]\n/切换会话 <ID或序号>\n/重命名会话 <ID或序号> <新标题>\n/删除会话 <ID或序号>\n/确认分镜计划\n/取消分镜计划",
      );
      return true;
    }

    return false;
  };

  const isMixedGridRequest = (text: string): boolean => {
    const input = String(text || "").toLowerCase();
    const has4 = /4\s*宫格|四\s*宫格|2x2|2×2/.test(input);
    const has8 = /8\s*宫格|八\s*宫格|2x4|4x2|2×4|4×2/.test(input);
    const hasSceneFightMix = /(剧情|文戏|叙事).*(打斗|战斗|动作)|(?:打斗|战斗|动作).*(剧情|文戏|叙事)/.test(input);
    return has4 && has8 && hasSceneFightMix;
  };

  // 监听各类事件
  agent.emitter.on("data", (text) => {
    send("stream", text);
  });

  agent.emitter.on("response", async (text) => {
    send("response_end", text);
    await saveHistory();
  });

  agent.emitter.on("subAgentStream", (data) => {
    send("subAgentStream", data);
  });

  agent.emitter.on("subAgentEnd", (data) => {
    send("subAgentEnd", data);
  });

  agent.emitter.on("toolCall", (data) => {
    send("toolCall", data);
  });

  agent.emitter.on("transfer", (data) => {
    send("transfer", data);
  });

  agent.emitter.on("refresh", (data) => {
    send("refresh", data);
  });

  agent.emitter.on("error", (err) => {
    send("error", err.toString());
  });

  agent.emitter.on("segmentsUpdated", (data) => {
    send("segmentsUpdated", data);
  });

  agent.emitter.on("shotsUpdated", (data) => {
    if (isVideoMode) return;
    send("shotsUpdated", data);
  });

  agent.emitter.on("shotImageGenerateStart", (data) => {
    send("shotImageGenerateStart", data);
  });

  agent.emitter.on("shotImageGenerateProgress", (data) => {
    send("shotImageGenerateProgress", data);
  });

  agent.emitter.on("shotImageGenerateComplete", (data) => {
    send("shotImageGenerateComplete", data);
  });

  agent.emitter.on("shotImageGenerateError", (data) => {
    send("shotImageGenerateError", data);
    if (!isVideoMode) {
      const shotId = Number(data?.shotId || 0);
      const errorText = String(data?.error || "分镜图生成失败");
      send("notice", shotId > 0 ? `分镜 ${shotId} 生成失败：${errorText}` : `分镜图生成失败：${errorText}`);
    }
  });

  agent.emitter.on("shotImageGenerateSummary", (data) => {
    send("shotImageGenerateSummary", data);
    if (!isVideoMode) {
      const successCount = Number(data?.successCount || 0);
      const failedCount = Number(data?.failedCount || 0);
      const failed = Array.isArray(data?.failed) ? data.failed.slice(0, 3) : [];
      let summary = `分镜图任务结束：成功 ${successCount} 条，失败 ${failedCount} 条。`;
      if (failed.length > 0) {
        const lines = failed.map((item: any) => `分镜 ${Number(item?.shotId || 0)}：${String(item?.error || "失败")}`);
        summary += `\n失败示例：\n${lines.join("\n")}`;
      }
      send("notice", summary);
      send("response_end", summary);
    }
  });

  send("init", {
    projectId,
    scriptId,
    currentSessionId,
    currentSessionTitle: getCurrentSessionTitle(),
    mode: isVideoMode ? "video" : "storyboard",
  });
  if (!isVideoMode) {
    send("shotsUpdated", agent.getShotsSnapshot().shots);
  } else {
    await syncVideoCanvasAsync();
  }
  sendSessionHistory();

  if (isVideoMode) {
    sendNotice(
      `已进入AI视频会话「${getCurrentSessionTitle()}」。发送“开始”进入流程：选择视频模型 -> 选择模式（首尾帧/单图）-> 生成视频配置 -> 逐条生成视频。`,
    );
    await listSessions();
  } else {
    const confirmHint = STORYBOARD_PLAN_CONFIRM
      ? " 当前启用分镜计划确认：生成后需 /确认分镜计划 才会写入画布。"
      : "";
    sendNotice(
      `已进入会话「${getCurrentSessionTitle()}」。发送 /会话 可查看并切换历史会话。视频生成可用命令：/视频配置 /选择视频配置 /视频模式 /生成视频配置 /生成视频 <视频配置ID>。${confirmHint}`,
    );
    await listSessions();
  }

  type DataTyype =
    | "msg"
    | "cleanHistory"
    | "generateShotImage"
    | "replaceShot"
    | "listSessions"
    | "createSession"
    | "switchSession"
    | "renameSession"
    | "deleteSession";

  ws.on("message", async function (rawData: string) {
    let data: { type: DataTyype; data: any } | null = null;

    try {
      data = JSON.parse(rawData);
    } catch (error) {
      send("error", "数据解析异常");
      ws.close(500, "数据解析异常");
      return;
    }

    if (!data) {
      send("error", "数据格式错误");
      ws.close(500, "数据格式错误");
      return;
    }

    const msg = data.data;
    try {
      switch (data?.type) {
        case "msg": {
          const prompt = msg.data;
          if (msg.type === "user") {
            appendHistory("user", prompt);
            if (await handleSessionCommand(prompt)) {
              await saveHistory();
              return;
            }
            if (!isVideoMode && pendingStoryboardPlan && !String(prompt || "").trim().startsWith("/")) {
              sendNotice("当前有待确认的分镜计划。请发送 /确认分镜计划 或 /取消分镜计划。");
              await saveHistory();
              return;
            }
            if (isVideoMode) {
              sendNotice("当前为AI视频模式。请先发送“开始”，我会引导你完成：选配置 -> 选模式 -> 生成视频。");
              await saveHistory();
              return;
            }
            if (isMixedGridRequest(prompt)) {
              sendNotice(
                "检测到“剧情4宫格 + 打斗8宫格”的混合需求。建议分两步生成更稳定：\n1. 先选择剧情片段，生成4宫格。\n2. 再选择打斗片段，生成8宫格。\n请直接告诉我：哪些片段走4宫格，哪些片段走8宫格（例如：1-3用4宫格，4-6用8宫格）。",
              );
              await saveHistory();
              return;
            }
            if (await runStoryboardWithPlanConfirm(prompt)) {
              await saveHistory();
              return;
            }
            await agent.call(prompt);
          }
          break;
        }
        case "cleanHistory":
          agent.history = [];
          agent.novelChapters = [];
          if (isVideoMode) {
            videoDraftState = createEmptyVideoDraft();
          } else {
            pendingStoryboardPlan = null;
          }
          await saveHistory();
          sendSessionHistory();
          if (isVideoMode) await syncVideoCanvasAsync();
          sendNotice("当前会话历史已清空");
          break;
        case "generateShotImage":
          if (isVideoMode) {
            sendNotice("当前为AI视频模式，不支持分镜生图。");
            break;
          }
          {
            const payload = msg || {};
            const rawShotIds: any[] = [];
            if (Array.isArray(payload?.shotIds)) rawShotIds.push(...payload.shotIds);
            if (typeof payload?.shotId === "number") rawShotIds.push(payload.shotId);
            if (typeof payload?.id === "number") rawShotIds.push(payload.id);
            const shotIds = Array.from(
              new Set(
                rawShotIds,
              ),
            )
              .map((id: any) => Math.trunc(Number(id)))
              .filter((id: number) => id > 0);

            const rawSegmentIds: any[] = [];
            if (Array.isArray(payload?.segmentIds)) rawSegmentIds.push(...payload.segmentIds);
            if (typeof payload?.segmentId === "number") rawSegmentIds.push(payload.segmentId);
            const segmentIds = Array.from(
              new Set(
                rawSegmentIds,
              ),
            )
              .map((id: any) => Math.trunc(Number(id)))
              .filter((id: number) => id > 0);

            if (segmentIds.length) {
              const bySegment = (agent.getShotsSnapshot().shots || [])
                .filter((shot: any) => segmentIds.includes(Math.trunc(Number(shot?.segmentId || 0))))
                .map((shot: any) => Math.trunc(Number(shot?.id || 0)))
                .filter((id: number) => id > 0);
              shotIds.push(...bySegment);
            }

            await startStoryboardImageGeneration("", shotIds);
          }
          break;
        case "replaceShot":
          agent.updatePreShots(msg.segmentId, msg.cellId, msg.cell);
          break;
        case "listSessions":
          await listSessions();
          break;
        case "createSession":
          await createAndSwitchSession(msg?.title);
          break;
        case "switchSession":
          await switchSession(msg?.sessionId || "");
          break;
        case "renameSession":
          await renameSession(msg?.sessionId || "", msg?.title || "");
          break;
        case "deleteSession":
          await deleteSession(msg?.sessionId || "");
          break;
        default:
          break;
      }
    } catch (e: any) {
      send("error", `数据解析/脚本生成异常: ${e?.message || String(e)}`);
      console.error(e);
    }
  });

  ws.on("close", async () => {
    agent?.emitter?.removeAllListeners();
    await saveHistory();
  });

  async function saveHistory() {
    const history = agent?.history || [];
    const novelChapters = agent?.novelChapters || [];
    const { shots, shotIdCounter } = agent.getShotsSnapshot();
    const videoDraft = isVideoMode ? videoDraftState : null;
    const pendingPlan = isVideoMode ? null : pendingStoryboardPlan;
    sessionsCache = await saveStoryboardChatSession({
      projectId: projectIdNum,
      scriptId: sessionScopeScriptId,
      sessionId: currentSessionId,
      history,
      novelChapters,
      shots,
      shotIdCounter,
      videoDraft,
      pendingStoryboardPlan: pendingPlan,
      titleIfMissing: getCurrentSessionTitle(),
    });
    sessionsCache = await loadScopedSessions();
  }
});

export default router;
