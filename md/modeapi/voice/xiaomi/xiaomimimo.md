# xiaomimimo（小米）
## 文档
https://platform.xiaomimimo.com/docs/zh-CN/api/audio/Speech-Recognition
https://platform.xiaomimimo.com/docs/zh-CN/usage-guide/speech-synthesis-v2.5
https://platform.xiaomimimo.com/docs/zh-CN/usage-guide/speech-synthesis

## 模型
TTS 系列 限时免费（暂时免费）
mimo-v2.5-tts、mimo-v2.5-tts-voiceclone、mimo-v2.5-tts-voicedesign、mimo-v2-tts 

## apikey
https://platform.xiaomimimo.com/console/api-keys
使用非codeplan 的 apikey，且不能欠费


## 接口
### 语音识别（MiMo-V2.5-ASR）
当前仅支持 mimo-v2.5-asr 模型。

curl --location --request POST 'https://api.xiaomimimo.com/v1/chat/completions' \
--header "api-key: $MIMO_API_KEY" \
--header 'Content-Type: application/json' \
--data-raw '{
    "model": "mimo-v2.5-asr",
    "messages": [
        {
            "role": "user",
            "content": [
                {
                    "type": "input_audio",
                    "input_audio": {
                        "data": "data:{MIME_TYPE};base64,$BASE64_AUDIO"
                    }
                }
            ]
        }
    ],
    "asr_options": {
        "language": "auto"
    }
}'

支持的格式及对应 MIME 类型：

格式	MIME 类型
wav	audio/wav
mp3	audio/mpeg 或 audio/mp3
调用示例
例如-》"data": "data:audio/mpeg;base64,UklGRiS+BQBXQVZFZm10IBAAAAABAAEAwF0AAIC7AAACABAAZGF0YQC+BQD//wA..“


注意事项

音频数据需通过 input_audio.data 字段以 data URL 格式传入。
使用 asr_options.language 指定语种，未配置时为自动检测。明确语种时建议手动指定，提升识别效果。支持取值：auto、zh、en。

返回数据：
{
    "id": "9545cb02efc34315910e71317270b737",
    "choices": [
        {
            "finish_reason": "stop",
            "index": 0,
            "message": {
                "content": "Yeah, I grabbed a sandwich earlier. It was pretty good, actually. You should try the place down the street sometime.",
                "role": "assistant",
                "audio": null,
                "tool_calls": null,
                "audio_tokens": []
            }
        }
    ],
    "created": 1781071681,
    "model": "mimo-v2.5-asr",
    "object": "chat.completion",
    "usage": {
        "completion_tokens": 26,
        "prompt_tokens": 72,
        "total_tokens": 98,
        "completion_tokens_details": {
            "reasoning_tokens": 0
        },
        "prompt_tokens_details": {
            "audio_tokens": 50,
            "cached_tokens": 4
        },
        "seconds": 8
    }
}

## 语音合成(mimo-v2.5-tts)

curl --location --request POST 'https://api.xiaomimimo.com/v1/chat/completions' \
--header "api-key: $MIMO_API_KEY" \
--header 'Content-Type: application/json' \
--data-raw '{
    "model": "mimo-v2.5-tts",
    "messages": [
        {
            "role": "user",
            "content": "Bright, bouncy, slightly sing-song tone — like you are bursting with good news you can barely hold in. Fast pace, rising pitch at the end."
        },
        {
            "role": "assistant",
            "content": "Hey boss — guess what, guess what? I just got the results back and I actually passed! Not just passed, I got a distinction! I know, I know — you told me I was cutting it close, but hey, here we are. Drinks are on me tonight, okay?"
        }
    ],
    "audio": {
        "format": "wav",
        "voice": "Chloe"
    }
}'

预置音色列表
使用时，可在 {"audio": {"voice": "mimo_default"}} 中设置预置音色。

音色名	Voice ID	语言	性别
MiMo-默认	mimo_default	因部署集群而异，中国集群默认为 冰糖，其他集群默认为 Mia
冰糖	冰糖	中文	女性
茉莉	茉莉	中文	女性
苏打	苏打	中文	男性
白桦	白桦	中文	男性
Mia	Mia	英文	女性
Chloe	Chloe	英文	女性
Milo	Milo	英文	男性
Dean	Dean	英文	男性

