# Release v1.0.0

## GitHub Release
https://github.com/viaco2ove/Toonflow-game/releases/tag/v1.0.0

## 发布说明

### 新功能
- 支持视频头像和角色分离源文件保存
- 优化对话规则注释，明确角色发言指引
- 修正 voiceId 与模型兼容性校验逻辑
- 补充章节编写详细说明与结构规范
- 优化 SessionMemoryWorker 轮询和错误重试机制

### 安装包
- **ToonFlow-1.0.0-win32-x64-portable.zip** - 便携版，无需安装 (~388MB)
- **ToonFlow-Setup-1.0.0.exe** - 安装版本 (~149MB)
- **ToonFlow-1.0.0-win-x64.exe** - 直接运行版本 (~149MB)

## 构建流程

### 1. 构建 TypeScript
```bash
yarn build
```

### 2. 打包 Electron 应用
```bash
npx electron-builder --win --config.npmRebuild=false
```
注意：`--config.npmRebuild=false` 跳过 native 模块重新编译（避免编译环境问题）

### 3. 创建便携版压缩包
```powershell
Compress-Archive -Path 'dist\win-unpacked\*' -DestinationPath 'dist\ToonFlow-1.0.0-win32-x64-portable.zip'
```

## GitHub Release 操作

### 获取已存在 Release ID
```bash
curl -s "https://api.github.com/repos/viaco2ove/Toonflow-game/releases/tags/v1.0.0" \
  -H "Authorization: token $GITHUB_TOKEN"
```

### 上传安装包
```bash
curl -X POST "https://uploads.github.com/repos/viaco2ove/Toonflow-game/releases/$RELEASE_ID/assets?name=ToonFlow-1.0.0-win32-x64-portable.zip&label=Portable+version" \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Content-Type: application/zip" \
  --data-binary "@dist/ToonFlow-1.0.0-win32-x64-portable.zip"
```

### 更新 Release 说明
```bash
curl -X PATCH "https://api.github.com/repos/viaco2ove/Toonflow-game/releases/$RELEASE_ID" \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body":"## Release Notes\n\n### Features\n- ..."}'
```

## 已知问题

### better-sqlite3 编译失败
- 错误：`spawn MSBuild.exe ENOENT` 或 V8 API 不兼容
- 原因：Native 模块需要 C++ 编译器，且 Electron 40.x 与 better-sqlite3 版本不兼容
- 解决：使用 `--config.npmRebuild=false` 跳过编译

### Electron 下载失败
- 错误：`dial tcp connectex: A connection attempt failed`
- 解决：
  1. 手动下载 Electron 到 `%LOCALAPPDATA%\electron\Cache\`
  2. 或等待重试（之前成功下载过的版本会被缓存）

## 环境要求
[.env](../../../.env)