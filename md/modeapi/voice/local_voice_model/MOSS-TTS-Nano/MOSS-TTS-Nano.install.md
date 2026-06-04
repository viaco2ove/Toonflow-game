假设 tool_path=D:\Users\xxx\tools\Toonflow-game\toonflow-game-app\Toonflow-game\tools
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
downloading Model from https://www.modelscope.cn to directory: D:/Users/viaco/tools/Toonflow-game/toonflow-game-app/Toonflow-game/tools/moss-tts-nano/MOSS-TTS-Nano-100M-ONNX\OpenMOSS\MOSS-TTS-Nano-100M-ONNX
MOSS-Audio-Tokenizer-Nano-ONNX
6.测试