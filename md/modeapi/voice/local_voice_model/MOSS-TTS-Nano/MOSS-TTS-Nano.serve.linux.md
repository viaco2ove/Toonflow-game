# no_modify
## linux
(`base) root@VM-0-5-ubuntu:/data/toonflow/tools/moss-tts-nano/venv/bin# ./moss-tts-nano serve --backend onnx --execution-provider cpu --cpu-threads 1 --host 127.0.0.1 --port 18084`
报错：
```
building fst for en_normalizer ...

^CTraceback (most recent call last):

  File "/data/toonflow/tools/moss-tts-nano/venv/bin/./moss-tts-nano", line 6, in <module>

    sys.exit(main())

  File "/data/toonflow/tools/moss-tts-nano/MOSS-TTS-Nano/moss_tts_nano/cli.py", line 406, in main

    return int(args.handler(args))

  File "/data/toonflow/tools/moss-tts-nano/MOSS-TTS-Nano/moss_tts_nano/cli.py", line 399, in _run_serve
```
MOSS-TTS-Nano 启动时，发现你本地的 models 文件夹里没有那两个 ONNX 模型文件。

于是它非常“贴心”地自动调用 huggingface_hub 去官方仓库（Hugging Face）下载。
然后报错！


`export HF_ENDPOINT=https://hf-mirror.com && ./moss-tts-nano serve --backend onnx --execution-provider cpu --cpu-threads 1 --host 127.0.0.1 --port 18084`
下载模型...
运行成功！