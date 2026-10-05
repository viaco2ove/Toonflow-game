/**
 * PluginAgentRunner — 插件专属 agent 执行器
 *
 * 目前支持的 agent：
 *   - field-survival-map-gener：利用故事动态数据生成/维护野外生存地图 JSON
 *   - field-survival-shop-gener：★ v5 利用故事动态数据 + 常驻世界书条目，
 *     为「系统面板 · 商城」生成贴合故事的商品清单（插件再叠加自带物资）
 *
 * 调用链（req.md 设计）：
 *   插件 entry.ts (后端进程内)
 *     → ctx.tsApi.agent.run("field-survival-map-gener", { storyDigest, currentMap })
 *     → 本模块：getPromptByCode(prompt code) + u.ai.text.invoke
 *     → 输出 JSON 解析/修复/数值裁剪
 *     → 返回给插件（插件自己决定存 t_plugin_session_data 的哪个 dataKey）
 *
 * 提示词默认值在 src/agents/plugins.prompts.ts，DB customValue 可覆盖。
 */
import u from "@/utils";
import { getPromptByCode } from "@/lib/promptHelper";
import { pluginAgentPromptCode } from "@/agents/plugins.prompts";

/** ★ fix③：插件 agent 调用超时上限。
 *  背景：web 端点「开始游戏」时 /plugin/tick(action=start) 会同步等待地图生成，
 *  原实现对 u.ai.text.invoke 不设上限 → 模型卡住/流式停顿会让该 HTTP 请求长时间不返回
 *  （前端表现：无返回、加载态消失）。超时即抛错 → 走 fallback 地图，请求必定及时返回。 */
const AGENT_TIMEOUT_MS = 15000;

/** 给 Promise 加超时（定时器在完成/失败后清理，避免悬挂） */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    }),
  ]);
}

/** ★ v5：商城生成 agent 输入 */
export interface ShopGenerInput {
  /** 常驻世界书条目摘要（故事世界观 / 物资设定） */
  worldBookDigest?: string;
  /** 用户参数卡（等级 / 金钱，用于定价与量级） */
  playerCard?: Record<string, unknown>;
}

export interface MapGenerInput {
  /** 故事动态数据摘要（动态角色卡/全局背景/世界时钟/参战名单等，已拼好的文本） */
  storyDigest?: string;
  /** 增量维护模式：带上当前地图 JSON，agent 只输出需变更字段 */
  currentMap?: Record<string, unknown>;
  /** 变化摘要（维护模式说明发生了什么） */
  changeSummary?: string;
}

const num = (v: unknown, d: number, min: number, max: number): number => {
  const f = Number(v);
  if (!Number.isFinite(f)) return d;
  return Math.min(max, Math.max(min, f));
};

