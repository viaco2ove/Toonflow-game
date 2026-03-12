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
): Promise<void> => {
  const existing = await getSessionRow(projectId, sessionId);
  const payload = {
    data: JSON.stringify(history ?? []),
    novel: JSON.stringify(novelChapters ?? []),
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
  return {
    history: safeParseJson<any[]>(row.data, []),
    novelChapters: safeParseJson<any[]>(row.novel, []),
  };
};

export const saveStoryboardChatSession = async (params: {
  projectId: number;
  sessionId: string;
  scriptId?: number | null;
  history: any[];
  novelChapters: any[];
  titleIfMissing?: string;
}): Promise<StoryboardChatSessionMeta[]> => {
  const { projectId, sessionId, scriptId = null, history, novelChapters, titleIfMissing } = params;
  const now = Date.now();

  await upsertSessionRow(projectId, sessionId, history, novelChapters);
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

  await upsertSessionRow(projectId, sessionId, [], []);
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
}): Promise<{ sessionId: string; sessions: StoryboardChatSessionMeta[]; history: any[]; novelChapters: any[] }> => {
  const { projectId, scriptId = null } = params;
  const sessions = await getMetaList(projectId);
  const scopedSessions = pickSessionsForScript(sessions, scriptId);
  if (scopedSessions.length > 0) {
    const active = scopedSessions[0];
    const loaded = await loadStoryboardChatSession(projectId, active.id);
    if (loaded) {
      return { sessionId: active.id, sessions, history: loaded.history, novelChapters: loaded.novelChapters };
    }
    const fixed = await saveStoryboardChatSession({
      projectId,
      sessionId: active.id,
      scriptId,
      history: [],
      novelChapters: [],
      titleIfMissing: active.title,
    });
    return { sessionId: active.id, sessions: fixed, history: [], novelChapters: [] };
  }

  const legacy = await u.db("t_chatHistory").where({ projectId, type: LEGACY_TYPE }).first();
  const legacyHistory = safeParseJson<any[]>(legacy?.data, []);
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
  };
};
