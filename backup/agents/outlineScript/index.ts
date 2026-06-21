// @/agents/outlineScript.ts
import u from "@/utils";
import { createAgent } from "langchain";
import { EventEmitter } from "events";
import { openAI } from "@/agents/models";
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import type { DB } from "@/types/database";
// ==================== 类型定义 ====================

type AgentType = "AI1" | "AI2" | "director";
type AssetType = "角色" | "道具" | "场景";
type RefreshEvent = "storyline" | "outline" | "assets";

interface AssetItem {
  name: string;
  description: string;
}

interface EpisodeData {
  episodeIndex: number;
  title: string;
  chapterRange: number[];
  scenes: AssetItem[]; // 按 outline 出场顺序排列
  characters: AssetItem[]; // 按 outline 出场顺序排列
  props: AssetItem[]; // 按 outline 出场顺序排列
  coreConflict: string;
  outline: string; // 最高优先级，剧本生成的唯一权威
  openingHook: string; // outline 第一句话的视觉化，开篇第一个镜头
  keyEvents: string[]; // 4个元素：[起, 承, 转, 合]，严格按 outline 顺序
  emotionalCurve: string; // 对应 keyEvents 各阶段
  visualHighlights: string[]; // 按 outline 顺序排列的标志性镜头
  endingHook: string; // outline 之后的悬念延伸
  classicQuotes: string[];
}

// ==================== Schema 定义 ====================

const sceneItemSchema = z.object({
  name: z.string().describe("场景名称，如'五星酒店宴会厅'、'老旧出租屋'"),
  description: z.string().describe("环境描写：空间结构、光线氛围、装饰陈设、环境细节"),
});

const characterItemSchema = z.object({
  name: z.string().describe("角色姓名（必须是具体人名，禁止'众人'、'群众'等集合描述）"),
  description: z.string().describe("人设样貌：年龄体态、五官特征、发型妆容、服装配饰、气质神态"),
});

const propItemSchema = z.object({
  name: z.string().describe("道具名称"),
  description: z.string().describe("样式描写：材质质感、颜色图案、形状尺寸、磨损痕迹、特殊标记"),
});

const episodeSchema = z.object({
  episodeIndex: z.number().describe("集数索引，从1开始递增"),
  title: z.string().describe("8字内标题，疑问/感叹句，含情绪爆点"),
  chapterRange: z.array(z.number()).describe("关联章节号数组"),
  scenes: z.array(sceneItemSchema).describe("场景列表，按 outline 出场顺序排列"),
  characters: z.array(characterItemSchema).describe("角色列表，按 outline 出场顺序排列，必须是独立个体"),
  props: z.array(propItemSchema).describe("道具列表，按 outline 出场顺序排列，至少3个"),
  coreConflict: z.string().describe("核心矛盾：A想要X vs B阻碍X"),
  outline: z.string().describe("100-300字剧情主干，最高优先级，剧本生成的唯一权威，按时间顺序完整叙述"),
  openingHook: z.string().describe("开场镜头：outline 第一句话的视觉化，必须作为剧本第一个镜头"),
  keyEvents: z.array(z.string()).length(4).describe("4个元素的数组：[起, 承, 转, 合]，严格按 outline 顺序从中提取"),
  emotionalCurve: z.string().describe("情绪曲线，如：2(压抑)→5(反抗)→9(爆发)→3(余波)，对应 keyEvents 各阶段"),
  visualHighlights: z.array(z.string()).describe("3-5个标志性镜头，按 outline 叙事顺序排列"),
  endingHook: z.string().describe("结尾悬念：outline 之后的延伸，勾引下集"),
  classicQuotes: z.array(z.string()).describe("1-2句金句，每句≤15字，必须从原文提取"),
});

// ==================== 常量配置 ====================

// ==================== 主类 ====================

export default class OutlineScript {
  private readonly projectId: number;
  readonly emitter = new EventEmitter();
  history: Array<[string, string]> = [];
  novelChapters: DB["t_novel"][] = [];

  modelName = "gpt-4.1";
  apiKey = "";
  baseURL = "";

  constructor(projectId: number) {
    this.projectId = projectId;
  }

  // ==================== 公共方法 ====================

  get events() {
    return this.emitter;
  }

  setNovel(chapters: DB["t_novel"][]) {
    this.novelChapters = chapters;
  }

  // ==================== 私有工具方法 ====================

  private emit(event: string, data?: any) {
    this.emitter.emit(event, data);
  }

