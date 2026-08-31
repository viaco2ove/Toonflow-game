# 管理面板更新与操作指南

> 适用于 Android proot Ubuntu / Termux / 普通 Ubuntu 环境。
> proot 环境没有 systemd，所有 systemctl 命令不可用。

---

## 一、更新管理面板

安装脚本运行后，面板文件位于 `$PANEL_DIR`（默认 `/opt/toonflow/panel`）：

```bash
# 复制新版本（如果需要手动更新）
cp ~/ubuntu/detail/main.py /opt/toonflow/panel/main.py
```

`start-panel.sh` 是安装脚本自动生成的，无需手动复制或修改。

---

## 二、PM2 进程名

| 环境 | PM2 进程名 |
|------|-----------|
| proot / Termux | `toonflow-panel` |
| systemd Ubuntu | `toonflow-panel`（systemd 托管，不走 PM2） |

注意：进程名是 `toonflow-panel`，**不是** `toonflow-panel.service`。
`toonflow-panel.service` 是 systemd 服务文件名，不是 PM2 进程名。

---

## 三、查看状态

```bash
# 查看 PM2 所有进程
pm2 status

# 查看管理面板进程
pm2 describe toonflow-panel

# 查看管理面板日志
pm2 logs toonflow-panel --lines 100
pm2 logs toonflow-panel --nostream   # 非实时，只看当前日志
```

如果管理面板用 systemd 托管（非 proot 环境）：

```bash
systemctl status toonflow-panel.service
journalctl -u toonflow-panel.service -n 100 --no-pager
```

---

## 四、启停管理面板

### proot / Termux 环境（用 PM2）

```bash
# 停止
pm2 stop toonflow-panel

# 重启
pm2 restart toonflow-panel

# 删除后重新启动
pm2 delete toonflow-panel
cd /opt/toonflow/panel
pm2 start start-panel.sh --name toonflow-panel
pm2 save
```

### systemd 环境

```bash
# 停止
sudo systemctl stop toonflow-panel.service

# 重启
sudo systemctl restart toonflow-panel.service

# 查看日志
sudo journalctl -u toonflow-panel.service -n 100 --no-pager
```

---

## 五、查看管理面板进程（手动方式）

```bash
ps aux | grep -E 'uvicorn|python.*main' | grep -v grep
```

---

## 六、常见问题

**Q: pm2 logs 显示进程不存在？**
A: 检查进程名是否正确：`pm2 status`，进程名是 `toonflow-panel`。

**Q: systemctl 命令报错 "System has not been booted with systemd"？**
A: 这是 proot/Termux 环境，没有 systemd。请用上面的 PM2 命令替代。

**Q: 想完全重新部署面板？**
A:
```bash
pm2 delete toonflow-panel
cd /opt/toonflow/panel
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install fastapi uvicorn
pm2 start start-panel.sh --name toonflow-panel
pm2 save
```
