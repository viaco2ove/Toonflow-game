3. pip
$tool_path\moss-tts-nano\venv\Scripts\python.exe -m pip install --upgrade pip
4. install
conda create -n toonflow python=3.10 -y
conda activate toonflow
conda install python-dateutil librosa numpy pyyaml -y
pip install torch torchvision torchaudio
conda install -c conda-forge pynini
pip install WeTextProcessing --no-deps
pip install importlib-resources
pip.exe install python-dateutil
cd D:\Users\xxx\tools\Toonflow-game\toonflow-game-app\Toonflow-game\tools\moss-tts-nano\MOSS-TTS-Nano
pip install -r requirements.txt
pip install -e .

$tool_path\moss-tts-nano\venv\Scripts\python.exe -m pip install -e $tool_path\moss-tts-nano\MOSS-TTS-Nano
$tool_path\moss-tts-nano\venv\Scripts\python.exe -m pip install onnxruntime soundfile
$tool_path\moss-tts-nano\venv\Scripts\python.exe -m pip install modelscope
$tool_path\moss-tts-nano\venv\Scripts\python.exe -m pip install WeTextProcessing