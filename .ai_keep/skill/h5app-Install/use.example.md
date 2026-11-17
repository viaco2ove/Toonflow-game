# h5app-Install 使用示例

## 场景 1：前端改完，要装到手机上看效果

```
/h5app-Install
```

等脚本跑完，手机上 App 自动打开，直接看效果。

## 场景 2：只改了安卓壳（MainActivity / gradle 配置），前端没动

```
/h5app-Install 跳过前端构建
```

直接用现有 `dist`，省一次 vite 构建。

## 场景 3：出正式包上传 GitHub Releases

```
/h5app-Install 打 release 包
```

产物在 `app/build/outputs/apk/release/`。注意 release 需要配好签名密钥。

## 场景 4：先看看会执行什么，别真动手

```
/h5app-Install 预览命令
```

对应脚本的 `--dry-run`，只打印不执行。

## 手动调用

```bash
cd D:/Users/viaco/tools/Toonflow-game/toonflow-game-plugins/.aispace/workbuddy-ai/skills/h5app-Install
node scripts/h5app-install.mjs --skip-build
```

## 常见后续动作

装完想看截图：

```bash
adb exec-out screencap -p > shot.png
```

想看 App 有没有崩：

```bash
adb logcat -d | grep -i "toonflow\|AndroidRuntime" | tail -50
```
