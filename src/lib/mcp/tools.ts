/**
 * MCP Tools 层 —— AI agent 的插件工具集（2026-11-12，网络通信机制 v3 §6 / §10 M3）
 *
 * 原则（v3 §6 红线）：**能转发既有 handle_action 的绝不重写逻辑**。
 *   - 权威游戏逻辑在 entry.ts（esbuild 编译为 entry.js）；MCP 层不直接改 state，
 *     否则绕过权威结算（经验/掉落/任务计数会漏）。
 *   - 写工具全部经 PluginStateExecutor.executePluginActionWithState（与 tick 共用
 *     内存态 + 会话锁，v3 §5.1）；读工具走 readPluginStateSnapshot（内存态，免锁，
 *     M2-5）——查 DB 会读到最多 2s 前的快照，AI 会误判（以为怪还活着，其实刚被杀）。
 *   - 错误信息面向 AI（M3-8）：说明为什么失败、下一步怎么改。
 */
import { toJsonText } from "@/lib/gameEngine";
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

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  /** 协议级必填参数（缺失 → JSON-RPC -32602，M3-7） */
  required: string[];
  inputSchema: Record<string, unknown>;
  handler: (c: McpToolCallContext, args: Record<string, any>) => Promise<McpToolResult>;
}

/* ── 内部工具函数 ── */

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2);
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

/** entry 返回 okResp(失败文案) 也是 code=0 —— 用响应文案判业务成败（AI 可读，M3-8） */
function toolResultFromResponse(response: string, successPattern: RegExp, hint: string): McpToolResult {
  if (successPattern.test(response)) return { text: response };
  return { text: `${response}\n（${hint}）`, isError: true };
}

