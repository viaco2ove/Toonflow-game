#!/usr/bin/env bash
set -Eeuo pipefail

# 手动启动 Ubuntu 管理页。
# 用途：
# 1. 本地/服务器前台调试 main.py；
# 2. 作为 PM2 托管的稳定启动入口，避免 `bash -lc` 包长命令时出现换行与引号解析问题。

cd /opt/toonflow/panel || exit 1

# 显式导出管理页所依赖的环境变量，确保手动启动与 PM2 启动使用同一套参数。
export PANEL_APP_NAME="toonflow-game"
export PANEL_APP_DIR="/opt/toonflow/toonflow-game-app"
export PANEL_APP_PORT="60002"
export PANEL_WEB_PORT="80"
export PANEL_WEB_PUBLISH_DIR="/var/www/toonflow"
export PANEL_WEB_PROJECT_DIR="/opt/toonflow/Toonflow-game-web"
export PANEL_WEB_BUILD_NODE_OPTIONS="--max-old-space-size=512"

exec /opt/toonflow/panel/.venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 6008
