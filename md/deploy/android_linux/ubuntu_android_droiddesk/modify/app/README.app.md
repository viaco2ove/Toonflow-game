后端是 **tower-pm2 托管的 Node.js 服务**，不是 systemd，所以之前的 `journalctl` 命令完全没用。

# 手动新增/启动 PM2 服务
```# 进入项目目录
cd /opt/toonflow/toonflow-game-app

# 确保环境变量文件存在
# env/.env.local 已包含 PORT=60002 DB_PATH UPLOAD_DIR LOG_PATH OSSURL 等

# 启动 PM2 服务（首次）
NODE_ENV=local tower-pm2 start build/app.js --name toonflow-game --update-env

# 保存服务列表（开机自启必需）
tower-pm2 save`
```
```aiexclude
{
  "name": "toonflow-game",
  "cmd": "NODE_ENV=local node /opt/toonflow/toonflow-game-app/build/app.js",
  "cwd": "/opt/toonflow/toonflow-game-app",
  "stdout_log": "/var/log/tower/toonflow-game.out.log",
  "stderr_log": "/var/log/tower/toonflow-game.err.log",
  "keep_live": true,
  "start_with_os": false,
  "start_nginx_with_ubuntu": false
}
```
# 正确查看后端运行日志命令（直接复制用）
## 1. 实时查看后端日志（最常用、必用）
```bash
tower-pm2 logs toonflow-game
```



## 2. 只看最近 100 行 + 实时追踪（不刷屏）
```bash
tower-pm2 logs toonflow-game --lines 100
```

## 3. 只查看历史日志（不实时刷新）
```bash
tower-pm2 logs toonflow-game --nostream
```

## 4. 查看后端服务是否在线
```bash
tower-pm2 status
```

---

# 额外：日志文件物理位置（方便下载/查看）
如果需要直接看日志文件，路径在这里：
```
/data/toonflow/logs/
```

查看所有日志文件：
```bash
ls -lh /data/toonflow/logs/
```

---

# 常用运维命令（你一定会用到）
## 重启后端
```bash
tower-pm2 restart toonflow-game
tower-pm2 restart toonflow-game --update-env
tower-pm2 save
```

## 停止后端
```bash
tower-pm2 stop toonflow-game
```

## 查看后端资源占用
```bash
tower-pm2 monit
```

---

### 总结
1. **你们后端是 tower-pm2 管理** → 用 `tower-pm2 logs` 看日志
2. **实时日志**：`tower-pm2 logs toonflow-game`
3. **服务状态**：`tower-pm2 status`
4. **重启服务**：`tower-pm2 restart toonflow-game`

现在直接输入第一条命令就能看到后端日志了！


## 维护

### 清理库
cd /opt/toonflow/toonflow-game-app
rm -rf /opt/toonflow/toonflow-game-app/node_modules

### nodejs 22 安装 与加速
[nodejs.md](nodejs.md)

###
git pull --ff-only origin dev

### 更新库
yarn install  --frozen-lockfile --ignore-engines

### 构建
yarn build


## 监控
ps aux | grep "node /opt/toonflow" | grep -v grep
看看有没有跑了多个线程

ps aux | grep "tower-pm2" | grep -v grep
看看 tower-pm2 自己有没有跑了多个线程