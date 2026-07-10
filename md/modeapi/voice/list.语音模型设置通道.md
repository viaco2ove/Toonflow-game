# no_modify
# 语音模型设置通道
minimax:vulue=minimax
阿里百炼:vulue=aliyun_direct
local CosyVoice(ai_voice_tts):vulue=ai_voice_tts
## 语音设计
### 阿里百炼
- qwen3-tts-vd-2026-01-26:qwen-voice-design->qwen3-tts-vd-2026-01-26
- cosyvoice-v3-plus:voice-enrollment->cosyvoice-v3-plus

### minimax
- voice_design:接口没有模型选择的参数

## 语音克隆
[README.md](../../../res/voice-presets/can_clone/README.md)


### 阿里百炼
- voice-enrollment：创建 cosyvoice-v3-* 专属音色，CosyVoice 系列合成语音
- qwen-voice-enrollment：创建 qwen3-tts-vc-* 专属音色，qwen 系列合成语音

### local CosyVoice(ai_voice_tts)
https://github.com/viaco2ove/ai_voice_tts.git
- /v1/tts/clone_upload

### MiniMax
- speech-2.8-hd
- speech-2.8-turbo
- speech-2.6-hd
- speech-2.6-turbo
- speech-02-hd
- speech-02-turbo
- speech-01-hd
- speech-01-turbo

## 语音合成
### 阿里百炼
- cosyvoice-v3-flash
- cosyvoice-v3-plus
- cosyvoice-v3.5-flash
- cosyvoice-v3.5-plus
- qwen3-tts-flash
- qwen-tts-latest
- qwen3-tts

### local CosyVoice(ai_voice_tts)
/v1/tts

### minimax
- speech-2.8-hd
- speech-2.8-turbo
- speech-2.6-hd
- speech-2.6-turbo
- speech-02-hd
- speech-02-turbo
- speech-01-hd
- speech-01-turbo

## 语音识别
### 阿里百炼
- qwen3-asr-flash

### local CosyVoice(ai_voice_tts)
- fun-asr-realtime



# 语音模型的协同工作
## 语音设计
当前项目的语音设计的目的是产生一个用于克隆的参考音色文件。所以随便配。
## 预设音色
角色在根据合成音色模型获得预设列表
### 但是一下六个音色是走的克隆通道，因为这是本项目的系统克隆预设，不是模型的预设：
标准男声(克隆)
标准女声(克隆)
温柔女声(克隆)
活泼女声(克隆)
沉稳男声(克隆)
讲述者音色(克隆)

### 模型预设音色
根据设置的合成语音模型加载不同的模型预设音色列表

### 生成音色文件
不管什么模型，选择什么预设音色。 
点击“生成音色文件”都要生成符合要求的用于克隆的参考音色文件：
要求说明：
[README.md](../../../res/voice-presets/can_clone/README.md)

## 语音合成与语音克隆设置的一致性
供应商的一致性：语音合成与语音克隆必须使用相同的供应商
模型通道的一致性：语音合成与语音克隆必须使用匹配的模型
CosyVoice 做克隆，必须指定模型（如 cosyvoice-v3.5-plus 等），这个音色只认这个模型，其他模型（包括 Qwen‑TTS）完全不认

## 生成音色文件
音色设计/音色混合/预设音色/克隆音色
里的“生成音色文件” 按钮也就是generateBindingVoice 接口。
不管什么模型，选择什么预设音色。 
点击“生成音色文件”都要生成符合要求的用于克隆的参考音色文件：
要求说明：
[README.md](../../../res/voice-presets/can_clone/README.md)

## ai故事游玩和章节调试时
重点：克隆参考音色文件非常重要。它才是换模型换供应商的最好兼容方案。
- 会判断voice_id 是否与游玩的用户设置的模型吻合。
不吻合的重新走克隆通道重新生成voice_id 存到用户的”故事存档/内存“里。
- 音色过期了，会新走克隆通道重新生成voice_id
- 兜底音色，角色设置参考音色文件的会使用兜底音色合成语音