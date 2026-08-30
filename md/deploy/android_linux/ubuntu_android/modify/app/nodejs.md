## nodejs 22
npm install -g n
n 22
## 加速
全局换成国内 npmm irror 源（最关键提速）
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