  private refresh(type: RefreshEvent) {
    this.emit("refresh", type);
  }

  private log(action: string, detail?: string) {
    const msg = detail ? `${action}: ${detail}` : action;
    console.log(`\n[${new Date().toLocaleTimeString()}] ${msg}\n`);
  }

  private safeParseJson<T>(str: string, fallback: T): T {
    try {
      return JSON.parse(str);
    } catch {
      return fallback;
    }
  }

  private uniqueByName<T extends { name: string }>(items: T[]): T[] {
    return Array.from(new Map(items.map((item) => [item.name, item])).values());
  }

  // ==================== 数据库操作 ====================

  private async getProjectInfo(): Promise<any> {
    return u.db("t_project").where({ id: this.projectId }).first();
  }

  private async getNovelInfo(asString = false): Promise<any> {
    const info = await this.getProjectInfo();
    if (!info) return asString ? "未查询到项目信息" : null;

    if (asString) {
      const fields = [
        `小说名称: ${info.name}`,
         `小说简介: ${info.intro}`,
        `小说全局背景: ${info.worldGlobalBackground}`,
        `小说类型: ${info.type}`,
        `目标短剧类型: ${info.artStyle}`,
        `短剧画幅: ${info.videoRatio}`,
      ];
      return fields.join("\n");
    }
    return info;
  }

  // ==================== 故事线操作 ====================

  private async findStoryline() {
    return u.db("t_storyline").where({ projectId: this.projectId }).first();
  }

  private async upsertStorylineContent(content: string) {
    const existing = await this.findStoryline();
    if (existing) {
      await u.db("t_storyline").where({ projectId: this.projectId }).update({ content });
    } else {
      await u.db("t_storyline").insert({ projectId: this.projectId, content });
    }
    this.refresh("storyline");
  }

  private async deleteStorylineContent() {
    const deleted = await u.db("t_storyline").where({ projectId: this.projectId }).del();
    this.refresh("storyline");
    return deleted;
  }

  // ==================== 大纲操作 ====================

  private async findOutlines() {
    return u.db("t_outline").where({ projectId: this.projectId }).orderBy("episode", "asc");
  }

  private async findOutlineById(id: number) {
    return u.db("t_outline").where({ id, projectId: this.projectId }).first();
  }

  private async getMaxEpisode(): Promise<number> {
    const result: any = await u.db("t_outline").where({ projectId: this.projectId }).max("episode as max").first();
    return result?.max ?? 0;
  }

  private async clearOutlinesAndScripts() {
    const outlines = await u.db("t_outline").select("id").where({ projectId: this.projectId });
    if (outlines.length === 0) return 0;

    const outlineIds = outlines.map((o) => o.id);
    await u.db("t_script").whereIn("outlineId", outlineIds).del();
    await u.db("t_outline").where({ projectId: this.projectId }).del();

    return outlines.length;
  }

  private async insertOutlines(episodes: EpisodeData[], startEpisode: number) {
    const insertList = episodes.map((ep, idx) => ({
      projectId: this.projectId,
      data: JSON.stringify({ ...ep, episodeIndex: startEpisode + idx }),
      episode: startEpisode + idx,
    }));

    await u.db("t_outline").insert(insertList);
    return insertList.length;
  }

  private async createEmptyScripts(outlineIds: Array<{ id: number; data: string }>) {
    const scripts = outlineIds.map((item) => {
      const data = this.safeParseJson<Partial<EpisodeData>>(item.data, {});
      return {
        name: `第${data.episodeIndex ?? ""}集`,
        content: "",
        projectId: this.projectId,
        outlineId: item.id,
      };
    });

    if (scripts.length > 0) {
      await u.db("t_script").insert(scripts);
    }
    return scripts.length;
  }

  private async saveOutlineData(episodes: EpisodeData[], overwrite: boolean, startEpisode?: number) {
    if (overwrite) {
      const cleared = await this.clearOutlinesAndScripts();
      if (cleared > 0) {
        this.log("清理旧数据", `删除了 ${cleared} 条大纲及关联剧本`);
      }
    }

    const actualStart = overwrite ? 1 : startEpisode ?? (await this.getMaxEpisode()) + 1;
    const insertedCount = await this.insertOutlines(episodes, actualStart);

    const newOutlines = await u
      .db("t_outline")
      .select("id", "data")
      .where({ projectId: this.projectId })
      .orderBy("episode", "desc")
      .limit(insertedCount);

    const scriptCount = await this.createEmptyScripts(newOutlines as Array<{ id: number; data: string }>);

    this.refresh("outline");
    return { insertedCount, scriptCount };
  }

