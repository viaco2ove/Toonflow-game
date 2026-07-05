# webp 格式头像的台词处理

## 在单条模式时台词显示
【大头像】每次生成都播放一次然后定格在第一帧。
【台词】

### 处理历程，包括调试日志的处理

## 每次生成台词时web
WebDebugLogUtil.log(WEBP_LOG_TAGS.play, "是否为webp格式", );
WebDebugLogUtil.log(WEBP_LOG_TAGS.play, "路径变化", { newPath, autoPlay });
WebDebugLogUtil.log(WEBP_LOG_TAGS.play, "第一帧png url", { firstFrameUrl });
WebDebugLogUtil.log(WEBP_LOG_TAGS.play, "初始化路径", { initPath, autoPlay });
WebDebugLogUtil.log(WEBP_LOG_TAGS.play, "开始播放", { path: originalPath.value, playDuration });
WebDebugLogUtil.log(WEBP_LOG_TAGS.play, "定时器到点，触发 onAnimationEnd", { path: originalPath.value });
WebDebugLogUtil.log(WEBP_LOG_TAGS.play, "定时器到点，定格", { foregroundPath });
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

## 渲染层
WebDebugLogUtil.log(WEBP_LOG_TAGS.render, "LayeredAvatar 初始化", { foregroundPath, backgroundPath, animated, animationDuration, firstFramePath, hasBackendFirstFrame });
WebDebugLogUtil.log(WEBP_LOG_TAGS.render, "动画播放结束，定格", { foregroundPath: props.foregroundPath });
【核心原理】两个 img 层同时存在，CSS 控制显隐，不切换 src
- webp 层：永远绑定 webp URL，播放时 visible，定格时 hidden
- png 层：永远绑定后端第一帧 PNG URL，定格时 visible，播放时 hidden
- 无需 canvas 提取，无 CORS 问题，无 src 切换闪烁

## 白名单配置
webDebugLogConfig = {
  debugLogMode: "whitelist",
  debugLogWhitelist: ["[webp]"],
  debugLogBlacklist: [],
}
【开启调试】URL 加 ?debug=true 或 localStorage 设 debug=true
【白名单日志 tag 前缀】[webp:play] / [webp:extract] / [webp:cache] / [webp:render] / [webp:detect]

## 数据流
后端 /game/storyInfo 返回 avatarFirstFramePath（PNG）和 avatarDurationMs（时长）
  → store.role.avatarFirstFramePath / avatarDurationMs
  → LayeredAvatar props.firstFramePath / backendDurationMs
  → useWebpAvatar backendFirstFrameUrl / playDuration
  → 渲染两个 img 层，CSS 控制显隐

## CSS 控制显隐
.layered-avatar__fg--png.is-hidden { visibility: hidden; }  // 播放中隐藏 PNG
.layered-avatar__fg--webp.is-hidden { visibility: hidden; }  // 定格时隐藏 WebP