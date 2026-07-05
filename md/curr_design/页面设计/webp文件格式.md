# webp 格式头像的台词处理

## 在单条模式时台词显示
【大头像】每次生成都播放一次然后定格在第一帧。
【台词】

### 处理历程，包括调试日志的处理

## 每次生成台词时web
WebDebugLogUtil.log(WEBP_LOG_TAGS.play, "是否为webp格式", );
WebDebugLogUtil.log(WEBP_LOG_TAGS.play, "路径变化", { newPath, autoPlay });
WebDebugLogUtil.log(WEBP_LOG_TAGS.play, "初始化路径", { initPath, autoPlay });
WebDebugLogUtil.log(WEBP_LOG_TAGS.play, "开始播放", { path: originalPath.value, playDuration });
WebDebugLogUtil.log(WEBP_LOG_TAGS.play, "定时器到点，触发 onAnimationEnd", { path: originalPath.value });
WebDebugLogUtil.log(WEBP_LOG_TAGS.play, "暂停/定格", { path: originalPath.value });
WebDebugLogUtil.log(WEBP_LOG_TAGS.play, "reset 重置", { path: originalPath.value });
WebDebugLogUtil.log(WEBP_LOG_TAGS.play, "组件卸载，清理定时器", { path: originalPath.value, isPlaying: isPlaying.value });
WebDebugLogUtil.log(WEBP_LOG_TAGS.play, "play 跳过", { path: originalPath.value, isAnimated: isAnimated.value, isPlaying: isPlaying.value });
WebDebugLogUtil.log(WEBP_LOG_TAGS.play, "watch 异常", { error: e instanceof Error ? e.message : String(e) });
WebDebugLogUtil.log(WEBP_LOG_TAGS.play, "初始化异常", { error: e instanceof Error ? e.message : String(e) });

## webp 文件格式检测
WebDebugLogUtil.log(WEBP_LOG_TAGS.detect, "Range 请求失败，保守返回 true(动画)", { url, status: rangeResponse.status });
WebDebugLogUtil.log(WEBP_LOG_TAGS.detect, "检测完成", { url, isAnimated });
WebDebugLogUtil.log(WEBP_LOG_TAGS.detect, "检测异常，保守返回 true(动画)", { url, error: err instanceof Error ? err.message : String(err) });
【原理】Range 请求前 1000 字节，检查 RIFF/WEBP/VP8X/ANIM Chunk

## 第一帧提取
WebDebugLogUtil.log(WEBP_LOG_TAGS.extract, "skip: 非webp或空路径", { path, isWebp: !!path && isWebpUrl(path) });
WebDebugLogUtil.log(WEBP_LOG_TAGS.extract, "开始提取第一帧", { path, forceRefresh });
WebDebugLogUtil.log(WEBP_LOG_TAGS.extract, "提取成功", { path, isAnimated: result.isAnimated, dataUrlLength: result.dataUrl?.length || 0 });
WebDebugLogUtil.log(WEBP_LOG_TAGS.extract, "提取失败，降级原始路径", { path, error: error.value });
WebDebugLogUtil.log(WEBP_LOG_TAGS.extract, "提取异常，降级原始路径", { path, error: error.value });
WebDebugLogUtil.log(WEBP_LOG_TAGS.extract, "refresh 重新提取", { path: originalPath.value });
WebDebugLogUtil.log(WEBP_LOG_TAGS.extract, "canvas 提取开始", { url });
WebDebugLogUtil.log(WEBP_LOG_TAGS.extract, "canvas 提取成功", { url, width: canvas.width, height: canvas.height, dataUrlLength: dataUrl.length });
WebDebugLogUtil.log(WEBP_LOG_TAGS.extract, "canvas 提取失败：尺寸为0", { url });
WebDebugLogUtil.log(WEBP_LOG_TAGS.extract, "canvas 提取失败：无法获取2D上下文", { url });
WebDebugLogUtil.log(WEBP_LOG_TAGS.extract, "canvas 提取异常", { url, error: error instanceof Error ? error.message : "未知错误" });
WebDebugLogUtil.log(WEBP_LOG_TAGS.extract, "canvas 图片加载失败", { url });
WebDebugLogUtil.log(WEBP_LOG_TAGS.extract, "canvas 提取超时(10s)", { url });
【原理】Image + Canvas，浏览器加载 webp 自动停在第一帧，toDataURL 捕获为 PNG DataURL
【注意】不设置 crossOrigin，避免服务端无 CORS 头时 canvas.toDataURL() 报 Tainted canvases 错误