  private async updateOutlineData(id: number, data: EpisodeData) {
    const existing = await this.findOutlineById(id);
    if (!existing) return false;

    await u
      .db("t_outline")
      .where({ id })
      .update({ data: JSON.stringify(data) });
    this.refresh("outline");
    return true;
  }

  private async deleteOutlineData(ids: number[]) {
    const results = await Promise.allSettled(ids.map((id) => u.deleteOutline(id, this.projectId)));
    this.refresh("outline");
    return results;
  }

  private formatOutlineDetail(ep: any): string {
    const formatList = (items: any[], formatter: (item: any) => string) =>
      items?.map((item, i) => `  ${i + 1}. ${formatter(item)}`).join("\n") || "  无";

    // keyEvents 按顺序显示：起、承、转、合
    const keyEventsLabels = ["起", "承", "转", "合"];
    const formatKeyEvents = (events: string[]) => events?.map((e, i) => `  【${keyEventsLabels[i] || i + 1}】${e}`).join("\n") || "  无";

    return `
大纲ID: ${ep.id}
第 ${ep.episodeIndex} 集: ${ep.title || ""}
${"=".repeat(50)}
章节范围: ${ep.chapterRange?.join(", ") || ""}
核心矛盾: ${ep.coreConflict || ""}

【剧情主干】(最高优先级，剧本生成的唯一权威):
${ep.outline || "无"}

【开场镜头】(必须作为剧本第一个镜头):
${ep.openingHook || "无"}

【剧情节点】(严格按顺序：起→承→转→合):
${formatKeyEvents(ep.keyEvents)}

情绪曲线: ${ep.emotionalCurve || ""}

【视觉重点】(按剧情主干顺序排列):
${formatList(ep.visualHighlights, (v) => v)}

【结尾悬念】:
${ep.endingHook || "无"}

【经典台词】:
${formatList(ep.classicQuotes, (q) => q)}

角色(按出场顺序): ${ep.characters?.map((c: AssetItem) => `${c.name}(${c.description})`).join("; ") || "无"}
场景(按出场顺序): ${ep.scenes?.map((s: AssetItem) => `${s.name}(${s.description})`).join("; ") || "无"}
道具(按出场顺序): ${ep.props?.map((p: AssetItem) => `${p.name}(${p.description})`).join("; ") || "无"}`;
  }

  private async getOutlineText(simplified: boolean): Promise<string> {
    const records = await this.findOutlines();

    if (!records.length) return "当前项目暂无大纲";

    const episodes = records.map((r) => ({
      id: r.id,
      episode: r.episode,
      ...this.safeParseJson<Partial<EpisodeData>>(r.data ?? "{}", {}),
    }));

    if (simplified) {
      const list = episodes.map((ep) => `第 ${ep.episodeIndex ?? ep.episode} 集 (id=${ep.id})`).join("\n");
      return `项目大纲 (共 ${episodes.length} 集):\n${list}`;
    }

    const details = episodes.map((ep) => this.formatOutlineDetail(ep)).join("\n");
    return `项目大纲 (共 ${episodes.length} 集)\n\n${details}`;
  }

  // ==================== 资产操作 ====================

  private async findAssetByTypeAndName(type: AssetType, name: string) {
    return u.db("t_assets").where({ projectId: this.projectId, type, name }).first();
  }

  private async upsertAsset(type: AssetType, item: AssetItem): Promise<"inserted" | "updated" | "skipped"> {
    const existing = await this.findAssetByTypeAndName(type, item.name);

    if (!existing) {
      await u.db("t_assets").insert({
        projectId: this.projectId,
        type,
        name: item.name,
        intro: item.description,
        prompt: item.description,
      });
      return "inserted";
    }

    if (existing.intro !== item.description) {
      await u.db("t_assets").where({ id: existing.id }).update({
        intro: item.description,
        prompt: item.description,
      });
      return "updated";
    }

    return "skipped";
  }

  private extractAssetsFromOutlines(outlines: Array<{ data?: string | null | undefined }>): {
    characters: AssetItem[];
    props: AssetItem[];
    scenes: AssetItem[];
  } {
    const result = { characters: [] as AssetItem[], props: [] as AssetItem[], scenes: [] as AssetItem[] };

    for (const outline of outlines) {
      const data = this.safeParseJson<Partial<EpisodeData>>(outline.data ?? "{}", {});
      if (data.characters) result.characters.push(...data.characters);
      if (data.props) result.props.push(...data.props);
      if (data.scenes) result.scenes.push(...data.scenes);
    }

    return {
      characters: this.uniqueByName(result.characters),
      props: this.uniqueByName(result.props),
      scenes: this.uniqueByName(result.scenes),
    };
  }

