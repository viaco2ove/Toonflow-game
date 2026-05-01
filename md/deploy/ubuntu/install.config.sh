#!/usr/bin/env bash

# Ubuntu 一键安装配置文件。
# 用法：
#   1. 先修改下面变量
#   2. 再执行：
#      source ./install.config.sh
#      ./install.sh

export INSTALL_ROOT="/opt/toonflow"
export DATA_DIR="/data/toonflow"

export APP_REPO="https://github.com/viaco2ove/Toonflow-game.git"
export WEB_REPO="https://github.com/viaco2ove/Toonflow-game-web.git"

# 可选：指定分支，不需要就留空。
export APP_BRANCH="dev"
export WEB_BRANCH="dev"

export NODE_MAJOR="20"
export APP_PORT="60002"
export HTTP_PORT="80"
export PM2_NAME="toonflow-game"
export SERVER_NAME="_"

# 必填：这里写你最终给浏览器访问的地址。
# 例如：
# export PUBLIC_URL="http://8.8.8.8/"
# export PUBLIC_URL="https://toonflow.example.com/"
export PUBLIC_URL="http://你的服务器IP/"

# 可选：临时 OSS 配置，不需要就留空。
export TEMP_OSS=""

# 可选：如果 scripts/web 已经是最新前端产物，改成 1 可以跳过前端构建。
export SKIP_FRONTEND="0"

# 可选：管理页端口。给 detail/main.py 用。
export PANEL_PORT="6008"
export PANEL_NAME="toonflow-panel"
export PANEL_DIR="$INSTALL_ROOT/panel"
export PANEL_APP_NAME="$PM2_NAME"
export PANEL_APP_DIR="$INSTALL_ROOT/toonflow-game-app"
export PANEL_WEB_PORT="$HTTP_PORT"
export PANEL_APP_PORT="$APP_PORT"
export PANEL_WEB_PUBLISH_DIR="/var/www/toonflow"
