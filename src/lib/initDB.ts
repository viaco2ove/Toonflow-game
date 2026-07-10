/**
 * initDB 是「搭毛坯房」：从零开始建出完整结构，放好基础家具；
 */
import { Knex } from "knex";
import { v4 as uuid } from "uuid";
interface TableSchema {
  name: string;
  builder: (table: Knex.CreateTableBuilder) => void;
  initData?: (knex: Knex) => Promise<void>;
}

import {
  PROMPT_OUTLINESCRIPT_MAIN,
  PROMPT_OUTLINESCRIPT_A1,
  PROMPT_OUTLINESCRIPT_A2,
  PROMPT_OUTLINESCRIPT_DIRECTOR,
  PROMPT_STORYBOARD_MAIN,
  PROMPT_STORYBOARD_SEGMENT,
  PROMPT_STORYBOARD_SHOT,
  PROMPT_GENERATEIMAGEPROMPTS,
  PROMPT_ROLE_POLISH,
  PROMPT_ROLE_GENERATEIMAGE,
  PROMPT_SCENE_POLISH,
  PROMPT_SCENE_GENERATEIMAGE,
  PROMPT_STORYBOARD_POLISH,
  PROMPT_STORYBOARD_GENERATEIMAGE,
  PROMPT_TOOL_POLISH,
  PROMPT_TOOL_GENERATEIMAGE,
  PROMPT_SCRIPT,
  PROMPT_VIDEO_STARTEND,
  PROMPT_VIDEO_MULTI,
  PROMPT_VIDEO_SINGLE,
  PROMPT_VIDEO_MAIN,
  PROMPT_VIDEO_TEXT,
  PROMPT_STORY_MAIN,
  PROMPT_STORY_ORCHESTRATOR,
  PROMPT_STORY_ORCHESTRATOR_COMPACT,
  PROMPT_STORY_ORCHESTRATOR_ADVANCED,
  PROMPT_STORY_SPEAKER,
  PROMPT_STORY_MEMORY,
  PROMPT_STORY_CHAPTER,
  PROMPT_STORY_EVENT_PROGRESS,
  PROMPT_STORY_MINI_GAME,
  PROMPT_STORY_MINI_GAME_BATTLE,
  PROMPT_STORY_MINI_GAME_FISHING,
  PROMPT_STORY_MINI_GAME_WEREWOLF,
  PROMPT_STORY_MINI_GAME_CULTIVATION,
  PROMPT_STORY_MINI_GAME_MINING,
  PROMPT_STORY_MINI_GAME_RESEARCH_SKILL,
  PROMPT_STORY_MINI_GAME_ALCHEMY,
  PROMPT_STORY_MINI_GAME_UPGRADE_EQUIPMENT,
  PROMPT_STORY_SAFETY
} from "./initDB.prompts";
export default async (knex: Knex, forceInit: boolean = false): Promise<void> => {
  const tables: TableSchema[] = [
    {
      name: "t_user",
      builder: (table) => {
        table.integer("id").notNullable();
        table.text("name");
        table.text("password");
        table.text("avatarPath");
        table.text("avatarBgPath");
        table.primary(["id"]);
        table.unique(["id"]);
      },
      initData: async (knex) => {
        await knex("t_user").insert([{ id: 1, name: "admin", password: "admin123" }]);
      },
    },
    {
      name: "t_assets",
      builder: (table) => {
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
      },
    },
    {
      name: "t_chatHistory",
      builder: (table) => {
        table.integer("id").notNullable();
        table.text("type");
        table.text("data");
        table.text("novel");
        table.integer("projectId");
        table.primary(["id"]);
        table.unique(["id"]);
      },
    },
    {
      name: "t_aiTokenUsageLog",
      builder: (table) => {
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
      },
    },
    {
      name: "t_novel",
      builder: (table) => {
        table.integer("id").notNullable();
        table.integer("chapterIndex");
        table.text("reel");
        table.text("chapter");
        table.text("chapterData");
        table.integer("projectId");
        table.integer("createTime");
        table.primary(["id"]);
        table.unique(["id"]);
      },
    },
    {
      name: "t_outline",
      builder: (table) => {
        table.integer("id").notNullable();
        table.integer("episode");
        table.text("data");
        table.integer("projectId");
        table.primary(["id"]);
        table.unique(["id"]);
      },
    },
    {
      name: "t_storyline",
      builder: (table) => {
        table.integer("id").notNullable();
        table.text("name");
        table.text("content");
        table.text("novelIds");
        table.integer("projectId");
        table.primary(["id"]);
        table.unique(["id"]);
      },
    },
    {
      name: "t_project",
      builder: (table) => {
        table.integer("id");
        table.text("name");
        table.text("intro");
        table.text("type");
        table.text("artStyle");
        table.text("videoRatio");
        table.integer("createTime");
        table.integer("userId");
        table.primary(["id"]);
      },
    },
    {
      name: "t_script",
      builder: (table) => {
        table.integer("id").notNullable();
        table.text("name");
        table.text("content");
        table.integer("projectId");
        table.integer("outlineId");
        table.primary(["id"]);
        table.unique(["id"]);
      },
    },
    {
      name: "t_scriptSegment",
      builder: (table) => {
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
      },
    },
    {
      name: "t_setting",
      builder: (table) => {
        table.integer("id").notNullable();
        table.integer("userId");
        table.text("tokenKey");
        table.text("imageModel");
        table.text("languageModel");
        table.integer("projectId");
        table.primary(["id"]);
        table.unique(["id"]);
      },
      initData: async (knex) => {
        await knex("t_setting").insert({
          id: 1,
          userId: 1,
          tokenKey: uuid().slice(0, 8),
          imageModel: "{}",
          languageModel: "{}",
          projectId: null,
        });
      },
    },
    {
      name: "t_video",
      builder: (table) => {
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
        table.integer("configId"); // 关联的视频配置ID
        table.integer("aiConfigId");
        table.primary(["id"]);
        table.unique(["id"]);
      },
    },
    {
      name: "t_taskList",
      builder: (table) => {
        table.integer("id").notNullable();
        table.integer("projectName");
        table.text("name");
        table.text("prompt");
        table.text("state");
        table.text("startTime");
        table.text("endTime");
        table.primary(["id"]);
        table.unique(["id"]);
      },
    },
    {
      name: "t_roleAvatarTask",
      builder: (table) => {
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
      },
    },
    {
      name: "t_image",
      builder: (table) => {
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
      },
    },
    {
      name: "t_config",
      builder: (table) => {
        table.integer("id").notNullable();
        table.text("type");
        table.text("model");
        table.text("modelType");
        table.text("apiKey");
        table.text("baseUrl");
        table.text("manufacturer");
        table.float("inputPricePer1M");
        table.float("outputPricePer1M");
        table.float("cacheReadPricePer1M");
        table.text("currency");
        table.text("reasoningEffort");
        table.integer("createTime");
        table.integer("index");
        table.integer("userId");
        table.primary(["id"]);
        table.unique(["id"]);
      },
      initData: async (knex) => {},
    },
    {
      name: "t_videoConfig",
      builder: (table) => {
        table.integer("id").notNullable();
        table.integer("scriptId"); // 关联的脚本ID
        table.integer("projectId"); // 关联的项目ID
        table.integer("aiConfigId"); //ai配置ID
        table.integer("audioEnabled"); //声音
        table.text("manufacturer"); // 厂商：volcengine/runninghub/openAi
        table.text("mode"); // 模式：startEnd/multi/single
        table.text("startFrame"); // 首帧图片信息 JSON
        table.text("endFrame"); // 尾帧图片信息 JSON
        table.text("images"); // 多图模式的图片列表 JSON
        table.text("resolution"); // 分辨率
        table.integer("duration"); // 时长
        table.text("prompt"); // 提示词
        table.integer("selectedResultId"); // 选中的生成结果ID
        table.integer("voiceConfigId"); // 语音配置ID
        table.integer("audioTrack"); // 音频轨道索引
        table.integer("dialogueTrack"); // 台词轨道索引
        table.text("voicePresetId"); // 语音预设ID
        table.text("dialogue"); // 台词文本
        table.text("audioPath"); // 音频轨道文件
        table.text("ttsAudioPath"); // 台词生成音频
        table.integer("sort"); // 时间轴排序
        table.integer("createTime"); // 创建时间
        table.integer("updateTime"); // 更新时间
        table.primary(["id"]);
        table.unique(["id"]);
      },
    },
    {
      name: "t_aiModelMap",
      builder: (table) => {
        table.integer("id").notNullable();
        table.integer("configId"); // 模型列表id
        table.text("name");
        table.text("key");
        table.primary(["id"]);
        table.unique(["id"]);
      },
      initData: async (knex) => {
        await knex("t_aiModelMap").insert([
          {
            id: 1,
            configId: null,
            name: "分镜Agent",
            key: "storyboardAgent",
          },
          {
            id: 2,
            configId: null,
            name: "分镜Agent图片生成",
            key: "storyboardImage",
          },
          {
            id: 3,
            configId: null,
            name: "大纲故事线Agent",
            key: "outlineScriptAgent",
          },
          {
            id: 4,
            configId: null,
            name: "资产提示词润色",
            key: "assetsPrompt",
          },
          {
            id: 5,
            configId: null,
            name: "资产图片生成",
            key: "assetsImage",
          },
          {
            id: 6,
            configId: null,
            name: "剧本生成",
            key: "generateScript",
          },
          {
            id: 7,
            configId: null,
            name: "视频提示词生成",
            key: "videoPrompt",
          },
          {
            id: 8,
            configId: null,
            name: "图片编辑",
            key: "editImage",
          },
        ]);
      },
    },
    {
      name: "t_prompts",
      builder: (table) => {
        table.integer("id").notNullable();
        table.text("code"); // 代号，唯一标识
        table.text("name"); // 名称/描述
        table.text("type"); // 类型：mainAgent/subAgent/system
        table.text("parentCode"); // 父级代号（subAgent关联主agent）
        table.text("defaultValue"); // 默认提示词
        table.text("customValue"); // 自定义修改值
        table.primary(["id"]);
        table.unique(["id"]);
        table.unique(["code"]); // 代号唯一
      },
      initData: async (knex) => {
        await knex("t_prompts").insert([
          {
            id: 1,
            code: "outlineScript-main",
            name: "大纲故事线Agent",
            type: "mainAgent",
            parentCode: null,
            defaultValue:
              PROMPT_OUTLINESCRIPT_MAIN,
            customValue: null,
          },
          {
            id: 2,
            code: "outlineScript-a1",
            name: "大纲故事线Agent-故事师",
            type: "subAgent",
            parentCode: "outlineScript-main",
            defaultValue:
              PROMPT_OUTLINESCRIPT_A1,
            customValue: null,
          },
          {
            id: 3,
            code: "outlineScript-a2",
            name: "大纲故事线Agent-大纲师",
            type: "subAgent",
            parentCode: "outlineScript-main",
            defaultValue:
              PROMPT_OUTLINESCRIPT_A2,
            customValue: null,
          },
          {
            id: 4,
            code: "outlineScript-director",
            name: "大纲故事线Agent-导演",
            type: "subAgent",
            parentCode: "outlineScript-main",
            defaultValue:
              PROMPT_OUTLINESCRIPT_DIRECTOR,
            customValue: null,
          },
          {
            id: 5,
            code: "storyboard-main",
            name: "分镜Agent",
            type: "mainAgent",
            parentCode: null,
            defaultValue:
              PROMPT_STORYBOARD_MAIN,
            customValue: null,
          },
          {
            id: 6,
            code: "storyboard-segment",
            name: "分镜Agent-片段分析师",
            type: "subAgent",
            parentCode: "storyboard-main",
            defaultValue:
              PROMPT_STORYBOARD_SEGMENT,
            customValue: null,
          },
          {
            id: 7,
            code: "storyboard-shot",
            name: "分镜Agent-分镜师",
            type: "subAgent",
            parentCode: "storyboard-main",
            defaultValue:
              PROMPT_STORYBOARD_SHOT,

            customValue: null,
          },
          {
            id: 8,
            code: "generateImagePrompts",
            name: "分镜Agent生图润色提示词",
            type: "system",
            parentCode: null,
            defaultValue:
              PROMPT_GENERATEIMAGEPROMPTS,
            customValue: null,
          },
          {
            id: 9,
            code: "role-polish",
            name: "资产-角色提示词润色",
            type: "system",
            parentCode: null,
            defaultValue:
              PROMPT_ROLE_POLISH,
            customValue: null,
          },
          {
            id: 10,
            code: "role-generateImage",
            name: "资产-角色图片生成",
            type: "system",
            parentCode: null,
            defaultValue:
              PROMPT_ROLE_GENERATEIMAGE,
            customValue: null,
          },
          {
            id: 11,
            code: "scene-polish",
            name: "资产-场景提示词润色",
            type: "system",
            parentCode: null,
            defaultValue:
              PROMPT_SCENE_POLISH,
            customValue: null,
          },
          {
            id: 12,
            code: "scene-generateImage",
            name: "资产-场景图片生成",
            type: "system",
            parentCode: null,
            defaultValue:
              PROMPT_SCENE_GENERATEIMAGE,
            customValue: null,
          },
          {
            id: 13,
            code: "storyboard-polish",
            name: "资产-分镜提示词润色",
            type: "system",
            parentCode: null,
            defaultValue:
              PROMPT_STORYBOARD_POLISH,
            customValue: null,
          },
          {
            id: 14,
            code: "storyboard-generateImage",
            name: "资产-分镜图片生成",
            type: "system",
            parentCode: null,
            defaultValue:
              PROMPT_STORYBOARD_GENERATEIMAGE,
            customValue: null,
          },
          {
            id: 15,
            code: "tool-polish",
            name: "资产-道具提示词润色",
            type: "system",
            parentCode: null,
            defaultValue:
              PROMPT_TOOL_POLISH,
            customValue: null,
          },
          {
            id: 16,
            code: "tool-generateImage",
            name: "资产-道具图片生成",
            type: "system",
            parentCode: null,
            defaultValue:
              PROMPT_TOOL_GENERATEIMAGE,
            customValue: null,
          },
          {
            id: 17,
            code: "script",
            name: "剧本生成",
            type: "system",
            parentCode: null,
            defaultValue:
              PROMPT_SCRIPT,
            customValue: null,
          },
          {
            id: 18,
            code: "video-startEnd",
            name: "视频提示词-首尾帧",
            type: "system",
            parentCode: null,
            defaultValue:
              PROMPT_VIDEO_STARTEND,
            customValue: null,
          },
          {
            id: 19,
            code: "video-multi",
            name: "视频提示词-多图模式",
            type: "system",
            parentCode: null,
            defaultValue:
              PROMPT_VIDEO_MULTI,
            customValue: null,
          },
          {
            id: 20,
            code: "video-single",
            name: "视频提示词-单图模式",
            type: "system",
            parentCode: null,
            defaultValue:
              PROMPT_VIDEO_SINGLE,
            customValue: null,
          },
          {
            id: 21,
            code: "video-main",
            name: "视频提示词-总规则",
            type: "system",
            parentCode: null,
            defaultValue:
              PROMPT_VIDEO_MAIN,
            customValue: null,
          },
          {
            id: 22,
            code: "video-text",
            name: "视频提示词-文本模式",
            type: "system",
            parentCode: null,
            defaultValue:
              PROMPT_VIDEO_TEXT,
            customValue: null,
          },
          {
            id: 23,
            code: "story-main",
            name: "AI故事-总调度",
            type: "mainAgent",
            parentCode: null,
            defaultValue:
              PROMPT_STORY_MAIN,
            customValue: null,
          },
          {
            id: 24,
            code: "story-orchestrator",
            name: "AI故事-剧情编排",
            type: "subAgent",
            parentCode: "story-main",
            defaultValue:
              PROMPT_STORY_ORCHESTRATOR,
            customValue: null,
          },
          {
            id: 30,
            code: "story-orchestrator-compact",
            name: "AI故事-剧情编排(精简版)",
            type: "subAgent",
            parentCode: "story-main",
            defaultValue:
              PROMPT_STORY_ORCHESTRATOR_COMPACT,
            customValue: null,
          },
          {
            id: 31,
            code: "story-orchestrator-advanced",
            name: "AI故事-剧情编排(高级版)",
            type: "subAgent",
            parentCode: "story-main",
            defaultValue:
              PROMPT_STORY_ORCHESTRATOR_ADVANCED,
            customValue: null,
          },
          {
            id: 25,
            code: "story-speaker",
            name: "AI故事-角色发言",
            type: "subAgent",
            parentCode: "story-main",
          defaultValue:
              PROMPT_STORY_SPEAKER,
            customValue: null,
          },
          {
            id: 26,
            code: "story-memory",
            name: "AI故事-记忆管理",
            type: "subAgent",
            parentCode: "story-main",
            defaultValue:
              PROMPT_STORY_MEMORY,
            customValue: null,
          },
          {
            id: 27,
            code: "story-chapter",
            name: "AI故事-章节判定",
            type: "subAgent",
            parentCode: "story-main",
            defaultValue:
              PROMPT_STORY_CHAPTER,
            customValue: null,
          },
          {
            id: 32,
            code: "story-event-progress",
            name: "AI故事-事件进度检测",
            type: "subAgent",
            parentCode: "story-main",
            defaultValue:
              PROMPT_STORY_EVENT_PROGRESS,
            customValue: null,
          },
          {
            id: 28,
            code: "story-mini-game",
            name: "AI故事-小游戏Agent",
            type: "subAgent",
            parentCode: "story-main",
            defaultValue:
              PROMPT_STORY_MINI_GAME,
            customValue: null,
          },
          {
            id: 33,
            code: "story-mini-game-battle",
            name: "AI故事-小游戏-战斗",
            type: "subAgent",
            parentCode: "story-main",
            defaultValue:
              PROMPT_STORY_MINI_GAME_BATTLE,
            customValue: null,
          },
          {
            id: 34,
            code: "story-mini-game-fishing",
            name: "AI故事-小游戏-钓鱼",
            type: "subAgent",
            parentCode: "story-main",
            defaultValue:
              PROMPT_STORY_MINI_GAME_FISHING,
            customValue: null,
          },
          {
            id: 35,
            code: "story-mini-game-werewolf",
            name: "AI故事-小游戏-狼人杀",
            type: "subAgent",
            parentCode: "story-main",
            defaultValue:
              PROMPT_STORY_MINI_GAME_WEREWOLF,
            customValue: null,
          },
          {
            id: 36,
            code: "story-mini-game-cultivation",
            name: "AI故事-小游戏-修炼",
            type: "subAgent",
            parentCode: "story-main",
            defaultValue:
              PROMPT_STORY_MINI_GAME_CULTIVATION,
            customValue: null,
          },
          {
            id: 37,
            code: "story-mini-game-mining",
            name: "AI故事-小游戏-挖矿",
            type: "subAgent",
            parentCode: "story-main",
            defaultValue:
              PROMPT_STORY_MINI_GAME_MINING,
            customValue: null,
          },
          {
            id: 38,
            code: "story-mini-game-research-skill",
            name: "AI故事-小游戏-研发技能",
            type: "subAgent",
            parentCode: "story-main",
            defaultValue:
              PROMPT_STORY_MINI_GAME_RESEARCH_SKILL,
            customValue: null,
          },
          {
            id: 39,
            code: "story-mini-game-alchemy",
            name: "AI故事-小游戏-炼药",
            type: "subAgent",
            parentCode: "story-main",
            defaultValue:
              PROMPT_STORY_MINI_GAME_ALCHEMY,
            customValue: null,
          },
          {
            id: 40,
            code: "story-mini-game-upgrade-equipment",
            name: "AI故事-小游戏-升级装备",
            type: "subAgent",
            parentCode: "story-main",
            defaultValue:
              PROMPT_STORY_MINI_GAME_UPGRADE_EQUIPMENT,
            customValue: null,
          },
          {
            id: 29,
            code: "story-safety",
            name: "AI故事-安全审查",
            type: "subAgent",
            parentCode: "story-main",
            defaultValue:
              PROMPT_STORY_SAFETY,
            customValue: null,
          },
        ]);
      },
    },
    {
      name: "t_aiModelMap",
      builder: (table) => {
        table.integer("id").notNullable();
        table.integer("configId");
        table.text("name");
        table.text("key");
        table.primary(["id"]);
      },
      initData: async (knex) => {
        await knex("t_aiModelMap").insert([
          { id: 1, configId: 3, name: "分镜Agent", key: "storyboardAgent" },
          { id: 2, configId: 2, name: "大纲故事线Agent", key: "outlineScriptAgent" },
          { id: 3, configId: 4, name: "资产提示词润色", key: "assetsPrompt" },
          { id: 4, configId: 5, name: "资产图片生成", key: "assetsImage" },
          { id: 5, configId: 3, name: "剧本生成", key: "generateScript" },
          { id: 6, configId: 2, name: "视频提示词生成", key: "videoPrompt" },
          { id: 7, configId: 5, name: "分镜图片生成", key: "storyboardImage" },
          { id: 8, configId: 5, name: "图片编辑", key: "editImage" },
          { id: 9, configId: null, name: "AI故事-编排师", key: "storyOrchestratorModel" },
          { id: 18, configId: null, name: "AI故事-章节判定", key: "storyChapterJudgeModel" },
          { id: 17, configId: null, name: "AI故事-快速角色发言", key: "storyFastSpeakerModel" },
          { id: 10, configId: null, name: "AI故事-角色发言", key: "storySpeakerModel" },
          { id: 11, configId: null, name: "AI故事-记忆管理", key: "storyMemoryModel" },
          { id: 12, configId: null, name: "AI故事-AI生图", key: "storyImageModel" },
          { id: 13, configId: null, name: "AI故事-头像分离", key: "storyAvatarMattingModel" },
          { id: 14, configId: null, name: "AI故事-语音生成", key: "storyVoiceModel" },
          { id: 15, configId: null, name: "AI故事-语音识别", key: "storyAsrModel" },
          { id: 16, configId: null, name: "AI故事-语音设计", key: "storyVoiceDesignModel" },
          { id: 21, configId: null, name: "AI故事-语音克隆", key: "storyVoiceCloneModel" },
          { id: 19, configId: null, name: "AI故事-事件进度检测", key: "storyEventProgressModel" },
          { id: 20, configId: null, name: "AI故事-小游戏动作解析", key: "storyMiniGameModel" },
        ]);
      },
    },

    {
      name: "t_textModel",
      builder: (table) => {
        table.integer("id").notNullable();
        table.text("manufacturer");
        table.text("model");
        table.text("responseFormat");
        table.integer("image");
        table.integer("think");
        table.integer("tool");
        table.primary(["id"]);
      },
      initData: async (knex) => {
        await knex("t_textModel").insert([
          { manufacturer: "deepSeek", model: "deepseek-chat", responseFormat: "schema", image: 0, think: 0, tool: 1 },
          { manufacturer: "deepSeek", model: "deepseek-reasoner", responseFormat: "schema", image: 0, think: 1, tool: 1 },
            { manufacturer: "deepSeek", model: "deepseek-v4-flash", responseFormat: "schema", image: 0, think: 1, tool: 1 },
            { manufacturer: "deepSeek", model: "deepseek-v4-pro", responseFormat: "schema", image: 1, think: 1, tool: 1 },
          { manufacturer: "lmstudio", model: "qwen3.5-9b", responseFormat: "schema", image: 0, think: 0, tool: 1 },
          { manufacturer: "autodl_chat", model: "DeepSeek-R1-0528", responseFormat: "object", image: 0, think: 1, tool: 1 },
          { manufacturer: "autodl_chat", model: "GLM-5", responseFormat: "object", image: 0, think: 1, tool: 1 },
          { manufacturer: "autodl_chat", model: "DeepSeek-V3.2", responseFormat: "object", image: 0, think: 1, tool: 1 },
          { manufacturer: "autodl_chat", model: "MiniMax-M2.7", responseFormat: "object", image: 0, think: 1, tool: 1 },
          { manufacturer: "autodl_chat", model: "MiniMax-M2.5", responseFormat: "object", image: 0, think: 1, tool: 1 },
          { manufacturer: "autodl_chat", model: "Qwen3.5-397B-A17B", responseFormat: "object", image: 0, think: 1, tool: 1 },
          { manufacturer: "autodl_chat", model: "Kimi-K2.5", responseFormat: "object", image: 0, think: 1, tool: 1 },
          { manufacturer: "autodl_chat", model: "gpt-5.4", responseFormat: "object", image: 0, think: 1, tool: 1 },
          { manufacturer: "volcengine", model: "doubao-seed-2-0-pro-260215", responseFormat: "object", image: 1, think: 1, tool: 1 },
          { manufacturer: "volcengine", model: "doubao-seed-2-0-lite-260215", responseFormat: "object", image: 1, think: 1, tool: 1 },
          { manufacturer: "volcengine", model: "doubao-seed-2-0-mini-260215", responseFormat: "object", image: 1, think: 1, tool: 1 },
          { manufacturer: "volcengine", model: "doubao-seed-1-8-251228", responseFormat: "object", image: 1, think: 1, tool: 1 },
          { manufacturer: "volcengine", model: "doubao-seed-1-6-251015", responseFormat: "object", image: 1, think: 1, tool: 1 },
          { manufacturer: "volcengine", model: "doubao-seed-1-6-lite-251015", responseFormat: "object", image: 1, think: 1, tool: 1 },
          { manufacturer: "volcengine", model: "doubao-seed-1-6-flash-250828", responseFormat: "object", image: 1, think: 1, tool: 1 },
          { manufacturer: "zhipu", model: "glm-4.7", responseFormat: "object", image: 0, think: 0, tool: 1 },
          // { manufacturer: "zhipu", model: "glm-4.7-flashx", responseFormat: "object", image: 0, think: 0, tool: 1 },
          { manufacturer: "zhipu", model: "glm-4.6", responseFormat: "object", image: 0, think: 0, tool: 1 },
          // { manufacturer: "zhipu", model: "glm-4.5-air", responseFormat: "object", image: 0, think: 0, tool: 1 },
          // { manufacturer: "zhipu", model: "glm-4.5-airx", responseFormat: "object", image: 0, think: 0, tool: 1 },
          // { manufacturer: "zhipu", model: "glm-4-long", responseFormat: "object", image: 0, think: 0, tool: 1 },
          // { manufacturer: "zhipu", model: "glm-4-flashx-250414", responseFormat: "object", image: 0, think: 0, tool: 1 },
          { manufacturer: "zhipu", model: "glm-4.7-flash", responseFormat: "object", image: 0, think: 0, tool: 1 },
          // { manufacturer: "zhipu", model: "glm-4.5-flash", responseFormat: "object", image: 0, think: 1, tool: 1 },
          // { manufacturer: "zhipu", model: "glm-4-flash-250414", responseFormat: "object", image: 0, think: 0, tool: 1 },
          { manufacturer: "zhipu", model: "glm-4.6v", responseFormat: "object", image: 1, think: 1, tool: 1 },
          { manufacturer: "aliyun_direct", model: "qwen-vl-max", responseFormat: "schema", image: 1, think: 0, tool: 1 },
          { manufacturer: "aliyun_direct", model: "qwen-plus-latest", responseFormat: "schema", image: 0, think: 0, tool: 1 },
          { manufacturer: "aliyun_direct", model: "qwen-max", responseFormat: "schema", image: 0, think: 0, tool: 1 },
          // { manufacturer: "aliyun_direct", model: "qwen2.5-72b-instruct", responseFormat: "schema", image: 0, think: 0, tool: 1 },
          // { manufacturer: "aliyun_direct", model: "qwen2.5-14b-instruct-1m", responseFormat: "schema", image: 0, think: 0, tool: 1 },
          // { manufacturer: "aliyun_direct", model: "qwen2.5-vl-72b-instruct", responseFormat: "schema", image: 1, think: 0, tool: 1 },
          // { manufacturer: "openai", model: "gpt-4o", responseFormat: "schema", image: 1, think: 0, tool: 1 },
          // { manufacturer: "openai", model: "gpt-4o-mini", responseFormat: "schema", image: 1, think: 0, tool: 1 },
          { manufacturer: "openai", model: "gpt-4.1", responseFormat: "schema", image: 1, think: 0, tool: 1 },
          // { manufacturer: "openai", model: "gpt-5.1", responseFormat: "schema", image: 1, think: 0, tool: 1 },
          { manufacturer: "openai", model: "gpt-5.2", responseFormat: "schema", image: 1, think: 0, tool: 1 },
          { manufacturer: "gemini", model: "gemini-3-pro-preview", responseFormat: "schema", image: 1, think: 1, tool: 1 },
          { manufacturer: "gemini", model: "gemini-2.5-pro", responseFormat: "schema", image: 1, think: 1, tool: 1 },
          // { manufacturer: "gemini", model: "gemini-2.5-flash", responseFormat: "schema", image: 1, think: 1, tool: 1 },
          // { manufacturer: "gemini", model: "gemini-2.0-flash", responseFormat: "schema", image: 1, think: 0, tool: 1 },
          // { manufacturer: "gemini", model: "gemini-2.0-flash-lite", responseFormat: "schema", image: 1, think: 0, tool: 1 },
          // { manufacturer: "gemini", model: "gemini-1.5-pro", responseFormat: "schema", image: 1, think: 0, tool: 1 },
          // { manufacturer: "gemini", model: "gemini-1.5-flash", responseFormat: "schema", image: 1, think: 0, tool: 1 },
          { manufacturer: "anthropic", model: "claude-opus-4-5", responseFormat: "schema", image: 1, think: 0, tool: 1 },
          { manufacturer: "anthropic", model: "claude-haiku-4-5", responseFormat: "schema", image: 1, think: 0, tool: 1 },
          { manufacturer: "anthropic", model: "claude-sonnet-4-5", responseFormat: "schema", image: 1, think: 0, tool: 1 },
          { manufacturer: "anthropic", model: "claude-opus-4-1", responseFormat: "schema", image: 1, think: 0, tool: 1 },
          // { manufacturer: "anthropic", model: "claude-opus-4-0", responseFormat: "schema", image: 1, think: 0, tool: 1 },
          // { manufacturer: "anthropic", model: "claude-sonnet-4-0", responseFormat: "schema", image: 1, think: 0, tool: 1 },
          // { manufacturer: "anthropic", model: "claude-3-7-sonnet-latest", responseFormat: "schema", image: 1, think: 0, tool: 1 },
          // { manufacturer: "anthropic", model: "claude-3-5-haiku-latest", responseFormat: "schema", image: 1, think: 0, tool: 1 },
          { manufacturer: "xai", model: "grok-3", responseFormat: "schema", image: 0, think: 0, tool: 1 },
          { manufacturer: "xai", model: "grok-4", responseFormat: "schema", image: 0, think: 0, tool: 1 },
          { manufacturer: "xai", model: "grok-4.1", responseFormat: "schema", image: 1, think: 0, tool: 1 },
          { manufacturer: "t8star", model: "gpt-5.4-pro", responseFormat: "schema", image: 1, think: 1, tool: 1 },
          { manufacturer: "t8star", model: "gemini-2.5-pro", responseFormat: "schema", image: 1, think: 1, tool: 1 },
          { manufacturer: "other", model: "", responseFormat: "object", image: 1, think: 0, tool: 1 },
          { manufacturer: "modelScope", model: "deepseek-ai/DeepSeek-V3.2", responseFormat: "object", image: 0, think: 0, tool: 1 },
        ]);
      },
    },
    {
      name: "t_imageModel",
      builder: (table) => {
        table.integer("id").notNullable();
        table.text("manufacturer");
        table.text("model");
        table.integer("grid");
        table.text("type");
        table.primary(["id"]);
      },
      initData: async (knex) => {
        await knex("t_imageModel").insert([
          { manufacturer: "volcengine", model: "doubao-seedream-5-0-260128", grid: 1, type: "ti2i" },
          { manufacturer: "volcengine", model: "doubao-seedream-4-5-251128", grid: 0, type: "ti2i" },
          // { manufacturer: "volcengine", model: "doubao-seedream-4-0-250828", grid: 0, type: "ti2i" },
          { manufacturer: "kling", model: "kling-image-o1", grid: 0, type: "ti2i" },
          { manufacturer: "gemini", model: "gemini-2.5-flash-image", grid: 1, type: "ti2i" },
          { manufacturer: "gemini", model: "gemini-3-pro-image-preview", grid: 1, type: "ti2i" },
          { manufacturer: "vidu", model: "viduq1", grid: 0, type: "i2i" },
          { manufacturer: "vidu", model: "viduq2", grid: 0, type: "ti2i" },
          { manufacturer: "runninghub", model: "nanobanana", grid: 1, type: "ti2i" },
          { manufacturer: "modelScope", model: "Qwen/Qwen-Image", grid: 1, type: "ti2i" },
          { manufacturer: "grsai", model: "nano-banana-fast", grid: 1, type: "ti2i" },
          { manufacturer: "grsai", model: "nano-banana-pro", grid: 1, type: "ti2i" },
          { manufacturer: "grsai", model: "nano-banana", grid: 1, type: "ti2i" },
          { manufacturer: "grsai", model: "nano-banana-2", grid: 1, type: "ti2i" },
        ]);
      },
    },
    {
      name: "t_videoModel",
      builder: (table) => {
        table.integer("id").notNullable();
        table.text("manufacturer");
        table.text("model");
        table.text("durationResolutionMap");
        table.text("aspectRatio");
        table.integer("audio");
        table.text("type");
        table.primary(["id"]);
      },
      initData: async (knex) => {
        await knex("t_videoModel").insert([
          {
            id: 1,
            manufacturer: "volcengine",
            model: "doubao-seedance-1-5-pro-251215",
            durationResolutionMap: JSON.stringify([{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["480p", "720p", "1080p"] }]),
            aspectRatio: JSON.stringify(["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"]),
            audio: 1,
            type: JSON.stringify(["text", "endFrameOptional"]),
          },
          {
            id: 2,
            manufacturer: "volcengine",
            model: "doubao-seedance-1-0-pro-250528",
            durationResolutionMap: JSON.stringify([{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["480p", "720p", "1080p"] }]),
            aspectRatio: JSON.stringify(["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"]),
            audio: 0,
            type: JSON.stringify(["text", "endFrameOptional"]),
          },
          {
            id: 3,
            manufacturer: "volcengine",
            model: "doubao-seedance-1-0-pro-fast-251015",
            durationResolutionMap: JSON.stringify([{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["480p", "720p", "1080p"] }]),
            aspectRatio: JSON.stringify(["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"]),
            audio: 0,
            type: JSON.stringify(["text", "singleImage"]),
          },
          {
            id: 4,
            manufacturer: "volcengine",
            model: "doubao-seedance-1-0-lite-i2v-250428",
            durationResolutionMap: JSON.stringify([{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["480p", "720p", "1080p"] }]),
            aspectRatio: JSON.stringify([]),
            audio: 0,
            type: JSON.stringify(["endFrameOptional", "reference"]),
          },
          {
            id: 5,
            manufacturer: "volcengine",
            model: "doubao-seedance-1-0-lite-t2v-250428",
            durationResolutionMap: JSON.stringify([{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["480p", "720p", "1080p"] }]),
            aspectRatio: JSON.stringify(["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"]),
            audio: 0,
            type: JSON.stringify(["text"]),
          },
          {
            id: 6,
            manufacturer: "kling",
            model: "kling-v1(STD)",
            durationResolutionMap: JSON.stringify([{ duration: [5, 10], resolution: ["720p"] }]),
            aspectRatio: JSON.stringify(["16:9", "1:1", "9:16"]),
            audio: 0,
            type: JSON.stringify(["text"]),
          },
          {
            id: 7,
            manufacturer: "kling",
            model: "kling-v1(STD)",
            durationResolutionMap: JSON.stringify([{ duration: [5, 10], resolution: ["720p"] }]),
            aspectRatio: JSON.stringify([]),
            audio: 0,
            type: JSON.stringify(["startEndRequired"]),
          },
          {
            id: 8,
            manufacturer: "kling",
            model: "kling-v1(PRO)",
            durationResolutionMap: JSON.stringify([{ duration: [5, 10], resolution: ["1080p"] }]),
            aspectRatio: JSON.stringify(["16:9", "1:1", "9:16"]),
            audio: 0,
            type: JSON.stringify(["text"]),
          },
          {
            id: 9,
            manufacturer: "kling",
            model: "kling-v1(PRO)",
            durationResolutionMap: JSON.stringify([{ duration: [5, 10], resolution: ["1080p"] }]),
            aspectRatio: JSON.stringify([]),
            audio: 0,
            type: JSON.stringify(["startEndRequired"]),
          },
          {
            id: 10,
            manufacturer: "kling",
            model: "kling-v1-6(PRO)",
            durationResolutionMap: JSON.stringify([{ duration: [5, 10], resolution: ["1080p"] }]),
            aspectRatio: JSON.stringify(["16:9", "1:1", "9:16"]),
            audio: 0,
            type: JSON.stringify(["text"]),
          },
          {
            id: 11,
            manufacturer: "kling",
            model: "kling-v1-6(PRO)",
            durationResolutionMap: JSON.stringify([{ duration: [5, 10], resolution: ["1080p"] }]),
            aspectRatio: JSON.stringify([]),
            audio: 0,
            type: JSON.stringify(["startEndRequired"]),
          },
          {
            id: 12,
            manufacturer: "kling",
            model: "kling-v2-5-turbo(PRO)",
            durationResolutionMap: JSON.stringify([{ duration: [5, 10], resolution: ["1080p"] }]),
            aspectRatio: JSON.stringify(["16:9", "1:1", "9:16"]),
            audio: 0,
            type: JSON.stringify(["text"]),
          },
          {
            id: 13,
            manufacturer: "kling",
            model: "kling-v2-5-turbo(PRO)",
            durationResolutionMap: JSON.stringify([{ duration: [5, 10], resolution: ["1080p"] }]),
            aspectRatio: JSON.stringify([]),
            audio: 0,
            type: JSON.stringify(["startEndRequired"]),
          },
          {
            id: 14,
            manufacturer: "kling",
            model: "kling-v2-6(PRO)",
            durationResolutionMap: JSON.stringify([{ duration: [5, 10], resolution: ["1080p"] }]),
            aspectRatio: JSON.stringify(["16:9", "1:1", "9:16"]),
            audio: 0,
            type: JSON.stringify(["text"]),
          },
          {
            id: 15,
            manufacturer: "kling",
            model: "kling-v2-6(PRO)",
            durationResolutionMap: JSON.stringify([{ duration: [5, 10], resolution: ["1080p"] }]),
            aspectRatio: JSON.stringify([]),
            audio: 0,
            type: JSON.stringify(["startEndRequired"]),
          },
          {
            id: 16,
            manufacturer: "vidu",
            model: "viduq3-pro",
            durationResolutionMap: JSON.stringify([
              { duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], resolution: ["540p", "720p", "1080p"] },
            ]),
            aspectRatio: JSON.stringify(["16:9", "9:16", "3:4", "4:3", "1:1"]),
            audio: 1,
            type: JSON.stringify(["text"]),
          },
          {
            id: 17,
            manufacturer: "vidu",
            model: "viduq3-pro",
            durationResolutionMap: JSON.stringify([
              { duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], resolution: ["540p", "720p", "1080p"] },
            ]),
            aspectRatio: JSON.stringify([]),
            audio: 1,
            type: JSON.stringify(["singleImage"]),
          },
          {
            id: 18,
            manufacturer: "vidu",
            model: "viduq2-pro-fast",
            durationResolutionMap: JSON.stringify([{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], resolution: ["720p", "1080p"] }]),
            aspectRatio: JSON.stringify([]),
            audio: 0,
            type: JSON.stringify(["singleImage", "startEndRequired"]),
          },
          {
            id: 19,
            manufacturer: "vidu",
            model: "viduq2-pro",
            durationResolutionMap: JSON.stringify([{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], resolution: ["540p", "720p", "1080p"] }]),
            aspectRatio: JSON.stringify(["16:9", "9:16", "3:4", "4:3", "1:1"]),
            audio: 0,
            type: JSON.stringify(["text"]),
          },
          {
            id: 20,
            manufacturer: "vidu",
            model: "viduq2-pro",
            durationResolutionMap: JSON.stringify([{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], resolution: ["540p", "720p", "1080p"] }]),
            aspectRatio: JSON.stringify([]),
            audio: 0,
            type: JSON.stringify(["singleImage", "reference", "startEndRequired"]),
          },
          {
            id: 21,
            manufacturer: "vidu",
            model: "viduq2-turbo",
            durationResolutionMap: JSON.stringify([{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], resolution: ["540p", "720p", "1080p"] }]),
            aspectRatio: JSON.stringify(["16:9", "9:16", "3:4", "4:3", "1:1"]),
            audio: 0,
            type: JSON.stringify(["text"]),
          },
          {
            id: 22,
            manufacturer: "vidu",
            model: "viduq2-turbo",
            durationResolutionMap: JSON.stringify([{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], resolution: ["540p", "720p", "1080p"] }]),
            aspectRatio: JSON.stringify([]),
            audio: 0,
            type: JSON.stringify(["singleImage", "reference", "startEndRequired"]),
          },
          {
            id: 23,
            manufacturer: "vidu",
            model: "viduq1",
            durationResolutionMap: JSON.stringify([{ duration: [5], resolution: ["1080p"] }]),
            aspectRatio: JSON.stringify(["16:9", "9:16", "1:1"]),
            audio: 0,
            type: JSON.stringify(["text"]),
          },
          {
            id: 24,
            manufacturer: "vidu",
            model: "viduq1",
            durationResolutionMap: JSON.stringify([{ duration: [5], resolution: ["1080p"] }]),
            aspectRatio: JSON.stringify([]),
            audio: 0,
            type: JSON.stringify(["singleImage", "reference", "startEndRequired"]),
          },
          {
            id: 25,
            manufacturer: "vidu",
            model: "viduq1-classic",
            durationResolutionMap: JSON.stringify([{ duration: [5], resolution: ["1080p"] }]),
            aspectRatio: JSON.stringify([]),
            audio: 0,
            type: JSON.stringify(["singleImage", "startEndRequired"]),
          },
          {
            id: 26,
            manufacturer: "vidu",
            model: "vidu2.0",
            durationResolutionMap: JSON.stringify([
              { duration: [4], resolution: ["360p", "720p", "1080p"] },
              { duration: [8], resolution: ["720p"] },
            ]),
            aspectRatio: JSON.stringify([]),
            audio: 0,
            type: JSON.stringify(["singleImage", "reference", "startEndRequired"]),
          },
          {
            id: 27,
            manufacturer: "wan",
            model: "wan2.6-t2v",
            durationResolutionMap: JSON.stringify([{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["720p", "1080p"] }]),
            aspectRatio: JSON.stringify(["16:9", "9:16", "1:1", "4:3", "3:4"]),
            audio: 1,
            type: JSON.stringify(["text"]),
          },
          {
            id: 28,
            manufacturer: "wan",
            model: "wan2.5-t2v-preview",
            durationResolutionMap: JSON.stringify([{ duration: [5, 10], resolution: ["480p", "720p", "1080p"] }]),
            aspectRatio: JSON.stringify(["16:9", "9:16", "1:1", "4:3", "3:4"]),
            audio: 1,
            type: JSON.stringify(["text"]),
          },
          {
            id: 29,
            manufacturer: "wan",
            model: "wan2.2-t2v-plus",
            durationResolutionMap: JSON.stringify([{ duration: [5], resolution: ["480p", "1080p"] }]),
            aspectRatio: JSON.stringify(["16:9", "9:16", "1:1", "4:3", "3:4"]),
            audio: 0,
            type: JSON.stringify(["text"]),
          },
          {
            id: 30,
            manufacturer: "wan",
            model: "wanx2.1-t2v-turbo",
            durationResolutionMap: JSON.stringify([{ duration: [5], resolution: ["480p", "720p"] }]),
            aspectRatio: JSON.stringify(["16:9", "9:16", "1:1", "4:3", "3:4"]),
            audio: 0,
            type: JSON.stringify(["text"]),
          },
          {
            id: 31,
            manufacturer: "wan",
            model: "wanx2.1-t2v-plus",
            durationResolutionMap: JSON.stringify([{ duration: [5], resolution: ["720p"] }]),
            aspectRatio: JSON.stringify(["16:9", "9:16", "1:1", "4:3", "3:4"]),
            audio: 0,
            type: JSON.stringify(["text"]),
          },
          {
            id: 32,
            manufacturer: "wan",
            model: "wan2.6-i2v-flash",
            durationResolutionMap: JSON.stringify([{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["720p", "1080p"] }]),
            aspectRatio: JSON.stringify([]),
            audio: 1,
            type: JSON.stringify(["singleImage"]),
          },
          {
            id: 33,
            manufacturer: "wan",
            model: "wan2.6-i2v",
            durationResolutionMap: JSON.stringify([{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["720p", "1080p"] }]),
            aspectRatio: JSON.stringify([]),
            audio: 1,
            type: JSON.stringify(["singleImage"]),
          },
          {
            id: 34,
            manufacturer: "wan",
            model: "wan2.5-i2v-preview",
            durationResolutionMap: JSON.stringify([{ duration: [5, 10], resolution: ["480p", "720p", "1080p"] }]),
            aspectRatio: JSON.stringify([]),
            audio: 1,
            type: JSON.stringify(["singleImage"]),
          },
          {
            id: 35,
            manufacturer: "wan",
            model: "wan2.2-i2v-flash",
            durationResolutionMap: JSON.stringify([{ duration: [5], resolution: ["480p", "720p", "1080p"] }]),
            aspectRatio: JSON.stringify([]),
            audio: 0,
            type: JSON.stringify(["singleImage"]),
          },
          {
            id: 36,
            manufacturer: "wan",
            model: "wan2.2-i2v-plus",
            durationResolutionMap: JSON.stringify([{ duration: [5], resolution: ["480p", "1080p"] }]),
            aspectRatio: JSON.stringify([]),
            audio: 0,
            type: JSON.stringify(["singleImage"]),
          },
          {
            id: 37,
            manufacturer: "wan",
            model: "wanx2.1-i2v-plus",
            durationResolutionMap: JSON.stringify([{ duration: [5], resolution: ["720p"] }]),
            aspectRatio: JSON.stringify([]),
            audio: 0,
            type: JSON.stringify(["singleImage"]),
          },
          {
            id: 38,
            manufacturer: "wan",
            model: "wanx2.1-i2v-turbo",
            durationResolutionMap: JSON.stringify([{ duration: [3, 4, 5], resolution: ["480p", "720p"] }]),
            aspectRatio: JSON.stringify([]),
            audio: 0,
            type: JSON.stringify(["singleImage"]),
          },
          {
            id: 39,
            manufacturer: "wan",
            model: "wan2.2-kf2v-flash",
            durationResolutionMap: JSON.stringify([{ duration: [5], resolution: ["480p", "720p", "1080p"] }]),
            aspectRatio: JSON.stringify([]),
            audio: 0,
            type: JSON.stringify(["startEndRequired"]),
          },
          {
            id: 40,
            manufacturer: "wan",
            model: "wanx2.1-kf2v-plus",
            durationResolutionMap: JSON.stringify([{ duration: [5], resolution: ["720p"] }]),
            aspectRatio: JSON.stringify([]),
            audio: 0,
            type: JSON.stringify(["startEndRequired"]),
          },
          {
            id: 41,
            manufacturer: "gemini",
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
            id: 42,
            manufacturer: "gemini",
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
            id: 43,
            manufacturer: "gemini",
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
            id: 44,
            manufacturer: "gemini",
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
            id: 45,
            manufacturer: "gemini",
            model: "veo-2.0-generate-001",
            durationResolutionMap: JSON.stringify([{ duration: [5, 6, 7, 8], resolution: ["720p"] }]),
            aspectRatio: JSON.stringify(["16:9", "9:16"]),
            audio: 0,
            type: JSON.stringify(["text", "singleImage"]),
          },
          {
            id: 46,
            manufacturer: "runninghub",
            model: "sora-2",
            durationResolutionMap: JSON.stringify([{ duration: [10, 15], resolution: [] }]),
            aspectRatio: JSON.stringify(["16:9", "9:16"]),
            audio: 0,
            type: JSON.stringify(["singleImage", "text"]),
          },
          {
            id: 47,
            manufacturer: "runninghub",
            model: "sora-2-pro",
            durationResolutionMap: JSON.stringify([{ duration: [15, 25], resolution: [] }]),
            aspectRatio: JSON.stringify(["16:9", "9:16"]),
            audio: 0,
            type: JSON.stringify(["singleImage", "text"]),
          },
          {
            id: 48,
            manufacturer: "grsai",
            model: "sora-2",
            durationResolutionMap: JSON.stringify([{ duration: [10, 15], resolution: [] }]),
            aspectRatio: JSON.stringify(["16:9", "9:16"]),
            audio: 0,
            type: JSON.stringify(["singleImage", "text"]),
          },
          {
            id: 49,
            manufacturer: "grsai",
            model: "veo3.1-pro",
            durationResolutionMap: JSON.stringify([]),
            aspectRatio: JSON.stringify(["16:9", "9:16"]),
            audio: 0,
            type: JSON.stringify(["startEndRequired", "text"]),
          },

          {
            id: 50,
            manufacturer: "grsai",
            model: "veo3.1-pro-1080p",
            durationResolutionMap: JSON.stringify([]),
            aspectRatio: JSON.stringify(["16:9", "9:16"]),
            audio: 0,
            type: JSON.stringify(["startEndRequired", "text"]),
          },
          {
            id: 51,
            manufacturer: "grsai",
            model: "veo3.1-pro-4k",
            durationResolutionMap: JSON.stringify([]),
            aspectRatio: JSON.stringify(["16:9", "9:16"]),
            audio: 0,
            type: JSON.stringify(["startEndRequired", "text"]),
          },
          {
            id: 52,
            manufacturer: "grsai",
            model: "veo3.1-fast",
            durationResolutionMap: JSON.stringify([]),
            aspectRatio: JSON.stringify(["16:9", "9:16"]),
            audio: 0,
            type: JSON.stringify(["startEndRequired", "text"]),
          },
          {
            id: 53,
            manufacturer: "grsai",
            model: "veo3.1-fast-1080p",
            durationResolutionMap: JSON.stringify([]),
            aspectRatio: JSON.stringify(["16:9", "9:16"]),
            audio: 0,
            type: JSON.stringify(["startEndRequired", "text"]),
          },
          {
            id: 54,
            manufacturer: "grsai",
            model: "veo3.1-fast-4k",
            durationResolutionMap: JSON.stringify([]),
            aspectRatio: JSON.stringify(["16:9", "9:16"]),
            audio: 0,
            type: JSON.stringify(["startEndRequired", "text"]),
          },
          {
            id: 55,
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
            id: 56,
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
            id: 57,
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
            id: 58,
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
            id: 59,
            manufacturer: "t8star",
            model: "veo-2.0-generate-001",
            durationResolutionMap: JSON.stringify([{ duration: [5, 6, 7, 8], resolution: ["720p"] }]),
            aspectRatio: JSON.stringify(["16:9", "9:16"]),
            audio: 0,
            type: JSON.stringify(["text", "singleImage"]),
          },
          {
            id: 65,
            manufacturer: "t8star",
            model: "veo3.1-fast",
            durationResolutionMap: JSON.stringify([{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["480p", "720p", "1080p", "2K", "4K"] }]),
            aspectRatio: JSON.stringify(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]),
            audio: 1,
            type: JSON.stringify(["text", "singleImage", "startEndRequired", "endFrameOptional", "reference"]),
          },
          {
            id: 66,
            manufacturer: "t8star",
            model: "veo3.1-fast-4k",
            durationResolutionMap: JSON.stringify([{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["4K", "2K", "1080p"] }]),
            aspectRatio: JSON.stringify(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]),
            audio: 1,
            type: JSON.stringify(["text", "singleImage", "startEndRequired", "endFrameOptional", "reference"]),
          },
          {
            id: 67,
            manufacturer: "t8star",
            model: "veo3.1-pro",
            durationResolutionMap: JSON.stringify([{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["720p", "1080p", "2K"] }]),
            aspectRatio: JSON.stringify(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]),
            audio: 1,
            type: JSON.stringify(["text", "singleImage", "startEndRequired", "endFrameOptional", "reference"]),
          },
          {
            id: 68,
            manufacturer: "t8star",
            model: "veo3.1-pro-4k",
            durationResolutionMap: JSON.stringify([{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["4K", "2K", "1080p"] }]),
            aspectRatio: JSON.stringify(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]),
            audio: 1,
            type: JSON.stringify(["text", "singleImage", "startEndRequired", "endFrameOptional", "reference"]),
          },
          {
            id: 60,
            manufacturer: "qingyuntop",
            model: "veo3.1-fast",
            durationResolutionMap: JSON.stringify([{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["480p", "720p", "1080p", "2K", "4K"] }]),
            aspectRatio: JSON.stringify(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]),
            audio: 1,
            type: JSON.stringify(["text", "singleImage", "startEndRequired", "endFrameOptional", "reference"]),
          },
          {
            id: 61,
            manufacturer: "qingyuntop",
            model: "veo3.1-fast-4k",
            durationResolutionMap: JSON.stringify([{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["4K", "2K", "1080p"] }]),
            aspectRatio: JSON.stringify(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]),
            audio: 1,
            type: JSON.stringify(["text", "singleImage", "startEndRequired", "endFrameOptional", "reference"]),
          },
          {
            id: 62,
            manufacturer: "qingyuntop",
            model: "veo3.1-pro",
            durationResolutionMap: JSON.stringify([{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["720p", "1080p", "2K"] }]),
            aspectRatio: JSON.stringify(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]),
            audio: 1,
            type: JSON.stringify(["text", "singleImage", "startEndRequired", "endFrameOptional", "reference"]),
          },
          {
            id: 63,
            manufacturer: "qingyuntop",
            model: "veo3.1-pro-4k",
            durationResolutionMap: JSON.stringify([{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["4K", "2K", "1080p"] }]),
            aspectRatio: JSON.stringify(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]),
            audio: 1,
            type: JSON.stringify(["text", "singleImage", "startEndRequired", "endFrameOptional", "reference"]),
          },
          {
            id: 64,
            manufacturer: "kieai",
            model: "veo3_fast",
            durationResolutionMap: JSON.stringify([
              { duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["720p"] },
            ]),
            aspectRatio: JSON.stringify(["16:9"]),
            audio: 1,
            type: JSON.stringify(["text", "singleImage", "startEndRequired", "endFrameOptional", "reference"]),
          },
        ]);
      },
    },
    {
      name: "t_storyWorld",
      builder: (table) => {
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
      },
    },
    {
      name: "t_storyChapter",
      builder: (table) => {
        table.integer("id").notNullable();
        table.integer("worldId");
        table.text("chapterKey");
        table.text("backgroundPath");
        table.text("openingRole");
        table.text("openingText");
        table.text("bgmPath");
        table.integer("bgmAutoPlay");
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
      },
    },
    {
      name: "t_chapterTask",
      builder: (table) => {
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
      },
    },
    {
      name: "t_chapterTrigger",
      builder: (table) => {
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
      },
    },
    {
      name: "t_gameSession",
      builder: (table) => {
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
      },
    },
    {
      name: "t_sessionMessage",
      builder: (table) => {
        table.integer("id").notNullable();
        table.text("sessionId");
        table.text("role");
        table.text("roleType");
        table.text("content");
        table.text("eventType");
        table.text("meta");
        table.text("revisitData");
        table.integer("createTime");
        table.primary(["id"]);
        table.unique(["id"]);
      },
    },
    {
      name: "t_sessionStateSnapshot",
      builder: (table) => {
        table.integer("id").notNullable();
        table.text("sessionId");
        table.text("stateJson");
        table.text("reason");
        table.integer("round");
        table.integer("createTime");
        table.primary(["id"]);
        table.unique(["id"]);
      },
    },
    {
      name: "t_entityStateDelta",
      builder: (table) => {
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
      },
    },
    {
      name: "t_voiceModel",
      builder: (table) => {
        table.integer("id").notNullable();
        table.text("manufacturer");
        table.text("model");
        table.text("mode");
        table.primary(["id"]);
        table.unique(["id"]);
      },
      initData: async (knex) => {
        await knex("t_voiceModel").insert([
          { manufacturer: "ai_voice_tts", model: "ai_voice_tts", mode: JSON.stringify(["text", "clone", "mix", "prompt_voice"]) },
          { manufacturer: "moss_tts_nano", model: "moss-tts-nano-100m", mode: JSON.stringify(["text", "clone"]) },
          { manufacturer: "siliconflow", model: "FunAudioLLM/CosyVoice2-0.5B", mode: JSON.stringify(["text", "clone"]) },
        ]);
      },
    },
  ];

  for (const t of tables) {
    const tableExists = await knex.schema.hasTable(t.name);
    if (!tableExists || forceInit) {
      if (tableExists && forceInit) {
        await knex.schema.dropTable(t.name);
        console.log("[初始化数据库] 已存在表删除并重建:", t.name);
      } else {
        console.log("[初始化数据库] 创建数据表:", t.name);
      }
      await knex.schema.createTable(t.name, t.builder);
      if (t.initData) {
        await t.initData(knex);
        console.log("[初始化数据库] 表数据初始化:", t.name);
      }
    }
  }
};
