# WebP 格式头像动画处理设计

## 一、整体架构

```
webpFrameExtractor.ts          底层工具：URL检测 / 动画检测 / 第一帧提取 / 缓存
useWebpAvatar.ts               Composable：播放状态机（播放/暂停/定时定格/路径监听）
LayeredAvatar.vue              渲染组件：前景+背景层叠加
ScenePlay.vue                 使用方：大头像立绘
SceneCreate.vue / SceneMy.vue 使用方：角色卡头像
```

**核心原理**：利用浏览器 `<img>` 加载 WebP 时自动停在第一帧的特性，通过 Canvas 捕获为 PNG DataURL 作为"定格帧"，播放期间切回原始 WebP URL 触发浏览器重播动画，实现"播放一轮→定格→等待→重播"循环。

---

## 二、WebP 文件格式（动画识别原理）

### 2.1 WebP 动画文件结构

```
┌──────────────────────────────────────────────┐
│ RIFF  header (4 bytes)                       │
│   'R' 'I' 'F' 'F'                            │
├──────────────────────────────────────────────┤
│ WEBP  version (4 bytes)                       │
│   'W' 'E' 'B' 'P'                            │
├──────────────────────────────────────────────┤
│ Chunk 1 (e.g. VP8X - 扩展格式头)              │
│   4 bytes: chunk ID                            │
│   4 bytes: chunk size                          │
│   data...                                      │
├──────────────────────────────────────────────┤
│ Chunk 2 (ANIM - 动画参数)                     │
│   'A' 'N' 'I' 'M'                             │
│   ...                                          │
├──────────────────────────────────────────────┤
│ Chunk N (ANMF - 动画帧)                       │
│   'A' 'N' 'M' 'F'                             │
│   ...                                          │
└──────────────────────────────────────────────┘
```

### 2.2 关键 Chunk

| Chunk | 含义 | 判断方式 |
|---|---|---|
| `RIFF` | WebP 容器标识 | 文件头4字节 |
| `WEBP` | WebP 格式标识 | 字节 8-11 |
| `VP8X` | 扩展格式（包含 flags） | 字节 12-15 |
| `ANIM` | 动画参数（背景色、帧率） | 存在即表示动画文件 |
| `ANMF` | 动画帧数据（每帧含 duration） | 包含帧延迟信息 |

### 2.3 动画判断算法（`detectWebpAnimation`）

```
1. Range 请求前 1000 字节（只下载头部，不下完整文件）
2. 检查字节 0-3 == "RIFF"
3. 检查字节 8-11 == "WEBP"
4. 遍历字节 12 之后的 chunk：
   - 发现 "ANIM" → 是动画
   - 发现 "VP8X" 且 flags[1] (0x02) == 1 → 是动画
5. 都未命中 → 保守返回 false（静态图）
```

**为什么不能直接拿动画时长？**  
浏览器 `<img>` / `<video>` 均不暴露 WebP 帧信息。`@jsquash/webp` 库可以完整解码拿到每帧 duration，但需要下载完整文件，适合预加载场景。

---

## 三、核心模块详解

### 3.1 `webpFrameExtractor.ts` — 底层工具

**导出函数**：

| 函数 | 作用 |
|---|---|
| `isWebpUrl(url)` | 判断 URL 是否为 .webp 文件（URL 后缀匹配） |
| `detectWebpAnimation(url)` | Range 请求头部，检测是否为动画格式 |
| `extractWebpFirstFrame(url, forceRefresh?)` | 主入口：命中缓存返回第一帧 DataURL；未命中则用 Canvas 提取 |
| `extractFrameWithCanvas(url)` | Image + Canvas 提取第一帧，返回 PNG DataURL |
| `prefetchWebpFrames(urls)` | 批量预提取（并发数3） |
| `clearWebpFrameCache(url?)` | 清缓存（全清或单条） |
| `getWebpFrameCacheStats()` | 获取缓存统计（size/limit/oldestEntry） |

**缓存机制**：
- 内存 Map，key=URL，TTL=30分钟，LRU 淘汰（上限50条）
- 缓存命中时直接返回，不走 Image+Canvas 提取

**返回值类型**：
```ts
interface ExtractWebpFrameResult {
  success: boolean;
  dataUrl: string;       // 第一帧 PNG DataURL
  isAnimated: boolean;   // 是否动画
  error?: string;
}
```

### 3.2 `useWebpAvatar.ts` — 播放状态机 Composable

**接口**：
```ts
function useWebpAvatar(
  avatarPath: string | null | undefined,   // 原始 WebP URL
  options: {
    playDuration?: number;    // 播放时长，默认3000ms，0=无限
    autoPlay?: boolean;       // 传入后是否立即开始播放
    onLoaded?: (result) => void;   // 第一帧提取完成回调
    onAnimationEnd?: () => void;  // 定时播放结束回调
  }
): UseWebpAvatarReturn
```

**返回对象**：
```ts
interface UseWebpAvatarReturn {
  displayedPath: string;     // 当前应显示的路径（原始webp 或 第一帧DataURL）
  isLoading: boolean;
  isAnimated: boolean;      // 是否动画webp
  isPlaying: boolean;        // 是否正在播放
  error: string | null;
  path: string;              // 当前原始路径快照
  play(): void;              // 开始播放
  pause(): void;             // 暂停/定格
  toggle(): void;            // 切换播放状态
  refresh(): Promise<void>; // 刷新（清缓存+重新提取第一帧）
  reset(): void;             // 重置到初始状态
}
```

