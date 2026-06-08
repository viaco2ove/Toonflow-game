# 现在的获取台词播放语音的流程是怎样的
## 第一轮
整体链路：编排 → 台词生成 → 绑定音色 → TTS 合成 → 代理播放
整个流程是 6 步串行管线，前端严格按序调用：

1️⃣ 编排阶段 — 确定谁说、动机
接口: /game/orchestration 或 /game/orchestration/minigame
后端: NarrativeOrchestrator 调用编排 AI，决定下一步谁说话
返回: { role, roleType, motive, eventType, presetContent } — 角色名、角色类型、说话动机、事件类型、预置文本
2️⃣ 生成台词 — AI Speaker 模型
接口: /game/streamlines
后端: 调用 runStorySpeakerContent() 通过 Speaker 模型生成完整台词文本
NDJSON 流式返回: start → delta(分片) → sentence(整句) → done
特例: 开场白(presetContent)和小游戏规则说明(on_mini_game_start)直接使用预置文本，跳过 Speaker 模型
关键代码: streamlines.ts:621 — content = await runStorySpeakerContent(...)
3️⃣ 生成绑定音色 — 角色语音配置
接口: /voice/generateBindingVoice
前端逻辑 (ScenePlay.vue:2872): ensureRuntimeCloneBinding() 统一把所有模式转为 clone 模式
text 模式：先生成参考音频文件 → 再转 clone
clone 模式：如果已有 referenceAudioPath 直接用
mix/prompt_voice：先合成混合/设计音频 → 再转 clone
首次生成后缓存（runtimeVoiceCloneBindingCache），后续同一角色直接复用
4️⃣ 语音合成 — TTS 合成音频
接口: /game/streamvoice
前端调用 (ScenePlay.vue:2932): store.streamVoice(configId, text, mode, presetId, ...)
后端 实际走的是 /voice/preview 的同一套 TTS 逻辑
5 路 TTS 厂商通道：
厂商	模式	合成方式
aliyun_direct (CosyVoice/Qwen-TTS)	text/clone/mix/prompt_voice	WebSocket 或 HTTP API
minimax	clone	上传音频 → voice_clone → TTS
siliconflow	clone	上传音频 → MOSS-TTSD → TTS
moss_tts_nano	clone	本地推理
本地网关 (ai_voice_tts)	clone	/v1/tts/clone_upload
逐段分句: 前端把台词按句切分（splitSpeechSegments），逐句请求 TTS
三级缓存: runtimeVoicePreviewCache (audioUrl) → runtimeVoicePreviewInflight (去重) → runtimeVoiceBlobCache (Blob)
5️⃣ 音频代理 — 统一音频获取
接口: /voice/audioProxy?source=xxx&configId=xxx&token=xxx
功能:
本地 OSS 路径（/user/xxx、/system/xxx）: 直接读文件返回
远程 URL: 代理转发，透传 Authorization 鉴权
audioUrl 构建 (preview.ts:278): buildProxyAudioUrl() 把源地址转成代理 URL
前端 (ScenePlay.vue:2989): fetchRuntimeVoiceBlob() → fetch(audioUrl) → blob()
6️⃣ 前端播放 — Audio + Blob URL
核心函数 (ScenePlay.vue:2999): playRuntimeVoiceBlob()
播放流程:
Blob → URL.createObjectURL() → new Audio(objectUrl) → player.play()
超时控制: 根据文本长度估算播放时长，超时自动终止
容错降级链 (ScenePlay.vue:3138-3193):
AI TTS 播放 → 失败 → 降级到兼容音色 → 再失败 → 浏览器 Speech API
预热机制 (ScenePlay.vue:2977): warmVoiceBinding() 在台词生成前，先用种子文本预热 clone 通道
关键文件索引
文件	职责
routes/game/streamlines.ts	流式台词生成
routes/game/streamvoice.ts	运行时语音合成（代理到 preview）
routes/voice/preview.ts	核心语音合成逻辑（5路TTS）
routes/voice/generateBindingVoice.ts	角色音色绑定文件生成
routes/voice/audioProxy.ts	音频代理下载
lib/voiceGateway.ts	语音配置/厂商判断/预设管理
lib/aliyunCosyVoice.ts	阿里 CosyVoice WebSocket TTS
lib/miniMaxVoice.ts	MiniMax TTS
lib/siliconflowVoice.ts	SiliconFlow TTS
lib/localMossTts.ts	MOSS-TTS-Nano 本地推理
lib/businessVoicePresets.ts	业务内置预设音色
lib/voiceDesign.ts	语音设计（提示词生成音色）
ScenePlay.vue:2840-3200	前端语音播放全流程


