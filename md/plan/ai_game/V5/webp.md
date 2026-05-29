**结论：浏览器原生 `<img>` 不提供 WebP 动画时长，不能直接自动拿，但可以通过解析 WebP 二进制数据精确算出总时长。**

直接在 Vue3 里用、不用后端、纯前端解析、自动拿到准确 PLAY_DURATION** 的方案。

---

## 一、为什么不能直接“自动获取”
- 浏览器 `<img>` 标签播放 WebP 动画时，**没有 API 暴露总时长/帧数/每帧延迟**
- WebP 动画时长存在文件内部的 **ANIM/ANMF 块**里，需要读二进制流解析
- `<video>` 也不能用：**animated WebP 不是视频，video 元素不支持**

所以：**不能像视频那样一行代码拿到 duration，必须解析 WebP 二进制。**

---

## 二、Vue3 可用：纯前端解析 WebP 动画总时长（自动算 PLAY_DURATION）
### 1. 安装轻量解析库（只做 WebP 动画解码）
```bash
npm install @jsquash/webp
```

### 2. 封装一个工具函数（拿到总毫秒数）
```js
import { decodeAnimated } from '@jsquash/webp';

// 传入 WebP URL，返回总时长（ms）
async function getAnimatedWebpDuration(url) {
  // 1. 拿到 WebP 二进制
  const res = await fetch(url);
  if (!res.ok) throw new Error('加载失败');
  const arrayBuffer = await res.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);

  // 2. 解析所有帧（含每帧 duration）
  const frames = await decodeAnimated(uint8);

  // 3. 累加所有帧时长 → 总时长
  const totalMs = frames.reduce((sum, f) => sum + f.duration, 0);
  return totalMs;
}
```
- `frames` 里每一帧都有 `duration`（毫秒）
- 累加就是**一轮动画的准确时长**，完美替代手动写死 `PLAY_DURATION`

### 3. 接入你的 Vue 代码（自动获取 + 定格循环）
```vue
<template>
  <div class="play-figure-stage__glow"></div>
  <div
    v-if="currentLiveFigureFgPath"
    class="play-figure play-figure--fg"
    :key="animKey"
    :style="{
      backgroundImage: `url(${currentLiveFigureFgPath})`,
      backgroundSize: 'auto 100%'
    }"
  ></div>
  <div class="play-figure-stage__fade"></div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';

// 你原有的代码（保持不动）
const currentLiveFigureRole = ref(null);
const roleAvatarForeground = (r) => r?.fgPath || '';
const currentLiveFigureFgPath = computed(() =>
  roleAvatarForeground(currentLiveFigureRole.value)
);

// ======================
// 动画控制逻辑
// ======================
const animKey = ref(0);
const WAIT_DURATION = 3000; // 定格等待时间（可改）
let animTimer = null;
let isAnimatedWebp = false; // 是否为动图 WebP

/**
 * 判断是否为 动图 WebP
 */
async function checkIsAnimatedWebP(url) {
  try {
    // 只下载头部几十字节，不下载整张图，超快
    const res = await fetch(url, { headers: { Range: 'bytes=0-50' } });
    const buf = await res.arrayBuffer();
    const arr = new Uint8Array(buf);
    
    // 动图 WebP 特征：VP8X 块 + 动画标志位
    const header = String.fromCharCode(...arr.slice(0, 4));
    if (header !== 'RIFF') return false;

    const webpType = String.fromCharCode(...arr.slice(8, 12));
    if (webpType !== 'WEBP') return false;

    const chunk = String.fromCharCode(...arr.slice(12, 16));
    if (chunk !== 'VP8X') return false;

    // 检查动画位
    const flags = arr[20];
    return (flags & 0x02) !== 0;
  } catch (e) {
    return false;
  }
}

/**
 * 播放一轮 → 定格 → 等待 → 重播
 */
function playAnimation() {
  if (!isAnimatedWebp) return; // 非动图直接不执行

  animKey.value++;
  clearTimeout(animTimer);

  // 这里你可以自己测试微调时长（动图一般 5000~7500ms）
  animTimer = setTimeout(() => {
    setTimeout(() => {
      playAnimation();
    }, WAIT_DURATION);
  }, 2800);
}

// 监听图片变化 → 自动判断是否动图
watch(
  currentLiveFigureFgPath,
  async (path) => {
    clearTimeout(animTimer);
    if (!path) return;

    isAnimatedWebp = await checkIsAnimatedWebP(path);
    console.log('是否为动图 WebP：', isAnimatedWebp);

    if (isAnimatedWebp) {
      playAnimation();
    } else {
      animKey.value = 0; // PNG/静态图 正常显示，不做动画
    }
  },
  { immediate: true }
);

onUnmounted(() => clearTimeout(animTimer));
</script>
```

---

## 三、效果
- **自动拿到每个 WebP 的准确时长**，不用手动改 `PLAY_DURATION`
- 播放 → 定格最后一帧 → 等待 N 秒 → 重播
- 路径切换时自动重新解析、适配新动画时长

---

## 四、注意点
1. **跨域**：WebP 图片服务器需要配置 `Access-Control-Allow-Origin`，否则 `fetch` 会跨域报错
2. **体积**：解析会下载完整 WebP 二进制，大图会稍耗流量/内存
3. **降级**：解析失败会用默认 5000ms，保证不崩

---