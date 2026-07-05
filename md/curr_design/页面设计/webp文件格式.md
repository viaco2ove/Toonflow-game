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