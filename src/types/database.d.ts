// @db-hash de02a273b10804022172080963e3fa16
//该文件由脚本自动生成，请勿手动修改

export interface t_aiModelMap {
  'configId'?: number | null;
  'id'?: number;
  'key'?: string | null;
  'name'?: string | null;
}
export interface t_aiTokenUsageLog {
  'amount'?: number | null;
  'cacheReadPricePer1M'?: number | null;
  'cacheReadTokens'?: number | null;
  'channel'?: string | null;
  'createTime': number;
  'currency'?: string | null;
  'id'?: number;
  'inputPricePer1M'?: number | null;
  'inputTokens'?: number | null;
  'manufacturer'?: string | null;
  'meta'?: string | null;
  'model'?: string | null;
  'outputPricePer1M'?: number | null;
  'outputTokens'?: number | null;
  'reasoningTokens'?: number | null;
  'remark'?: string | null;
  'totalTokens'?: number | null;
  'type'?: string | null;
  'userId': number;
}
export interface t_assets {
  'duration'?: string | null;
  'episode'?: string | null;
  'filePath'?: string | null;
  'id'?: number;
  'intro'?: string | null;
  'name'?: string | null;
  'projectId'?: number | null;
  'prompt'?: string | null;
  'remark'?: string | null;
  'scriptId'?: number | null;
  'segmentId'?: number | null;
  'shotIndex'?: number | null;
  'state'?: string | null;
  'type'?: string | null;
  'videoPrompt'?: string | null;
  'voiceConfig'?: string | null;
}
export interface t_chapterTask {
  'chapterId'?: number | null;
  'createTime'?: number | null;
  'failCondition'?: string | null;
  'goalType'?: string | null;
  'id'?: number;
  'parentTaskId'?: number | null;
  'rewardAction'?: string | null;
  'sort'?: number | null;
  'status'?: string | null;
  'successCondition'?: string | null;
  'taskType'?: string | null;
  'title'?: string | null;
  'updateTime'?: number | null;
}
export interface t_chapterTrigger {
  'actionExpr'?: string | null;
  'chapterId'?: number | null;
  'conditionExpr'?: string | null;
  'createTime'?: number | null;
  'enabled'?: number | null;
  'id'?: number;
  'name'?: string | null;
  'sort'?: number | null;
  'triggerEvent'?: string | null;
  'updateTime'?: number | null;
}
export interface t_chatHistory {
  'data'?: string | null;
  'id'?: number;
  'novel'?: string | null;
  'projectId'?: number | null;
  'type'?: string | null;
}
export interface t_config {
  'apiKey'?: string | null;
  'baseUrl'?: string | null;
  'cacheReadPricePer1M'?: number | null;
  'createTime'?: number | null;
  'currency'?: string | null;
  'id'?: number;
  'inputPricePer1M'?: number | null;
  'manufacturer'?: string | null;
  'model'?: string | null;
  'modelType'?: string | null;
  'outputPricePer1M'?: number | null;
  'reasoningEffort'?: string | null;
  'type'?: string | null;
  'userId'?: number | null;
}
export interface t_entityStateDelta {
  'createTime'?: number | null;
  'entityId'?: string | null;
  'entityType'?: string | null;
  'eventId'?: string | null;
  'field'?: string | null;
  'id'?: number;
  'newValue'?: string | null;
  'oldValue'?: string | null;
  'sessionId'?: string | null;
  'source'?: string | null;
}
export interface t_gameSession {
  'chapterId'?: number | null;
  'contentVersion'?: string | null;
  'createTime'?: number | null;
  'id'?: number;
  'projectId'?: number | null;
  'sessionId'?: string | null;
  'stateJson'?: string | null;
  'status'?: string | null;
  'title'?: string | null;
  'updateTime'?: number | null;
  'userId'?: number | null;
  'worldId'?: number | null;
}
export interface t_image {
  'assetsId'?: number | null;
  'filePath'?: string | null;
  'id'?: number;
  'projectId'?: number | null;
  'scriptId'?: number | null;
  'state'?: string | null;
  'type'?: string | null;
  'videoId'?: number | null;
}
export interface t_imageModel {
  'grid'?: number | null;
  'id'?: number;
  'manufacturer'?: string | null;
  'model'?: string | null;
  'type'?: string | null;
}
export interface t_novel {
  'chapter'?: string | null;
  'chapterData'?: string | null;
  'chapterIndex'?: number | null;
  'createTime'?: number | null;
  'id'?: number;
  'projectId'?: number | null;
  'reel'?: string | null;
}
export interface t_outline {
  'data'?: string | null;
  'episode'?: number | null;
  'id'?: number;
  'projectId'?: number | null;
}
export interface t_project {
  'artStyle'?: string | null;
  'createTime'?: number | null;
  'id'?: number | null;
  'intro'?: string | null;
  'name'?: string | null;
  'type'?: string | null;
  'userId'?: number | null;
  'videoRatio'?: string | null;
}
export interface t_prompts {
  'code'?: string | null;
  'customValue'?: string | null;
  'defaultValue'?: string | null;
  'id'?: number;
  'name'?: string | null;
  'parentCode'?: string | null;
  'type'?: string | null;
}
export interface t_roleAvatarTask {
  'backgroundFilePath'?: string | null;
  'backgroundPath'?: string | null;
  'createTime'?: number | null;
  'errorMessage'?: string | null;
  'foregroundFilePath'?: string | null;
  'foregroundPath'?: string | null;
  'id'?: number;
  'message'?: string | null;
  'progress'?: number | null;
  'projectId'?: number | null;
  'status'?: string | null;
  'taskType'?: string | null;
  'updateTime'?: number | null;
  'userId': number;
}
export interface t_script {
  'content'?: string | null;
  'id'?: number;
  'name'?: string | null;
  'outlineId'?: number | null;
  'projectId'?: number | null;
}
export interface t_scriptSegment {
  'content'?: string | null;
  'createTime'?: number | null;
  'endAnchor'?: string | null;
  'id'?: number;
  'projectId': number;
  'scriptId': number;
  'sort': number;
  'startAnchor'?: string | null;
  'summary'?: string | null;
  'title'?: string | null;
  'updateTime'?: number | null;
}
export interface t_sessionMessage {
  'content'?: string | null;
  'createTime'?: number | null;
  'eventType'?: string | null;
  'id'?: number;
  'meta'?: string | null;
  'revisitData'?: string | null;
  'role'?: string | null;
  'roleType'?: string | null;
  'sessionId'?: string | null;
}
export interface t_sessionStateSnapshot {
  'createTime'?: number | null;
  'id'?: number;
  'reason'?: string | null;
  'round'?: number | null;
  'sessionId'?: string | null;
  'stateJson'?: string | null;
}
export interface t_setting {
  'id'?: number;
  'imageModel'?: string | null;
  'languageModel'?: string | null;
  'projectId'?: number | null;
  'tokenKey'?: string | null;
  'userId'?: number | null;
}
export interface t_storyChapter {
  'backgroundPath'?: string | null;
  'bgmAutoPlay'?: number | null;
  'bgmPath'?: string | null;
  'chapterKey'?: string | null;
  'completionCondition'?: string | null;
  'content'?: string | null;
  'createTime'?: number | null;
  'entryCondition'?: string | null;
  'id'?: number;
  'openingRole'?: string | null;
  'openingText'?: string | null;
  'runtimeOutline'?: string | null;
  'showCompletionCondition'?: number | null;
  'sort'?: number | null;
  'status'?: string | null;
  'title'?: string | null;
  'updateTime'?: number | null;
  'worldId'?: number | null;
}
export interface t_storyline {
  'content'?: string | null;
  'id'?: number;
  'name'?: string | null;
  'novelIds'?: string | null;
  'projectId'?: number | null;
}
export interface t_storyWorld {
  'coverPath'?: string | null;
  'createTime'?: number | null;
  'id'?: number;
  'intro'?: string | null;
  'name'?: string | null;
  'narratorRole'?: string | null;
  'playerRole'?: string | null;
  'projectId'?: number | null;
  'publishStatus'?: string | null;
  'settings'?: string | null;
  'updateTime'?: number | null;
}
export interface t_taskList {
  'endTime'?: string | null;
  'id'?: number;
  'name'?: string | null;
  'projectName'?: number | null;
  'prompt'?: string | null;
  'startTime'?: string | null;
  'state'?: string | null;
}
export interface t_textModel {
  'id'?: number;
  'image'?: number | null;
  'manufacturer'?: string | null;
  'model'?: string | null;
  'responseFormat'?: string | null;
  'think'?: number | null;
  'tool'?: number | null;
}
export interface t_user {
  'avatarBgPath'?: string | null;
  'avatarPath'?: string | null;
  'id'?: number;
  'name'?: string | null;
  'password'?: string | null;
}
export interface t_video {
  'aiConfigId'?: number | null;
  'configId'?: number | null;
  'errorReason'?: string | null;
  'filePath'?: string | null;
  'firstFrame'?: string | null;
  'id'?: number;
  'model'?: string | null;
  'prompt'?: string | null;
  'providerManufacturer'?: string | null;
  'providerQueryUrl'?: string | null;
  'providerTaskId'?: string | null;
  'resolution'?: string | null;
  'scriptId'?: number | null;
  'state'?: number | null;
  'storyboardImgs'?: string | null;
  'time'?: number | null;
}
export interface t_videoConfig {
  'aiConfigId'?: number | null;
  'audioEnabled'?: number | null;
  'audioPath'?: string | null;
  'audioTrack'?: number | null;
  'createTime'?: number | null;
  'dialogue'?: string | null;
  'dialogueTrack'?: number | null;
  'duration'?: number | null;
  'endFrame'?: string | null;
  'id'?: number;
  'images'?: string | null;
  'manufacturer'?: string | null;
  'mode'?: string | null;
  'projectId'?: number | null;
  'prompt'?: string | null;
  'resolution'?: string | null;
  'scriptId'?: number | null;
  'selectedResultId'?: number | null;
  'sort'?: number | null;
  'startFrame'?: string | null;
  'ttsAudioPath'?: string | null;
  'updateTime'?: number | null;
  'voiceConfigId'?: number | null;
  'voicePresetId'?: string | null;
}
export interface t_videoModel {
  'aspectRatio'?: string | null;
  'audio'?: number | null;
  'durationResolutionMap'?: string | null;
  'id'?: number;
  'manufacturer'?: string | null;
  'model'?: string | null;
  'type'?: string | null;
}
export interface t_voiceModel {
  'id'?: number;
  'manufacturer'?: string | null;
  'mode'?: string | null;
  'model'?: string | null;
}

