/**
 * MCP Tools 注册表 —— 宿主只做「注册 + 通用分发」，插件业务留在插件里
 * （2026-11-13 重构，网络通信机制 v3 §6 原则的落地形态）
 *
 * ★ 职责边界（为什么这样分）：
 *   - 插件业务（工具叫什么、参数是什么、摘要长什么样、什么算成功）
 *     由插件在 **manifest.contributes.mcpTools** 里**声明**，权威执行在插件 entry 的
 *     handle_action（kind=action → 权威结算；kind=read → 插件的 ai_query_state 等）。
 *     宿主升级/新增插件时，宿主代码**零改动**。
 *   - 宿主只保留：① 与具体插件无关的内置工具（如事件队列）；
 *     ② 通用分发器（读声明 → 校验 → 经共享执行层转发 → successPattern 判定）。
 *
 * 分发通道（v3 §5.1 红线的延续）：
 *   - kind="action"（写）→ executePluginActionWithState（与 tick 共用内存态 + fast 锁，
 *     forceSync 返回即落库）——绝不在 MCP 层直接改 state。
 *   - kind="read"（读）→ readPluginStateSnapshot（内存态）+ executePluginAction 直读，
 *     不加锁、不落盘、不写内存态（M2-5 语义）。
 *   - kind="host"（宿主内置）→ 本文件内的 handler。
 */
import { toJsonText } from "@/lib/gameEngine";
import { executePluginAction } from "@/lib/PluginExecutor";
import { loadPluginManifestFromFile, listEnabledPlugins } from "@/lib/pluginRegistry";
import {
  executePluginActionWithState,
  readPluginStateSnapshot,
} from "@/lib/plugins/PluginStateExecutor";
import { pushPluginEvent } from "@/routes/plugin/events";
import type { PluginExecutionContextBundle } from "@/lib/plugins/PluginExecutionContext";

/** 单次 tool 调用的上下文（路由 bootstrap 后传入） */
export interface McpToolCallContext {
  userId: number;
  sessionId: string;
  pluginId: string;
  boot: PluginExecutionContextBundle;
  db: any;
}

/** tool 执行结果：text 面向 AI；isError=true 表示业务失败（协议层仍是成功的 JSON-RPC result） */
export interface McpToolResult {
  text: string;
  isError?: boolean;
  data?: unknown;
}

/**
 * 业务失败（非协议错误）：路由捕获后转 isError:true 的 tool result（AI 可读）。
 * 例：会话没有进行中的游戏 / 本局已结束。
 */
export class ToolBusinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolBusinessError";
  }
}

/* ── 工具声明（manifest.contributes.mcpTools 的条目形状）── */

export interface McpToolDeclaration {
  /** 工具名（建议全局唯一；跨插件撞名时内置工具优先、先注册者保留并告警） */
  name: string;
  title?: string;
  description?: string;
  /** action=写（权威结算，默认）；read=读（直读内存态，不落盘） */
  kind?: "action" | "read";
  /** 转发到插件 entry.handle_action 的 action 名；缺省 = 工具名 */
  action?: string;
  /** 协议级必填参数（缺 → JSON-RPC -32602） */
  required?: string[];
  inputSchema?: Record<string, unknown>;
  /** 响应文案的成功判定正则（字符串形式）；匹配 → 成功，不匹配 → isError。
   *  未声明 → 一律视为成功（如 read 类工具）。 */
  successPattern?: string;
}

/** 注册表条目（声明 + 归属 + 兜底字段） */
export interface RegisteredTool {
  name: string;
  title: string;
  description: string;
  kind: "action" | "read" | "host";
  /** 转发到 entry 的 action（host 类无此字段语义） */
  action?: string;
  required: string[];
  inputSchema: Record<string, unknown>;
  successPattern?: RegExp;
  /** 归属：插件 id 或 "host" */
  owner: string;
  /** host 内置工具的 handler（仅 kind="host"） */
  hostHandler?: (c: McpToolCallContext, args: Record<string, any>) => Promise<McpToolResult>;
}

const TOOL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{1,63}$/;