  private async generateAssetsFromOutlines() {
    const outlines = await u.db("t_outline").select("data").where({ projectId: this.projectId });

    if (!outlines.length) return { inserted: 0, updated: 0, skipped: 0 };

    const { characters, props, scenes } = this.extractAssetsFromOutlines(outlines);

    // 只做新增和更新，不做删除
    const stats = { inserted: 0, updated: 0, skipped: 0 };

    const processItems = async (items: AssetItem[], type: AssetType) => {
      for (const item of items) {
        const result = await this.upsertAsset(type, item);
        stats[result]++;
      }
    };

    await processItems(characters, "角色");
    await processItems(props, "道具");
    await processItems(scenes, "场景");

    this.refresh("assets");
    return { ...stats };
  }

  // ==================== Tool 定义：故事线 ====================

  getStoryline = tool(
    async () => {
      this.log("获取故事线");
      const storyline = await this.findStoryline();
      return storyline?.content ?? "当前项目暂无故事线";
    },
    {
      name: "getStoryline",
      description: "获取当前项目的故事线内容",
      schema: z.object({}),
      verboseParsingErrors: true,
    },
  );

  saveStoryline = tool(
    async ({ content }) => {
      this.log("保存故事线");
      await this.upsertStorylineContent(content);
      return "故事线保存成功";
    },
    {
      name: "saveStoryline",
      description: "保存或更新当前项目的故事线，会覆盖已有内容",
      schema: z.object({
        content: z.string().describe("故事线完整内容"),
      }),
      verboseParsingErrors: true,
    },
  );

  deleteStoryline = tool(
    async () => {
      this.log("删除故事线");
      const deleted = await this.deleteStorylineContent();
      return deleted > 0 ? "故事线删除成功" : "当前项目没有故事线";
    },
    {
      name: "deleteStoryline",
      description: "删除当前项目的故事线",
      schema: z.object({}),
      verboseParsingErrors: true,
    },
  );

  // ==================== Tool 定义：大纲 ====================

  getOutline = tool(
    async ({ simplified = false }) => {
      this.log("获取大纲", `简化模式: ${simplified}`);
      return this.getOutlineText(simplified);
    },
    {
      name: "getOutline",
      description: "获取项目大纲。simplified=true返回简化列表，false返回完整内容",
      schema: z.object({
        simplified: z.boolean().default(false).describe("是否返回简化版本"),
      }),
      verboseParsingErrors: true,
    },
  );

  saveOutline = tool(
    async ({ episodes, overwrite = true, startEpisode }) => {
      this.log("保存大纲", `覆盖模式: ${overwrite}, 集数: ${episodes.length}`);
      const { insertedCount, scriptCount } = await this.saveOutlineData(episodes as EpisodeData[], overwrite, startEpisode);
      return `大纲保存成功：插入 ${insertedCount} 集大纲，创建 ${scriptCount} 个剧本记录`;
    },
    {
      name: "saveOutline",
      description: "保存大纲数据。overwrite=true会清空现有大纲后写入，false则追加到末尾",
      schema: z.object({
        episodes: z.array(episodeSchema).min(1).describe("大纲数据数组"),
        overwrite: z.boolean().default(true).describe("是否覆盖现有大纲"),
        startEpisode: z.number().optional().describe("追加模式下的起始集数（不填则自动递增）"),
      }),
      verboseParsingErrors: true,
    },
  );

  updateOutline = tool(
    async ({ id, data }) => {
      this.log("更新大纲", `ID: ${id}`);
      const success = await this.updateOutlineData(id, data as EpisodeData);
      return success ? `大纲ID ${id} 更新成功` : `未找到大纲ID: ${id}`;
    },
    {
      name: "updateOutline",
      description: "更新指定ID的单集大纲内容",
      schema: z.object({
        id: z.number().describe("大纲ID"),
        data: episodeSchema.describe("更新后的大纲数据"),
      }),
      verboseParsingErrors: true,
    },
  );