## 缓存管理
WebDebugLogUtil.log(WEBP_LOG_TAGS.cache, "命中", { url, isAnimated: cached.isAnimated });
WebDebugLogUtil.log(WEBP_LOG_TAGS.cache, "未命中，开始提取", { url, forceRefresh });
WebDebugLogUtil.log(WEBP_LOG_TAGS.cache, "写入缓存", { url, isAnimated: result.isAnimated });
WebDebugLogUtil.log(WEBP_LOG_TAGS.cache, "缓存过期，删除", { url });
WebDebugLogUtil.log(WEBP_LOG_TAGS.cache, "LRU 淘汰", { evictedUrl: lruUrl, cacheSize: memoryCache.size });
【规则】内存 Map，key=URL，TTL=30分钟，上限50条，LRU 淘汰

## 渲染层
WebDebugLogUtil.log(WEBP_LOG_TAGS.render, "LayeredAvatar 初始化", { foregroundPath, backgroundPath, animated, animationDuration });
WebDebugLogUtil.log(WEBP_LOG_TAGS.render, "动画播放结束，定格", { foregroundPath: props.foregroundPath });

## 白名单配置
webDebugLogConfig = {
  debugLogMode: "whitelist",          // 白名单模式
  debugLogWhitelist: ["[webp]"],       // 只放行 webp 相关日志
  debugLogBlacklist: [],
}
【开启调试】URL 加 ?debug=true 或 localStorage 设 debug=true
【白名单日志 tag 前缀】[webp:play] / [webp:extract] / [webp:cache] / [webp:render] / [webp:detect]

# ai 给的具体方案
[webp文件格式.ai.md](webp%E6%96%87%E4%BB%B6%E6%A0%BC%E5%BC%8F.ai.md)
很明显一点用都没有！！！
要解决的问题是：首先webp 是否可以感知播放了一轮，是否可以感知播放。然后是否可以提取第一帧。这些问题能发解决。canvas 不起作用的原因是什么？ 前端是否可以解决这跟问题！！！ 
  Q1: 能否感知 webp 播放了一轮? ❌ 前端无法知道。浏览器 <img> 不暴露动画时长/播放进度的 API,我们只能靠 setTimeout 写死时长(现在默认3s)来模拟。
     
  Q2: 能否感知当前是否在播放? ❌ 前端无法知道。浏览器 <img> 不暴露动画状态。isPlaying 只是我们内部状态机的状态,不是从 DOM 读的。
     
  Q3: 能否提取第一帧? ❌ canvas 失败。原因是 new Image() 发起新请求,服务端没 CORS 头所以图片加载失败(尺寸为0)。naturalWidth 拿不到数据。
     
  解决方案:LayeredAvatar 的 <img> 标签已经加载并缓存了图片,用 DOM img 元素的数据去 canvas 提取,不重新发请求。

# 解决方案
- 核心1 第一帧获取:
- 核心2 感知播放了一轮
- 核心3 替换为第一帧
// 1. 生成动画
头像分离（抠图大模型）
local_birefnet local_modnet 等本地或者在线头像分离模型
抠图大模型生成webp 动画

// 2. 提取第一帧作为静态图
直接在 renderSemanticAvatarAssets 里把抠好的第一帧保存为 PNG

// 3. 获取动画时长
生成webp 时的动画时长做为前端播放时长

// 4. 上传三者到 OSS，返回给前端
{
  animatedPath: "xxx.webp",
  firstFramePath: "xxx_first_frame.png", 
  durationMs: 3000
}

整个链路完全正确！总结：

数据流
后端生成 WebP + 第一帧 PNG + 时长
        ↓
saveWorld API 持久化到 t_world 表（settings JSON）
        ↓
前端 http://127.0.0.1:60002/game/storyInfo
        ↓
npcs[角色].parameterCardJson/player.parameterCardJson
        ↓
avatarFirstFramePath = "/1/game/role/xxx.png"
avatarDurationMs = 4083
        ↓
ScenePlay.vue 模板调用
        ↓
LayeredAvatar 接收 props：
  - first-frame-path="http://127.0.0.1:60002/1/game/role/xxx.png"
  - animation-duration="4083"
LayeredAvatar 内部逻辑
effectiveDuration = 4083（后端精确值）
播放时：img.src = WebP URL，动画播放
定时器到点后：fgIsPlaying = false
定格时：img.src = 后端第一帧 PNG URL（绕过 CORS，直接用 URL）
现在重启前端，然后刷新页面进入游戏，看控制台日志：

[LayeredAvatar 初始化] 应该显示 firstFramePath 有值、animationDuration: 4083
[使用后端第一帧] 应该出现
动画播放完定格后，img.src 应该变成 PNG 路径而不是 WebP