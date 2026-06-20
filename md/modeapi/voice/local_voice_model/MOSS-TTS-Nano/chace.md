方案 A：单次 CLI 调用（临时内存缓存，最简单，你现在用）
同 PS 窗口连续执行 2 条，第二条自动走缓存、不用重解析音频：
powershell
./moss-tts-nano.exe generate --prompt-audio-path assets/audio/zh_1.wav --text "第一段" --output o1.wav
./moss-tts-nano.exe generate --prompt-audio-path assets/audio/zh_1.wav --text "第二段" --output o2.wav
关掉 PS 再新开，缓存清空，重新解析 wav。
方案 B：常驻 serve 服务（全局内存缓存，最优做游戏批量生成）
启动服务预加载音色，全程只解码 1 次 wav，所有接口请求永久读缓存：
powershell
`./moss-tts-nano.exe serve` 最简单命令
`./moss-tts-nano.exe serve -h` 看参数
`./moss-tts-nano.exe serve --backend onnx --execution-provider cpu --cpu-threads 4 --host 127.0.0.1 --port 18084`
启动完调用接口只用传音色文件名zh_1.wav，不用传完整路径，自动取缓存 refcode。
方案 C：永久离线缓存（保存 ref 编码到文件，重启也不用读 wav）
不用 CLI，用项目 python 脚本把 wav 预编译成二进制缓存文件：
powershell
python finetuning/prepare_data.py --single-ref-encode assets/audio/zh_1.wav --out-cache zh_1.cache

## 两种复用音色方案（彻底不用重复解析原音频）

方案 1：手动预提取 ref_code 文件（最推荐，等效自建 VoiceID）
底层 Tokenizer 可以单独把参考 wav 预编码成二进制 ref_code 文件（几十～几百字节），保存本地当作你的「自定义音色 ID 文件」，后续合成直接加载编码，跳过音频解码 + 特征提取，毫秒级载入音色。
bash
运行
#1 提前一次性提取音色编码（只跑1次，替代反复传wav）
python codec_extract.py --ref_wav user_voice.wav --save_code user01.refcode

#2 后续所有合成，加载refcode，不再读原wav，省去提取耗时
moss-tts generate --ref-code-path user01.refcode --text "xxxx" --out xxx.wav
1 段 3s 音频提取 ref_code 仅5~15ms（4 核 CPU），存完后每次合成跳过音频解析步骤。
方案 2：内存缓存（单次进程内重复生成秒开）
Python 调用常驻进程：第一次加载 wav 提取 ref_codes 存入内存变量，同脚本循环生成不同文本时，直接复用内存里的 ref 编码，全程不再碰原音频文件，首句慢、后面全实时。
ONNX 部署 / 网页封装：做简易缓存字典{音色别名:ref_codes}，自定义别名替代 VoiceID，例如zh_man1:编码二进制，调用时传别名查表拿编码。


## 预设音色
内置 16 种固定音色自带内置编码，零提取
常用音色统一提取.refcode放音色文件夹，文件名 = 自定义 ID（boss.refcode、girl.refcode）

16 个内置音色清单 + 对应文件名
中文（6 个）
表格
文件名	音色人名	性别
zh_1.wav	Junhao	男声
zh_2.wav	Zhiming	男声
zh_3.wav	Weiguo	男声
zh_4.wav	Xiaoyu	女声
zh_5.wav	Yuewen	女声
zh_6.wav	Lingyu	女声
英文（5 个）
表格
文件名	音色
en_1.wav	Ava (女)
en_2.wav	Bella (女)
en_3.wav	Adam (男)
en_4.wav	Nathan (男)
en_5.wav	Trump 川普特型
日文（5 个）
ja_1(Sakura)、ja_2(Yui)、ja_3(Aoi)、ja_4(Hina)、ja_5(Mei)

单次生成

`$tool_path = "{tool_path}"
cd /d "%tool_path%\./moss-tts-nano.exe\venv\Scripts"`

`././moss-tts-nano.exe.exe generate \
--backend onnx \
--mode continuation \
--prompt-audio-path assets/audio/zh_1.wav \
--text "onnx加速内置音色，CPU速度翻倍" \
--output onnx_junhao.wav`


