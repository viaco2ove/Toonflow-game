# no_modify
假设 tool_path=D:\Users\xxx\tools\Toonflow-game\toonflow-game-app\Toonflow-game\tools
upload= D:\Users\xxx\tools\Toonflow-game\toonflow-app-run-db\uploads\

# 改成你实际根目录
$tool_path = "{tool_path}"
# 替换真实upload路径
$upload    = "{upload}"     

1.clone
```
git clone --depth 1  https://github.com/OpenMOSS/MOSS-TTS-Nano.git $tool_path\moss-tts-nano\MOSS-TTS-Nano
```

2. venv
windows
``` bash
cd $tool_path\moss-tts-nano
# wget https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda/Miniconda3-latest-Linux-x86_64.sh -O miniconda.sh
conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/main
conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/r
conda create --prefix ./venv python=3.10 -y -c defaults
conda activate ./venv
conda install -c conda-forge pynini=2.1.6 -y
pip install WeTextProcessing --no-deps
pip install importlib-resources python-dateutil

cd MOSS-TTS-Nano
# powsershell
(Get-Content requirements.txt) -notmatch "WeTextProcessing|pynini|tn" | Set-Content requirements_clean.txt
pip install -r requirements_clean.txt
pip install -e .
```

linux
```
# 1. 进入工具目录 (注意路径分隔符改为斜杠)
cd $tool_path/moss-tts-nano

# (可选) 下载并安装 Miniconda (如果环境中还没有 conda)
# wget https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda/Miniconda3-latest-Linux-x86_64.sh -O miniconda.sh
# bash miniconda.sh -b

# 2. 创建并激活局部 Conda 环境
conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/main
conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/r
conda create --prefix ./venv python=3.10 -y -c defaults
conda activate ./venv

# 3. 安装底层依赖和文本正规化模块
conda install -c conda-forge pynini=2.1.6 -y
pip install WeTextProcessing --no-deps
pip install importlib-resources python-dateutil

# 4. 进入源码目录
cd MOSS-TTS-Nano

# 5. 清洗 requirements.txt
# 使用 Linux 下的 grep -vE 来等效替换 PowerShell 的 -notmatch，剔除这三个包
grep -vE "WeTextProcessing|pynini|tn" requirements.txt > requirements_clean.txt

# 6. 安装剩余依赖和项目本体
pip install -r requirements_clean.txt
pip install -e .
```


# 先单独装离线whl版pynini，跳过源码build
pip install https://mirrors.tuna.tsinghua.edu.cn/pypi/web/wheel/pynini/pynini-2.1.6-cp313-cp313-win_amd64.whl --no-build-isolation
# 再装主包
pip install WeTextProcessing --no-deps

3. 镜像下载 安装
downloading Model from https://www.modelscope.cn to directory: $tool_path/moss-tts-nano/MOSS-TTS-Nano-100M-ONNX\OpenMOSS\MOSS-TTS-Nano-100M-ONNX
MOSS-Audio-Tokenizer-Nano-ONNX

4.测试
cd $tool_path/moss-tts-nano/venv/Scripts/
``` bash
moss-tts-nano.exe generate --backend onnx --onnx-model-dir $tool_path\moss-tts-nano\MOSS-TTS-Nano-100M-ONNX --text 表哥？ --output $upload\user\1\game\voice-preview\66e77f5b-13e6-41a1-96f2-0e7c77e9b089.mp3 --mode voice_clone --prompt-speech /system/voice-presets/generated/npc__/prompt_voice_a1dd065f500c0d72.wav
```

```
# 1. 定义环境变量，按需修改路径
# 改成你实际根目录
$tool_path = "{tool_path}"
# 替换真实upload路径
$upload    = "$upload"       
        

# 2. 切换目录
Set-Location "$tool_path/moss-tts-nano/venv/Scripts/"

# 3. 执行合成命令（PS兼容正反斜杠，自动替换变量）
# 执行命令（已修复所有路径）
.\moss-tts-nano.exe generate `
--backend onnx `
--onnx-model-dir "$tool_path\moss-tts-nano\MOSS-TTS-Nano-100M-ONNX" `
--text "表哥？" `
--output "$upload\user\1\game\voice-preview\66e77f5b-13e6-41a1-96f2-0e7c77e9b089.mp3" `
--mode voice_clone `
--prompt-speech "$upload\system\voice-presets\generated\npc__\prompt_voice_a1dd065f500c0d72.wav"
```