/* ── Tool 定义（M3-1 ~ M3-5 + M3-6 schema）── */

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "query_state",
    title: "查询野外生存游戏状态",
    description:
      "读取野外生存插件的实时世界状态（内存态，无滞后）：phase / tick / 玩家（hp、等级、坐标）/ " +
      "存活敌人列表（id、名字、血量、距离，含最近敌人）/ 特效数 / 击杀数 / 金钱 / 最近事件。" +
      "kill_mob 前先用它选目标（记下 entity id）。session 必填（game.sessionId）。",
    required: [],
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async (c) => {
      const st = await readPluginStateSnapshot({ userId: c.userId, sessionId: c.sessionId, pluginId: c.pluginId });
      if (!st || typeof st !== "object") {
        return {
          text: "该会话当前没有野外生存游戏状态（玩家可能还没进入游戏）。" +
            "可以先让玩家在故事对话中发送 #野外生存 开始游戏，或稍后再查询。",
          isError: true,
        };
      }
      const s: any = st;
      const player = Array.isArray(s.entities) ? s.entities.find((e: any) => e.side === "player") : null;
      const enemies = (Array.isArray(s.entities) ? s.entities : [])
        .filter((e: any) => e.side === "enemy" && e.alive !== false && !e.deathMs)
        .map((e: any) => ({
          id: e.id,
          name: e.name,
          lv: e.level ?? 1,
          hp: Math.max(0, Math.round(e.hp ?? 0)),
          maxHp: Math.round(e.maxHp ?? e.hp ?? 0),
          dist: player ? Math.round(dist(player.x, player.y, e.x, e.y) * 10) / 10 : undefined,
        }))
        .sort((a: any, b: any) => (a.dist ?? 1e9) - (b.dist ?? 1e9));
      const vfxArr = Array.isArray(s.vfx) ? s.vfx : [];
      const events = Array.isArray(s.events) ? s.events.slice(-3) : [];
      const skillCds = (Array.isArray(s.skills) ? s.skills : [])
        .filter((k: any) => k && k.name && !k.empty)
        .map((k: any) => ({ name: k.name, cdLeft: k.cdLeft ?? 0, cd: k.cd ?? 0 }));
      const lines: string[] = [];
      lines.push(`phase=${s.phase} tick=${s.tick} 击杀=${s.kills ?? 0} 金钱=${s.money ?? 0}`);
      if (skillCds.length) {
        lines.push(`技能冷却: ${skillCds.map((k: any) => `${k.name} ${k.cdLeft}/${k.cd}`).join(", ")}`);
      }
      if (player) {
        lines.push(
          `玩家: ${player.name} Lv${player.level ?? 1} hp=${Math.max(0, Math.round(player.hp ?? 0))}/${Math.round(player.maxHp ?? 0)} ` +
          `坐标=(${Math.round(player.x)}, ${Math.round(player.y)})`,
        );
      } else {
        lines.push("玩家: （场上无玩家实体）");
      }
      if (enemies.length) {
        const list = enemies.slice(0, 10).map((e: any) =>
          `${e.id} ${e.name} Lv${e.lv} hp=${e.hp}/${e.maxHp} 距离${e.dist ?? "?"}m`,
        );
        lines.push(`存活敌人 ${enemies.length} 个（最近在前）:\n  ${list.join("\n  ")}`);
        lines.push(`最近敌人: ${enemies[0].id}（${enemies[0].name}，距离 ${enemies[0].dist ?? "?"}m）`);
      } else {
        lines.push("存活敌人: 0 个（附近已清空，可等待刷新或用 spawn_entity 生成练习目标）");
      }
      lines.push(`进行中特效: ${vfxArr.length} 个`);
      if (events.length) lines.push(`最近事件: ${events.join(" | ")}`);
      return { text: lines.join("\n"), data: { phase: s.phase, tick: s.tick, kills: s.kills ?? 0, enemies, skills: skillCds } };
    },
  },
  {
    name: "kill_mob",
    title: "击杀野怪（权威结算）",
    description:
      "对指定野怪发起一次普攻（与玩家点击普攻走同一条权威结算链：伤害/经验/掉落/任务计数一致）。" +
      "要求目标在玩家 4m 攻击范围内；太远会失败并提示先用别的方式接近。" +
      "先用 query_state 拿 entity id，再传 targetId。",
    required: ["targetId"],
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string", description: "野怪实体 id（来自 query_state 的敌人列表）" },
      },
      required: ["targetId"],
      additionalProperties: false,
    },
    handler: async (c, args) => {
      const targetId = String(args.targetId || "").trim();
      if (!targetId) {
        return { text: "缺少 targetId（野怪实体 id）。先用 query_state 查看存活敌人及其 id。", isError: true };
      }
      const { result } = await runAuthoritativeAction(c, "attack", { targetId });
      const response = String(result?.response || "");
      // 成功形如「普攻 → 巨狼 -72」；失败是 okResp(原因)（不在范围/已死亡等）
      return toolResultFromResponse(
        response,
        /^普攻 → .+ -\d+$/,
        "击杀未生效：目标可能不在 4m 攻击范围内或已死亡；可用 query_state 确认目标与玩家距离",
      );
    },
  },
  {
    name: "clear_effect",
    title: "清除技能特效",
    description:
      "把一个或全部打击特效从权威状态 s.vfx 移除（前端下一帧即消失）。" +
      "effectId 与 all 二选一；都不传视为全部清除。",
    required: [],
    inputSchema: {
      type: "object",
      properties: {
        effectId: { type: "string", description: "要清除的特效 id（vfx_*）" },
        all: { type: "boolean", description: "true=清除全部特效" },
      },
      additionalProperties: false,
    },
    handler: async (c, args) => {
      const params: Record<string, any> = {};
      if (args.effectId != null) params.effectId = String(args.effectId);
      if (args.all === true) params.all = true;
      const { result } = await runAuthoritativeAction(c, "ai_clear_vfx", params);
      const response = String(result?.response || "");
      return toolResultFromResponse(response, /^已清除/, "特效清除未生效：effectId 可能不存在；不带参数可全部清除");
    },
  },
  {
    name: "spawn_entity",
    title: "刷出实体（野怪）",
    description:
      "在权威状态里刷出野怪（与正常刷怪同一构造链，经验/金钱奖励一致）。" +
      "类型只能用当前地图怪图鉴里的 archetypeId（不带参数会列出可用类型）；" +
      "count 1~6；不带坐标时按正常刷怪规则散布在玩家 30~100m。",
    required: [],
    inputSchema: {
      type: "object",
      properties: {
        archetypeId: { type: "string", description: "野怪图鉴 id（如 enemy_1）；缺省用图鉴第一个" },
        count: { type: "integer", minimum: 1, maximum: 6, description: "数量（1~6，缺省 1）" },
        x: { type: "number", description: "世界坐标 x（米），与 y 一起提供才生效" },
        y: { type: "number", description: "世界坐标 y（米），与 x 一起提供才生效" },
      },
      additionalProperties: false,
    },
    handler: async (c, args) => {
      const params: Record<string, any> = {};
      if (args.archetypeId != null) params.archetypeId = String(args.archetypeId);
      if (args.count != null) params.count = args.count;
      if (args.x != null && args.y != null) { params.x = args.x; params.y = args.y; }
      const { result } = await runAuthoritativeAction(c, "ai_spawn", params);
      const response = String(result?.response || "");
      return toolResultFromResponse(response, /^已刷出/, "刷出未生效：游戏可能未开始（phase!=playing）或类型名不在图鉴中");
    },
  },
  {
    name: "plugin_events_push",
    title: "推送插件事件（AI 主动消息）",
    description:
      "向该会话的插件事件队列（P3）推一条事件（如 wake_sms 唤醒短信决策）。" +
      "插件在下一次 tick 时消费；队列上限 64 条，溢出丢最旧。",
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
    handler: async (c, args) => {
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

export function findMcpTool(name: string): McpToolDefinition | undefined {
  return MCP_TOOLS.find((t) => t.name === name);
}
