import u from "@/utils";

export interface StoryboardChatSessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  preview?: string;
  scriptId?: number | null;
}

export interface StoryboardChatSessionData {
  history: any[];
  novelChapters: any[];
  shots: any[];
  shotIdCounter: number;
}

interface SessionNovelPayload {
  novelChapters: any[];
  shots: any[];
  shotIdCounter: number;
}

const LEGACY_TYPE = "storyboardAgent";
const META_TYPE = "storyboardAgent:sessions";
const SESSION_PREFIX = "storyboardAgent:session:";

const toSessionType = (sessionId: string) => `${SESSION_PREFIX}${sessionId}`;

const safeParseJson = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const normalizeHistoryArray = (raw: unknown): any[] => {
  let value = raw;
  for (let i = 0; i < 3; i++) {
    if (typeof value !== "string") break;
    const text = value.trim();
    if (!text) return [];
    try {
      value = JSON.parse(text);
    } catch {
      return [];
    }
  }

  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const objectValue = value as Record<string, any>;
    if (Array.isArray(objectValue.history)) return objectValue.history;
    if (Array.isArray(objectValue.messages)) return objectValue.messages;
  }
  return [];
};

const parseSessionNovelPayload = (rawNovel: string | null | undefined): SessionNovelPayload => {
  const parsed = safeParseJson<any>(rawNovel, []);
  if (Array.isArray(parsed)) {
    return {
      novelChapters: parsed,
      shots: [],
      shotIdCounter: 0,
    };
  }
  if (parsed && typeof parsed === "object") {
    return {
      novelChapters: Array.isArray(parsed.novelChapters) ? parsed.novelChapters : [],
      shots: Array.isArray(parsed.shots) ? parsed.shots : [],
      shotIdCounter: Number.isFinite(parsed.shotIdCounter as number) ? Number(parsed.shotIdCounter) : 0,
    };
  }
  return {
    novelChapters: [],
    shots: [],
    shotIdCounter: 0,
  };
};

const normalizeTitle = (title: unknown, index: number): string => {
  const text = typeof title === "string" ? title.trim() : "";
  return text || `会话 ${index + 1}`;
};

const normalizeSessionMetaList = (raw: unknown): StoryboardChatSessionMeta[] => {
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  const dedup = new Map<string, StoryboardChatSessionMeta>();
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as StoryboardChatSessionMeta | undefined;
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    if (!id || dedup.has(id)) continue;
    const createdAt = Number.isFinite(item?.createdAt) ? Number(item!.createdAt) : now;
    const updatedAt = Number.isFinite(item?.updatedAt) ? Number(item!.updatedAt) : createdAt;
    dedup.set(id, {
      id,
      title: normalizeTitle(item?.title, i),
      createdAt,
      updatedAt,
      preview: typeof item?.preview === "string" ? item.preview : "",
      scriptId: Number.isFinite(item?.scriptId as number) ? Number(item!.scriptId) : null,
    });
  }
  return Array.from(dedup.values()).sort((a, b) => b.updatedAt - a.updatedAt);
};

const buildPreview = (history: any[]): string => {
  if (!Array.isArray(history) || history.length === 0) return "";
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (typeof item?.content === "string" && item.content.trim()) {
      return item.content.trim().slice(0, 100);
    }
    if (Array.isArray(item?.content)) {
      const textPart = item.content.find((part: any) => typeof part?.text === "string" && part.text.trim());
      if (textPart?.text) return String(textPart.text).trim().slice(0, 100);
    }
  }
  return "";
};

const createSessionId = (): string => `s_${u.uuid().replace(/-/g, "").slice(0, 16)}`;

const pickSessionsForScript = (
  sessions: StoryboardChatSessionMeta[],
  scriptId?: number | null,
): StoryboardChatSessionMeta[] => {
  if (!Number.isFinite(scriptId as number)) return sessions;
  const currentScriptId = Number(scriptId);
  const exact = sessions.filter((item) => Number.isFinite(item.scriptId as number) && Number(item.scriptId) === currentScriptId);
  if (exact.length > 0) return exact;
  const legacy = sessions.filter((item) => !Number.isFinite(item.scriptId as number));
  if (legacy.length > 0) return legacy;
  return sessions;
};

