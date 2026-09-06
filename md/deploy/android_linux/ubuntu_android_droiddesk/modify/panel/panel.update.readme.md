# 管理面板更新与操作指南 (supervisor)

> 适用于 Android proot Ubuntu / Termux / 普通 Ubuntu 环境。
> 管理面板使用 **supervisor** 托管，不依赖 systemd，也不使用 tower-pm2。

---

## 一、更新管理面板

安装脚本运行后，面板文件位于 `$PANEL_DIR`（默认 `/opt/toonflow/panel`）：

```bash
# 复制新版本（如果需要手动更新）
cp ~/ubuntu/detail/main.py /opt/toonflow/panel/main.py
```

`start-panel.sh` 是安装脚本自动生成的，无需手动复制或修改。

---

## 安装并启用服务:Toonflow管理页

```bash
#droiddesk-tower service list
droiddesk-tower service add ToonflneowPanel /opt/toonflow/panel/start-panel.sh --nginx --keep-live
# droiddesk-tower service delete "ToonflneowPanel"
#droiddesk-tower service config ToonflneowPanel
```

## 二、进程名

| 组件 | 进程名 |
|------|--------|
| 后端服务 | `toonflow-game`（tower-pm2 托管） |
| 管理面板 | `toonflow-panel`（supervisor 托管） |

---

## 三、查看状态

```bash
# 查看后端 tower-pm2 状态
tower-pm2 status

# 查看后端 tower-pm2 日志
tower-pm2 logs toonflow-game --lines 100
tower-pm2 logs toonflow-game --nostream


# 查看管理面板日志
tail -f /opt/toonflow/panel/supervisor.log
tail -f /opt/toonflow/panel/supervisor.err.log
```

---


## 五、查看管理面板进程（手动方式）

```bash
ps aux | grep -E 'uvicorn|python.*main' | grep -v grep
```

---



**Q: 面板构建 yarn build 失败？**
A: 如果直接运行 `./start-panel.sh` 正常但通过 supervisor 跑有问题，检查环境变量是否正确传递。确认 `/etc/supervisor/conf.d/toonflow-panel.conf` 中的 `environment` 配置。


cat /var/log/supervisor/supervisord.log