```
set "tool_path=$tool_path"
set "upload=$upload"

cd /d "%tool_path%\moss-tts-nano\venv\Scripts"

moss-tts-nano.exe generate ^
--backend onnx ^
--onnx-model-dir "%tool_path%\moss-tts-nano\MOSS-TTS-Nano-100M-ONNX" ^
--text "表哥？" ^
--output "%upload%\user\1\game\voice-preview\66e77f5b-13e6-41a1-96f2-0e7c77e9b089.mp3" ^
--mode voice_clone ^
--prompt-speech "%upload%\system\voice-presets\generated\npc__\prompt_voice_a1dd065f500c0d72.wav"
```

5.serve
powershell
cd %tool_path%\moss-tts-nano\venv\Scripts
`./moss-tts-nano.exe serve` 最简单命令
`./moss-tts-nano.exe serve -h` 看参数
`./moss-tts-nano.exe serve --backend onnx --execution-provider cpu --cpu-threads 4 --host 127.0.0.1 --port 18084`

```
cd %tool_path%\moss-tts-nano\ 
conda activate ./venv
moss-tts-nano serve --backend onnx --execution-provider cpu --cpu-threads 4 --host 127.0.0.1 --port 18084
```
6.serve 测试
文档
http://127.0.0.1:18084/docs
网页
http://127.0.0.1:18084/

我来帮你看看这个服务,先抓取文档和首页了解接口。
服务是 HTTP 但 WebFetch 自动走了 HTTPS，改为用 PowerShell 直接抓取。
这是一个 **MOSS-TTS-Nano ONNX** 文本转语音服务。以下是接口分析和测试命令：

---

#  serve API 端点概览

| 端点 | 方法 | 用途 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/api/warmup-status` | GET | 预热状态 |
| `/api/demo-prompt-audio/{demo_id}` | GET | 获取示例音频 |
| `/api/generate` | POST | **核心接口** - 文字转语音 |
| `/api/generate-stream/start` | POST | 流式生成(开始) |
| `/api/generate-stream/{stream_id}/status` | GET | 流式状态查询 |
| `/api/generate-stream/{stream_id}/audio` | GET | 流式音频获取 |
| `/api/generate-stream/{stream_id}/close` | POST | 关闭流式任务 |

---

## 测试 CURL

### 1. 健康检查
```bash
curl http://127.0.0.1:18084/health
```

### 2. 基础 TTS 生成（纯文字，最简调用）
```bash
curl 'http://127.0.0.1:18084/api/generate' \
  -H 'Accept: */*' \
  -H 'Accept-Language: zh-CN,zh;q=0.9' \
  -H 'Connection: keep-alive' \
  -H 'Content-Type: multipart/form-data; boundary=----WebKitFormBoundaryRPA0AEqkPrpyC52W' \
  -H 'Origin: http://127.0.0.1:18084' \
  -H 'Referer: http://127.0.0.1:18084/' \
  -H 'Sec-Fetch-Dest: empty' \
  -H 'Sec-Fetch-Mode: cors' \
  -H 'Sec-Fetch-Site: same-origin' \
  -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36' \
  -H 'sec-ch-ua: "Not A(Brand";v="8", "Chromium";v="132", "Google Chrome";v="132"' \
  -H 'sec-ch-ua-mobile: ?0' \
  -H 'sec-ch-ua-platform: "Windows"' \
  --data-raw $'------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="text"\r\n\r\n欢迎关注模思智能、上海创智学院与复旦大学自然语言处理实验室。\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="demo_id"\r\n\r\ndemo-1\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="prompt_audio"; filename="story_gentle_female.wav"\r\nContent-Type: audio/wav\r\n\r\n\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="max_new_frames"\r\n\r\n375\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="voice_clone_max_text_tokens"\r\n\r\n75\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="attn_implementation"\r\n\r\nfixed\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="do_sample"\r\n\r\n1\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="text_temperature"\r\n\r\n1.0\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="text_top_p"\r\n\r\n1.0\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="text_top_k"\r\n\r\n50\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="audio_temperature"\r\n\r\n0.8\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="audio_top_p"\r\n\r\n0.95\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="audio_top_k"\r\n\r\n25\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="audio_repetition_penalty"\r\n\r\n1.2\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="seed"\r\n\r\n0\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="tts_max_batch_size"\r\n\r\n1\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="codec_max_batch_size"\r\n\r\n0\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="enable_text_normalization"\r\n\r\n1\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="enable_normalize_tts_text"\r\n\r\n1\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="cpu_threads"\r\n\r\n4\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W--\r\n'
