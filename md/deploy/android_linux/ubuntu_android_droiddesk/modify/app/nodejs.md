## nodejs 22
npm install -g n
n 22
## 加速
全局换成国内 npmmirror 源（最关键提速）
bash
运行
```
# 设置淘宝新镜像
yarn config set registry https://registry.npmmirror.com/
# 超时拉到10分钟，防止大依赖超时重试卡死
yarn config set network-timeout 600000
# electron、sass二进制包单独走国内镜像（@electron/rebuild慢主要原因）
yarn config set electron_mirror https://npmmirror.com/mirrors/electron/
yarn config set sass_binary_site https://npmmirror.com/mirrors/node-sass/
# 校验源是否生效
yarn config get registry
```

# 同时设环境变量（保险）
```
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export SASS_BINARY_SITE="https://npmmirror.com/mirrors/node-sass/"
```

在项目根目录放一个 .yarnrc 文件（注意没有后缀），内容如下：
文本
```
registry "https://registry.npmmirror.com"
network-timeout 600000
electron_mirror "https://npmmirror.com/mirrors/electron/"
sass_binary_site "https://npmmirror.com/mirrors/node-sass/"
```

## 如何清缓存
```
cd /opt/toonflow/toonflow-game-app
rm -rf /opt/toonflow/toonflow-game-app/node_modules
rm -rf node_modules dist .cache
yarn cache clean
```


## 更新库
yarn install  --frozen-lockfile --ignore-engines
建议：首次部署用 yarn install --ignore-engines（不加 frozen-lockfile），等 lockfile 更新后再用 --frozen-lockfile。或者在脚本里做判断：

## 构建
yarn build

## 重启后端
tower-pm2 restart toonflow-game

## 看日志
只看最近 100 行 + 实时追踪（不刷屏）
tower-pm2 logs toonflow-game --lines 100


## 关于ai 说nodejs 22 与 安卓的proot 环境 的兼容问题
 proot ≥ v5.1.107.75 后 就没有这个问题！
 ai 胡扯！
### 验证命令汇总
进 proot 后依次跑：
bash
复制
node -v
node -e "console.log(JSON.stringify(require('os').networkInterfaces(), null, 2))"
mkdir -p /tmp/test && cd /tmp/test && npm init -y && npm install express --no-save
三条都通过说明 Node 22 在 proot 里可正常使用。

### 直接运行 toonflow-panel
tower-pm2 stop toonflow-panel
cd /opt/toonflow/panel
./start-panel.sh
再次点击构建-构建成功。 结论弱智ai!

## 改用 supervisor
supervisor 去启动detail/main.py toonflow-panel