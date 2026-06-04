假设 tool_path=D:\Users\xxx\tools\Toonflow-game\toonflow-game-app\Toonflow-game\tools
upload= D:\Users\xxx\tools\Toonflow-game\toonflow-app-run-db\uploads\
1.clone
```
git clone --depth 1 https://github.com/OpenMOSS/MOSS-TTS-Nano.git {tool_path}\moss-tts-nano\MOSS-TTS-Nano
```
2. venv
{tool_path}\moss-tts-nano\venv
3. pip
{tool_path}\moss-tts-nano\venv\Scripts\python.exe -m pip install --upgrade pip
4. install
{tool_path}\moss-tts-nano\venv\Scripts\python.exe -m pip install -e {tool_path}\moss-tts-nano\MOSS-TTS-Nano
{tool_path}\moss-tts-nano\venv\Scripts\python.exe -m pip install onnxruntime soundfile
{tool_path}\moss-tts-nano\venv\Scripts\python.exe -m pip install modelscope

5.镜像下载 安装
downloading Model from https://www.modelscope.cn to directory: {tool_path}/moss-tts-nano/MOSS-TTS-Nano-100M-ONNX\OpenMOSS\MOSS-TTS-Nano-100M-ONNX
MOSS-Audio-Tokenizer-Nano-ONNX
6.测试
cd {tool_path}/moss-tts-nano/venv/Scripts/
``` bash
moss-tts-nano.exe generate --backend onnx --onnx-model-dir {tool_path}\moss-tts-nano\MOSS-TTS-Nano-100M-ONNX --text 表哥？ --output {upload}\user\1\game\voice-preview\66e77f5b-13e6-41a1-96f2-0e7c77e9b089.mp3 --mode voice_clone --prompt-speech /system/voice-presets/generated/npc__/prompt_voice_a1dd065f500c0d72.wav
```

```
# 1. 定义环境变量，按需修改路径
# 改成你实际根目录
$tool_path = "{tool_path}"
# 替换真实upload路径
$upload    = "{upload}"       
        

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
set "tool_path={tool_path}"
set "upload={upload}"

cd /d "%tool_path%\moss-tts-nano\venv\Scripts"

moss-tts-nano.exe generate ^
--backend onnx ^
--onnx-model-dir "%tool_path%\moss-tts-nano\MOSS-TTS-Nano-100M-ONNX" ^
--text "表哥？" ^
--output "%upload%\user\1\game\voice-preview\66e77f5b-13e6-41a1-96f2-0e7c77e9b089.mp3" ^
--mode voice_clone ^
--prompt-speech "%upload%\system\voice-presets\generated\npc__\prompt_voice_a1dd065f500c0d72.wav"
```