支持的模型列表
当前支持 MiMo-V2.5-TTS 系列的三种模型，模型列表如下：

Model ID	功能	音色	注意事项
mimo-v2.5-tts	使用预置精品音色进行语音合成	使用预置音色列表中的精品音色	支持唱歌模式，不支持音色设计与音色复刻
mimo-v2.5-tts-voicedesign	通过文本描述定制音色	通过文本描述自动生成音色，无需预置或音频样本	不支持唱歌模式、预置音色与音色复刻
mimo-v2.5-tts-voiceclone	基于音频样本复刻任意音色	通过音频样本精准复刻音色，实现任意声音的语音合成	不支持唱歌模式、预置音色与音色设计

注意事项

如需体验更佳的唱歌风格，必须在目标文本最开头添加 (唱歌) 标签，格式为：(唱歌)歌词。歌词 建议采用中文，可获得更优合成效果。标签内标识支持以下取值，效果等效：

唱歌、sing、singing

样例：

(怅然)这么多年过去了，再走过那条街，心里一下子空了一块。
(慵懒)再让我睡五分钟……就五分钟，真的，最后一次。
(磁性)夜已经深了，城市还在呼吸。我是今晚陪你的人，欢迎收听《午夜电台》。
(东北话)哎呀妈呀，这天儿也忒冷了吧！你说这风，嗖嗖的，跟刀子似的，割脸啊！
(粤语)呢个真係好正啊！食过一次就唔会忘记！
(唱歌)原谅我这一生不羁放纵爱自由，也会怕有一天会跌倒，Oh no。背弃了理想，谁人都可以，哪会怕有一天只你共我。
在此基础上，我们还支持在文本中任意位置插入 [音频标签]。通过 [音频标签] ，你可以对声音进行细粒度控制，精准调节语气、情绪和表达风格——无论是低声耳语、放声大笑，还是带点小情绪的小吐槽，也可以灵活插入呼吸声，停顿，咳嗽等，都能轻松实现。语速同样可以灵活调整，让每句话都有它该有的节奏。

风格类型	风格示例
语速与节奏	吸气/深呼吸/叹气/长叹一口气/喘息/屏息
情绪状态	紧张/害怕/激动/疲惫/委屈/撒娇/心虚/震惊/不耐烦
语音特征	颤抖/声音颤抖/变调/破音/鼻音/气声/沙哑
哭笑表达	笑/轻笑/大笑/冷笑/抽泣/呜咽/哽咽/嚎啕大哭



返回数据：
{
    "id": "94f961f62a734bc4bd15c8c80a46b764",
    "choices": [
        {
            "finish_reason": "stop",
            "index": 0,
            "message": {
                "content": "",
                "role": "assistant",
                "audio": {
                    "id": "99a08a7ae8f64df48f509cacc0ac6fb6",
                    "data": "UklGRiSaCwBXQVZFZm10IBAAAAABAAEAwF0AAIC7AAACABAAZGF0YQCaCwC4AdYBwwHCAccByQG...",
                    "expires_at": null,
                    "transcript": null
                },
                "tool_calls": null,
                "final_text_preview": "Hey boss — guess what, guess what? I just got the results back and I actually passed! Not just passed, I got a distinction! I know, I know — you told me I was cutting it close, but hey, here we are. Drinks are on me tonight, okay?"
            }
        }
    ],
    "created": 1781071466,
    "model": "mimo-v2.5-tts",
    "object": "chat.completion",
    "usage": {
        "completion_tokens": 101,
        "prompt_tokens": 259,
        "total_tokens": 360,
        "completion_tokens_details": {
            "reasoning_tokens": 0
        },
        "prompt_tokens_details": {
            "cached_tokens": 155
        }
    }
}


## 文本设计音色进行语音合成(mimo-v2.5-tts-voicedesign)
文本设计音色进行语音合成

