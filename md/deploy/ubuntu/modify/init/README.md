# 初始服务器环境
## 资源文件
[README.md](../tools/README.md)
## 安装 MOSS-TTS-Nano
`git clone --depth 1  https://github.com/OpenMOSS/MOSS-TTS-Nano.git /data/toonflow/tools/moss-tts-nano/MOSS-TTS-Nano
`
`wget https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda/Miniconda3-latest-Linux-x86_64.sh -O miniconda.sh
`
linux
```
# 1. 进入工具目录 (注意路径分隔符改为斜杠)
cd /data/toonflow/tools/moss-tts-nano

# (可选) 下载并安装 Miniconda (如果环境中还没有 conda)
# wget https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda/Miniconda3-latest-Linux-x86_64.sh -O miniconda.sh
# bash miniconda.sh -b

# 2. 创建并激活局部 Conda 环境
conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/main
conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/r
conda create --prefix ./venv python=3.10 -y --override-channels -c conda-forge
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


## 清除旧的虚拟环境
rm -rf /data/toonflow/tools/moss-tts-nano/venv
cd /data/toonflow/tools/moss-tts-nano

## 创建交换文件，增加虚拟内存
sudo fallocate -l 8G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile


## 本地头像分离
[本地头像分离模型安装_linux.md](../../../../modeapi/image/本地头像分离模型安装_linux.md)


### nodejs 22 安装 与加速
[nodejs.md](nodejs.md)