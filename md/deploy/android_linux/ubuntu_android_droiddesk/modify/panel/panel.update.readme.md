# 管理面板更新与操作指南 (supervisor)

> 适用于 Android proot Ubuntu / Termux / 普通 Ubuntu 环境。
> 管理面板使用 **supervisor** 托管，不依赖 systemd，也不使用 PM2。

---

## 一、更新管理面板

安装脚本运行后，面板文件位于 `$PANEL_DIR`（默认 `/opt/toonflow/panel`）：

```bash
# 复制新版本（如果需要手动更新）
cp ~/ubuntu/detail/main.py /opt/toonflow/panel/main.py
```

`start-panel.sh` 是安装脚本自动生成的，无需手动复制或修改。

---

## 二、进程名

| 组件 | 进程名 |
|------|--------|
| 后端服务 | `toonflow-game`（PM2 托管） |
| 管理面板 | `toonflow-panel`（supervisor 托管） |

---

## 三、查看状态

```bash
# 查看后端 PM2 状态
pm2 status

# 查看后端 PM2 日志
pm2 logs toonflow-game --lines 100
pm2 logs toonflow-game --nostream

# 查看管理面板 supervisor 状态
supervisorctl status toonflow-panel

# 查看管理面板日志
tail -f /opt/toonflow/panel/supervisor.log
tail -f /opt/toonflow/panel/supervisor.err.log
```

---

## 四、启停管理面板

### 启动/停止/重启

```bash
supervisorctl start toonflow-panel
supervisorctl stop toonflow-panel
supervisorctl restart toonflow-panel
supervisorctl reread      # 重新读取配置（修改 .conf 后用）
supervisorctl update      # 应用配置更新
```

### 完全重新部署管理面板

```bash
supervisorctl stop toonflow-panel
cd /opt/toonflow/panel
cp ~/ubuntu/detail/main.py /opt/toonflow/panel/main.py
supervisorctl start toonflow-panel
supervisorctl status toonflow-panel
```

---

## 五、查看管理面板进程（手动方式）

```bash
ps aux | grep -E 'uvicorn|python.*main' | grep -v grep
```

---

## 六、supervisor 配置文件位置

```bash
/etc/supervisor/conf.d/toonflow-panel.conf
```

如果需要修改启动参数，编辑这个文件后执行：

```bash
supervisorctl reread
supervisorctl update
supervisorctl restart toonflow-panel
```

---

## 七、常见问题

**Q: supervisorctl 报错 "toonflow-panel: ERROR (no such process)"？**
A: 面板进程可能未启动，先启动：
```bash
supervisorctl start toonflow-panel
```

**Q: 想临时手动运行面板调试？**
A:
```bash
cd /opt/toonflow/panel
./start-panel.sh
```

**Q: supervisor 开机自启？**
A: proot 环境没有 systemd 开机自启，但 supervisor 进程本身会随系统重启。如果 proot 重启后 supervisor 未运行，需要手动：
```bash
supervisord -c /etc/supervisor/supervisord.conf
```

**Q: 面板构建 yarn build 失败？**
A: 如果直接运行 `./start-panel.sh` 正常但通过 supervisor 跑有问题，检查环境变量是否正确传递。确认 `/etc/supervisor/conf.d/toonflow-panel.conf` 中的 `environment` 配置。


cat /var/log/supervisor/supervisord.log