curl --location --request POST 'https://api.xiaomimimo.com/v1/chat/completions' \
--header "api-key: $MIMO_API_KEY" \
--header 'Content-Type: application/json' \
--data-raw '{
    "model": "mimo-v2.5-tts-voicedesign",
    "messages": [
        {
            "role": "user",
            "content": "Give me a young male tone."
        },
        {
            "role": "assistant",
            "content": "Yes, I had a sandwich."
        }
    ],
    "audio": {
        "format": "wav",
        "optimize_text_preview": true
    }
}'

返回数据：
{
    "id": "936c1f328aae453aa6006f622fbeb1c6",
    "choices": [
        {
            "finish_reason": "stop",
            "index": 0,
            "message": {
                "content": "",
                "role": "assistant",
                "audio": {
                    "id": "e07d62c076aa4088b35de328aa2c5ca4",
                    "data": "UklGRiS+BQBXQVZFZm10IBAAAAABAAEAwF0AAIC7AAACABAAZGF0YQC+BQD//wAA///+///////+/wAA...",
                    "expires_at": null,
                    "transcript": null
                },
                "tool_calls": null,
                "final_text_preview": "Yeah, I grabbed a sandwich earlier — it was pretty good, actually. You should try the place down the street sometime.",
                "reasoning_content": null
            }
        }
    ],
    "created": 1781070873,
    "model": "mimo-v2.5-tts-voicedesign",
    "object": "chat.completion",
    "usage": {
        "completion_tokens": 51,
        "prompt_tokens": 48,
        "total_tokens": 99,
        "completion_tokens_details": {
            "reasoning_tokens": 0
        },
        "prompt_tokens_details": {
            "cached_tokens": 3
        }
    }
}

## 使用音色复刻进行语音合成(mimo-v2.5-tts-voiceclone)
curl --location --request POST 'https://api.xiaomimimo.com/v1/chat/completions' \
--header "api-key: $MIMO_API_KEY" \
--header 'Content-Type: application/json' \
--data-raw '{
    "model": "mimo-v2.5-tts-voiceclone",
    "messages": [
        {
            "role": "user",
            "content": ""
        },
        {
            "role": "assistant",
            "content": "Yes, I had a sandwich."
        }
    ],
    "audio": {
        "format": "wav",
        "voice": "data:{MIME_TYPE};base64,$BASE64_AUDIO"
    }
}'

将音频文件样本转换为 Base64 编码字符串后传入。转换后的 Base64 编码的字符串大小不能超过 10 MB，目前仅支持传入 mp3 和 wav 格式的音频样本文件。

注意事项

请在 Base64 编码前携带前缀：data:{MIME_TYPE};base64,$BASE64_AUDIO

{MIME_TYPE}：音频的 MIME 类型（媒体类型），用于标识音频格式，需替换为实际音频对应的 MIME 值。这里的取值可以为：audio/mpeg（或 audio/mp3），audio/wav。

$BASE64_AUDIO：音频文件的纯 Base64 编码字符串（不含任何前缀）。
例如-》"voice": "data:audio/mpeg;base64,UklGRiS+BQBXQVZFZm10IBAAAAABAAEAwF0AAIC7AAACABAAZGF0YQC+BQD//wA..“


返回数据：
{
    "id": "3271f01ba9f3464fbef1058368c28f68",
    "choices": [
        {
            "finish_reason": "stop",
            "index": 0,
            "message": {
                "content": "",
                "role": "assistant",
                "audio": {
                    "id": "45365643d16f4289acf2d2299cba7740",
                    "data": "UklGRiRoAQBXQVZFZm10IBAAAAABAAEAwF0AAIC7AAACABAAZGF0YQBoAQD/////AAAAAP....",
                    "expires_at": null,
                    "transcript": null
                },
                "tool_calls": null,
                "final_text_preview": "Yes, I had a sandwich."
            }
        }
    ],
    "created": 1781071323,
    "model": "mimo-v2.5-tts-voiceclone",
    "object": "chat.completion",
    "usage": {
        "completion_tokens": 14,
        "prompt_tokens": 86,
        "total_tokens": 100,
        "completion_tokens_details": {
            "reasoning_tokens": 0
        },
        "prompt_tokens_details": {
            "cached_tokens": 9
        }
    }
}
