/**
 * toonflowTsApi — 后端插件 API 门面
 *
 * 按 req.md 设计：后端插件（entry.ts）通过 toonflowTsApi 读取和设置数据变量。
 *  - 故事的动态数据：由 MiniGameController setup 时以 roles/playerCard 形式注入 ctx；
 *  - 系统的配置数据：模型接口配置等（getPromptAi），插件一般不直接碰；
 *  - 插件数据：t_plugin_session_data（本 API 的 pluginData）。
 *
 * 注入方式：PluginExecutor.executePluginAction 在调 handle_action 前把
 *   ctx.tsApi = buildToonflowTsApi({ userId, sessionId, pluginId })
 * 挂上，插件 entry.ts 内直接 `ctx.tsApi.pluginData.get("map_data")`。
 *
 * agent 能力（插件专属 agent，如 field-survival-map-gener）：
 *   const r = await ctx.tsApi.agent.run("field-survival-map-gener", {
 *     storyDigest, currentMap,
 *   });
 */
import {
  getPluginData,
  setPluginData,
  listPluginDataKeys,
  removePluginData,
} from "@/lib/plugins/PluginSessionDataService";
import { runPluginAgent } from "@/lib/plugins/PluginAgentRunner";

export interface ToonflowTsApiScope {
  userId: number;
  sessionId: string;
  pluginId: string;
}

export interface ToonflowTsApi {
  /** 插件会话数据（t_plugin_session_data） */
  pluginData: {
    get(dataKey: string): Promise<any>;
    set(dataKey: string, value: unknown): Promise<void>;
    list(): Promise<string[]>;
    remove(dataKey: string): Promise<void>;
  };
  /** 插件专属 agent */
  agent: {
    run(
      agentName: string,
      input: Record<string, unknown>
    ): Promise<{ ok: boolean; output?: Record<string, any>; error?: string }>;
  };
}

/** 构造绑定到某个 (userId, sessionId, pluginId) 的后端插件 API */
export function buildToonflowTsApi(scope: ToonflowTsApiScope): ToonflowTsApi {
  return {
    pluginData: {
      get: async (dataKey: string) => {
        const entry = await getPluginData(scope, dataKey);
        return entry ? entry.dataValue : null;
      },
      set: (dataKey: string, value: unknown) => setPluginData(scope, dataKey, value),
      list: () => listPluginDataKeys(scope),
      remove: (dataKey: string) => removePluginData(scope, dataKey),
    },
    agent: {
      run: (agentName: string, input: Record<string, unknown>) =>
        runPluginAgent(agentName, (input || {}) as any),
    },
  };
}