/** 把插件的声明 sanitize 成注册表条目（非法条目跳过并告警，不拖垮整表） */
function sanitizeDeclaration(raw: any, pluginId: string): RegisteredTool | null {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name || "").trim();
  if (!TOOL_NAME_RE.test(name)) {
    console.warn(`[mcp/tools] 插件 ${pluginId} 声明了非法工具名「${name}」，已跳过`);
    return null;
  }
  const kindRaw = String(raw.kind || "action").trim();
  const kind: "action" | "read" = kindRaw === "read" ? "read" : "action";
  const action = String(raw.action || name).trim();
  let successPattern: RegExp | undefined;
  if (raw.successPattern) {
    try {
      successPattern = new RegExp(String(raw.successPattern));
    } catch {
      console.warn(`[mcp/tools] 插件 ${pluginId} 工具 ${name} 的 successPattern 非法，忽略`);
    }
  }
  const schema = (raw.inputSchema && typeof raw.inputSchema === "object" && !Array.isArray(raw.inputSchema))
    ? (raw.inputSchema as Record<string, unknown>)
    : { type: "object", properties: {} };
  const required = Array.isArray(raw.required) ? raw.required.map(String) : [];
  return {
    name,
    title: String(raw.title || name),
    description: String(raw.description || `插件 ${pluginId} 提供的工具 ${name}（缺描述）`),
    kind,
    action,
    required,
    inputSchema: schema,
    successPattern,
    owner: pluginId,
  };
}

/** 从某插件的 manifest 读声明（manifest 每次现读，改了即生效） */
async function getPluginDeclaredTools(userId: number, pluginId: string): Promise<RegisteredTool[]> {
  const manifest = await loadPluginManifestFromFile(userId, pluginId);
  const rawList = (manifest as any)?.contributes?.mcpTools;
  if (!Array.isArray(rawList)) return [];
  return rawList
    .map((r: any) => sanitizeDeclaration(r, pluginId))
    .filter((t: RegisteredTool | null): t is RegisteredTool => t !== null);
}

/* ── 宿主内置工具（与具体插件无关的能力；插件业务不写在这里）── */

const HOST_BUILTIN_TOOLS: RegisteredTool[] = [
  {
    name: "plugin_events_push",
    title: "推送插件事件（AI 主动消息）",
    description:
      "向指定会话的插件事件队列（P3）推一条事件（如 wake_sms 唤醒短信决策）。" +
      "插件在下一次 tick 时消费；队列上限 64 条，溢出丢最旧。这是宿主通用能力，对所有插件可用。",
    kind: "host",
    required: ["type"],
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "事件类型，如 wake_sms" },
        payload: { type: "object", description: "事件附加数据（可选）" },
      },
      required: ["type"],
      additionalProperties: false,
    },
    owner: "host",
    hostHandler: async (c, args) => {
      const type = String(args.type || "").trim();
      if (!type) return { text: "缺少 type（事件类型，如 wake_sms）", isError: true };
      const ok = await pushPluginEvent(
        c.userId, c.sessionId, c.pluginId,
        { type, ...(args.payload && typeof args.payload === "object" ? { payload: args.payload } : {}) },
      );
      if (!ok) return { text: "事件入队失败（存储异常），请稍后重试", isError: true };
      return { text: `事件已入队：type=${type}（插件下一次 tick 时可见）` };
    },
  },
];

/* ── 注册表读取 ── */

/** 全量工具清单：宿主内置 + 所有已启用插件的声明（按名字去重，内置优先，撞名告警） */
export async function listMcpTools(userId: number): Promise<RegisteredTool[]> {
  const byName = new Map<string, RegisteredTool>();
  for (const t of HOST_BUILTIN_TOOLS) byName.set(t.name, t);
  let plugins: Awaited<ReturnType<typeof listEnabledPlugins>> = [];
  try {
    plugins = await listEnabledPlugins(userId);
  } catch (e) {
    console.warn("[mcp/tools] listEnabledPlugins 失败（仅返回内置工具）：", e);
  }
  for (const p of plugins) {
    try {
      for (const t of await getPluginDeclaredTools(userId, p.pluginId)) {
        if (byName.has(t.name)) {
          console.warn(`[mcp/tools] 工具名冲突：${t.name}（${t.owner} 与 ${byName.get(t.name)!.owner}），保留先注册者`);
          continue;
        }
        byName.set(t.name, t);
      }
    } catch (e) {
      console.warn(`[mcp/tools] 读取插件 ${p.pluginId} 的 mcpTools 声明失败：`, e);
    }
  }
  return Array.from(byName.values());
}

/** 按名字找工具：优先指定插件（会话指针指向的插件），再全表 */
export async function findMcpTool(
  userId: number,
  name: string,
  pluginIdHint?: string,
): Promise<RegisteredTool | null> {
  const builtin = HOST_BUILTIN_TOOLS.find((t) => t.name === name);
  if (builtin) return builtin;
  if (pluginIdHint) {
    for (const t of await getPluginDeclaredTools(userId, pluginIdHint)) {
      if (t.name === name) return t;
    }
  }
  const all = await listMcpTools(userId);
  return all.find((t) => t.name === name) || null;
}

/* ── 通用分发 ── */

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2);
}

/** 从 tool arguments 提取 entry params（剥掉路由层参数） */
function entryParams(args: Record<string, any>): Record<string, any> {
  const p = { ...args };
  delete p.sessionId;
  delete p.session_id;
  delete p.pluginId;
  return p;
}

