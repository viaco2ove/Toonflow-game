# no_modify
# voice_id
## 我们的voice_id 是在什么时候生成然后给 章节调试和游玩用的。过期或者换了模型又会怎么样？
 voice_id 生命周期总结

  什么时候生成

  配置角色音色时（POST /voice/generateBindingVoice）生成，有 4 条路径：

  ┌───────────────┬───────────────────────────────────┬────────────────────────────┐
  │     模式      │             生成方式              │       voice_id 来源        │
  ├───────────────┼───────────────────────────────────┼────────────────────────────┤
  │ clone         │ 发送参考音频到阿里云              │ Aliyun 返回 cosyvoice-xxx  │
  ├───────────────┼───────────────────────────────────┼────────────────────────────┤
  │ prompt_voice  │ 发送文本提示词到 voice-design API │ Aliyun 返回自定义 voice_id │
  ├───────────────┼───────────────────────────────────┼────────────────────────────┤
  │ mix           │ 混合多音色 → 注册                 │ Aliyun 返回                │
  ├───────────────┼───────────────────────────────────┼────────────────────────────┤
  │ MiniMax clone │ 上传音频 → /v1/voice_clone        │ MiniMax 返回               │
  └───────────────┴───────────────────────────────────┴────────────────────────────┘

  调试/游玩时（POST /voice/preview）复用已有的 voice_id，不重新生成。

  voice_id 存在哪里

  不在数据库，存在两个地方：

  1. OSS .meta.json 伴生文件（持久化）— 与参考音频 .wav 同目录
  2. 内存 Map（进程级）— TTL 6 小时，重启丢失

  换了模型会怎样

  自动失效：OSS 路径 hash 包含 targetModel，换模型 → 新路径 → 旧缓存不复用。

  同时 isVoiceIdCompatibleWithModel() 会检查：
  - cosyvoice-xxx 不能给 Qwen 用
  - qwen-tts-vd-xxx 不能给 CosyVoice 用

  不兼容时 bypassCache: true 强制重新生成。

  voice_id 过期会怎样

  自愈：CosyVoice 返回 InvalidParameter 错误时 → 删除内存缓存 → 重新 createDirectAliyunCustomVoice() → 更新 .meta.json → 重试合成。新建的 voice_id 还有 3 次退避重试（1.5s / 2.5s / 4s）防止阿里云延迟生效。

  核心设计

  换模型 → hash 变 → 新文件路径 → 旧 voice_id 不复用 → 自动重新注册
  voice_id 过期 → 捕获异常 → 删缓存 → 重新注册 → 自动重试
  服务器重启 → 内存缓存清空 → 下次请求从 .meta.json 恢复或重新注册