const getMetaRow = async (projectId: number) => {
  return u.db("t_chatHistory").where({ projectId, type: META_TYPE }).first();
};

const getMetaList = async (projectId: number): Promise<StoryboardChatSessionMeta[]> => {
  const row = await getMetaRow(projectId);
  const parsed = safeParseJson<unknown>(row?.data, []);
  return normalizeSessionMetaList(parsed);
};

const upsertMetaList = async (projectId: number, sessions: StoryboardChatSessionMeta[]): Promise<void> => {
  const existing = await getMetaRow(projectId);
  const data = JSON.stringify(sessions);
  if (existing) {
    await u.db("t_chatHistory").where({ projectId, type: META_TYPE }).update({ data });
  } else {
    await u.db("t_chatHistory").insert({
      projectId,
      type: META_TYPE,
      data,
      novel: "",
    });
  }
};

const getSessionRow = async (projectId: number, sessionId: string) => {
  return u.db("t_chatHistory").where({ projectId, type: toSessionType(sessionId) }).first();
};

const upsertSessionRow = async (
  projectId: number,
  sessionId: string,
  history: any[],
  novelChapters: any[],
  shots: any[] = [],
  shotIdCounter = 0,
): Promise<void> => {
  const existing = await getSessionRow(projectId, sessionId);
  const novelPayload: SessionNovelPayload = {
    novelChapters: novelChapters ?? [],
    shots: shots ?? [],
    shotIdCounter: Number.isFinite(shotIdCounter) ? shotIdCounter : 0,
  };
  const payload = {
    data: JSON.stringify(history ?? []),
    novel: JSON.stringify(novelPayload),
  };
  if (existing) {
    await u.db("t_chatHistory").where({ projectId, type: toSessionType(sessionId) }).update(payload);
  } else {
    await u.db("t_chatHistory").insert({
      projectId,
      type: toSessionType(sessionId),
      ...payload,
    });
  }
};

const upsertLegacyRow = async (projectId: number, history: any[], novelChapters: any[]): Promise<void> => {
  const existing = await u.db("t_chatHistory").where({ projectId, type: LEGACY_TYPE }).first();
  const payload = {
    data: JSON.stringify(history ?? []),
    novel: JSON.stringify(novelChapters ?? []),
  };
  if (existing) {
    await u.db("t_chatHistory").where({ projectId, type: LEGACY_TYPE }).update(payload);
  } else {
    await u.db("t_chatHistory").insert({
      projectId,
      type: LEGACY_TYPE,
      ...payload,
    });
  }
};

export const listStoryboardChatSessions = async (
  projectId: number,
  scriptId?: number | null,
): Promise<StoryboardChatSessionMeta[]> => {
  const sessions = await getMetaList(projectId);
  return pickSessionsForScript(sessions, scriptId);
};

export const loadStoryboardChatSession = async (projectId: number, sessionId: string): Promise<StoryboardChatSessionData | null> => {
  const row = await getSessionRow(projectId, sessionId);
  if (!row) return null;
  const novelPayload = parseSessionNovelPayload(row.novel);
  return {
    history: normalizeHistoryArray(row.data),
    novelChapters: novelPayload.novelChapters,
    shots: novelPayload.shots,
    shotIdCounter: novelPayload.shotIdCounter,
  };
};

export const saveStoryboardChatSession = async (params: {
  projectId: number;
  sessionId: string;
  scriptId?: number | null;
  history: any[];
  novelChapters: any[];
  shots?: any[];
  shotIdCounter?: number;
  titleIfMissing?: string;
}): Promise<StoryboardChatSessionMeta[]> => {
  const { projectId, sessionId, scriptId = null, history, novelChapters, shots = [], shotIdCounter = 0, titleIfMissing } = params;
  const now = Date.now();

  await upsertSessionRow(projectId, sessionId, history, novelChapters, shots, shotIdCounter);
  await upsertLegacyRow(projectId, history, novelChapters);

  const sessions = await getMetaList(projectId);
  const index = sessions.findIndex((item) => item.id === sessionId);
  if (index >= 0) {
    const current = sessions[index];
    sessions[index] = {
      ...current,
      updatedAt: now,
      preview: buildPreview(history),
      scriptId: scriptId ?? current.scriptId ?? null,
    };
  } else {
    sessions.unshift({
      id: sessionId,
      title: (titleIfMissing || "").trim() || `会话 ${sessions.length + 1}`,
      createdAt: now,
      updatedAt: now,
      preview: buildPreview(history),
      scriptId,
    });
  }

  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  await upsertMetaList(projectId, sessions);
  return sessions;
};

