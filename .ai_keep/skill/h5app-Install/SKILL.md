---
name: h5app-Install
description: 把 web 前端打包成安卓 App（h5app）并安装到已连接的设备。当用户说「打包安装 h5app」「前端打包发到 h5app 然后安装」「更新安卓端」「把 web 装到手机上」「h5app install」「重新构建 APK」时使用。流程为：构建 web → 同步 dist 到 Android assets → gradle 打 APK → adb 安装 → 启动。
---

# h5app-Install

把 `Toonflow-game-web` 的前端产物，打包进 `Toonflow-game-android-h5` 的 Android WebView 壳，
生成 APK 并安装到已连接的安卓设备上。

## 关键背景

`h5app` 不是独立项目，而是**「Vue H5 + Android WebView 壳」两段式**结构：

| 段 | 位置 | 作用 |
|---|---|---|
| 前端源码 | `D:\Users\viaco\tools\Toonflow-game\Toonflow-game-web` | Vue 3 + Vite，真正要改的代码在这 |
| H5 壳工程 | `D:\Users\viaco\tools\Toonflow-game\Toonflow-game-android-h5` | Gradle 工程 + WebView 容器 |
| 打包进 APK 的产物 | `Toonflow-game-android-h5/app/src/main/assets/dist/` | **web 的 dist 原样拷进来** |

安卓壳的 `MainActivity` 加载的是 `file:///android_asset/dist/index.html`，
所以 **APK 里的内容完全等于 web 的 `dist/`**，构建 web 是必做步骤。

> ⚠️ 不要直接改 `assets/dist/` 里的文件 —— 那是构建产物，下次构建就被覆盖。
> 要改前端就改 `Toonflow-game-web/src/`。

## 用法

```
/h5app-Install
/h5app-Install 跳过前端构建，直接用现有 dist
/h5app-Install 打 release 包
```

或者直接跑脚本：

```bash
cd <repo>/.aispace/workbuddy-ai/skills/h5app-Install
node scripts/h5app-install.mjs                # 完整流程（debug）
node scripts/h5app-install.mjs --skip-build   # 跳过前端构建
node scripts/h5app-install.mjs --release      # release 包
node scripts/h5app-install.mjs --no-launch    # 只装不启动
node scripts/h5app-install.mjs --dry-run      # 只打印命令不执行
node scripts/h5app-install.mjs --web <path> --h5 <path>   # 自定义路径
```

## 手工流程（等价命令）

调试时也可以逐步手动执行：

```bash
# 1. 构建 web 前端
cd D:/Users/viaco/tools/Toonflow-game/Toonflow-game-web
yarn build          # 有 yarn.lock 用 yarn；否则 npm run build

# 2. 同步 dist 到 Android assets（先删旧的，避免残留旧 chunk）
cd D:/Users/viaco/tools/Toonflow-game/Toonflow-game-android-h5
rm -rf app/src/main/assets/dist
cp -r D:/Users/viaco/tools/Toonflow-game/Toonflow-game-web/dist app/src/main/assets/

# 3. 构建 APK（gradlew 在工程根，不在 app/ 下）
./gradlew.bat assembleDebug        # Windows
./gradlew assembleDebug            # macOS / Linux
# 产物：app/build/outputs/apk/debug/app-debug.apk

# 4. 安装并启动
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p com.toonflow.game -c android.intent.category.LAUNCHER 1
```

## 验收

装完必须确认三件事：

1. `adb devices` 有设备且状态是 `device`（不是 `offline`/`unauthorized`）；
2. `adb shell dumpsys window | grep mCurrentFocus` 显示 `com.toonflow.game/.MainActivity`；
3. 截图看是不是真渲染 —— 别只信启动成功。取图：

```bash
adb exec-out screencap -p > shot.png
```

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `adb: no devices/emulators found` | USB 没授权或 adb 服务没起。`adb kill-server && adb start-server`，手机上重新确认「允许 USB 调试」 |
| Windows 设备管理器里 `ADB Interface` 状态 `Unknown`、错误码 `CM_PROB_PHANTOM`（幻影设备） | 设备物理断连 / 息屏 / USB 切成「仅充电」，系统只留了残留节点。**必须在手机上操作**：解锁屏幕、USB 模式切「传输文件」、重新勾选「允许 USB 调试」，必要时重新插拔数据线。命令行修不了 |
| 设备连上但脚本已经跑失败了 | 不用重跑全流程，APK 已经是新的。直接补装：`node scripts/h5app-install.mjs --skip-build --shot` |
| 无线 adb 备用方案 | 手机和 PC 同网段时，先 USB 连上执行 `adb tcpip 5555`，之后可 `adb connect <手机IP>:5555` 免数据线。手机 IP 用 `arp -a`（本机 IP 是 `192.168.0.103` 时手机常为 `.104`）查 |
| gradle 报 SDK location not found | `local.properties` 的 `sdk.dir` 要指向本机 SDK。当前为 `C:\Users\viaco\AppData\Local\Android\Sdk` |
| APK 里还是旧页面 | 第 2 步没删旧 `assets/dist`，或第 1 步构建产物没更新。删干净重来 |
| 白屏 | 大概率 `dist/index.html` 的资源路径是绝对路径。web 的 vite `base` 必须是 `./`（相对路径），否则 `file://` 下加载不到 |
| 脚本提示「前台被抢占」但 `mFocusedApp` 还是 `com.toonflow.game/.MainActivity` | 手机锁屏或通知栏下拉，`mCurrentFocus` 被 `NotificationShade` 占走。解锁屏幕、收起通知（`adb shell cmd statusbar collapse`），再用 `am start -n com.toonflow.game/.MainActivity` 拉起即可 |
| 构建报 chunk 过大 | 只是 warning，不影响出包，可忽略 |
| 端口冲突 | h5 的 vite dev server 是 5174，web 是 5173，别混用 |

## 相关文档

- `Toonflow-game-android-h5/md/bulid/h5_bulid.md` — 构建说明
- `Toonflow-game-android-h5/CLAUDE.md` — 壳工程结构与 WebView 配置
- `Toonflow-game-web/AGENTS.md` — 前端开发规范

## 注意

- 前端源码改动要**同时**考虑 web 与安卓端是否都适用（例：按住语音输入只适用安卓）。
- 本技能只做「构建 + 安装」，不负责改代码。
