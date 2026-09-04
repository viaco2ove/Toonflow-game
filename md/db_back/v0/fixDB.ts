/**
 * fixDB 是「装修 / 改造」：在不拆房子的前提下，加房间、改布局、修旧毛病、补新家具。
 * 改表字段、改存量数据、加新配置：必须写在 fixDB.ts 里，不能只改 initDB.ts。
 * 新增一张表：规范做法是两边都写——initDB.ts 里放完整建表逻辑（给新环境用），fixDB.ts 里放幂等建表逻辑（给老环境升级用）。
 * 只改 initDB.ts 不改 fixDB.ts 的后果：你本地重置数据库一切正常，线上 / 已部署的老环境完全不生效，该缺的字段还是缺、该改的数据还是旧的，大概率直接报运行错误。
 *
 * fixDB 是「全量幂等驱动」：没有版本记录表，每次运行都把所有变更从头到尾扫一遍，靠每一步自己的 if exists 判断要不要执行。相当于把 Flyway 的「版本号校验」换成了「业务存在性校验」。
 * 一句话总结
 * 它就是人工手写的一堆补丁，每个补丁都自带「有没有？没有就装」的判断，每次全量跑一遍。
 * 没有自动差异对比，没有版本号管理，所有变更都必须你手动写进代码里；好处是轻量、不用引额外工具，坏处是变更多了文件会越来越臃肿，也没法自动回滚。
 */
import { Knex } from "knex";
import {
  buildChapterRuntimeOutline,
  normalizeChapterFields,
  toJsonText,
} from "@/lib/gameEngine";
import {
  PROMPT_GENERATEIMAGEPROMPTS,
  PROMPT_INTENT_ANALYZER,
  PROMPT_SCENE_GENERATEIMAGE,
  PROMPT_STORYBOARD_POLISH,
  PROMPT_STORYBOARD_SHOT,
  PROMPT_STORY_CHAPTER,
  PROMPT_STORY_EVENT_PROGRESS,
  PROMPT_STORY_MAIN,
  PROMPT_STORY_MEMORY,
  PROMPT_STORY_MINI_GAME,
  PROMPT_STORY_MINI_GAME_ALCHEMY,
  PROMPT_STORY_MINI_GAME_BATTLE,
  PROMPT_STORY_MINI_GAME_CULTIVATION,
  PROMPT_STORY_MINI_GAME_FISHING,
  PROMPT_STORY_MINI_GAME_MINING,
  PROMPT_STORY_MINI_GAME_RESEARCH_SKILL,
  PROMPT_STORY_MINI_GAME_UPGRADE_EQUIPMENT,
  PROMPT_STORY_MINI_GAME_WEREWOLF,
  PROMPT_STORY_ORCHESTRATOR,
  PROMPT_STORY_ORCHESTRATOR_ADVANCED,
  PROMPT_STORY_ORCHESTRATOR_COMPACT,
  PROMPT_STORY_SAFETY,
  PROMPT_STORY_SELL_ITEM,
  PROMPT_STORY_SPEAKER,
  PROMPT_TASK_COMPLETION_AGENT,
  PROMPT_TASK_DIRECTOR_AGENT,
  PROMPT_TASK_PROGRESS_AGENT,
  PROMPT_TASK_SPEAKER_AGENT,
  PROMPT_PLAY_TIP_AGENT,
  PROMPT_STORY_ORCHESTRATOR_OPTIONS,
  PROMPT_TASK_DIRECTOR_AGENT_OPTIONS,
  PROMPT_STORY_UPDATE_ALIGN,
  PROMPT_VIDEO_TEXT,
} from "./fixDB.prompts";

