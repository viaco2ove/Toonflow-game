export HF_ENDPOINT=https://hf-mirror.com && ./moss-tts-nano serve --backend onnx --execution-provider cpu --cpu-threads 1 --host 127.0.0.1 --port 18084

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

# MOSS-TTS-Nano serve 命令参数全说明表
**严格对照你本地 `--help` 输出的原生参数，无任何额外私货/不存在的参数**，核心低配/磁盘优化参数已加粗标注。

| 参数分类 | 参数名 | 可选值/类型 | 核心官方意义 | 适用场景 | 低配部署/磁盘防爆满优化建议 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **核心性能&磁盘控制类（你最关心）** | **`--cpu-threads`** | 正整数 | ONNX 后端专属：设置 onnxruntime 推理时的 CPU 内部运算线程数 | 仅 ONNX 后端生效 | ✅ **低配必设，固定为 2**<br>不填默认自动拉满全部 CPU 核心，会导致算子编译缓存大批量落地磁盘，是 33MB/s 狂写盘的核心元凶 |
| | **`--output-dir`** | 本地文件夹路径 | 生成的语音 wav 音频文件的存放目录 | 全后端通用 | ✅ **低配必设，指向系统临时目录**<br>不填默认生成在当前程序目录，反复调用会持续堆积音频文件，最终占满系统盘<br>Windows 设为 `%TEMP%\moss_tts_wav`，Linux 设为 `/tmp/moss_tts_wav`，系统自动定期清理 |
| | **`--backend`** | `pytorch` / `onnx` | 选择语音推理的核心引擎 | 全场景通用 | ✅ **低配固定选 `onnx`**<br>`onnx` 是轻量生产级引擎，低内存/低CPU占用，不依赖显卡；`pytorch` 是开发调试用，吃显存/内存/磁盘，低配完全不推荐 |
| | **`--execution-provider`** | `cpu` / `cuda` | ONNX 后端专属：设置 ONNX 运行的硬件设备 | 仅 ONNX 后端生效 | ✅ **低配固定选 `cpu`**<br>`cuda` 仅支持 NVIDIA 显卡，需要额外安装 onnxruntime-gpu 依赖，无显卡/低配服务器完全用不到 |
| | `--device` | `auto` / `cpu` / `cuda` | 全局设置模型推理的执行设备 | 全后端通用 | 低配默认 `auto` 即可，会自动适配可用的 CPU/显卡，无需手动修改 |
| | `--max-new-frames` | 正整数 | ONNX 后端专属：限制单次生成的音频最大帧数（控制音频时长） | 仅 ONNX 后端生效 | 低配按需设置合理值，避免生成超长音频文件占用磁盘，日常使用默认不填即可 |
| **模型配置类（低配无需修改）** | `--checkpoint` | HuggingFace 仓库 ID / 本地模型路径 | PyTorch 后端专属：MOSS-TTS-Nano 模型的来源路径 | 仅 PyTorch 后端生效 | ONNX 后端完全用不到，无需填写 |
| | `--audio-tokenizer` / `--audio_tokenizer` | HuggingFace 仓库 ID / 本地分词器路径 | PyTorch 后端专属：MOSS-Audio-Tokenizer-Nano 分词器的来源路径 | 仅 PyTorch 后端生效 | ONNX 后端完全用不到，无需填写 |
| | `--onnx-model-dir` | 本地文件夹路径 | ONNX 后端专属：browser_onnx 模型的存放目录 | 仅 ONNX 后端生效 | 默认使用程序自动下载的官方模型路径，无需手动修改 |
| | `--dtype` | `auto` / `float32` / `float16` / `bfloat16` | 模型权重的计算精度 | 全后端通用 | 低配默认 `auto` 即可，自动适配硬件，手动修改无明显性能提升 |
| | `--attn-implementation` | `auto` / `sdpa` / `flash_attention_2` / `eager` | 注意力机制的加速实现方式 | 全后端通用 | 低配默认 `auto` 即可，自动选择最优加速方案，手动修改无低配优化效果 |
| **网络服务类** | `--host` | IP 地址 | 服务监听的主机 IP 地址 | 全场景通用 | 本地使用默认 `127.0.0.1` 即可，需要外网访问按需修改为 `0.0.0.0` |
| | `--port` | 端口号（1-65535） | 服务监听的端口号 | 全场景通用 | 按需设置，比如你当前用的 `18084`，避免和其他服务端口冲突即可 |
| | `--share` | 无值，仅开关 | 兼容内网穿透的参数，无实际核心功能 | 仅需要公网临时访问时使用 | 低配/本地部署完全不需要开启，无任何优化效果 |

---

## 低配部署最终最简结论
1. 你当前加的 `--cpu-threads 2` 是**官方原生唯一的低配限流参数**，完全正确，能从源头减少 CPU 占用和磁盘缓存写入；
2. 唯一需要补充的防爆盘参数是 `--output-dir`，把生成的音频指向系统临时目录，避免文件持续堆积；
3. 其余 90% 的参数都是模型/网络配置，低配部署完全不需要修改，保持默认即可。

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