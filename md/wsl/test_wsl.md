
# wsl 下 前端使用 UI 测试配置时，运行 
wsl
```
cd {current_project}
```
```
mkdir -p "node_modules_wsl"
rsync -av --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude dist \
  --exclude '*.log' \
  --exclude node_modules_wsl \
  ./ node_modules_wsl/
```
```
cd node_modules_wsl
yarn install
yarn dev
```

## 已工具化的 WSL 镜像命令

仓库根目录现在可以直接用：

```bash
yarn sync:wsl
```

同步当前工作区到 `.wsl_mirror/`，但保留镜像里的 Linux `node_modules`。

```bash
yarn lint:wsl
```

先同步，再进入 `.wsl_mirror/` 执行 `yarn lint`。

```bash
yarn build:wsl
```

先同步，再进入 `.wsl_mirror/` 执行 `yarn build`。

如果 `.wsl_mirror/node_modules` 不存在，脚本会自动执行一次 `yarn install`。也可以手动执行：

```bash
cd .wsl_mirror
yarn install
```