function stripLegacyStoryMainPrefix(prompt: unknown): string {
  const lines = String(prompt || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const filtered = lines.filter((line) => {
    const normalized = line.trim();
    if (!normalized) return true;
    if (normalized.includes("你是 AI 故事总调度")) return false;
    if (normalized.includes("决定把任务交给哪个子 agent")) return false;
    return true;
  });
  return filtered.join("\n").trim();
}

export default async (knex: Knex): Promise<void> => {
  const legacyVolcengineTextModelAliases: Record<string, string> = {
    "Doubao-Seed-2.0-pro": "doubao-seed-2-0-pro-260215",
    "Doubao-Seed-2.0-lite": "doubao-seed-2-0-lite-260215",
    "Doubao-Seed-2.0-mini": "doubao-seed-2-0-mini-260215",
  };
  const volcengineTextModels = [
    { manufacturer: "volcengine", model: "doubao-seed-2-0-pro-260215", responseFormat: "object", image: 1, think: 1, tool: 1 },
    { manufacturer: "volcengine", model: "doubao-seed-2-0-lite-260215", responseFormat: "object", image: 1, think: 1, tool: 1 },
    { manufacturer: "volcengine", model: "doubao-seed-2-0-mini-260215", responseFormat: "object", image: 1, think: 1, tool: 1 },
    { manufacturer: "volcengine", model: "doubao-seed-1-8-251228", responseFormat: "object", image: 1, think: 1, tool: 1 },
    { manufacturer: "volcengine", model: "doubao-seed-1-6-251015", responseFormat: "object", image: 1, think: 1, tool: 1 },
    { manufacturer: "volcengine", model: "doubao-seed-1-6-lite-251015", responseFormat: "object", image: 1, think: 1, tool: 1 },
    { manufacturer: "volcengine", model: "doubao-seed-1-6-flash-250828", responseFormat: "object", image: 1, think: 1, tool: 1 },
  ];
  const lmstudioTextModels = [
    { manufacturer: "lmstudio", model: "qwen3.5-9b", responseFormat: "schema", image: 0, think: 0, tool: 1 },
  ];
  const autodlTextModels = [
    { manufacturer: "autodl_chat", model: "DeepSeek-R1-0528", responseFormat: "object", image: 0, think: 1, tool: 1 },
    { manufacturer: "autodl_chat", model: "GLM-5", responseFormat: "object", image: 0, think: 1, tool: 1 },
    { manufacturer: "autodl_chat", model: "DeepSeek-V3.2", responseFormat: "object", image: 0, think: 1, tool: 1 },
    { manufacturer: "autodl_chat", model: "MiniMax-M2.7", responseFormat: "object", image: 0, think: 1, tool: 1 },
    { manufacturer: "autodl_chat", model: "MiniMax-M2.5", responseFormat: "object", image: 0, think: 1, tool: 1 },
    { manufacturer: "autodl_chat", model: "Qwen3.5-397B-A17B", responseFormat: "object", image: 0, think: 1, tool: 1 },
    { manufacturer: "autodl_chat", model: "Kimi-K2.5", responseFormat: "object", image: 0, think: 1, tool: 1 },
    { manufacturer: "autodl_chat", model: "gpt-5.4", responseFormat: "object", image: 0, think: 1, tool: 1 },
  ];

  const ensureTable = async (table: string, builder: (table: Knex.CreateTableBuilder) => void) => {
    if (!(await knex.schema.hasTable(table))) {
      await knex.schema.createTable(table, builder);
    }
  };

  const addColumnAndDef = async (
  table: string,
  column: string,
  type: string,
  options?: { defaultTo?: any }
    ) => {
      if (!(await knex.schema.hasTable(table))) return;
      if (!(await knex.schema.hasColumn(table, column))) {
        await knex.schema.alterTable(table, (t) => {
          const col = (t as any)[type](column);
          if (options?.defaultTo !== undefined) {
            col.defaultTo(options.defaultTo);
          }
        });
      }
  };
  const addColumn = async (table: string, column: string, type: string) => {
    if (!(await knex.schema.hasTable(table))) return;
    if (!(await knex.schema.hasColumn(table, column))) {
      await knex.schema.alterTable(table, (t) => (t as any)[type](column));
    }
  };

  const dropColumn = async (table: string, column: string) => {
    if (!(await knex.schema.hasTable(table))) return;
    if (await knex.schema.hasColumn(table, column)) {
      await knex.schema.alterTable(table, (t) => t.dropColumn(column));
    }
  };

  const alterColumnType = async (table: string, column: string, type: string) => {
    if (!(await knex.schema.hasTable(table))) return;
    if (await knex.schema.hasColumn(table, column)) {
      await knex.schema.alterTable(table, (t) => {
        (t as any)[type](column).alter();
      });
    }
  };

  await ensureTable("t_aiTokenUsageLog", (table) => {
    table.increments("id").primary();
    table.integer("userId").notNullable();
    table.integer("createTime").notNullable();
    table.text("type");
    table.text("manufacturer");
    table.text("model");
    table.text("channel");
    table.integer("inputTokens").defaultTo(0);
    table.integer("outputTokens").defaultTo(0);
    table.integer("reasoningTokens").defaultTo(0);
    table.integer("cacheReadTokens").defaultTo(0);
    table.integer("totalTokens").defaultTo(0);
    table.float("inputPricePer1M").defaultTo(0);
    table.float("outputPricePer1M").defaultTo(0);
    table.float("cacheReadPricePer1M").defaultTo(0);
    table.float("amount").defaultTo(0);
    table.text("currency").defaultTo("CNY");
    table.text("remark");
    table.text("meta");
    table.index(["userId", "createTime"], "idx_aiTokenUsageLog_user_time");
    table.index(["type"], "idx_aiTokenUsageLog_type");
  });

  await addColumn("t_sessionMessage", "revisitData", "text");
  await addColumn("t_config", "reasoningEffort", "text");
  await addColumn("t_config", "remark", "text");
  await addColumnAndDef("t_config", "temperature", "float", { defaultTo: 0.3 });
  await addColumnAndDef("t_config", "topP", "float", { defaultTo: 0.5 });
  if (await knex.schema.hasTable("t_config")) {
    await knex("t_config")
      .where("type", "text")
      .where((builder) => {
        builder.whereNull("reasoningEffort").orWhere("reasoningEffort", "");
      })
      .update({ reasoningEffort: "minimal" });
    await knex("t_config")
      .where("type", "text")
      .whereNull("temperature")
      .update({ temperature: 0.3 });
    await knex("t_config")
      .where("type", "text")
      .whereNull("topP")
      .update({ topP: 0.5 });
  }

  const upsertVideoModels = async (
    models: Array<{
      manufacturer: string;
      model: string;
      durationResolutionMap: string;
      aspectRatio: string;
      audio: number;
      type: string;
    }>,
  ) => {
    if (!(await knex.schema.hasTable("t_videoModel"))) return;
    for (const item of models) {
      const exists = await knex("t_videoModel")
        .where({ manufacturer: item.manufacturer, model: item.model })
        .first();
      if (exists) {
        await knex("t_videoModel")
          .where({ id: (exists as any).id })
          .update({
            durationResolutionMap: item.durationResolutionMap,
            aspectRatio: item.aspectRatio,
            audio: item.audio,
            type: item.type,
          });
        continue;
      }
      const maxIdResult = (await knex("t_videoModel").max("id as maxId").first()) as { maxId?: number } | undefined;
      const nextId = (maxIdResult?.maxId || 0) + 1;
      await knex("t_videoModel").insert({
        id: nextId,
        ...item,
      });
    }
  };

  const upsertTextModels = async (
    models: Array<{
      manufacturer: string;
      model: string;
      responseFormat: string;
      image: number;
      think: number;
      tool: number;
    }>,
  ) => {
    if (!(await knex.schema.hasTable("t_textModel"))) return;
    for (const item of models) {
      const exists = await knex("t_textModel")
        .where({ manufacturer: item.manufacturer, model: item.model })
        .first();
      if (exists) {
        await knex("t_textModel")
          .where({ id: (exists as any).id })
          .update({
            responseFormat: item.responseFormat,
            image: item.image,
            think: item.think,
            tool: item.tool,
          });
        continue;
      }
      const maxIdResult = (await knex("t_textModel").max("id as maxId").first()) as { maxId?: number } | undefined;
      const nextId = (maxIdResult?.maxId || 0) + 1;
      await knex("t_textModel").insert({
        id: nextId,
        ...item,
      });
    }
  };

  const cleanupDuplicateStorySessions = async () => {
    const requiredTables = ["t_gameSession", "t_sessionMessage", "t_sessionStateSnapshot", "t_entityStateDelta"];
    for (const table of requiredTables) {
      if (!(await knex.schema.hasTable(table))) return;
    }
    const sessionRows = await knex("t_gameSession")
      .whereNotNull("userId")
      .whereNotNull("worldId")
      .where("userId", ">", 0)
      .where("worldId", ">", 0)
      .select("id", "sessionId", "userId", "worldId", "updateTime")
      .orderBy("userId", "asc")
      .orderBy("worldId", "asc")
      .orderBy("updateTime", "desc")
      .orderBy("id", "desc");
    if (!sessionRows.length) return;
    const seenKeys = new Set<string>();
    const duplicateRows: Array<{ id: number; sessionId: string | null }> = [];
    for (const row of sessionRows as Array<{ id?: number | null; sessionId?: string | null; userId?: number | null; worldId?: number | null }>) {
      const userId = Number(row.userId || 0);
      const worldId = Number(row.worldId || 0);
      if (!userId || !worldId) continue;
      const key = `${userId}:${worldId}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        continue;
      }
      duplicateRows.push({
        id: Number(row.id || 0),
        sessionId: row.sessionId || null,
      });
    }
    if (!duplicateRows.length) return;
    const duplicateIds = duplicateRows.map((row) => row.id).filter((id) => id > 0);
    const duplicateSessionIds = duplicateRows
      .map((row) => row.sessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId));
    await knex.transaction(async (trx) => {
      if (duplicateSessionIds.length) {
        await trx("t_sessionMessage").whereIn("sessionId", duplicateSessionIds).delete();
        await trx("t_sessionStateSnapshot").whereIn("sessionId", duplicateSessionIds).delete();
        await trx("t_entityStateDelta").whereIn("sessionId", duplicateSessionIds).delete();
      }
      if (duplicateIds.length) {
        await trx("t_gameSession").whereIn("id", duplicateIds).delete();
      }
    });
    console.log(`[fixDB] cleaned duplicate story sessions: ${duplicateRows.length}`);
  };

  const cleanupStoryChapterDrafts = async () => {
    if (!(await knex.schema.hasTable("t_storyChapter"))) return;
    const rows = await knex("t_storyChapter")
      .select("id", "title", "sort", "openingText", "content")
      .orderBy("id", "asc");
    if (!rows.length) return;
    const splitParagraphs = (input: string) =>
      String(input || "")
        .replace(/\r\n/g, "\n")
        .split(/\n\s*\n+/)
        .map((item) => item.trim())
        .filter(Boolean);
    let changed = 0;
    for (const row of rows as Array<{ id?: number; title?: string | null; sort?: number | null; openingText?: string | null; content?: string | null }>) {
      const id = Number(row.id || 0);
      if (id <= 0) continue;
      const sort = Number(row.sort || 0);
      const currentTitle = String(row.title || "").trim();
      const currentOpening = String(row.openingText || "").trim();
      const currentContent = String(row.content || "").trim();
      let nextTitle = currentTitle;
      let nextOpening = currentOpening;
      let nextContent = currentContent;
      if (/^章节\s*\d{10,}$/u.test(currentTitle) && sort > 0) {
        nextTitle = `第 ${sort} 章`;
      }
      const openingParagraphs = splitParagraphs(currentOpening);
      if (openingParagraphs.length > 1) {
        nextOpening = openingParagraphs[0];
        const remainder = openingParagraphs.slice(1).join("\n\n").trim();
        if (remainder) {
          const remainderParagraphs = splitParagraphs(remainder);
          const contentParagraphs = splitParagraphs(currentContent);
          const alreadyPrefixed = remainderParagraphs.every((item, index) => contentParagraphs[index] === item);
          if (!alreadyPrefixed) {
            nextContent = [remainder, currentContent].filter(Boolean).join("\n\n").trim();
          }
        }
      }
      if (nextTitle === currentTitle && nextOpening === currentOpening && nextContent === currentContent) continue;
      await knex("t_storyChapter").where({ id }).update({
        title: nextTitle,
        openingText: nextOpening,
        content: nextContent,
      });
      changed += 1;
    }
    if (changed > 0) {
      console.log(`[fixDB] cleaned story chapters: ${changed}`);
    }
  };

  const backfillStoryChapterRuntimeOutline = async () => {
    if (!(await knex.schema.hasTable("t_storyChapter"))) return;
    const rows = await knex("t_storyChapter")
      .select(
        "id",
        "openingRole",
        "openingText",
        "content",
        "entryCondition",
        "completionCondition",
        "runtimeOutline",
      )
      .orderBy("id", "asc");
    if (!rows.length) return;
    let changed = 0;
    for (const row of rows as Array<Record<string, unknown>>) {
      const id = Number(row.id || 0);
      if (id <= 0) continue;
      const normalized = normalizeChapterFields({
        content: row.content,
        openingRole: row.openingRole,
        openingText: row.openingText,
        entryCondition: row.entryCondition,
        completionCondition: row.completionCondition,
      });
      const runtimeOutline = buildChapterRuntimeOutline({
        openingRole: normalized.openingRole,
        openingText: normalized.openingText,
        content: normalized.content,
        completionCondition: normalized.completionCondition,
        runtimeOutline: row.runtimeOutline,
      });
      // 老章节没有 runtimeOutline 时，启动修复阶段回填最小运行模板。
      const nextOutlineText = toJsonText(runtimeOutline, {});
      if (String(row.runtimeOutline || "") === nextOutlineText) continue;
      await knex("t_storyChapter").where({ id }).update({
        runtimeOutline: nextOutlineText,
      });
      changed += 1;
    }
    if (changed > 0) {
      console.log(`[fixDB] backfilled story chapter runtime outlines: ${changed}`);
    }
  };

  await ensureTable("t_scriptSegment", (table) => {
    table.integer("id").notNullable();
    table.integer("scriptId").notNullable();
    table.integer("projectId").notNullable();
    table.integer("sort").notNullable();
    table.text("title");
    table.text("content");
    table.text("summary");
    table.text("startAnchor");
    table.text("endAnchor");
    table.integer("createTime");
    table.integer("updateTime");
    table.primary(["id"]);
    table.unique(["id"]);
  });
  await ensureTable("t_voiceModel", (table) => {
    table.integer("id").notNullable();
    table.text("manufacturer");
    table.text("model");
    table.text("mode");
    table.primary(["id"]);
    table.unique(["id"]);
  });
  await ensureTable("t_roleAvatarTask", (table) => {
    table.increments("id").primary();
    table.integer("userId").notNullable();
    table.integer("projectId");
    table.text("taskType");
    table.text("status");
    table.integer("progress");
    table.text("message");
    table.text("errorMessage");
    table.text("foregroundPath");
    table.text("foregroundFilePath");
    table.text("backgroundPath");
    table.text("backgroundFilePath");
    table.text("sourcePath");
    table.text("sourceFilePath");
    table.integer("createTime");
    table.integer("updateTime");
  });

  await addColumn("t_roleAvatarTask", "sourcePath", "text");
  await addColumn("t_roleAvatarTask", "sourceFilePath", "text");

  //添加字段
  await addColumn("t_video", "time", "integer");
  await addColumn("t_video", "aiConfigId", "integer");
  await addColumn("t_config", "modelType", "text");
  await addColumn("t_config", "inputPricePer1M", "float");
  await addColumn("t_config", "outputPricePer1M", "float");
  await addColumn("t_config", "cacheReadPricePer1M", "float");
  await addColumn("t_config", "currency", "text");
  await addColumn("t_aiTokenUsageLog", "inputPricePer1M", "float");
  await addColumn("t_aiTokenUsageLog", "outputPricePer1M", "float");
  await addColumn("t_aiTokenUsageLog", "cacheReadPricePer1M", "float");
  await addColumn("t_aiTokenUsageLog", "amount", "float");
  await addColumn("t_aiTokenUsageLog", "currency", "text");
  await addColumn("t_videoConfig", "audioEnabled", "integer");
  await addColumn("t_video", "errorReason", "text");
  await addColumn("t_video", "providerTaskId", "text");
  await addColumn("t_video", "providerQueryUrl", "text");
  await addColumn("t_video", "providerManufacturer", "text");
  await addColumn("t_scriptSegment", "summary", "text");
  await addColumn("t_scriptSegment", "startAnchor", "text");
  await addColumn("t_scriptSegment", "endAnchor", "text");
  await addColumn("t_scriptSegment", "createTime", "integer");
  await addColumn("t_scriptSegment", "updateTime", "integer");
  await addColumn("t_assets", "voiceConfig", "text");
  await addColumn("t_videoConfig", "voiceConfigId", "integer");
  await addColumn("t_videoConfig", "voicePresetId", "text");
  await addColumn("t_videoConfig", "dialogue", "text");
  await addColumn("t_videoConfig", "audioPath", "text");
  await addColumn("t_videoConfig", "ttsAudioPath", "text");
  await addColumn("t_videoConfig", "sort", "integer");
  await addColumn("t_videoConfig", "audioTrack", "integer");
  await addColumn("t_videoConfig", "dialogueTrack", "integer");
  await addColumn("t_gameSession", "contentVersion", "text");
  await addColumn("t_user", "avatarPath", "text");
  await addColumn("t_user", "avatarBgPath", "text");
  await addColumn("t_storyWorld", "coverPath", "text");
  await addColumn("t_storyWorld", "publishStatus", "text");
  await addColumn("t_storyChapter", "backgroundPath", "text");
  await addColumn("t_storyChapter", "openingRole", "text");
  await addColumn("t_storyChapter", "openingText", "text");
  await addColumn("t_storyChapter", "bgmPath", "text");
  await addColumn("t_storyChapter", "bgmAutoPlay", "integer");
  await addColumn("t_storyChapter", "showCompletionCondition", "integer");
  await addColumn("t_storyChapter", "runtimeOutline", "text");

  // ===== 方向2：故事发布门控--表结构升级 =====
  // 1) 新列：t_gameSession 记录发布版本关联与版本号
  await addColumn("t_gameSession", "worldPublishId", "integer");
  await addColumn("t_gameSession", "worldVersion", "integer");

  // 2) 幂等建表：发布快照表（builder 与 initDB.ts 一致）
  await ensureTable("t_storyWorld_published", (table) => {
    table.integer("id").notNullable();
    table.integer("worldId");
    table.integer("version");
    table.integer("publishedAt");
    table.text("publishedBy");
    table.text("name");
    table.text("intro");
    table.text("coverPath");
    table.text("settings");
    table.text("playerRole");
    table.text("narratorRole");
    table.integer("projectId");
    table.integer("createTime");
    table.integer("updateTime");
    table.primary(["id"]);
    table.unique(["id"]);
    table.unique(["worldId"]);
    table.index(["worldId"], "idx_storyWorld_published_worldId");
  });

  // 世界书条目表：幂等建表，老库自动补建（阶段1 存储层，注入引擎是阶段2）
  await ensureTable("t_worldBook", (table) => {
    table.increments("id").primary();
    table.integer("worldId");
    table.text("entryId");
    table.text("title");
    table.text("category");
    table.text("keys");
    table.integer("constant");
    table.integer("probability");
    table.integer("order");
    table.text("group");
    table.text("selectiveLogic");
    table.text("selectiveKeys");
    table.text("content");
    table.integer("sort");
    table.integer("createTime");
    table.integer("updateTime");
    table.text("agentList");
    table.index(["worldId"], "idx_worldBook_worldId");
  });
  // 老库升级：t_worldBook 建表语句里加了 agentList，老部署不会自动补列，
  // 导致保存世界书时 SQLite 报 no such column: agentList。这里显式补一列。
  await addColumn("t_worldBook", "agentList", "text");
  await ensureTable("t_storyChapter_published", (table) => {
    table.integer("id").notNullable();
    table.integer("worldPublishId");
    table.integer("chapterId");
    table.text("title");
    table.text("content");
    table.text("runtimeOutline");
    table.integer("sort");
    table.text("openingRole");
    table.text("openingText");
    table.text("bgmPath");
    table.integer("bgmAutoPlay");
    table.text("backgroundPath");
    table.text("entryCondition");
    table.text("completionCondition");
    table.integer("showCompletionCondition");
    table.text("triggersJson");
    table.text("tasksJson");
    table.integer("publishedAt");
    table.primary(["id"]);
    table.unique(["id"]);
    table.unique(["worldPublishId", "chapterId"], "uq_storyChapter_published_publish_chapter");
    table.index(["worldPublishId"], "idx_storyChapter_published_worldPublishId");
    table.index(["chapterId"], "idx_storyChapter_published_chapterId");
  });

  //更正字段
  await alterColumnType("t_config", "modelType", "text");

  //删除字段
  await dropColumn("t_config", "index");


  await knex("t_prompts")
    .update({
      defaultValue:
        PROMPT_STORYBOARD_POLISH,
    })
    .where("code", "storyboard-polish");

  await knex("t_prompts")
    .update({
      defaultValue:
        PROMPT_STORYBOARD_SHOT,
    })
    .where("code", "storyboard-shot");
  await knex("t_prompts")
    .update({
      defaultValue:
        PROMPT_GENERATEIMAGEPROMPTS,
    })
    .where("code", "generateImagePrompts");
    await knex("t_prompts")
    .update({
      defaultValue:
      PROMPT_SCENE_GENERATEIMAGE
    })
    .where("code", "scene-generateImage");
  const videoText = await knex("t_prompts").where("code", "video-text").first();
  if (!videoText) {
    await knex("t_prompts").insert({
      id: 22,
      code: "video-text",
      name: "视频提示词-文本模式",
      type: "system",
      parentCode: null,
      defaultValue:
        PROMPT_VIDEO_TEXT,
      customValue: null,
    });
  }

  // 兼容老库：补齐 t8star 视频模型
  const t8starModels = [
    {
      manufacturer: "t8star",
      model: "veo-3.1-generate-preview",
      durationResolutionMap: JSON.stringify([
        { duration: [4, 6], resolution: ["720p"] },
        { duration: [8], resolution: ["720p", "1080p"] },
      ]),
      aspectRatio: JSON.stringify(["16:9", "9:16"]),
      audio: 1,
      type: JSON.stringify(["text", "singleImage", "startEndRequired", "endFrameOptional", "reference"]),
    },
    {
      manufacturer: "t8star",
      model: "veo-3.1-fast-generate-preview",
      durationResolutionMap: JSON.stringify([
        { duration: [4, 6], resolution: ["720p"] },
        { duration: [8], resolution: ["720p", "1080p"] },
      ]),
      aspectRatio: JSON.stringify(["16:9", "9:16"]),
      audio: 1,
      type: JSON.stringify(["text", "singleImage", "startEndRequired", "endFrameOptional", "reference"]),
    },
    {
      manufacturer: "t8star",
      model: "veo-3.0-generate-preview",
      durationResolutionMap: JSON.stringify([
        { duration: [4, 6], resolution: ["720p"] },
        { duration: [8], resolution: ["720p", "1080p"] },
      ]),
      aspectRatio: JSON.stringify(["16:9", "9:16"]),
      audio: 1,
      type: JSON.stringify(["text", "singleImage"]),
    },
    {
      manufacturer: "t8star",
      model: "veo-3.0-fast-generate-preview",
      durationResolutionMap: JSON.stringify([
        { duration: [4, 6], resolution: ["720p"] },
        { duration: [8], resolution: ["720p", "1080p"] },
      ]),
      aspectRatio: JSON.stringify(["16:9", "9:16"]),
      audio: 1,
      type: JSON.stringify(["text", "singleImage"]),
    },
    {
      manufacturer: "t8star",
      model: "veo-2.0-generate-001",
      durationResolutionMap: JSON.stringify([{ duration: [5, 6, 7, 8], resolution: ["720p"] }]),
      aspectRatio: JSON.stringify(["16:9", "9:16"]),
      audio: 0,
      type: JSON.stringify(["text", "singleImage"]),
    },
    {
      manufacturer: "t8star",
      model: "veo3.1-fast",
      durationResolutionMap: JSON.stringify([{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["480p", "720p", "1080p", "2K", "4K"] }]),
      aspectRatio: JSON.stringify(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]),
      audio: 1,
      type: JSON.stringify(["text", "singleImage", "startEndRequired", "endFrameOptional", "reference"]),
    },
    {
      manufacturer: "t8star",
      model: "veo3.1-fast-4k",
      durationResolutionMap: JSON.stringify([{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["4K", "2K", "1080p"] }]),
      aspectRatio: JSON.stringify(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]),
      audio: 1,
      type: JSON.stringify(["text", "singleImage", "startEndRequired", "endFrameOptional", "reference"]),
    },
    {
      manufacturer: "t8star",
      model: "veo3.1-pro",
      durationResolutionMap: JSON.stringify([{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["720p", "1080p", "2K"] }]),
      aspectRatio: JSON.stringify(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]),
      audio: 1,
      type: JSON.stringify(["text", "singleImage", "startEndRequired", "endFrameOptional", "reference"]),
    },
    {
      manufacturer: "t8star",
      model: "veo3.1-pro-4k",
      durationResolutionMap: JSON.stringify([{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["4K", "2K", "1080p"] }]),
      aspectRatio: JSON.stringify(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]),
      audio: 1,
      type: JSON.stringify(["text", "singleImage", "startEndRequired", "endFrameOptional", "reference"]),
    },
  ];
  await upsertVideoModels(t8starModels);

  // 兼容老库：补齐 qingyuntop 视频模型
  const qingyunModels = [
      {
        manufacturer: "qingyuntop",
        model: "veo3.1-fast",
        durationResolutionMap: JSON.stringify([{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["480p", "720p", "1080p", "2K", "4K"] }]),
        aspectRatio: JSON.stringify(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]),
        audio: 1,
        type: JSON.stringify(["text", "singleImage", "startEndRequired", "endFrameOptional", "reference"]),
      },
      {
        manufacturer: "qingyuntop",
        model: "veo3.1-fast-4k",
        durationResolutionMap: JSON.stringify([{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["4K", "2K", "1080p"] }]),
        aspectRatio: JSON.stringify(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]),
        audio: 1,
        type: JSON.stringify(["text", "singleImage", "startEndRequired", "endFrameOptional", "reference"]),
      },
      {
        manufacturer: "qingyuntop",
        model: "veo3.1-pro",
        durationResolutionMap: JSON.stringify([{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["720p", "1080p", "2K"] }]),
        aspectRatio: JSON.stringify(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]),
        audio: 1,
        type: JSON.stringify(["text", "singleImage", "startEndRequired", "endFrameOptional", "reference"]),
      },
      {
        manufacturer: "qingyuntop",
        model: "veo3.1-pro-4k",
        durationResolutionMap: JSON.stringify([{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["4K", "2K", "1080p"] }]),
        aspectRatio: JSON.stringify(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]),
        audio: 1,
        type: JSON.stringify(["text", "singleImage", "startEndRequired", "endFrameOptional", "reference"]),
      },
    ];

  await upsertVideoModels(qingyunModels);

  // 兼容老库：补齐 kieai 视频模型
  const kieaiModels = [
      {
        manufacturer: "kieai",
        model: "veo3_fast",
        durationResolutionMap: JSON.stringify([
          { duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["720p"] },
        ]),
        aspectRatio: JSON.stringify(["16:9"]),
        audio: 1,
        type: JSON.stringify(["text", "singleImage", "startEndRequired", "endFrameOptional", "reference"]),
      },
    ];

  await upsertVideoModels(kieaiModels);

  // 兼容老库：补齐 volcengine / t8star 文本模型
  if (await knex.schema.hasTable("t_textModel")) {
    for (const [legacyModel, canonicalModel] of Object.entries(legacyVolcengineTextModelAliases)) {
      await knex("t_textModel")
        .whereIn("manufacturer", ["volcengine", "doubao"])
        .andWhere("model", legacyModel)
        .update({
          model: canonicalModel,
          responseFormat: "object",
          image: 1,
          think: 1,
          tool: 1,
        });
    }

    const t8starTextModels = [
      { manufacturer: "t8star", model: "gpt-5.4-pro", responseFormat: "object", image: 1, think: 1, tool: 1 },
      { manufacturer: "t8star", model: "gemini-2.5-pro", responseFormat: "object", image: 1, think: 1, tool: 1 },
    ];

    await upsertTextModels(lmstudioTextModels);
    await upsertTextModels(volcengineTextModels);
    await upsertTextModels(t8starTextModels);
  }

  if (await knex.schema.hasTable("t_voiceModel")) {
    const voiceDefault = {
      manufacturer: "ai_voice_tts",
      model: "ai_voice_tts",
      mode: JSON.stringify(["text", "clone", "mix", "prompt_voice"]),
    };
    const exists = await knex("t_voiceModel").where({ manufacturer: voiceDefault.manufacturer, model: voiceDefault.model }).first();
    if (!exists) {
      const maxIdResult = (await knex("t_voiceModel").max("id as maxId").first()) as { maxId?: number } | undefined;
      const nextId = (maxIdResult?.maxId || 0) + 1;
      await knex("t_voiceModel").insert({ id: nextId, ...voiceDefault });
    }
  }

  if (await knex.schema.hasTable("t_config")) {
    await knex("t_config")
      .whereNull("currency")
      .orWhereRaw("trim(coalesce(currency, '')) = ''")
      .update({ currency: "CNY" });
    for (const [legacyModel, canonicalModel] of Object.entries(legacyVolcengineTextModelAliases)) {
      await knex("t_config")
        .where({ type: "text", model: legacyModel })
        .whereIn("manufacturer", ["volcengine", "doubao"])
        .update({
          model: canonicalModel,
        });
    }

    await knex("t_config")
      .where({ type: "voice", manufacturer: "aliyun_direct" })
      .whereRaw("lower(coalesce(modelType, '')) = ?", ["tts"])
      .where(function () {
        this.whereNull("model").orWhereRaw("trim(coalesce(model, '')) = ''");
      })
      .update({
        model: "cosyvoice-v3-flash",
        baseUrl: "https://dashscope.aliyuncs.com",
      });
    await knex("t_config")
      .where({ type: "voice", manufacturer: "aliyun_direct" })
      .whereRaw("lower(coalesce(modelType, '')) = ?", ["asr"])
      .where(function () {
        this.whereNull("model").orWhereRaw("trim(coalesce(model, '')) = ''");
      })
      .update({
        model: "qwen3-asr-flash",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
      });
  }

  if (await knex.schema.hasTable("t_aiTokenUsageLog")) {
    await knex("t_aiTokenUsageLog")
      .whereNull("currency")
      .orWhereRaw("trim(coalesce(currency, '')) = ''")
      .update({ currency: "CNY" });
  }

  const aiModels = [
    { name: "分镜Agent", key: "storyboardAgent" },
    { name: "分镜Agent图片生成", key: "storyboardImage" },
    { name: "大纲故事线Agent", key: "outlineScriptAgent" },
    { name: "资产提示词润色", key: "assetsPrompt" },
    { name: "资产图片生成", key: "assetsImage" },
    { name: "剧本生成", key: "generateScript" },
    { name: "视频提示词生成", key: "videoPrompt" },
    { name: "图片编辑", key: "editImage" },
    { name: "AI故事-编排师", key: "storyOrchestratorModel" },
    { name: "AI故事-章节判定", key: "storyChapterJudgeModel" },
    { name: "AI故事-事件进度检测", key: "storyEventProgressModel" },
    { name: "AI故事-小游戏动作解析", key: "storyMiniGameModel" },
    { name: "AI故事-快速角色发言", key: "storyFastSpeakerModel" },
    { name: "AI故事-角色发言", key: "storySpeakerModel" },
    { name: "AI故事-记忆管理", key: "storyMemoryModel" },
    { name: "AI故事-AI生图", key: "storyImageModel" },
    { name: "AI故事-头像分离", key: "storyAvatarMattingModel" },
    { name: "AI故事-语音设计", key: "storyVoiceDesignModel" },
    { name: "AI故事-语音克隆", key: "storyVoiceCloneModel" },
    { name: "AI故事-语音生成", key: "storyVoiceModel" },
    { name: "AI故事-语音识别", key: "storyAsrModel" },
    { name: "AI Agent-意图分析师", key: "intentClassifierModel" },
  ];
  const keys = aiModels.map((m) => m.key);
  const existItems = await knex("t_aiModelMap").whereIn("key", keys).select("key");
  const existKeys = new Set(existItems.map((i) => i.key));
  const needInsert = aiModels
    .filter((m) => !existKeys.has(m.key))
    .map((m) => ({
      configId: null,
      name: m.name,
      key: m.key,
    }));
  if (needInsert.length) {
    await knex("t_aiModelMap").insert(needInsert);
  }

  // 修复 voice_design / voice_clone 配置的 type 字段（之前错误地存为 "text"）
  if (await knex.schema.hasTable("t_config")) {
    await knex("t_config")
      .where({ type: "text" })
      .andWhere("modelType", "voice_design")
      .update({ type: "voice_design" });
    await knex("t_config")
      .where({ type: "text" })
      .andWhere("modelType", "voice_clone")
      .update({ type: "voice_clone" });
  }

  if (await knex.schema.hasTable("t_prompts")) {
    const storyPrompts = [
      {
        code: "story-main",
        name: "AI故事-总调度",
        type: "mainAgent",
        parentCode: null,
        defaultValue:
          PROMPT_STORY_MAIN,
      },
      {
        code: "story-orchestrator",
        name: "AI故事-剧情编排",
        type: "subAgent",
        parentCode: "story-main",
        defaultValue:
          PROMPT_STORY_ORCHESTRATOR,
      },
      {
        code: "story-orchestrator-compact",
        name: "AI故事-剧情编排(精简版)",
        type: "subAgent",
        parentCode: "story-main",
        defaultValue:
          PROMPT_STORY_ORCHESTRATOR_COMPACT,
      },
      {
        code: "story-orchestrator-advanced",
        name: "AI故事-剧情编排(高级版)",
        type: "subAgent",
        parentCode: "story-main",
        defaultValue:
          PROMPT_STORY_ORCHESTRATOR_ADVANCED,
      },
      {
        code: "story-speaker",
        name: "AI故事-角色发言",
        type: "subAgent",
        parentCode: "story-main",
        defaultValue:
          PROMPT_STORY_SPEAKER ,
      },
      {
        code: "story-memory",
        name: "AI故事-记忆管理",
        type: "subAgent",
        parentCode: "story-main",
        defaultValue:
            PROMPT_STORY_MEMORY  ,
      },
      {
        code: "story-chapter",
        name: "AI故事-章节判定",
        type: "subAgent",
        parentCode: "story-main",
        defaultValue:
          PROMPT_STORY_CHAPTER,
      },
      {
        code: "story-event-progress",
        name: "AI故事-事件进度检测",
        type: "subAgent",
        parentCode: "story-main",
        defaultValue:
          PROMPT_STORY_EVENT_PROGRESS,
      },
      {
        code: "story-mini-game",
        name: "AI故事-小游戏Agent",
        type: "subAgent",
        parentCode: "story-main",
        defaultValue:
          PROMPT_STORY_MINI_GAME,
      },
      {
        code: "story-mini-game-battle",
        name: "AI故事-小游戏-战斗",
        type: "subAgent",
        parentCode: "story-main",
        defaultValue:
                       PROMPT_STORY_MINI_GAME_BATTLE,
      },
      {
        code: "story-mini-game-fishing",
        name: "AI故事-小游戏-钓鱼",
        type: "subAgent",
        parentCode: "story-main",
        defaultValue:
          PROMPT_STORY_MINI_GAME_FISHING,
      },
      {
        code: "story-mini-game-werewolf",
        name: "AI故事-小游戏-狼人杀",
        type: "subAgent",
        parentCode: "story-main",
        defaultValue:
          PROMPT_STORY_MINI_GAME_WEREWOLF,
      },
      {
        code: "story-mini-game-cultivation",
        name: "AI故事-小游戏-修炼",
        type: "subAgent",
        parentCode: "story-main",
        defaultValue:
          PROMPT_STORY_MINI_GAME_CULTIVATION ,
      },
      {
        code: "story-mini-game-mining",
        name: "AI故事-小游戏-挖矿",
        type: "subAgent",
        parentCode: "story-main",
        defaultValue:
          PROMPT_STORY_MINI_GAME_MINING,
      },
      {
        code: "story-mini-game-research-skill",
        name: "AI故事-小游戏-研发技能",
        type: "subAgent",
        parentCode: "story-main",
        defaultValue:
          PROMPT_STORY_MINI_GAME_RESEARCH_SKILL,
      },
      {
        code: "story-mini-game-alchemy",
        name: "AI故事-小游戏-炼药",
        type: "subAgent",
        parentCode: "story-main",
        defaultValue:
          PROMPT_STORY_MINI_GAME_ALCHEMY,
      },
      {
        code: "story-mini-game-upgrade-equipment",
        name: "AI故事-小游戏-升级装备",
        type: "subAgent",
        parentCode: "story-main",
        defaultValue:
          PROMPT_STORY_MINI_GAME_UPGRADE_EQUIPMENT,
      },
      {
        code: "story-sell-item",
        name: "AI故事-物品出售",
        type: "subAgent",
        parentCode: "story-main",
        defaultValue:
          PROMPT_STORY_SELL_ITEM ,
      },
      {
        code: "story-safety",
        name: "AI故事-安全审查",
        type: "subAgent",
        parentCode: "story-main",
        defaultValue:
          PROMPT_STORY_SAFETY,
      },
      {
        code: "intent-analyzer",
        name: "AI Agent-意图分析师",
        type: "aiAgent",
        parentCode: null,
        defaultValue:
          PROMPT_INTENT_ANALYZER,
      },
      {
        code: "task-progress-agent",
        name: "AI Agent-任务推进判定器",
        type: "aiAgent",
        parentCode: null,
        defaultValue:
          PROMPT_TASK_PROGRESS_AGENT,
      },
      {
        code: "task-director-agent",
        name: "AI Agent-任务剧情编排师",
        type: "aiAgent",
        parentCode: null,
        defaultValue:
          PROMPT_TASK_DIRECTOR_AGENT,
      },
      {
        code: "task-speaker-agent",
        name: "AI Agent-任务角色发言器",
        type: "aiAgent",
        parentCode: null,
        defaultValue:
          PROMPT_TASK_SPEAKER_AGENT,
      },
      {
        code: "task-completion-agent",
        name: "AI Agent-任务完成评估器",
        type: "aiAgent",
        parentCode: null,
        defaultValue:
          PROMPT_TASK_COMPLETION_AGENT,
      },
      {
        code: "play-tip-agent",
        name: "AI Agent-玩家提示器",
        type: "aiAgent",
        parentCode: null,
        defaultValue:
          PROMPT_PLAY_TIP_AGENT,
      },
      {
        code: "story-update-align-agent",
        name: "AI Agent-存档智能对齐",
        type: "aiAgent",
        parentCode: null,
        defaultValue:
          PROMPT_STORY_UPDATE_ALIGN,
      },
      {
        code: "story-orchestrator-options",
        name: "AI Agent-剧情编排选项生成器",
        type: "aiAgent",
        parentCode: null,
        defaultValue:
          PROMPT_STORY_ORCHESTRATOR_OPTIONS,
      },
      {
        code: "task-director-agent-options",
        name: "AI Agent-任务编排选项生成器",
        type: "aiAgent",
        parentCode: null,
        defaultValue:
          PROMPT_TASK_DIRECTOR_AGENT_OPTIONS,
      },
    ];
    const existingRows = await knex("t_prompts").whereIn(
      "code",
      storyPrompts.map((item) => item.code),
    ).select("id", "code", "customValue");
    const existingCodeMap = new Map(existingRows.map((item: any) => [String(item.code), item]));
    const existingCodes = new Set(existingRows.map((item: any) => String(item.code)));
    let nextId = Number(((await knex("t_prompts").max({ maxId: "id" }).first()) as any)?.maxId || 0) + 1;
    const rowsToInsert = storyPrompts
      .filter((item) => !existingCodes.has(item.code))
      .map((item) => ({
        id: nextId++,
        ...item,
        customValue: null,
      }));
    if (rowsToInsert.length) {
      await knex("t_prompts").insert(rowsToInsert);
    }
    for (const item of storyPrompts) {
      const existed = existingCodeMap.get(item.code);
      if (!existed?.id) continue;
      await knex("t_prompts")
        .where("id", existed.id)
        .update({
          name: item.name,
          type: item.type,
          parentCode: item.parentCode,
          defaultValue: item.defaultValue,
        });
    }

    const legacyOrchestrator = existingCodeMap.get("story-orchestrator")
      || await knex("t_prompts").where("code", "story-orchestrator").first("id", "defaultValue", "customValue");
    if (legacyOrchestrator) {
      for (const code of ["story-orchestrator-compact", "story-orchestrator-advanced"]) {
        const existed = existingCodeMap.get(code)
          || await knex("t_prompts").where("code", code).first("id", "defaultValue", "customValue");
        if (!existed?.id) continue;
        const patch: Record<string, unknown> = {};
        if (!String(existed.defaultValue || "").trim() && String(legacyOrchestrator.defaultValue || "").trim()) {
          patch.defaultValue = legacyOrchestrator.defaultValue;
        }
        if (!String(existed.customValue || "").trim() && String(legacyOrchestrator.customValue || "").trim()) {
          patch.customValue = legacyOrchestrator.customValue;
        }
        if (Object.keys(patch).length) {
          await knex("t_prompts").where("id", existed.id).update(patch);
        }
      }
    }

    const orchestratorCodes = ["story-orchestrator", "story-orchestrator-compact", "story-orchestrator-advanced"];
    for (const code of orchestratorCodes) {
      const existed = existingCodeMap.get(code)
        || await knex("t_prompts").where("code", code).first("id", "defaultValue", "customValue");
      if (!existed?.id) continue;
      const nextDefaultValue = stripLegacyStoryMainPrefix(existed.defaultValue);
      const nextCustomValue = String(existed.customValue || "").trim()
        ? stripLegacyStoryMainPrefix(existed.customValue)
        : existed.customValue;
      const patch: Record<string, unknown> = {};
      if (String(existed.defaultValue || "") !== nextDefaultValue) {
        patch.defaultValue = nextDefaultValue;
      }
      if (String(existed.customValue || "") !== String(nextCustomValue || "")) {
        patch.customValue = nextCustomValue;
      }
      if (Object.keys(patch).length) {
        await knex("t_prompts").where("id", existed.id).update(patch);
      }
    }
  }

  await cleanupDuplicateStorySessions();
  await cleanupStoryChapterDrafts();
  await backfillStoryChapterRuntimeOutline();

  // ===== 方向2：存量回填--旧 session 关联发布版本 =====
  // 仅回填"已有 published 行"的 world 对应的旧 session（worldPublishId 为空）。
  // 不重新发布未快照的 world（避免在 fixDB 里触发 AI 角色卡生成）；
  // 那些 world 的 session 走 runtime 草稿回退路径，不崩。
  if (await knex.schema.hasTable("t_storyWorld_published")) {
    const publishedRows = await knex("t_storyWorld_published").select("worldId", "id", "version");
    const publishedByWorldId = new Map<number, { id: number; version: number }>();
    for (const row of publishedRows) {
      const wid = Number(row.worldId || 0);
      if (wid > 0) publishedByWorldId.set(wid, { id: Number(row.id || wid), version: Number(row.version || 0) });
    }
    if (publishedByWorldId.size) {
      const staleSessions = await knex("t_gameSession")
        .whereNull("worldPublishId")
        .orWhere("worldPublishId", 0)
        .select("id", "worldId");
      for (const sess of staleSessions) {
        const wid = Number(sess.worldId || 0);
        const pub = publishedByWorldId.get(wid);
        if (!pub) continue;
        await knex("t_gameSession").where({ id: Number(sess.id) }).update({
          worldPublishId: pub.id,
          worldVersion: pub.version,
        });
      }
    }
  }
};

