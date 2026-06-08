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

返回二进制数据流

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