```

### 3. 指定 音色
```bash
curl 'http://127.0.0.1:18084/api/generate' \
  -H 'Accept: */*' \
  -H 'Accept-Language: zh-CN,zh;q=0.9' \
  -H 'Connection: keep-alive' \
  -H 'Content-Type: multipart/form-data; boundary=----WebKitFormBoundaryRPA0AEqkPrpyC52W' \
  -H 'Origin: http://127.0.0.1:18084' \
  -H 'Referer: http://127.0.0.1:18084/' \
  -H 'Sec-Fetch-Dest: empty' \
  -H 'Sec-Fetch-Mode: cors' \
  -H 'Sec-Fetch-Site: same-origin' \
  -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36' \
  -H 'sec-ch-ua: "Not A(Brand";v="8", "Chromium";v="132", "Google Chrome";v="132"' \
  -H 'sec-ch-ua-mobile: ?0' \
  -H 'sec-ch-ua-platform: "Windows"' \
  --data-raw $'------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="text"\r\n\r\n欢迎关注模思智能、上海创智学院与复旦大学自然语言处理实验室。\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="demo_id"\r\n\r\ndemo-1\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="prompt_audio"; filename="story_gentle_female.wav"\r\nContent-Type: audio/wav\r\n\r\n\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="max_new_frames"\r\n\r\n375\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="voice_clone_max_text_tokens"\r\n\r\n75\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="attn_implementation"\r\n\r\nfixed\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="do_sample"\r\n\r\n1\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="text_temperature"\r\n\r\n1.0\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="text_top_p"\r\n\r\n1.0\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="text_top_k"\r\n\r\n50\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="audio_temperature"\r\n\r\n0.8\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="audio_top_p"\r\n\r\n0.95\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="audio_top_k"\r\n\r\n25\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="audio_repetition_penalty"\r\n\r\n1.2\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="seed"\r\n\r\n0\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="tts_max_batch_size"\r\n\r\n1\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="codec_max_batch_size"\r\n\r\n0\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="enable_text_normalization"\r\n\r\n1\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="enable_normalize_tts_text"\r\n\r\n1\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W\r\nContent-Disposition: form-data; name="cpu_threads"\r\n\r\n4\r\n------WebKitFormBoundaryRPA0AEqkPrpyC52W--\r\n'