## 第二轮
下一轮编排在上一轮的哪个时刻触发？

答案是：**语音播放完成的瞬间**，同时有一个**预取优化**让编排几乎零等待。

---

### 完整时序

| 上一轮阶段 | 状态码 | 下一轮动作 |
|-----------|--------|-----------|
| 编排 → 台词流式生成 | `streaming` | — |
| 台词生成完成 | `generated` | — |
| 文本逐句揭示给用户 | `revealing` | — |
| **语音播放中** | `voicing` | **后台预取编排** 🔥 |
| **语音播放完成** | → `waiting_next` | — |
| Watch 检测到 `waiting_next` | → `auto_advancing` | **触发下一轮全流程** |

### 关键机制拆解

**1. 预取 — 在语音播放期间就开始下一轮编排**

`useToonflowStore.ts:6905-6911`：当 `streamSessionPlan()` 完成（台词文本已生成并 commit），如果最后一条消息仍属于系统推进（不是用户回合），就调用 `prefetchNextSessionOrchestration()`，后台发起 `/game/orchestration` 请求。

```ts
if (shouldPrefetchNextSessionOrchestration(latestNarrativeMessage)) {
  prefetchNextSessionOrchestration(Number(latestNarrativeMessage?.id || 0));
}
```

这意味着**编排的 2~4 秒 AI 调用时间和语音播放是并行的**。

**2. 语音播完 → `waiting_next` → Watch 自动推进**

`ScenePlay.vue:2622-2637`：语音播放完成后（`playMessageAudio` 的 `waitForCompletion=true` 返回），状态设为 `waiting_next`（非用户回合时）。

`ScenePlay.vue:2130-2204` 的 **Watch** 监听器持续跟踪 `latestRevealedMessage` 的状态，一旦检测到 `waiting_next`，就：
1. 设状态为 `auto_advancing`
2. 调用 `continueSessionNarrative()`

**3. `continueSessionNarrative` → 复用预取结果**

`useToonflowStore.ts:1534-1553`：`resolveSessionOrchestration()` 首先检查是否有匹配的 `pendingSessionOrchestrationPrefetch`，有就直接 `await pending.promise` 拿到预取结果，省去编排 AI 调用。

```ts
if (pending && pending.sessionId === sessionId && pending.triggerMessageId === ...) {
  result = await pending.promise;  // 直接复用预取
} else {
  result = await api.orchestrateSession(sessionId);  // 重新请求
}
```

**4. 小游戏模式的差异**

小游戏不使用预取机制（`clearPendingSessionOrchestrationPrefetch`），而是严格串行：语音播完 → 等待 `miniGameVoiceWaitEnd`（默认 3 秒最小等待）→ `continueSessionNarrative` → `/game/orchestration/minigame`。

---

### 两种模式对比

| | 普通模式 | 小游戏模式 |
|--|---------|-----------|
| 预取 | 语音播放中后台预取编排 | 不预取，严格串行 |
| 触发时机 | 语音播完 → `waiting_next` → Watch → `auto_advancing` | 语音播完 → 设 `miniGameVoiceWaitEnd` → 等 3s → `continueSessionNarrative` |
| 编排接口 | 复用预取结果（几乎零等待） | `/game/orchestration/minigame`（每次重新调用） |
| 流程控制 | `performContinueSessionNarrative` 内最多 3 轮循环 | 每次只处理一轮编排+发言就返回 |

