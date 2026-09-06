#!/bin/bash

# PREFIX 是 Termux 专属环境变量，proot Ubuntu / 普通 Ubuntu 里不存在。
# 提前补默认值，避免 set -u 下引用未定义变量报错。
PREFIX="${PREFIX:-}"

# Android/Termux/Ubuntu 通用安装配置文件。
# 用法：
#   1. 先修改下面变量
#   2. 再执行：
#      source ./install.config.sh
#      ./install.sh

# 检测是否为 Termux 环境
if [ -d "/data/data/com.termux" ] || [ -f "$PREFIX/bin/pkg" ]; then
  # Termux 环境：使用 HOME 目录
  DEFAULT_ROOT="$HOME/storage/shared/toonflow"
  DEFAULT_DATA="$HOME/storage/shared/toonflow-data"
else
  # Ubuntu/Linux 环境：使用标准路径
  DEFAULT_ROOT="/opt/toonflow"
  DEFAULT_DATA="/data/toonflow"
fi

INSTALL_ROOT="${INSTALL_ROOT:-$DEFAULT_ROOT}"
DATA_DIR="${DATA_DIR:-$DEFAULT_DATA}"

export APP_REPO="https://github.com/viaco2ove/Toonflow-game.git"
export WEB_REPO="https://github.com/viaco2ove/Toonflow-game-web.git"

# 可选：指定分支，不需要就留空。
export APP_BRANCH="dev"
export WEB_BRANCH="dev"

export NODE_MAJOR="20"
export APP_PORT="60002"
export HTTP_PORT="8088"
export tower-pm2_NAME="toonflow-game"
export SERVER_NAME="_"

# 必填：这里写你最终给浏览器访问的地址。
# Termux 用户注意：Android 10+ 需要用 localhost + ADB reverse 或 ngrok
# export PUBLIC_URL="http://localhost:8088/"
export PUBLIC_URL="http://你的服务器IP/"

# 可选：临时 OSS 配置，不需要就留空。
export TEMP_OSS=""

# 可选：如果 scripts/web 已经是最新前端产物，改成 1 可以跳过前端构建。
export SKIP_FRONTEND="0"

# 可选：管理页端口。
export PANEL_PORT="6008"
export PANEL_NAME="toonflow-panel"
export PANEL_DIR="${INSTALL_ROOT}/panel"
export PANEL_APP_NAME="$tower-pm2_NAME"
export PANEL_APP_DIR="${INSTALL_ROOT}/toonflow-game-app"
export PANEL_WEB_PORT="$HTTP_PORT"
export PANEL_APP_PORT="$APP_PORT"
export PANEL_WEB_PUBLISH_DIR="${INSTALL_ROOT}/www"