```

### 4. 高级参数（自定义采样）
```bash
curl 'http://127.0.0.1:18084/api/generate' \
  -H 'Accept: */*' \
  -H 'Accept-Language: zh-CN,zh;q=0.9' \
  -H 'Connection: keep-alive' \
  -H 'Content-Type: multipart/form-data; boundary=----WebKitFormBoundaryAF0e2bDxiRD5iccp' \
  -H 'Origin: http://127.0.0.1:18084' \
  -H 'Referer: http://127.0.0.1:18084/' \
  -H 'Sec-Fetch-Dest: empty' \
  -H 'Sec-Fetch-Mode: cors' \
  -H 'Sec-Fetch-Site: same-origin' \
  -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36' \
  -H 'sec-ch-ua: "Not A(Brand";v="8", "Chromium";v="132", "Google Chrome";v="132"' \
  -H 'sec-ch-ua-mobile: ?0' \
  -H 'sec-ch-ua-platform: "Windows"' \
  --data-raw $'------WebKitFormBoundaryAF0e2bDxiRD5iccp\r\nContent-Disposition: form-data; name="text"\r\n\r\n欢迎关注模思智能、上海创智学院与复旦大学自然语言处理实验室。\r\n------WebKitFormBoundaryAF0e2bDxiRD5iccp\r\nContent-Disposition: form-data; name="demo_id"\r\n\r\ndemo-1\r\n------WebKitFormBoundaryAF0e2bDxiRD5iccp\r\nContent-Disposition: form-data; name="max_new_frames"\r\n\r\n375\r\n------WebKitFormBoundaryAF0e2bDxiRD5iccp\r\nContent-Disposition: form-data; name="voice_clone_max_text_tokens"\r\n\r\n75\r\n------WebKitFormBoundaryAF0e2bDxiRD5iccp\r\nContent-Disposition: form-data; name="attn_implementation"\r\n\r\nfixed\r\n------WebKitFormBoundaryAF0e2bDxiRD5iccp\r\nContent-Disposition: form-data; name="do_sample"\r\n\r\n1\r\n------WebKitFormBoundaryAF0e2bDxiRD5iccp\r\nContent-Disposition: form-data; name="text_temperature"\r\n\r\n1.0\r\n------WebKitFormBoundaryAF0e2bDxiRD5iccp\r\nContent-Disposition: form-data; name="text_top_p"\r\n\r\n1.0\r\n------WebKitFormBoundaryAF0e2bDxiRD5iccp\r\nContent-Disposition: form-data; name="text_top_k"\r\n\r\n50\r\n------WebKitFormBoundaryAF0e2bDxiRD5iccp\r\nContent-Disposition: form-data; name="audio_temperature"\r\n\r\n0.8\r\n------WebKitFormBoundaryAF0e2bDxiRD5iccp\r\nContent-Disposition: form-data; name="audio_top_p"\r\n\r\n0.95\r\n------WebKitFormBoundaryAF0e2bDxiRD5iccp\r\nContent-Disposition: form-data; name="audio_top_k"\r\n\r\n25\r\n------WebKitFormBoundaryAF0e2bDxiRD5iccp\r\nContent-Disposition: form-data; name="audio_repetition_penalty"\r\n\r\n1.2\r\n------WebKitFormBoundaryAF0e2bDxiRD5iccp\r\nContent-Disposition: form-data; name="seed"\r\n\r\n0\r\n------WebKitFormBoundaryAF0e2bDxiRD5iccp\r\nContent-Disposition: form-data; name="tts_max_batch_size"\r\n\r\n1\r\n------WebKitFormBoundaryAF0e2bDxiRD5iccp\r\nContent-Disposition: form-data; name="codec_max_batch_size"\r\n\r\n0\r\n------WebKitFormBoundaryAF0e2bDxiRD5iccp\r\nContent-Disposition: form-data; name="enable_text_normalization"\r\n\r\n1\r\n------WebKitFormBoundaryAF0e2bDxiRD5iccp\r\nContent-Disposition: form-data; name="enable_normalize_tts_text"\r\n\r\n1\r\n------WebKitFormBoundaryAF0e2bDxiRD5iccp\r\nContent-Disposition: form-data; name="cpu_threads"\r\n\r\n4\r\n------WebKitFormBoundaryAF0e2bDxiRD5iccp--\r\n'
```

### 5. 流式生成流程
```bash
# 5.1 发起流式任务
curl --location 'http://127.0.0.1:18084/api/generate-stream/start' \
--header 'Accept: */*' \
--header 'Accept-Language: zh-CN,zh;q=0.9' \
--header 'Connection: keep-alive' \
--header 'Origin: http://127.0.0.1:18084' \
--header 'Referer: http://127.0.0.1:18084/' \
--header 'Sec-Fetch-Dest: empty' \
--header 'Sec-Fetch-Mode: cors' \
--header 'Sec-Fetch-Site: same-origin' \
--header 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36' \
--header 'sec-ch-ua: "Not A(Brand";v="8", "Chromium";v="132", "Google Chrome";v="132"' \
--header 'sec-ch-ua-mobile: ?0' \
--header 'sec-ch-ua-platform: "Windows"' \
--form 'text="欢迎关注模思智能、上海创智学院与复旦大学自然语言处理实验室。"' \
--form 'demo_id="demo-1"' \
--form 'max_new_frames="375"' \
--form 'voice_clone_max_text_tokens="75"' \
--form 'attn_implementation="fixed"' \
--form 'do_sample="1"' \
--form 'text_temperature="1.0"' \
--form 'text_top_p="1.0"' \
--form 'text_top_k="50"' \
--form 'audio_temperature="0.8"' \
--form 'audio_top_p="0.95"' \
--form 'audio_top_k="25"' \
--form 'audio_repetition_penalty="1.2"' \
--form 'seed="0"' \
--form 'tts_max_batch_size="1"' \
--form 'codec_max_batch_size="0"' \
--form 'enable_text_normalization="1"' \
--form 'enable_normalize_tts_text="1"' \
--form 'cpu_threads="4"'


