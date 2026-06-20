# 克隆音色的参考文件（音色文件）格式等要求
先查看
[list.语音模型设置通道.md](../../../md/modeapi/voice/list.%E8%AF%AD%E9%9F%B3%E6%A8%A1%E5%9E%8B%E8%AE%BE%E7%BD%AE%E9%80%9A%E9%81%93.md)
[阿里云语音模型.md](../../../md/modeapi/voice/%E9%98%BF%E9%87%8C%E4%BA%91%E8%AF%AD%E9%9F%B3%E6%A8%A1%E5%9E%8B.md)
[minimax语音模型.md](../../../md/modeapi/voice/minimax%E8%AF%AD%E9%9F%B3%E6%A8%A1%E5%9E%8B.md)
# 例如某些模型的预设音色如何转化为可克隆的音色文件
## 文字
不管任何形式生成的音频文件
真正用于克隆的参考文件（音色文件）必须是如下文字内容人：
`恭喜，已成功复刻并合成了属于自己的声音。现在，请保持自然、清晰、稳定的语气，完整读出这段固定示例文本，用于校验音色、节奏与发音质量。愿这份新的声音陪伴你进入故事，清楚表达每一句话，也让角色在之后的对话中拥有稳定、真实、可辨识的声音表现。
`

## 音频格式
### 阿里要求
#### 上传参考音频文件时支持以下格式（通过 base64 上传）：

MIME Type	扩展名
audio/wav / audio/x-wav	.wav
audio/mpeg / audio/mp3	.mp3
audio/ogg	.ogg
audio/webm	.webm

#### 系统内部通过 ffmpeg 做格式归一化（audioNormalize.ts），规则如下：

目标格式：PCM WAV（16bit, mono）
目标采样率：24kHz（pcm_s16le -ar 24000 -ac 1）
触发时机：语音设计结果在进入 clone 通道前强制转换，防止"float WAV / 封装格式"被阿里拒
ffmpeg 路径发现顺序：

环境变量 FFMPEG_PATH
固定路径 D:\Program Files\ffmpeg-master-latest-win64-gpl-shared\bin\ffmpeg.exe 等
系统 PATH（where ffmpeg）

####
阿里云 DecoderError 错误码对应的正确格式
错误码 Audio.DecoderError / 提示 detect audio failed 时，说明参考音频不符合要求：

正确格式：采样率 > 16kHz 的 16bit WAV / MP3 / M4A / AAC，且音频中有清晰有效的人声（不能是纯音乐/纯噪音/无声）

五、阿里云直连支持的采样率枚举
代码中明确枚举的合法采样率：

8000 / 16000 / 22050 / 24000 / 44100 / 48000
推荐使用 24000 Hz 或 16000 Hz（语音场景最稳定）。

### minimax 要求
项目	要求
格式	MP3、M4A、WAV
最短时长	10 秒
最长时长	5 分钟
最大体积	20 MB

## 兼容角度
音色克隆测试使用：
使用 [prompt_voice_test.wav](prompt_voice_test.wav)

格式为wav
文字:恭喜，已成功复刻并合成了属于自己的声音。现在，请保持自然、清晰、稳定的语气，完整读出这段固定示例文本，用于校验音色、节奏与发音质量。愿这份新的声音陪伴你进入故事，清楚表达每一句话，也让角色在之后的对话中拥有稳定、真实、可辨识的声音表现。
时长：29s
文件大小：1.35 MB 
采样率： 24000 Hz 
比特深度：16bit

### 上传参考音频时的处理
需要进行ffmpeg 格式化成可以用于克隆的参考音频文件
1.格式不对就转格式
2.长度不对就自己拼接自己。