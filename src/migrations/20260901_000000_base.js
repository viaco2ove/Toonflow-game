/**
 * Auto-generated base migration: replaces the legacy initDB.js schema bootstrap.
 *
 * Creates all base tables (t_user, t_assets, ..., t_voiceModel). Idempotent:
 * if a table already exists (from the previous initDB bootstrap), the
 * createTable call is skipped.
 *
 * Source-of-truth: build/src/lib/initDB.js (compiled from src/lib/initDB.ts).
 * To regenerate after schema changes, rerun tmp/parse_initdb.py.
 */
'use strict';

exports.up = async function up(knex) {
    // t_user
    if (!(await knex.schema.hasTable("t_user"))) {
      await knex.schema.createTable("t_user", (table) => {
        table.integer("id").notNullable();
        table.text("name");
        table.text("password");
        table.text("avatarPath");
        table.text("avatarBgPath");
        table.primary(["id"]);
        table.unique(["id"]);
      });
    }

    // t_assets
    if (!(await knex.schema.hasTable("t_assets"))) {
      await knex.schema.createTable("t_assets", (table) => {
        table.integer("id").notNullable();
        table.text("name");
        table.text("intro");
        table.text("prompt");
        table.text("remark");
        table.text("videoPrompt");
        table.text("type");
        table.text("episode");
        table.text("duration");
        table.text("filePath");
        table.integer("projectId");
        table.integer("scriptId");
        table.integer("segmentId");
        table.integer("shotIndex");
        table.text("state");
        table.text("voiceConfig");
        table.primary(["id"]);
        table.unique(["id"]);
      });
    }

    // t_chatHistory
    if (!(await knex.schema.hasTable("t_chatHistory"))) {
      await knex.schema.createTable("t_chatHistory", (table) => {
        table.integer("id").notNullable();
        table.text("type");
        table.text("data");
        table.text("novel");
        table.integer("projectId");
        table.primary(["id"]);
        table.unique(["id"]);
      });
    }

    // t_novel
    if (!(await knex.schema.hasTable("t_novel"))) {
      await knex.schema.createTable("t_novel", (table) => {
        table.integer("id").notNullable();
        table.integer("chapterIndex");
        table.text("reel");
        table.text("chapter");
        table.text("chapterData");
        table.integer("projectId");
        table.integer("createTime");
        table.primary(["id"]);
        table.unique(["id"]);
      });
    }

    // t_outline
    if (!(await knex.schema.hasTable("t_outline"))) {
      await knex.schema.createTable("t_outline", (table) => {
        table.integer("id").notNullable();
        table.integer("episode");
        table.text("data");
        table.integer("projectId");
        table.primary(["id"]);
        table.unique(["id"]);
      });
    }

    // t_storyline
    if (!(await knex.schema.hasTable("t_storyline"))) {
      await knex.schema.createTable("t_storyline", (table) => {
        table.integer("id").notNullable();
        table.text("name");
        table.text("content");
        table.text("novelIds");
        table.integer("projectId");
        table.primary(["id"]);
        table.unique(["id"]);
      });
    }

    // t_project
    if (!(await knex.schema.hasTable("t_project"))) {
      await knex.schema.createTable("t_project", (table) => {
        table.integer("id");
        table.text("name");
        table.text("intro");
        table.text("type");
        table.text("artStyle");
        table.text("videoRatio");
        table.integer("createTime");
        table.integer("userId");
        table.primary(["id"]);
      });
    }

    // t_script
    if (!(await knex.schema.hasTable("t_script"))) {
      await knex.schema.createTable("t_script", (table) => {
        table.integer("id").notNullable();
        table.text("name");
        table.text("content");
        table.integer("projectId");
        table.integer("outlineId");
        table.primary(["id"]);
        table.unique(["id"]);
      });
    }

    // t_scriptSegment
    if (!(await knex.schema.hasTable("t_scriptSegment"))) {
      await knex.schema.createTable("t_scriptSegment", (table) => {
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
    }

    // t_setting
    if (!(await knex.schema.hasTable("t_setting"))) {
      await knex.schema.createTable("t_setting", (table) => {
        table.integer("id").notNullable();
        table.integer("userId");
        table.text("tokenKey");
        table.text("imageModel");
        table.text("languageModel");
        table.integer("projectId");
        table.primary(["id"]);
        table.unique(["id"]);
      });
    }

    // t_video
    if (!(await knex.schema.hasTable("t_video"))) {
      await knex.schema.createTable("t_video", (table) => {
        table.integer("id").notNullable();
        table.text("resolution");
        table.text("prompt");
        table.text("filePath");
        table.text("firstFrame");
        table.text("storyboardImgs");
        table.text("model");
        table.text("errorReason");
        table.text("providerTaskId");
        table.text("providerQueryUrl");
        table.text("providerManufacturer");
        table.integer("time");
        table.integer("state");
        table.integer("scriptId");
        table.integer("configId");
        table.integer("aiConfigId");
        table.primary(["id"]);
        table.unique(["id"]);
      });
    }

    // t_taskList
    if (!(await knex.schema.hasTable("t_taskList"))) {
      await knex.schema.createTable("t_taskList", (table) => {
        table.integer("id").notNullable();
        table.integer("projectName");
        table.text("name");
        table.text("prompt");
        table.text("state");
        table.text("startTime");
        table.text("endTime");
        table.primary(["id"]);
        table.unique(["id"]);
      });
    }

    // t_roleAvatarTask
    if (!(await knex.schema.hasTable("t_roleAvatarTask"))) {
      await knex.schema.createTable("t_roleAvatarTask", (table) => {
        table.increments("id");
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
        table.integer("createTime");
        table.integer("updateTime");
      });
    }

    // t_image
    if (!(await knex.schema.hasTable("t_image"))) {
      await knex.schema.createTable("t_image", (table) => {
        table.integer("id").notNullable();
        table.text("filePath");
        table.text("type");
        table.integer("assetsId");
        table.integer("scriptId");
        table.integer("projectId");
        table.integer("videoId");
        table.text("state");
        table.primary(["id"]);
        table.unique(["id"]);
      });
    }

    // t_config
    if (!(await knex.schema.hasTable("t_config"))) {
      await knex.schema.createTable("t_config", (table) => {
        table.integer("id").notNullable();
        table.text("type");
        table.text("model");
        table.text("modelType");
        table.text("apiKey");
        table.text("baseUrl");
        table.text("manufacturer");
        table.integer("createTime");
        table.integer("index");
        table.integer("userId");
        table.primary(["id"]);
        table.unique(["id"]);
      });
    }

    // t_videoConfig
    if (!(await knex.schema.hasTable("t_videoConfig"))) {
      await knex.schema.createTable("t_videoConfig", (table) => {
        table.integer("id").notNullable();
        table.integer("scriptId");
        table.integer("projectId");
        table.integer("aiConfigId");
        table.integer("audioEnabled");
        table.text("manufacturer");
        table.text("mode");
        table.text("startFrame");
        table.text("endFrame");
        table.text("images");
        table.text("resolution");
        table.integer("duration");
        table.text("prompt");
        table.integer("selectedResultId");
        table.integer("voiceConfigId");
        table.integer("audioTrack");
        table.integer("dialogueTrack");
        table.text("voicePresetId");
        table.text("dialogue");
        table.text("audioPath");
        table.text("ttsAudioPath");
        table.integer("sort");
        table.integer("createTime");
        table.integer("updateTime");
        table.primary(["id"]);
        table.unique(["id"]);
      });
    }

    // t_aiModelMap
    if (!(await knex.schema.hasTable("t_aiModelMap"))) {
      await knex.schema.createTable("t_aiModelMap", (table) => {
        table.integer("id").notNullable();
        table.integer("configId");
        table.text("name");
        table.text("key");
        table.primary(["id"]);
        table.unique(["id"]);
      });
    }

    // t_prompts
    if (!(await knex.schema.hasTable("t_prompts"))) {
      await knex.schema.createTable("t_prompts", (table) => {
        table.integer("id").notNullable();
        table.text("code");
        table.text("name");
        table.text("type");
        table.text("parentCode");
        table.text("defaultValue");
        table.text("customValue");
        table.primary(["id"]);
        table.unique(["id"]);
        table.unique(["code"]);
      });
    }

    // t_aiModelMap
    if (!(await knex.schema.hasTable("t_aiModelMap"))) {
      await knex.schema.createTable("t_aiModelMap", (table) => {
        table.integer("id").notNullable();
        table.integer("configId");
        table.text("name");
        table.text("key");
        table.primary(["id"]);
      });
    }

    // t_textModel
    if (!(await knex.schema.hasTable("t_textModel"))) {
      await knex.schema.createTable("t_textModel", (table) => {
        table.integer("id").notNullable();
        table.text("manufacturer");
        table.text("model");
        table.text("responseFormat");
        table.integer("image");
        table.integer("think");
        table.integer("tool");
        table.primary(["id"]);
      });
    }

    // t_imageModel
    if (!(await knex.schema.hasTable("t_imageModel"))) {
      await knex.schema.createTable("t_imageModel", (table) => {
        table.integer("id").notNullable();
        table.text("manufacturer");
        table.text("model");
        table.integer("grid");
        table.text("type");
        table.primary(["id"]);
      });
    }

    // t_videoModel
    if (!(await knex.schema.hasTable("t_videoModel"))) {
      await knex.schema.createTable("t_videoModel", (table) => {
        table.integer("id").notNullable();
        table.text("manufacturer");
        table.text("model");
        table.text("durationResolutionMap");
        table.text("aspectRatio");
        table.integer("audio");
        table.text("type");
        table.primary(["id"]);
      });
    }

    // t_storyWorld
    if (!(await knex.schema.hasTable("t_storyWorld"))) {
      await knex.schema.createTable("t_storyWorld", (table) => {
        table.integer("id").notNullable();
        table.integer("projectId");
        table.text("name");
        table.text("intro");
        table.text("coverPath");
        table.text("publishStatus");
        table.text("settings");
        table.text("playerRole");
        table.text("narratorRole");
        table.integer("createTime");
        table.integer("updateTime");
        table.primary(["id"]);
        table.unique(["id"]);
      });
    }

    // t_storyChapter
    if (!(await knex.schema.hasTable("t_storyChapter"))) {
      await knex.schema.createTable("t_storyChapter", (table) => {
        table.integer("id").notNullable();
        table.integer("worldId");
        table.text("chapterKey");
        table.text("backgroundPath");
        table.text("openingRole");
        table.text("openingText");
        table.text("bgmPath");
        table.integer("showCompletionCondition");
        table.text("title");
        table.text("content");
        table.text("entryCondition");
        table.text("completionCondition");
        table.text("runtimeOutline");
        table.integer("sort");
        table.text("status");
        table.integer("createTime");
        table.integer("updateTime");
        table.primary(["id"]);
        table.unique(["id"]);
      });
    }

    // t_chapterTask
    if (!(await knex.schema.hasTable("t_chapterTask"))) {
      await knex.schema.createTable("t_chapterTask", (table) => {
        table.integer("id").notNullable();
        table.integer("chapterId");
        table.integer("parentTaskId");
        table.text("title");
        table.text("taskType");
        table.text("goalType");
        table.text("successCondition");
        table.text("failCondition");
        table.text("rewardAction");
        table.integer("sort");
        table.text("status");
        table.integer("createTime");
        table.integer("updateTime");
        table.primary(["id"]);
        table.unique(["id"]);
      });
    }

    // t_chapterTrigger
    if (!(await knex.schema.hasTable("t_chapterTrigger"))) {
      await knex.schema.createTable("t_chapterTrigger", (table) => {
        table.integer("id").notNullable();
        table.integer("chapterId");
        table.text("name");
        table.text("triggerEvent");
        table.text("conditionExpr");
        table.text("actionExpr");
        table.integer("enabled");
        table.integer("sort");
        table.integer("createTime");
        table.integer("updateTime");
        table.primary(["id"]);
        table.unique(["id"]);
      });
    }

    // t_gameSession
    if (!(await knex.schema.hasTable("t_gameSession"))) {
      await knex.schema.createTable("t_gameSession", (table) => {
        table.integer("id").notNullable();
        table.text("sessionId");
        table.integer("worldId");
        table.integer("projectId");
        table.integer("chapterId");
        table.text("contentVersion");
        table.text("title");
        table.text("status");
        table.text("stateJson");
        table.integer("userId");
        table.integer("createTime");
        table.integer("updateTime");
        table.primary(["id"]);
        table.unique(["id"]);
        table.unique(["sessionId"]);
      });
    }

    // t_sessionMessage
    if (!(await knex.schema.hasTable("t_sessionMessage"))) {
      await knex.schema.createTable("t_sessionMessage", (table) => {
        table.integer("id").notNullable();
        table.text("sessionId");
        table.text("role");
        table.text("roleType");
        table.text("content");
        table.text("eventType");
        table.text("meta");
        table.integer("createTime");
        table.primary(["id"]);
        table.unique(["id"]);
      });
    }

    // t_sessionStateSnapshot
    if (!(await knex.schema.hasTable("t_sessionStateSnapshot"))) {
      await knex.schema.createTable("t_sessionStateSnapshot", (table) => {
        table.integer("id").notNullable();
        table.text("sessionId");
        table.text("stateJson");
        table.text("reason");
        table.integer("round");
        table.integer("createTime");
        table.primary(["id"]);
        table.unique(["id"]);
      });
    }

    // t_entityStateDelta
    if (!(await knex.schema.hasTable("t_entityStateDelta"))) {
      await knex.schema.createTable("t_entityStateDelta", (table) => {
        table.integer("id").notNullable();
        table.text("sessionId");
        table.text("eventId");
        table.text("entityType");
        table.text("entityId");
        table.text("field");
        table.text("oldValue");
        table.text("newValue");
        table.text("source");
        table.integer("createTime");
        table.primary(["id"]);
        table.unique(["id"]);
      });
    }

    // t_voiceModel
    if (!(await knex.schema.hasTable("t_voiceModel"))) {
      await knex.schema.createTable("t_voiceModel", (table) => {
        table.integer("id").notNullable();
        table.text("manufacturer");
        table.text("model");
        table.text("mode");
        table.primary(["id"]);
        table.unique(["id"]);
      });
    }
};

exports.down = async function down(knex) {
  // Drop tables in reverse dependency order.
  const tableNames = [
    "t_voiceModel",
    "t_entityStateDelta",
    "t_sessionStateSnapshot",
    "t_sessionMessage",
    "t_gameSession",
    "t_chapterTrigger",
    "t_chapterTask",
    "t_storyChapter",
    "t_storyWorld",
    "t_videoModel",
    "t_imageModel",
    "t_textModel",
    "t_aiModelMap",
    "t_prompts",
    "t_aiModelMap",
    "t_videoConfig",
    "t_config",
    "t_image",
    "t_roleAvatarTask",
    "t_taskList",
    "t_video",
    "t_setting",
    "t_scriptSegment",
    "t_script",
    "t_project",
    "t_storyline",
    "t_outline",
    "t_novel",
    "t_chatHistory",
    "t_assets",
    "t_user"  ];
  for (const name of tableNames) {
    if (await knex.schema.hasTable(name)) {
      await knex.schema.dropTable(name);
    }
  }
};
