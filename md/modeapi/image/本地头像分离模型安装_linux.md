[本地头像分离模型安装.md](%E6%9C%AC%E5%9C%B0%E5%A4%B4%E5%83%8F%E5%88%86%E7%A6%BB%E6%A8%A1%E5%9E%8B%E5%AE%89%E8%A3%85.md)
# 安装python
sudo apt update && sudo apt install python-is-python3 -y

python -m venv /data/toonflow/tools/avatar-matting/birefnet/venv
source /data/toonflow/tools/avatar-matting/birefnet/venv/bin/activate

python -m pip install --upgrade pip setuptools wheel

## MODNet 本地
```
python -c "import pathlib, urllib.request; p=pathlib.Path(r'/data/toonflow/tools/avatar-matting/birefnet/model-cache/modnet_photographic_portrait_matting.onnx'); p.parent.mkdir(parents=True, exist_ok=True); urllib.request.urlretrieve('https://huggingface.co/DavG25/modnet-pretrained-models/resolve/main/models/modnet_photographic_portrait_matting.onnx', p)"
```
```
python /data/toonflow/ools/avatar-matting/birefnet/run_modnet.py --warmup --model-path /data/toonflow/tools/avatar-matting/birefnet/model-cache/modnet_photographic_portrait_matting.onnx
```


## 一次性完整安装示例

### BiRefNet（质量高,资源消耗大，对于纯cpu工作速度非常慢，性价比略低）

``` linux
python -m venv /data/toonflow/tools/avatar-matting/birefnet/venv
source /data/toonflow/tools/avatar-matting/birefnet/venv/bin/activate
python -m pip install --upgrade pip setuptools wheel
python -m pip install rembg==2.0.67 onnxruntime==1.22.1 pillow numpy
python /data/toonflow/tools/avatar-matting/birefnet/run_birefnet.py --warmup --model birefnet-portrait
```

### MODNet（质量一般偏高,资源消耗小，速度快，性价比更高）
由于速度快，可以增加秒数和秒帧数来达到更好的体验
``` linux
python -m venv /data/toonflow/tools/avatar-matting/birefnet/venv
source /data/toonflow/tools/avatar-matting/birefnet/venv/bin/activate
python -m pip install --upgrade pip setuptools wheel
python -m pip install onnxruntime==1.22.1 pillow numpy rembg==2.0.67
python -c "import pathlib, urllib.request; p=pathlib.Path(r'/data/toonflow/tools/avatar-matting/birefnet/model-cache/modnet_photographic_portrait_matting.onnx'); p.parent.mkdir(parents=True, exist_ok=True); urllib.request.urlretrieve('https://huggingface.co/DavG25/modnet-pretrained-models/resolve/main/models/modnet_photographic_portrait_matting.onnx', p)"
python /data/toonflow/tools/avatar-matting/birefnet/run_modnet.py --warmup --model-path /data/toonflow/tools/avatar-matting/birefnet/model-cache/modnet_photographic_portrait_matting.onnx
```

#### 使用国内镜像：
``` linux
python -c "import pathlib, urllib.request; p=pathlib.Path('/data/toonflow/tools/avatar-matting/birefnet/model-cache/modnet_photographic_portrait_matting.onnx'); p.parent.mkdir(parents=True, exist_ok=True); urllib.request.urlretrieve('https://hf-mirror.com/DavG25/modnet-pretrained-models/resolve/main/models/modnet_photographic_portrait_matting.onnx', p)"
```

查看
/data/toonflow/tools/avatar-matting/birefnet/model-cache/modnet_photographic_portrait_matting.onnx