curl 'http://127.0.0.1:18084/api/generate-stream/start' \
  -H 'Accept: */*' \
  -H 'Accept-Language: zh-CN,zh;q=0.9' \
  -H 'Connection: keep-alive' \
  -H 'Content-Type: multipart/form-data; boundary=----WebKitFormBoundaryBGvXZpLjW4DZsXRd' \
  -H 'Origin: http://127.0.0.1:18084' \
  -H 'Referer: http://127.0.0.1:18084/' \
  -H 'Sec-Fetch-Dest: empty' \
  -H 'Sec-Fetch-Mode: cors' \
  -H 'Sec-Fetch-Site: same-origin' \
  -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36' \
  -H 'sec-ch-ua: "Not A(Brand";v="8", "Chromium";v="132", "Google Chrome";v="132"' \
  -H 'sec-ch-ua-mobile: ?0' \
  -H 'sec-ch-ua-platform: "Windows"' \
  --data-raw $'------WebKitFormBoundaryBGvXZpLjW4DZsXRd\r\nContent-Disposition: form-data; name="text"\r\n\r\n欢迎关注模思智能、上海创智学院与复旦大学自然语言处理实验室。\r\n------WebKitFormBoundaryBGvXZpLjW4DZsXRd\r\nContent-Disposition: form-data; name="demo_id"\r\n\r\ndemo-1\r\n------WebKitFormBoundaryBGvXZpLjW4DZsXRd\r\nContent-Disposition: form-data; name="prompt_audio"; filename="story_gentle_female.wav"\r\nContent-Type: audio/wav\r\n\r\n\r\n------WebKitFormBoundaryBGvXZpLjW4DZsXRd\r\nContent-Disposition: form-data; name="max_new_frames"\r\n\r\n375\r\n------WebKitFormBoundaryBGvXZpLjW4DZsXRd\r\nContent-Disposition: form-data; name="voice_clone_max_text_tokens"\r\n\r\n75\r\n------WebKitFormBoundaryBGvXZpLjW4DZsXRd\r\nContent-Disposition: form-data; name="attn_implementation"\r\n\r\nfixed\r\n------WebKitFormBoundaryBGvXZpLjW4DZsXRd\r\nContent-Disposition: form-data; name="do_sample"\r\n\r\n1\r\n------WebKitFormBoundaryBGvXZpLjW4DZsXRd\r\nContent-Disposition: form-data; name="text_temperature"\r\n\r\n1.0\r\n------WebKitFormBoundaryBGvXZpLjW4DZsXRd\r\nContent-Disposition: form-data; name="text_top_p"\r\n\r\n1.0\r\n------WebKitFormBoundaryBGvXZpLjW4DZsXRd\r\nContent-Disposition: form-data; name="text_top_k"\r\n\r\n50\r\n------WebKitFormBoundaryBGvXZpLjW4DZsXRd\r\nContent-Disposition: form-data; name="audio_temperature"\r\n\r\n0.8\r\n------WebKitFormBoundaryBGvXZpLjW4DZsXRd\r\nContent-Disposition: form-data; name="audio_top_p"\r\n\r\n0.95\r\n------WebKitFormBoundaryBGvXZpLjW4DZsXRd\r\nContent-Disposition: form-data; name="audio_top_k"\r\n\r\n25\r\n------WebKitFormBoundaryBGvXZpLjW4DZsXRd\r\nContent-Disposition: form-data; name="audio_repetition_penalty"\r\n\r\n1.2\r\n------WebKitFormBoundaryBGvXZpLjW4DZsXRd\r\nContent-Disposition: form-data; name="seed"\r\n\r\n0\r\n------WebKitFormBoundaryBGvXZpLjW4DZsXRd\r\nContent-Disposition: form-data; name="tts_max_batch_size"\r\n\r\n1\r\n------WebKitFormBoundaryBGvXZpLjW4DZsXRd\r\nContent-Disposition: form-data; name="codec_max_batch_size"\r\n\r\n0\r\n------WebKitFormBoundaryBGvXZpLjW4DZsXRd\r\nContent-Disposition: form-data; name="enable_text_normalization"\r\n\r\n1\r\n------WebKitFormBoundaryBGvXZpLjW4DZsXRd\r\nContent-Disposition: form-data; name="enable_normalize_tts_text"\r\n\r\n1\r\n------WebKitFormBoundaryBGvXZpLjW4DZsXRd\r\nContent-Disposition: form-data; name="cpu_threads"\r\n\r\n4\r\n------WebKitFormBoundaryBGvXZpLjW4DZsXRd--\r\n'