export interface DB {
  "t_aiModelMap": t_aiModelMap;
  "t_aiTokenUsageLog": t_aiTokenUsageLog;
  "t_assets": t_assets;
  "t_chapterTask": t_chapterTask;
  "t_chapterTrigger": t_chapterTrigger;
  "t_chatHistory": t_chatHistory;
  "t_config": t_config;
  "t_entityStateDelta": t_entityStateDelta;
  "t_gameSession": t_gameSession;
  "t_image": t_image;
  "t_imageModel": t_imageModel;
  "t_novel": t_novel;
  "t_outline": t_outline;
  "t_project": t_project;
  "t_prompts": t_prompts;
  "t_roleAvatarTask": t_roleAvatarTask;
  "t_script": t_script;
  "t_scriptSegment": t_scriptSegment;
  "t_sessionMessage": t_sessionMessage;
  "t_sessionStateSnapshot": t_sessionStateSnapshot;
  "t_setting": t_setting;
  "t_storyChapter": t_storyChapter;
  "t_storyline": t_storyline;
  "t_storyWorld": t_storyWorld;
  "t_taskList": t_taskList;
  "t_textModel": t_textModel;
  "t_user": t_user;
  "t_video": t_video;
  "t_videoConfig": t_videoConfig;
  "t_videoModel": t_videoModel;
  "t_voiceModel": t_voiceModel;
}
