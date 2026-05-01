# 运行目录
`/opt/toonflow/toonflow-game-app`

# 环境配置
`install.sh` 会自动生成：
[本地头像分离模型安装.md](../../../modeapi/image/%E6%9C%AC%E5%9C%B0%E5%A4%B4%E5%83%8F%E5%88%86%E7%A6%BB%E6%A8%A1%E5%9E%8B%E5%AE%89%E8%A3%85.md)
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
- 复制 [main.py](/mnt/d/users/viaco/tools/toonflow-game/toonflow-game-app/md/deploy/ubuntu/detail/main.py)
- 在 `PANEL_DIR` 创建 Python 虚拟环境
- 安装 `fastapi` 和 `uvicorn`
- 用 `pm2` 启动管理页进程

默认配置在：

[install.config.sh](/mnt/d/users/viaco/tools/toonflow-game/toonflow-game-app/md/deploy/ubuntu/install.config.sh)

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

安装完成后访问：

```text
http://你的服务器IP:6008/
```

查看状态：

```bash
pm2 status                                                                                                                                                                        
pm2 logs toonflow-game                                                                                                                                                            
pm2 logs toonflow-panel  
```
