# 语音合成「分段」显式配置：按标点符号 / 按字数（默认100可填）

## Context（根因与目标）

用户希望 TTS 增加「分段」配置（按标点符号 / 按字数，字数默认100可填），配置挂在**语音合成模型配置**上（截图的「编辑模型」弹窗）。

现状根因（已探明）：
- 听感上"所有平台都按标点分割"的真正来源是**前端流式逐句播放**：后端 `streamlines.ts` 按标点切出 sentence 事件 → 前端 `messageReveal.ts` 逐句调 `playMessageAudio(msg, false, true, sentence)`，每句单独合成一次。
- 前端 `textUtils.ts` 的 `splitSpeechSegments` 分段参数全是**硬编码**（`is_need_symbol_segm=false`、`MAX_SEGMENT_CHARS=100`），且输入已是单句（≪100字）所以字数切分永不触发；注释里"未来由后台数据库配置"从未实现——这就是"mimo 按字数没效果"的原因。
- 模型配置存 `t_config` 表（`select("*")` + 展开，新列自动带出）；保存走 `/setting/addModel`、`/setting/updateModel`（新字段仿 `remark` 的处理方式即可，不必动 `normalizeExternalModelConfig`）。

配置语义：
- **按标点符号**（默认，未配置的存量模型行为完全不变）：每个标点句单独合成；超长句按字数上限兜底切。
- **按字数**：流式播放时把相邻句子**攒批到 N 字**（默认100）再一次合成（这是让字数模式真正生效的关键），超长无标点文本按 N 字切。

## 后端（toonflow-game-app）

1. **新迁移** `src/migrations/20261122_000001_add_t_config_segment_fields.js`（仿 `20261120_000001` 风格）：`t_config` 加 `segmentMode`(text)、`segmentChars`(integer)，`hasColumn` 防重；down 删列。启动 `yarn local` 自动执行。
2. **`src/types/database.d.ts`**：`t_config` 接口补 `segmentMode`/`segmentChars` 两字段。
3. **`src/routes/setting/addModel.ts` / `updateModel.ts`**：zod 加 `segmentMode: z.enum(["punctuation","chars"]).nullable().optional()`、`segmentChars: z.number().int().nullable().optional()`；持久化仿 `remark`（`segmentChars` 规范化为正整数否则 null）。带注释。
4. `getSetting.ts` / `getVoiceModelList.ts` 均为 `select("*")` + 展开返回，**无需改动**。

## 前端（Toonflow-game-web）

5. **`src/types/toonflow.ts`**：`ModelConfigItem`、`ModelConfigPayload`、`VoiceModelConfig` 三个接口加 `segmentMode?: "punctuation" | "chars" | ""`、`segmentChars?: number | null`。
6. **`src/components/SettingsModelManagerDialog.vue`**（编辑模型弹窗）：
   - `form` 加 `segmentMode: "punctuation"`、`segmentChars: 100`；computed `shouldShowSegmentConfig = props.configType === "voice" && form.modelType === "tts"`（仿 `shouldShowTokenPricing`）。
   - 模板「模型」字段之后新增「分段」field：`select`（按标点符号/按字数）+ 按字数时显示数字输入（type=number，默认100）+ `settings-field-hint` 提示（按标点=每句单独合成；按字数=攒够 N 字合成一次）。
   - `openCreate`/`openEdit` 回填（`segmentMode==="chars"?…`；`segmentChars>0?:100`）；`submitEditor` payload 显示时传规范化值（clamp 10~500），隐藏时传 null。
7. **`src/composables/useToonflowStore.ts`**：
   - `voiceSegmentConfigFor(configId)`：从 `state.settingsVoiceConfigs` 查配置，缺省返回 `{mode:"punctuation", maxChars:100}`。
   - `ensureVoiceSegmentConfigs()`：`settingsPanelLoaded` 为 false 时轻量拉一次 `api.getVoiceModels()`（inflight 去重），供游玩时兜底（现有 `ensureSettingsPanelData` 只在设置页/绑定弹窗触发）。
8. **`src/composables/orchestrationVoiceFlow/textUtils.ts`**：`splitSpeechSegments(input, options?)` 改为参数化——`mode:"punctuation"` 按标点切 + `maxChars` 兜底；`mode:"chars"` 仅按 `maxChars` 切；缺省 `chars/100`（=现行为）。删除 `is_need_symbol_segm` 硬编码。
9. **`voiceGenPlay.ts`**：`playMessageAudioWithBinding` 按 `binding.configId` 取 `voiceSegmentConfigFor` 传给两处 `splitSpeechSegments`（非流式整段播放路径自动生效）。
10. **`messageReveal.ts` + `voiceGenPlay.ts` 新增 `createSentenceBatchPlayer`**（导出，带注释）：
    - 按标点模式：行为与现在逐句播放完全一致。
    - 按字数模式：`add(sentence, idx)` 攒批，speakable 长度 ≥ N 时 flush——`startSentencePlayback(start)` → `playMessageAudio(batchText)` → 按区间逐索引 `finishSentencePlayback`（播放状态表仅 debug 消费，已确认安全）；`flushRemaining()` 收尾；`discard()` 供取消分支把未合成区间标记结束。
    - 流式循环（L180）与尾句循环（L231）改用 batch player；flush 前 `await store.ensureVoiceSegmentConfigs()`。

## 验证

1. 后端 `yarn lint`；起 `yarn local` 确认迁移日志；python urllib（UTF-8）调 `/setting/updateModel` 给某 voice 配置写 `segmentMode=chars, segmentChars=80` → `/setting/getSetting` 回读校验 → 恢复。
2. 前端 `yarn type-check` 无新增错误。
3. IAB 走查：设置→语音生成→模型数据管理→编辑语音合成模型 → 分段配置显示/保存/重新打开回显；切按标点符号再验证。
4. 播放走查：将 TTS 模型设为按字数 → 自动朗读时 WebDebugLog 中 `resolveRuntimeVoiceUrl` 的 segment 应为攒批长文本；切回按标点符号恢复逐句。
5. 走查后停前后端服务、恢复测试配置。