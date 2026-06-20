# 硅基流动(siliconflow) 语音接口
==文档==
https://api-docs.siliconflow.cn/docs/api/audio-speech-post
https://api-docs.siliconflow.cn/docs/userguide/capabilities/text-to-speech
## 模型
https://cloud.siliconflow.cn/me/models?types=speech
- FunAudioLLM/CosyVoice2-0.5B
价格： ¥0.050000/ 千字符（UTF-8）
效果：还行
- fnlp/MOSS-TTSD-v0.5
价格： ¥0.050000/ 千字符（UTF-8）
效果：非常诡异，不按文本来


## 例子
### 创建文本转语音请求
curl --location 'https://api.siliconflow.cn/v1/audio/speech' \
--header 'Authorization: Bearer sk-xx' \
--header 'Content-Type: application/json' \
--data '{
  "model": "fnlp/MOSS-TTSD-v0.5",
  "input": "你站在桥上看风景，看风景的人在楼上看你。明月装饰了你的窗子，你装饰了别人的梦",
  "voice": "fnlp/MOSS-TTSD-v0.5:alex",
  "response_format": "mp3",
  "stream": true
}'

#### 返回二进制数据流

#### 参数：
端点：/audio/speech，具体使用可参考https://api-docs.siliconflow.cn/docs/api/audio-speech-post
主要请求参数：
model：用于语音合成的模型，支持的https://cloud.siliconflow.cn/models?types=speech。
input：待转换为音频的文本内容。
voice：参考音色，支持系统预置音色、用户预置音色、用户动态音色。
speed：可以控制音频速度，float类型，默认值是1.0，可选范围是[0.25,4.0]；
gain：音频增益，单位dB，可以控制音频声音大小，float类型，默认值是0.0，可选范围是[-10,10]；
response_format：控制输出格式，支持 mp3、opus、wav 和 pcm 格式。在选择不同的输出格式时，输出的采样率也会有所不同。
sample_rate：可以控制输出采样率，对于不同的视频输出类型，默认值和可取值范围均不同，具体如下：
opus: 目前只支持48000hz
wav, pcm: 支持 (8000, 16000, 24000, 32000, 44100), 默认44100
mp3: 支持(32000, 44100), 默认44100
注意：输入内容不要加空格，参考音频要小于30s
#### 情绪语言控制：
curl --location 'https://api.siliconflow.cn/v1/audio/speech' \
--header 'Authorization: Bearer xxxx' \
--header 'Content-Type: application/json' \
--data '{
	"model": "FunAudioLLM/CosyVoice2-0.5B",
	"input": "你能用粤语说吗？<|endofprompt|>今天真是太开心了，马上要放假了！I'\''m so happy, Spring Festival is coming!",
	"voice": "speech:clone_mq450a3u_1:pyr3bb9d75:frkblqhylzextbhnwhqb",
	"response_format": "mp3",
	"stream": false
}'
curl --location 'https://api.siliconflow.cn/v1/audio/speech' \
--header 'Authorization: Bearer xxxx' \
--header 'Content-Type: application/json' \
--data '{
	"model": "FunAudioLLM/CosyVoice2-0.5B",
	"input": "你能用很悲伤很愤怒的情绪怒吼着说吗？<|endofprompt|>今天真是太开心了，马上要放假了！I'\''m so happy, Spring Festival is coming!",
	"voice": "speech:clone_mq450a3u_1:pyr3bb9d75:frkblqhylzextbhnwhqb",
	"response_format": "mp3",
	"stream": false
}' 

#### <|endofprompt|>
"<|endofprompt|>" 前面可以加一些提示语，比如“<|endofprompt|>”，表示提示语的结束，之后的内容将作为输入文本。
如：
- 你能用很悲伤很愤怒的情绪怒吼着说吗？<|endofprompt|> xxx
有情绪变化，但是效果一般
- 你能用粤语来说吗？<|endofprompt|> xxx
效果一般

### 获取参考音频列表
curl --request GET \
  --url https://api.siliconflow.cn/v1/audio/voice/list \
  --header 'Authorization: Bearer <token>'

返回
{
  "results": [
    {
      "model": "fishaudio/fish-speech-1.4",
      "customName": "your-voice-name",
      "text": "在一无所知中, 梦里的一天结束了，一个新的轮回便会开始",
      "uri": "speech:your-voice-name:xxx:xxx"
    }
  ]
}

### 上传参考音频
curl -X POST "https://api.siliconflow.cn/v1/uploads/audio/voice" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "file=@test.mp3" \
  -F "model=FunAudioLLM/CosyVoice2-0.5B" \
  -F "customName=your-voice-name" \
  -F "text=慢工出细活，再给我两分钟，你马上就能见识到超梦分析的厉害了"  

参数：
text:必须通过语音识别生成。不能乱写！不能为空！
model:nlp/MOSS-TTSD-v0.5, FunAudioLLM/CosyVoice2-0.5B

返回：
{
  "uri": "speech:your-voice-name:xxx:xxx"
}

### 创建语音转文本请求
curl --request POST \
  --url https://api.siliconflow.cn/v1/audio/transcriptions \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -F "file=@path/to/your/audio.mp3" \
  -F "model=FunAudioLLM/SenseVoiceSmall"
支持模型：
FunAudioLLM/SenseVoiceSmall
TeleAI/TeleSpeechASR
返回
{
  "text": "string"
}