export const createStoryboardChatSession = async (params: {
  projectId: number;
  scriptId?: number | null;
  title?: string;
}): Promise<{ sessionId: string; sessions: StoryboardChatSessionMeta[] }> => {
  const { projectId, scriptId = null, title } = params;
  const sessions = await getMetaList(projectId);
  const now = Date.now();
  const sessionId = createSessionId();
  const sessionMeta: StoryboardChatSessionMeta = {
    id: sessionId,
    title: (title || "").trim() || `会话 ${sessions.length + 1}`,
    createdAt: now,
    updatedAt: now,
    preview: "",
    scriptId,
  };

  await upsertSessionRow(projectId, sessionId, [], [], [], 0);
  const next = [sessionMeta, ...sessions];
  await upsertMetaList(projectId, next);
  return { sessionId, sessions: next };
};

export const renameStoryboardChatSession = async (
  projectId: number,
  sessionId: string,
  title: string,
): Promise<StoryboardChatSessionMeta[]> => {
  const trimmed = title.trim();
  if (!trimmed) return getMetaList(projectId);
  const sessions = await getMetaList(projectId);
  const index = sessions.findIndex((item) => item.id === sessionId);
  if (index === -1) return sessions;
  sessions[index] = { ...sessions[index], title: trimmed };
  await upsertMetaList(projectId, sessions);
  return sessions;
};

export const deleteStoryboardChatSession = async (
  projectId: number,
  sessionId: string,
): Promise<StoryboardChatSessionMeta[]> => {
  await u.db("t_chatHistory").where({ projectId, type: toSessionType(sessionId) }).delete();
  const sessions = await getMetaList(projectId);
  const next = sessions.filter((item) => item.id !== sessionId);
  await upsertMetaList(projectId, next);
  return next;
};

export const ensureStoryboardChatBootstrap = async (params: {
  projectId: number;
  scriptId?: number | null;
}): Promise<{ sessionId: string; sessions: StoryboardChatSessionMeta[]; history: any[]; novelChapters: any[]; shots: any[]; shotIdCounter: number }> => {
  const { projectId, scriptId = null } = params;
  const sessions = await getMetaList(projectId);
  const scopedSessions = pickSessionsForScript(sessions, scriptId);
  if (scopedSessions.length > 0) {
    const active = scopedSessions[0];
    const loaded = await loadStoryboardChatSession(projectId, active.id);
    if (loaded) {
      return {
        sessionId: active.id,
        sessions,
        history: loaded.history,
        novelChapters: loaded.novelChapters,
        shots: loaded.shots,
        shotIdCounter: loaded.shotIdCounter,
      };
    }
    const fixed = await saveStoryboardChatSession({
      projectId,
      sessionId: active.id,
      scriptId,
      history: [],
      novelChapters: [],
      titleIfMissing: active.title,
    });
    return { sessionId: active.id, sessions: fixed, history: [], novelChapters: [], shots: [], shotIdCounter: 0 };
  }

  const legacy = await u.db("t_chatHistory").where({ projectId, type: LEGACY_TYPE }).first();
  const legacyHistory = normalizeHistoryArray(legacy?.data);
  const legacyNovel = safeParseJson<any[]>(legacy?.novel, []);

  const sessionId = createSessionId();
  const created = await saveStoryboardChatSession({
    projectId,
    sessionId,
    scriptId,
    history: legacyHistory,
    novelChapters: legacyNovel,
    titleIfMissing: "默认会话",
  });

  return {
    sessionId,
    sessions: created,
    history: legacyHistory,
    novelChapters: legacyNovel,
    shots: [],
    shotIdCounter: 0,
  };
};
