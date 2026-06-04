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

3. 
# 先单独装离线whl版pynini，跳过源码build
pip install https://mirrors.tuna.tsinghua.edu.cn/pypi/web/wheel/pynini/pynini-2.1.6-cp313-cp313-win_amd64.whl --no-build-isolation
# 再装主包
pip install WeTextProcessing --no-deps

5. 5.镜像下载 安装
downloading Model from https://www.modelscope.cn to directory: $tool_path/moss-tts-nano/MOSS-TTS-Nano-100M-ONNX\OpenMOSS\MOSS-TTS-Nano-100M-ONNX
MOSS-Audio-Tokenizer-Nano-ONNX

6.测试
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