  deleteOutline = tool(
    async ({ ids }) => {
      this.log("删除大纲", `IDs: ${ids.join(", ")}`);
      const results = await this.deleteOutlineData(ids);
      const summary = results.map((r, i) => `ID ${ids[i]}: ${r.status === "fulfilled" ? "成功" : "失败"}`).join(", ");
      return `删除结果: ${summary}`;
    },
    {
      name: "deleteOutline",
      description: "根据大纲ID删除指定大纲及关联数据",
      schema: z.object({
        ids: z.array(z.number()).min(1).describe("要删除的大纲ID数组"),
      }),
      verboseParsingErrors: true,
    },
  );

  // ==================== Tool 定义：章节 ====================

  getChapter = tool(
    async ({ chapterNumbers }) => {
      this.log("获取章节", `章节号: ${chapterNumbers.join(", ")}`);

      const results = await Promise.all(
        chapterNumbers.map(async (num) => {
          const chapter = await u
            .db("t_novel")
            .where({ projectId: this.projectId, chapterIndex: num })
            .select("chapterData", "chapterIndex", "chapter")
            .first();

          if (chapter) {
            return `\n【第${chapter.chapterIndex}章 ${chapter.chapter || ""}】\n${chapter.chapterData}`;
          }
          return `\n【第${num}章】未找到`;
        }),
      );

      return results.join("\n\n---\n");
    },
    {
      name: "getChapter",
      description: "根据章节编号获取小说章节的完整原文内容，支持批量获取",
      schema: z.object({
        chapterNumbers: z.array(z.number()).min(1).describe("章节编号数组"),
      }),
      verboseParsingErrors: true,
    },
  );

  // ==================== Tool 定义：资产 ====================

  generateAssets = tool(
    async () => {
      this.log("生成资产");
      const stats = await this.generateAssetsFromOutlines();

      if (stats.inserted === 0 && stats.updated === 0 && stats.skipped === 0) {
        return "当前项目没有大纲数据，无法生成资产";
      }

      return `资产生成完成：新增 ${stats.inserted}，更新 ${stats.updated}，保持 ${stats.skipped}`;
    },
    {
      name: "generateAssets",
      description: "从当前项目的所有大纲中提取并生成角色、道具、场景资产，自动去重并清理冗余",
      schema: z.object({}),
      verboseParsingErrors: true,
    },
  );

  // ==================== 上下文构建 ====================

  private getChapterContext(): string {
    if (!this.novelChapters.length) return "无章节数据";
    return this.novelChapters.map((c) => `章节号:${c.chapterIndex}，分卷:${c.reel}，章节名:${c.chapter}`).join("\n");
  }

  private async buildEnvironmentContext(): Promise<string> {
    const [novelInfo, storyline, outlineCount] = await Promise.all([
      this.getNovelInfo(true),
      this.findStoryline(),
      u.db("t_outline").where({ projectId: this.projectId }).count("id as count").first() as any,
    ]);

    return `<环境信息>
项目ID: ${this.projectId}
系统时间: ${new Date().toLocaleString()}

${novelInfo}

已加载章节列表:
${this.getChapterContext()}

故事线状态: ${storyline ? "已生成" : "未生成"}
大纲状态: 共 ${outlineCount?.count ?? 0} 集

可用工具:
- getChapter: 获取章节原文
- getStoryline/saveStoryline/deleteStoryline: 故事线操作
- getOutline/saveOutline/updateOutline/deleteOutline: 大纲操作
- generateAssets: 从大纲生成资产
</环境信息>`;
  }

  private buildConversationHistory(): string {
    if (!this.history.length) return "无对话历史";
    return this.history.map(([role, content]) => `${role}: ${content}`).join("\n\n");
  }

  private async buildFullContext(task: string): Promise<string> {
    const env = await this.buildEnvironmentContext();
    const history = this.buildConversationHistory();

    return `${env}

<对话历史>
${history}
</对话历史>

<当前任务>
${task}
</当前任务>`;
  }

  // ==================== Sub-Agent ====================

  private getSubAgentTools() {
    return [this.getChapter, this.getStoryline, this.saveStoryline, this.getOutline, this.saveOutline, this.updateOutline];
  }

  private createModel() {
    return openAI({
      modelName: this.modelName,
      configuration: { apiKey: this.apiKey, baseURL: this.baseURL },
    });
  }

