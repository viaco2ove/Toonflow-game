# toonflow-panel.service 安装
直接看 [README.md](../../README.md)

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
source .venv/bin/activate
/opt/toonflow/panel/.venv/bin/python -m pip install --upgrade pip
/opt/toonflow/panel/.venv/bin/python -m pip install fastapi uvicorn
```


## 安装并启用服务

```bash
#droiddesk-tower service list
droiddesk-tower service add Toonflow管理页 /opt/toonflow/panel/start-panel.sh --nginx --keep-live
# droiddesk-tower service delete Toonflow管理页
#droiddesk-tower service config Toonflow管理页
```

# 启动

启动前先清理旧的 `tower-pm2` 管理页进程与 6008 端口占用：

```bash
fuser -k 6008/tcp || true

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



查看 6008 端口占用：

```bash
ss -lntp | grep 6008
```

## 7. 说明

如果已经使用新版 `../../install.sh` 重新部署，安装脚本会自动：

- 生成 `/opt/toonflow/panel/start-panel.sh`
- 生成 `toonflow-panel.service`

此时无需手工重复创建服务文件。
