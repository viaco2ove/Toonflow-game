后端是 **PM2 托管的 Node.js 服务**，不是 systemd，所以之前的 `journalctl` 命令完全没用。

# 正确查看后端运行日志命令（直接复制用）
## 1. 实时查看后端日志（最常用、必用）
```bash
pm2 logs toonflow-game
```



## 2. 只看最近 100 行 + 实时追踪（不刷屏）
```bash
pm2 logs toonflow-game --lines 100
```

## 3. 只查看历史日志（不实时刷新）
```bash
pm2 logs toonflow-game --nostream
```

## 4. 查看后端服务是否在线
```bash
pm2 status
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
pm2 restart toonflow-game
```

## 停止后端
```bash
pm2 stop toonflow-game
```

## 查看后端资源占用
```bash
pm2 monit
```

---

### 总结
1. **你们后端是 PM2 管理** → 用 `pm2 logs` 看日志
2. **实时日志**：`pm2 logs toonflow-game`
3. **服务状态**：`pm2 status`
4. **重启服务**：`pm2 restart toonflow-game`

现在直接输入第一条命令就能看到后端日志了！


## 维护

### 清理库
cd /opt/toonflow/toonflow-game-app
rm -rf /opt/toonflow/toonflow-game-app/node_modules

### nodejs 22 安装 与加速
[nodejs.md](nodejs.md)


### 更新库
yarn install  --frozen-lockfile --ignore-engines

### 构建
yarn build