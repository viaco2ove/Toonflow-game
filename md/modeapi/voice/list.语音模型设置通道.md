# no_modify
# 语音模型设置通道
## 语音设计
### 阿里百炼
- qwen3-tts-vd-2026-01-26:qwen-voice-design->qwen3-tts-vd-2026-01-26
- cosyvoice-v3-plus:voice-enrollment->cosyvoice-v3-plus

### minimax
- voice_design:接口没有模型选择的参数

## 语音克隆
### 阿里百炼
- voice-enrollment：创建 cosyvoice-v3-* 专属音色
- qwen-voice-enrollment：创建 qwen3-tts-vc-* 专属音色

### local CosyVoice
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
- qwen-tts
- qwen-tts-latest

### local CosyVoice
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

### local CosyVoice
- fun-asr-realtime