**状态机逻辑**：
```
avatarPath 变化
  → reset()（清缓存、清状态）
  → autoPlay=true? → extractFrame() + play()
      → 提取第一帧（命中缓存则跳过）
      → play() → 播放原始webp（定时 playDuration ms）
        → 定时到 → pause()（定格，显示第一帧）
          → onAnimationEnd 回调
```

**`displayedPath` 计算规则**：
```
isPlaying && isAnimated → 返回原始 WebP URL（浏览器播放动画）
否则 → 返回第一帧 DataURL（定格）
```

### 3.3 `LayeredAvatar.vue` — 渲染组件

```
<template>
  <div class="layered-avatar">
    <img class="layered-avatar__bg"    ← 背景层（普通图片，CSS object-fit:cover）
    <img class="layered-avatar__fg"    ← 前景层（webp，:src=displayedPath）
    <div class="layered-avatar__loading" ← 加载指示器
  </div>
</template>
```

- `foregroundPath` → `useWebpAvatar` 控制播放
- `backgroundPath` → 普通 `<img>` 背景层
- `animated` prop 控制是否 autoPlay
- `animationDuration` prop 控制 playDuration

---

## 四、使用场景

### 4.1 ScenePlay.vue — 大头像立绘

```
位置: ScenePlay.vue:1788
调用: const liveFigureAvatar = useWebpAvatar(currentLiveFigureFgPath, {
         playDuration: 3000,   // 播放3秒后定格
         autoPlay: true,
       });
渲染: <div :style="{ backgroundImage: `url(${liveFigureAvatar.displayedPath})` }">
```

每次新台词生成触发 `currentLiveFigureFgPath` 变化 → `useWebpAvatar` watch 检测到变化 → 播放动画 → 3秒后定格。

### 4.2 SceneCreate.vue / SceneMy.vue — 角色卡头像

使用 `<LayeredAvatar>` 组件，传入 `foregroundPath`、`animated` prop，根据角色设定决定是否自动播放。

---

## 五、调试日志

### 5.1 白名单配置（`WebDebugLogConfig.ts`）

```ts
webDebugLogConfig = {
  debugLogMode: "whitelist",          // 白名单模式
  debugLogWhitelist: ["[webp]"],       // 只放行 webp 相关日志
  debugLogBlacklist: [],
}
```

**开启调试**：URL 加 `?debug=true` 或 localStorage 设 `debug=true`。

### 5.2 WebP 相关日志 Tag

| Tag | 含义 | 出现时机 |
|---|---|---|
| `[webp:play]` | 播放状态机 | 播放开始/跳过/定时结束/暂停/重置/路径变化/组件卸载 |
| `[webp:extract]` | 第一帧提取 | 开始/成功/失败/异常/跳过(canvas 提取各阶段) |
| `[webp:cache]` | 缓存 | 命中/未命中/过期/LRU淘汰/写入 |
| `[webp:render]` | 渲染层 | LayeredAvatar 初始化/动画播放结束 |
| `[webp:detect]` | 动画检测 | Range 请求/检测完成/异常 |

### 5.3 排查步骤

1. URL 带 `?debug=true`
2. 打开浏览器控制台，过滤 `[webp:`
3. 按出现顺序判断问题：
   - 只有 `[webp:detect]` 没有 `[webp:extract]` → `extractWebpFirstFrame` 未被调用，检查 `isWebpUrl()` 是否跳过
   - `[webp:extract]` 出现但没 `[webp:play]` → `autoPlay` 为 false 或 `isAnimated` 为 false
   - 都没有 → 检查 `useWebpAvatar` 是否被正确调用

---

## 六、已知问题与优化方向

### 6.1 动画时长获取（待实现）

当前：playDuration 写死 3000ms，无法适配不同 WebP 动画的实际时长。

**方案**：使用 `@jsquash/webp` 库，完整解码 WebP 二进制，累加所有帧 duration，拿到准确动画总时长。

```bash
npm install @jsquash/webp
```

```ts
import { decodeAnimated } from '@jsquash/webp';

async function getWebpDuration(url: string): Promise<number> {
  const res = await fetch(url);
  const buffer = await res.arrayBuffer();
  const frames = await decodeAnimated(new Uint8Array(buffer));
  return frames.reduce((sum, f) => sum + f.duration, 0);
}
```

接入点：`useWebpAvatar` 的 `extractFrame()` 成功后，调用 `getWebpDuration()` 自动拿到真实时长，替换 `playDuration`。

### 6.2 LayeredAvatar 返回值响应式

当前 `displayedPath`、`isLoading` 等返回 `.value` 快照（字符串/布尔），模板中直接用值。后续可考虑暴露 getter 函数或 ref，在需要响应式的场景使用。

### 6.3 跨域限制

`extractWebpFirstFrame` 内部使用 `fetch + canvas.toDataURL`，要求图片服务器配置 `Access-Control-Allow-Origin`。本地 `127.0.0.1:60002` 无此问题。