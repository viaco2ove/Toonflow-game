# toonflow-panel.service 安装
直接看 [README.md](../README.md)

# 手动安装如下：
`toonflow-panel` 建议使用 `systemd` 托管，不再使用 `pm2` 托管管理页。

原因：

- 管理页本身很轻量，但需要在按钮里触发 `yarn build`
- 低配 Ubuntu 机器上，`pm2 -> bash -> uvicorn -> 子进程构建` 这条链更容易增加排查复杂度
- `systemd` 直接托管 `start-panel.sh`，路径与环境变量更稳定，便于排查

## 1. 准备目录与文件

把管理页脚本和启动脚本放到服务器：

```bash
mkdir -p /opt/toonflow/panel
cp md/deploy/ubuntu/detail/main.py /opt/toonflow/panel/main.py
cp md/deploy/ubuntu/detail/start-panel.sh /opt/toonflow/panel/start-panel.sh
chmod +x /opt/toonflow/panel/start-panel.sh
```

## 2. 创建 Python 虚拟环境

```bash
python3 -m venv /opt/toonflow/panel/.venv
/opt/toonflow/panel/.venv/bin/python -m pip install --upgrade pip
/opt/toonflow/panel/.venv/bin/python -m pip install fastapi uvicorn
```

## 3. 创建 systemd 服务

写入 `/etc/systemd/system/toonflow-panel.service`：

```bash
cat >/etc/systemd/system/toonflow-panel.service <<'EOF'
[Unit]
Description=Toonflow Panel
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/toonflow/panel
ExecStart=/opt/toonflow/panel/start-panel.sh
Restart=always
RestartSec=3
User=root
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF
```

## 4. 安装并启用服务

```bash
systemctl daemon-reload
systemctl enable toonflow-panel.service
```

# 启动

启动前先清理旧的 `pm2` 管理页进程与 6008 端口占用：

```bash
fuser -k 6008/tcp || true
pm2 delete toonflow-panel || true
systemctl daemon-reload
systemctl restart toonflow-panel.service
systemctl status toonflow-panel.service --no-pager
journalctl -u toonflow-panel.service -n 50 --no-pager
```

## 5. 验证

本机验证：

```bash
curl -I http://127.0.0.1:6008/
```

浏览器验证：

```text
http://你的服务器IP:6008/
```

## 6. 常用排查命令

查看服务状态：

```bash
systemctl status toonflow-panel.service --no-pager
```

查看最近日志：

```bash
journalctl -u toonflow-panel.service -n 100 --no-pager
```

查看 6008 端口占用：

```bash
ss -lntp | grep 6008
```

## 7. 说明

如果已经使用新版 `md/deploy/ubuntu/install.sh` 重新部署，安装脚本会自动：

- 生成 `/opt/toonflow/panel/start-panel.sh`
- 生成 `toonflow-panel.service`
- 使用 `systemd` 启动管理页

此时无需手工重复创建服务文件。
