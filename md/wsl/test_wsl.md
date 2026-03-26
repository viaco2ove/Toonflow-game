
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