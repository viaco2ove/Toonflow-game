# 本地头像分离模型安装（Linux）

## 安装 ffmpeg

ffmpeg 是视频转 GIF 功能的必要依赖，必须在安装头像分离模型之前装好。

``` linux
sudo apt update
sudo apt install ffmpeg -y
```

验证安装：
``` linux
ffmpeg -version
```

> 注意：视频转动图（角色上传 MP4 转 GIF）功能依赖 ffmpeg，请确保已安装后再上传视频。

## 一键完整安装（含 ffmpeg）

### BiRefNet（质量高，资源消耗大，纯 CPU 速度较慢）
``` linux
# 安装 ffmpeg（必须）
sudo apt update && sudo apt install ffmpeg -y

# 创建虚拟环境
python -m venv /data/toonflow/tools/avatar-matting/birefnet/venv
source /data/toonflow/tools/avatar-matting/birefnet/venv/bin/activate

# 安装依赖
python -m pip install --upgrade pip setuptools wheel
#python -m pip install rembg==2.0.67 onnxruntime==1.22.1 pillow numpy
python -m pip install rembg onnxruntime pillow numpy

# 预热模型
python /data/toonflow/tools/avatar-matting/birefnet/run_birefnet.py --warmup --model birefnet-portrait
```

### MODNet（质量中上，资源消耗小，速度快，性价比高）
``` linux
# 安装 ffmpeg（必须）
sudo apt update && sudo apt install ffmpeg -y

# 创建虚拟环境
python -m venv /data/toonflow/tools/avatar-matting/birefnet/venv
source /data/toonflow/tools/avatar-matting/birefnet/venv/bin/activate

# 安装依赖
python -m pip install --upgrade pip setuptools wheel
# python -m pip install onnxruntime==1.22.1 pillow numpy rembg==2.0.67
python -m pip install rembg onnxruntime pillow numpy

# 下载 MODNet 模型
python -c "import pathlib, urllib.request; p=pathlib.Path(r'/data/toonflow/tools/avatar-matting/birefnet/model-cache/modnet_photographic_portrait_matting.onnx'); p.parent.mkdir(parents=True, exist_ok=True); urllib.request.urlretrieve('https://huggingface.co/DavG25/modnet-pretrained-models/resolve/main/models/modnet_photographic_portrait_matting.onnx', p)"

# 预热模型
python /data/toonflow/tools/avatar-matting/birefnet/run_modnet.py --warmup --model-path /data/toonflow/tools/avatar-matting/birefnet/model-cache/modnet_photographic_portrait_matting.onnx
```