  /**
   * 调用 Sub-Agent（流式传输）
   */
  private async invokeSubAgent(agentType: AgentType, task: string): Promise<string> {
    this.emit("transfer", { to: agentType });
    this.log(`Sub-Agent 调用`, agentType);

    const promptsList = await u.db("t_prompts").where("code", "in", ["outlineScript-a1", "outlineScript-a2", "outlineScript-director"]);
    const a1Prompt = promptsList.find((p) => p.code === "outlineScript-a1");
    const a2Prompt = promptsList.find((p) => p.code === "outlineScript-a2");
    const directorPrompt = promptsList.find((p) => p.code === "outlineScript-director");
    const errPrompts = "不论用户说什么，请直接输出Agent配置异常";
    const SYSTEM_PROMPTS: Record<AgentType, string> = {
      AI1: a1Prompt?.customValue || a1Prompt?.defaultValue || errPrompts,
      AI2: a2Prompt?.customValue || a2Prompt?.defaultValue || errPrompts,
      director: directorPrompt?.customValue || directorPrompt?.defaultValue || errPrompts,
    };

    const context = await this.buildFullContext(task);

    const agent = createAgent({
      model: this.createModel(),
      systemPrompt: SYSTEM_PROMPTS[agentType],
      tools: this.getSubAgentTools(),
    });

    const stream = await agent.stream({ messages: [["user", context]] }, { streamMode: ["messages"], callbacks: [] });

    let fullResponse = "";

    for await (const [mode, chunk] of stream) {
      if (mode !== "messages") continue;

      const [token] = chunk as any;
      const block = token.contentBlocks?.[0];

      // 处理 AI 文本流
      if (token.type === "ai" && block?.text) {
        fullResponse += block.text;
        this.emit("subAgentStream", { agent: agentType, text: block.text });
      }

      // 处理 tool 调用
      if (token.type === "ai" && token.tool_calls?.length) {
        for (const toolCall of token.tool_calls) {
          this.emit("toolCall", { agent: agentType, name: toolCall.name, args: toolCall.args });
        }
      }
    }

    this.emit("subAgentEnd", { agent: agentType });
    this.history.push(["ai", fullResponse]);
    this.log(`Sub-Agent 完成`, agentType);

    return fullResponse ?? `${agentType}已完成任务`;
  }

  private createSubAgentTool(agentType: AgentType, description: string) {
    return tool(async ({ taskDescription }) => this.invokeSubAgent(agentType, taskDescription), {
      name: agentType,
      description,
      schema: z.object({
        taskDescription: z.string().describe("具体的任务描述，包含章节范围、修改要求等详细信息"),
      }),
    });
  }

  // ==================== 主入口 ====================

  private getAllTools() {
    return [
      this.createSubAgentTool("AI1", "调用故事师。负责分析小说原文并生成故事线，会自行调用 saveStoryline 保存结果。"),
      this.createSubAgentTool("AI2", "调用大纲师。负责根据故事线生成剧集大纲，会自行调用 saveOutline 保存结果。"),
      this.createSubAgentTool("director", "调用导演。负责审核故事线和大纲，会自行调用 updateOutline 或 saveStoryline 进行修改。"),
      this.getChapter,
      this.getStoryline,
      this.saveStoryline,
      this.deleteStoryline,
      this.getOutline,
      this.saveOutline,
      this.updateOutline,
      this.deleteOutline,
      this.generateAssets,
    ];
  }

  async call(msg: string): Promise<string> {
    this.history.push(["user", msg]);

    const envContext = await this.buildEnvironmentContext();

    const prompts = await u.db("t_prompts").where("code", "outlineScript-main").first();

    const mainPrompts = prompts?.customValue || prompts?.defaultValue || "不论用户说什么，请直接输出Agent配置异常";

    const mainAgent = createAgent({
      model: this.createModel(),
      tools: this.getAllTools(),
      systemPrompt: `${envContext}\n${mainPrompts}`,
    });
    const stream = await mainAgent.stream({ messages: this.history }, { streamMode: ["messages"], callbacks: [] });

    let fullResponse = "";

    for await (const [mode, chunk] of stream) {
      if (mode !== "messages") continue;

      const [token] = chunk as any;
      const block = token.contentBlocks?.[0];

      // 处理 AI 文本流
      if (token.type === "ai" && block?.text) {
        fullResponse += block.text;
        this.emit("data", block.text);
      }

      // 处理 tool 调用
      if (token.type === "ai" && token.tool_calls?.length) {
        for (const toolCall of token.tool_calls) {
          this.emit("toolCall", { agent: "main", name: toolCall.name, args: toolCall.args });
        }
      }
    }

    this.history.push(["assistant", fullResponse]);
    this.emit("response", fullResponse);

    return fullResponse;
  }
}