简单总结：**下一轮编排在上一轮语音播放完成的瞬间由 Watch 触发，但实际的编排 AI 调用已经在语音播放期间通过预取完成了**，所以用户感知的间隔非常短。


## 如何判断为播放完
播放完成的判定机制
"播放完"不是单一判定，而是 3 条路径竞争，谁先触发谁赢：
player.onplay = () => {
    if (!waitForCompletion) finalize(true, "正在播放试听");  // 不等待模式：一开播就算完成
};
player.onended = () => finalize(true, "朗读完成");        // 正常播完
player.onerror = () => finalize(false, "朗读失败");       // 播放出错
player.play().catch(() => finalize(false, "朗读失败"));   // play() 被拒

三条完成路径
路径	触发条件	结果	说明
onended	浏览器 Audio 播到音频末尾	true	正常完成，最理想路径
onerror	解码失败/网络断开/格式不支持	false	失败，进入降级链
超时	estimatePlaybackTimeoutMs(text) 到期	false	兜底保护，防止无限挂起

超时时间估算：estimatePlaybackTimeoutMs

waitForCompletion 的影响
这个参数决定了 onplay 的行为：

waitForCompletion = true（自动语音、小游戏场景）：onplay 不做任何事，必须等 onended/onerror/超时
waitForCompletion = false（手动试听）：onplay 直接 finalize(true)，即"开播即完成"

多段播放：逐段串行
playMessageAudioWithBinding() (ScenePlay.vue:3085-3134) 把长台词按句切分（splitSpeechSegments），每段独立走一遍上面的 Promise 竞态，全部段播完才算整条消息播完：

降级链的完成判定
playMessageAudio() (ScenePlay.vue:3138-3193)：如果 AI TTS 播放失败，会降级到浏览器 Speech API：

一句话总结：播放完靠的是浏览器原生的 Audio.onended 事件，配合基于文本长度的超时兜底（8~45 秒），多段台词逐段串行等待，onended/onerror/超时三路竞争，第一个触发的生效。

### 编排执行流程

```
编排NPC-A → 台词A生成完 → break退出for循环
                                    ↓
                          ScenePlay播放语音A → 播完
                                    ↓
                          status = "waiting_next" → Watch检测到
                                    ↓
                          auto_advancing → continueSessionNarrative()
                                    ↓
                          复用预取结果 → 编排NPC-B → 台词B生成完 → break
                                    ↓
                          ScenePlay播放语音B → 播完
                                    ↓
                          ...循环直到轮到用户发言
```

每个 NPC 的语音都能完整播完，不会被下一个打断。预取机制仍然生效，所以编排步骤几乎零等待，整体节奏感知上不会变慢。

## 静音模式的按字数进行等待
关键代码
ScenePlay.vue
if (!autoVoice.value) {
  store.setRuntimeMessageStatus(currentMessage.id, nextStatusAfterVoice);
  await sleep(estimateRevealDelayMs(messageDisplayContent(currentMessage)));
  return;
}
静音模式（autoVoice = false）时，不播语音，直接把状态设为 waiting_next / waiting_player，然后 按字数估算一个等待时间。

估算公式
ScenePlay.vue
function estimateRevealDelayMs(text: string): number {
  const normalized = sanitizeSpeechText(text);
  const estimated = normalized.length * 90 + 1200;  // 每字90ms + 1.2秒基础
  return Math.max(1400, Math.min(4800, estimated)); // 1.4秒 ~ 4.8秒
}

文字长度	估算时间	说明
5 字	5×90+1200 = 1650ms	取 max → 1.65s
10 字	10×90+1200 = 2100ms	2.1s
20 字	20×90+1200 = 3000ms	3.0s
40 字	40×90+1200 = 4800ms	4.8s（上限）
80 字	80×90+1200 = 8400ms	截断 → 4.8s（上限）

开场白特殊处理
useToonflowStore.ts:173-181：开场白有单独的估算，静音时固定 2 秒：