/** 从 LLM 输出文本中提取 JSON（容忍 markdown 代码块/前后废话） */
function extractJson(text: string): Record<string, any> | null {
  if (!text) return null;
  let t = String(text).trim();
  // 剥 ```json ... ```
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  // 找第一个 { 到最后一个 }
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    const parsed = JSON.parse(t.slice(s, e + 1));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** 数值裁剪与结构修复：保证地图数据合法，坏字段回退默认 */
function sanitizeMap(map: Record<string, any>): Record<string, any> {
  const zones = Array.isArray(map.zones) ? map.zones.slice(0, 5) : [];
  const chests = Array.isArray(map.chests) ? map.chests.slice(0, 4) : [];
  const potions = Array.isArray(map.potions) ? map.potions.slice(0, 3) : [];
  const archetypes = Array.isArray(map.enemy_archetypes) ? map.enemy_archetypes.slice(0, 3) : [];

  return {
    theme: String(map.theme || "野外·清晨").slice(0, 40),
    narration: String(map.narration || "").slice(0, 400),
    zones: zones.map((z: any, i: number) => ({
      name: String(z?.name || `区域${i + 1}`).slice(0, 20),
      x: num(z?.x, 480, 40, 920),
      y: num(z?.y, 300, 120, 560),
      r: num(z?.r, 100, 60, 160),
      kind: ["safe", "danger", "loot", "quest"].includes(String(z?.kind)) ? String(z.kind) : "danger",
      desc: String(z?.desc || "").slice(0, 80),
    })),
    enemy_archetypes: archetypes.map((a: any, i: number) => ({
      id: String(a?.id || `enemy_${i + 1}`).slice(0, 32),
      name: String(a?.name || `敌人${i + 1}`).slice(0, 20),
      lv: num(a?.lv, 1, 1, 4),
      hp: num(a?.hp, 40, 30, 90),
      atk: num(a?.atk, 6, 4, 12),
      def: num(a?.def, 2, 0, 5),
      speed: num(a?.speed, 1.4, 0.8, 2.0),
      bounty: {
        exp: num(a?.bounty?.exp, 10, 6, 18),
        money: num(a?.bounty?.money, 8, 4, 14),
      },
      color: /^#[0-9a-f]{6}$/i.test(String(a?.color)) ? String(a.color) : "#9b3a3a",
    })),
    chests: chests.map((c: any) => ({
      x: num(c?.x, 700, 40, 920),
      y: num(c?.y, 200, 120, 560),
      tier: num(c?.tier, 1, 1, 3),
      loot: {
        exp: num(c?.loot?.exp, 15, 10, 30),
        money: num(c?.loot?.money, 12, 8, 25),
        item: String(c?.loot?.item || "").slice(0, 20),
      },
    })),
    potions: potions.map((p: any) => ({
      x: num(p?.x, 300, 40, 920),
      y: num(p?.y, 420, 120, 560),
      heal: num(p?.heal, 40, 30, 60),
    })),
    waves: Array.isArray(map.waves)
      ? map.waves.slice(0, 3).map((w: any) => ({
          archetype: String(w?.archetype || "enemy_1").slice(0, 32),
          count: num(w?.count, 3, 2, 4),
          interval: num(w?.interval, 600, 400, 900),
        }))
      : [{ archetype: "enemy_1", count: 3, interval: 600 }],
    notes: String(map.notes || "").slice(0, 200),
  };
}

/** ★ v5：商城 agent 名 */
const SHOP_AGENT_NAME = "field-survival-shop-gener";

/** ★ 角色发言器 agent 名（插件对话功能：城镇 NPC / 队友 / 旁白 的台词与选项） */
const SPEAKER_AGENT_NAME = "task-speaker-agent";

/**
 * ★ 角色发言器输入（由插件 entry.ts 的 sys_chat 传入）
 * 与 field-survival-*-gener 不同：它输入/输出都是文本，不解析 JSON。
 */
export interface SpeakerInput {
  /** 角色唯一 id（mapnpc_<id> / role id） */
  npcId?: string;
  /** 角色显示名 */
  npcName?: string;
  /** 角色参数卡（动态角色卡 / 地图 NPC 卡），可为 null */
  npcCard?: unknown;
  /** 是否为中立（旁白/环境）角色 */
  isNeutral?: boolean;
  /** 玩家本轮说的话（null = 玩家没说话，让角色主动开腔） */
  userText?: string | null;
  /** 上一句台词（对话历史） */
  lastResp?: string;
  /** options = 生成 3 个玩家发言选项；response = 生成角色台词 */
  mode?: "options" | "response";
  context?: { storyDigest?: string; playerLevel?: number };
}

/** ★ v5：商城商品裁剪（数量 / 数值兜底），坏字段一律回退默认 */
function sanitizeShop(out: Record<string, any>): Record<string, any> {
  const goods = Array.isArray(out?.goods) ? out.goods.slice(0, 14) : [];
  const KINDS = ["consumable", "material", "equipment", "skill_book", "quest"];
  const RARITIES = ["common", "fine", "rare", "epic", "legend"];
  return {
    goods: goods.map((g: any, i: number) => ({
      name: String(g?.name || `物资${i + 1}`).slice(0, 20),
      price: num(g?.price, 50, 1, 9999),
      kind: KINDS.includes(String(g?.kind)) ? String(g.kind) : "material",
      rarity: RARITIES.includes(String(g?.rarity)) ? String(g.rarity) : "common",
      heal: num(g?.heal, 0, 0, 200),
      desc: String(g?.desc || "").slice(0, 60),
    })),
  };
}

/** 生成一份保底地图（LLM 不可用/解析失败时用，保证游戏可玩） */
function fallbackMap(input?: MapGenerInput): Record<string, any> {
  return sanitizeMap({
    theme: "野外·清晨",
    narration: "薄雾笼罩着这片荒野，远处传来低沉的嘶吼。收拢心神，活下去。",
    zones: [
      { name: "营地", x: 480, y: 300, r: 120, kind: "safe", desc: "相对开阔的临时营地" },
      { name: "荒地", x: 720, y: 420, r: 140, kind: "danger", desc: "视野开阔的危险荒地" },
      { name: "废墟", x: 240, y: 200, r: 110, kind: "loot", desc: "可能残留物资的废墟" },
    ],
    enemy_archetypes: [
      { id: "enemy_1", name: "荒野游荡者", lv: 1, hp: 40, atk: 6, def: 2, speed: 1.4, bounty: { exp: 10, money: 8 }, color: "#9b3a3a" },
    ],
    chests: [
      { x: 240, y: 200, tier: 1, loot: { exp: 15, money: 12, item: "干粮" } },
      { x: 810, y: 180, tier: 2, loot: { exp: 20, money: 18, item: "急救包" } },
    ],
    potions: [
      { x: 300, y: 420, heal: 40 },
      { x: 660, y: 260, heal: 40 },
    ],
    waves: [{ archetype: "enemy_1", count: 3, interval: 600 }],
    notes: "fallback map（LLM 不可用时）",
  });
}

/** 增量维护：浅合并 currentMap 与 agent 输出的变更字段 */
function mergeMap(current: Record<string, any>, patch: Record<string, any>): Record<string, any> {
  const merged: Record<string, any> = { ...current };
  for (const k of Object.keys(patch)) {
    if (patch[k] !== undefined && patch[k] !== null && patch[k] !== "") {
      merged[k] = patch[k];
    }
  }
  return sanitizeMap(merged);
}

/**
 * 运行插件 agent。
 * @param agentName  agent 名（目前支持 field-survival-map-gener）
 * @param input     agent 输入
 * @param aiConfigKey 模型配置 key（默认复用小游戏模型 storyMiniGameModel，text 类兜底）
 */
export async function runPluginAgent(
  agentName: string,
  input: MapGenerInput & ShopGenerInput & SpeakerInput,
  aiConfigKey = "storyMiniGameModel"
): Promise<{ ok: boolean; output?: Record<string, any>; error?: string }> {
  const code = pluginAgentPromptCode(agentName);
  if (!code) return { ok: false, error: `未知插件 agent: ${agentName}` };
  const isShop = String(agentName || "").trim() === SHOP_AGENT_NAME;
  const isSpeaker = String(agentName || "").trim() === SPEAKER_AGENT_NAME;

  try {
    const systemPrompt = await getPromptByCode(code);
    if (!systemPrompt) return { ok: false, error: `提示词缺失: ${code}` };

    // ★ 角色发言器：文本进 / 文本出，不做 JSON 解析（与 map/shop agent 走不同分支）
    if (isSpeaker) {
      const mode = String(input?.mode || "response").trim();
      const npcName = String(input?.npcName || "???").trim() || "???";
      const npcCard = input?.npcCard ?? null;
      const isNeutral = input?.isNeutral === true;
      const userText = input?.userText ?? null;
      const lastResp = String(input?.lastResp || "").trim();
      const ctxObj = (input?.context || {}) as Record<string, unknown>;

      const roleHint = isNeutral
        ? "你是旁白 / 环境叙述者（描述场景氛围，不代替玩家发言）"
        : `你是角色「${npcName}」，正在与玩家面对面交谈`;

      const parts: string[] = [];
      parts.push(`【角色】${roleHint}`);
      if (npcCard) {
        parts.push(
          "【角色人设 / 参数卡】\n" +
            (typeof npcCard === "string" ? npcCard : JSON.stringify(npcCard))
        );
      }
      parts.push("【故事背景】\n" + String(ctxObj.storyDigest || "（无）"));
      parts.push(`【玩家等级】${Number(ctxObj.playerLevel ?? 1)}`);
      parts.push(`【最近对话】${lastResp || "（无）"}`);
      parts.push(
        `【玩家本轮输入】${userText ? String(userText) : "（玩家没有说话，请你主动开腔推进对话）"}`
      );
      parts.push(
        mode === "options"
          ? "【输出要求】输出玩家此刻可以说的 3 句发言选项（站在玩家立场、简短口语化、每句 ≤ 20 字）。只输出一个 JSON 数组，例如 [\"…\",\"…\",\"…\"]，不要任何解释文字。"
          : `【输出要求】只输出「${npcName}」本轮的台词本身（1-3 句、口语化、有推进感），不要 JSON 包装、不要前缀标签、不要写"作为NPC"这类元说明。`
      );

      // ★ task-speaker-agent 的提示词原为「任务模式」设计（输出 {speaker,content,tone,emotion} JSON 对象），
      //   插件对话需要的是「纯台词 / 纯选项数组」两种形态 → 在 system 尾部追加本轮格式覆盖，
      //   否则模型会把两套格式混着输出（既给 JSON 对象又给数组），前端解析不出干净结果。
      const formatOverride =
        mode === "options"
          ? "\n\n【本轮输出格式覆盖】忽略上文任何 JSON 对象格式要求。本轮只输出一个 JSON 字符串数组，包含 3 个玩家发言选项，例如 [\"…\",\"…\",\"…\"]。不要输出除该数组以外的任何文字。"
          : "\n\n【本轮输出格式覆盖】忽略上文任何 JSON 对象格式要求。本轮只输出纯台词文本本身（1-3 句），不要 JSON 包装、不要 speaker/content 字段、不要代码围栏、不要引号包裹。";
      const systemText = `${systemPrompt}${formatOverride}`;

      const aiConfig = await u.getPromptAi(aiConfigKey);
      const result = await withTimeout(
        u.ai.text.invoke(
          {
            plainTextOutput: true,
            usageType: "插件对话",
            usageRemark: "PluginSpeakerAgent",
            messages: [
              { role: "system", content: systemText },
              { role: "user", content: parts.join("\n\n") },
            ],
          } as any,
          aiConfig
        ),
        AGENT_TIMEOUT_MS,
        `插件对话 agent 调用超时（>${AGENT_TIMEOUT_MS}ms）`
      );
      const rawText = String((result as any)?.text ?? (result as any)?.content ?? "").trim();
      if (!rawText) return { ok: false, error: "角色发言器返回空文本" };
      // ★ 剥 ```json 围栏（options 模式常见）+ 剥首尾成对引号（response 模式常见）
      const unfenced = rawText
        .replace(/^\s*```[a-zA-Z]*\s*/, "")
        .replace(/\s*```\s*$/, "")
        .trim();
      const text = unfenced.replace(/^"([\s\S]*)"$/, "$1").trim();
      if (!text) return { ok: false, error: "角色发言器返回空文本" };
      return { ok: true, output: { text } };
    }

    const parts: string[] = [];
    parts.push("【故事动态数据】\n" + String(input.storyDigest || "（无）"));
    if (isShop) {
      parts.push("【常驻世界书条目】\n" + String(input.worldBookDigest || "（无）"));
      parts.push("【用户参数卡】\n" + JSON.stringify(input.playerCard || {}));
    } else if (input.currentMap) {
      parts.push(
        "【当前地图 JSON（增量维护，只输出需变更字段）】\n" +
          JSON.stringify(sanitizeMap(input.currentMap))
      );
      parts.push("【变化摘要】\n" + String(input.changeSummary || "（无）"));
    }
    const userPrompt = parts.join("\n\n");

    const aiConfig = await u.getPromptAi(aiConfigKey);
    const result = await withTimeout(
      u.ai.text.invoke(
        {
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        },
        aiConfig
      ),
      AGENT_TIMEOUT_MS,
      `插件 agent 调用超时（>${AGENT_TIMEOUT_MS}ms）`
    );

    const content: string = String((result as any)?.content ?? (result as any)?.text ?? "");
    const parsed = extractJson(content);
    if (!parsed) {
      // ★ 角色发言器没有兜底地图：失败就如实报错，由插件前端显示错误（不伪造台词）
      return { ok: false, error: "LLM 输出解析失败", output: isShop || isSpeaker ? undefined : fallbackMap(input) };
    }
    const output = isShop
      ? sanitizeShop(parsed)
      : input.currentMap
        ? mergeMap(input.currentMap, parsed)
        : sanitizeMap(parsed);
    return { ok: true, output };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg, output: isShop || isSpeaker ? undefined : fallbackMap(input) };
  }
}