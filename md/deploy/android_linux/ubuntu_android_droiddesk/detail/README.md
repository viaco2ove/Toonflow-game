# 运行目录
`/opt/toonflow/toonflow-game-app`
DB_PATH=/data/toonflow/db.sqlite
UPLOAD_DIR=/data/toonflow/uploads
LOG_PATH=/data/toonflow/logs

# 环境配置
`install.sh` 会自动生成：

```text
/opt/toonflow/toonflow-game-app/env/.env.local
```

`toonflow-game-app` 会使用这个 `.env.local` 作为运行环境配置。

# main.py 部署说明

`detail/main.py` 不需要单独部署。

执行：

```bash
source ./install.config.sh
./install.sh
```

`install.sh` 会自动做这些事：

- 安装 `python3`、`python3-pip`、`python3-venv`
- 复制 `detail/main.py` 到 `PANEL_DIR/main.py`
- 在 `PANEL_DIR` 创建 Python 虚拟环境
- 安装 `fastapi` 和 `uvicorn`
- 生成 `PANEL_DIR/start-panel.sh`
- 用 `droiddesk-tower service add` 托管管理页（服务名 `PANEL_NAME`，默认 `toonflow-panel`）

默认配置在：[install.config.sh](../install.config.sh)

主要变量：

```bash
export PANEL_PORT="6008"
export PANEL_NAME="toonflow-panel"
export PANEL_DIR="$INSTALL_ROOT/panel"
export PANEL_APP_NAME="$PM2_NAME"
export PANEL_APP_DIR="$INSTALL_ROOT/toonflow-game-app"
export PANEL_WEB_PORT="$HTTP_PORT"
export PANEL_APP_PORT="$APP_PORT"
export PANEL_WEB_PUBLISH_DIR="/var/www/toonflow"
```

可选安全项：设置 `PANEL_TOKEN` 后管理页需要口令访问（不带 token 的请求返回口令页）。
在 `install.config.sh` 里 `export PANEL_TOKEN="你的口令"` 即可，`install.sh`
会把它写进生成的 `start-panel.sh`。

安装完成后访问：

```text
http://你的服务器IP/
http://你的服务器IP:6008/
```

注意：

```text
主站是 http://你的服务器IP/
管理页是 http://你的服务器IP:6008/
不要写成 http://你的服务器IP/6008/
```

查看状态：

```bash
tower-pm2 status                     # 后端服务状态
tower-pm2 logs toonflow-game         # 后端日志
droiddesk-tower service list         # 管理页服务状态
```

# nginx 配置
/etc/nginx/sites-available/toonflow-game
[nginx.conf](../modify/toonflow-game)
修改命令

sudo nano /etc/nginx/sites-available/toonflow-game
sudo nginx -t
droiddesk-tower nginx reload

# 清理环境&安装
```
  cd /opt/toonflow/toonflow-game-app
  rm -rf node_modules build

  cd ~/ubuntu_android_droiddesk
  source ./install.config.sh
  ./install.sh
```

# 服务器上先加 swap，至少 2G 
```
sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  free -h   
```
cd /opt/toonflow/Toonflow-game-web/
yarn build

# 授权
chmod +x ~/ubuntu_android_droiddesk/install.sh
# 重启
- 方法1：http://你的服务器IP:6008/ 中操作
- 方法2：命令行
  - 查看状态

```bash
tower-pm2 status
```

  - 重启主站

```bash
tower-pm2 restart toonflow-game
```

  - 停止

```bash
tower-pm2 stop toonflow-game
```

  - 查看日志

```bash
tower-pm2 logs toonflow-game
```

  - 管理页服务

```bash
droiddesk-tower service list
droiddesk-tower service start toonflow-panel
droiddesk-tower service stop toonflow-panel
```