/** 用响应文案判业务成败（成功模式由插件在声明里给出） */
function judgeByPattern(response: string, pattern: RegExp | undefined, hint: string): McpToolResult {
  if (!pattern || pattern.test(response)) return { text: response };
  return { text: `${response}\n（${hint}）`, isError: true };
}

/**
 * 写工具的权威执行通道：executePluginActionWithState（与 tick 共用内存态+锁）
 * + 与 tick.ts needSync 分支等价的宿主会话节点同步 + stateJson 落库。
 * MCP tool 属「非 tick 命令」→ forceSync 立即落库（M2-3），崩溃恢复立即可见。
 */
async function runAuthoritativeAction(
  c: McpToolCallContext,
  action: string,
  params: Record<string, any>,
): Promise<{ result: any; resultState: any }> {
  const { userId, sessionId, pluginId, boot, db } = c;
  // ★ 守卫：写操作只允许发生在「有活局」的会话里。
  //   原因：entry.handle_action 对空 state 会兜底建 emptyState()（phase=select），
  //   若 AI 在没进游戏的会话里写操作，会凭空造出一个 select 态 ——
  //   tick 的 heal 守卫会把它当「活跃局」自愈出指针 → 选人面板死灰复燃（关了又重开）。
  const live = await readPluginStateSnapshot({ userId, sessionId, pluginId });
  if (!live || typeof live !== "object") {
    throw new ToolBusinessError(
      "该会话当前没有进行中的野外生存游戏（玩家未进入或已退出）。" +
      "可让玩家在故事对话中发送 #野外生存 开局后再操作。",
    );
  }
  if ((live as any).phase === "over") {
    throw new ToolBusinessError("本局已结束（phase=over），需重新开局后才能继续操作。");
  }

  const { result, resultState } = await executePluginActionWithState({
    ctx: boot.ctx as any,
    scope: { userId, sessionId, pluginId },
    action,
    params,
    hostState: boot.state,
    lock: "fast",
  });

  // 宿主会话节点同步（与 tick.ts 非 tick 命令路径等价）
  const sessionNode = boot.sessionNode;
  const publicState = boot.publicState;
  if (!sessionNode.status || sessionNode.status === "preparing") sessionNode.status = "active";
  sessionNode.phase = resultState?.phase ?? "playing";
  if (!sessionNode.game_type) sessionNode.game_type = "plugin";
  if (resultState?.phase === "over") {
    publicState.plugin_phase_over = true;
    sessionNode.status = "finished";
  }
  // 指针兜底（MCP 写入时若指针被编排 clobber，顺手自愈）
  if (!publicState.plugin_id) {
    publicState.plugin_id = pluginId;
    publicState.plugin_type = publicState.plugin_type || "plugin";
  }
  publicState.plugin_state = null; // 指针语义（真实状态在 t_plugin_session_data / 内存态）
  if (Array.isArray(result?.actions)) publicState.plugin_actions = result.actions;
  if (typeof result?.response === "string") publicState.plugin_response = result.response;
  sessionNode.public_state = publicState;
  boot.root.session = sessionNode;
  boot.state.miniGame = boot.root;
  await db("t_gameSession")
    .where({ sessionId, userId })
    .update({ stateJson: toJsonText(boot.state, {}), updateTime: Date.now() });

  return { result, resultState };
}

/** 通用分发入口：按 tool.kind 执行（路由只管协议，业务语义全部来自声明与插件） */
export async function runMcpTool(
  c: McpToolCallContext,
  tool: RegisteredTool,
  args: Record<string, any>,
): Promise<McpToolResult> {
  // ① 宿主内置
  if (tool.kind === "host") {
    return tool.hostHandler!(c, args);
  }
  const params = entryParams(args);
  // ② 读：内存态快照 + entry 直读（不加锁、不落盘、不写内存态 —— M2-5 语义）
  if (tool.kind === "read") {
    const snap = await readPluginStateSnapshot({ userId: c.userId, sessionId: c.sessionId, pluginId: c.pluginId });
    const result = await executePluginAction(c.boot.ctx as any, tool.action || tool.name, params, (snap || null) as any);
    const response = String(result?.response || "");
    const data = (result?.data && typeof result.data === "object") ? result.data : undefined;
    const out = judgeByPattern(response, tool.successPattern, "执行未按预期成功");
    return data ? { ...out, data } : out;
  }
  // ③ 写：权威结算通道
  const { result } = await runAuthoritativeAction(c, tool.action || tool.name, params);
  const response = String(result?.response || "");
  return judgeByPattern(
    response,
    tool.successPattern,
    "操作未生效：可用 query_state 确认世界状态后重试",
  );
}