# 5.2 查询状态 (替换 YOUR_STREAM_ID)
curl 'http://127.0.0.1:18084/api/generate-stream/stream-1780595826432-30e8b92f/status' \
  -H 'Accept: */*' \
  -H 'Accept-Language: zh-CN,zh;q=0.9' \
  -H 'Connection: keep-alive' \
  -H 'Referer: http://127.0.0.1:18084/' \
  -H 'Sec-Fetch-Dest: empty' \
  -H 'Sec-Fetch-Mode: cors' \
  -H 'Sec-Fetch-Site: same-origin' \
  -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36' \
  -H 'sec-ch-ua: "Not A(Brand";v="8", "Chromium";v="132", "Google Chrome";v="132"' \
  -H 'sec-ch-ua-mobile: ?0' \
  -H 'sec-ch-ua-platform: "Windows"'

# 5.3 获取音频 (替换 YOUR_STREAM_ID)
curl http://127.0.0.1:18084/api/generate-stream/YOUR_STREAM_ID/audio -o output.wav

# 5.4 关闭流
curl 'http://127.0.0.1:18084/api/generate-stream/stream-1780596011440-e4a9cccd/close' \
  -X 'POST' \
  -H 'Accept: */*' \
  -H 'Accept-Language: zh-CN,zh;q=0.9' \
  -H 'Connection: keep-alive' \
  -H 'Content-Length: 0' \
  -H 'Origin: http://127.0.0.1:18084' \
  -H 'Referer: http://127.0.0.1:18084/' \
  -H 'Sec-Fetch-Dest: empty' \
  -H 'Sec-Fetch-Mode: cors' \
  -H 'Sec-Fetch-Site: same-origin' \
  -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36' \
  -H 'sec-ch-ua: "Not A(Brand";v="8", "Chromium";v="132", "Google Chrome";v="132"' \
  -H 'sec-ch-ua-mobile: ?0' \
  -H 'sec-ch-ua-platform: "Windows"'
```

### 6. 保存 TTS 结果为文件
```bash
curl -X POST http://127.0.0.1:18084/api/generate \
  -F "text=你好，欢迎使用语音合成服务。" \
  -o output.wav
```

---

## 关键参数说明

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `text` | string | **必填** | 要合成的文字 |
| `demo_id` | string | "" | 音色模板ID |
| `max_new_frames` | int | 375 | 最大生成帧数 |
| `text_temperature` | float | 1.0 | 文字采样温度 |
| `audio_temperature` | float | 0.8 | 音频采样温度 |
| `do_sample` | string | "1" | 是否采样(1=是) |
| `seed` | string | "0" | 随机种子(0=随机) |

# Schemas
## Body_generate_api_generate_post
textstring
demo_idExpand allstring
prompt_audioExpand all(string | null)
max_new_framesExpand allinteger
voice_clone_max_text_tokensExpand allinteger
tts_max_batch_sizeExpand allinteger
codec_max_batch_sizeExpand allinteger
enable_text_normalizationExpand allstring
enable_normalize_tts_textExpand allstring
cpu_threadsExpand allinteger
attn_implementationExpand allstring
do_sampleExpand allstring
text_temperatureExpand allnumber
text_top_pExpand allnumber
text_top_kExpand allinteger
audio_temperatureExpand allnumber
audio_top_pExpand allnumber
audio_top_kExpand allinteger
audio_repetition_penaltyExpand allnumber
seedExpand allstring
## Body_generate_stream_start_api_generate_stream_start_post
textstring
demo_idExpand allstring
prompt_audioExpand all(string | null)
max_new_framesExpand allinteger
voice_clone_max_text_tokensExpand allinteger
tts_max_batch_sizeExpand allinteger
codec_max_batch_sizeExpand allinteger
enable_text_normalizationExpand allstring
enable_normalize_tts_textExpand allstring
cpu_threadsExpand allinteger
attn_implementationExpand allstring
do_sampleExpand allstring
text_temperatureExpand allnumber
text_top_pExpand allnumber
text_top_kExpand allinteger
audio_temperatureExpand allnumber
audio_top_pExpand allnumber
audio_top_kExpand allinteger
audio_repetition_penaltyExpand allnumber
seedExpand allstring
## HTTPValidationError
detailExpand allarray<object>
## ValidationError
locExpand allarray<(string | integer)>
msgstring
typestring
inputany
ctxobject

---