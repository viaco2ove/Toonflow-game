#!/usr/bin/env bash
set -Eeuo pipefail

# Toonflow Game Ubuntu 一键部署脚本。
# 用途：
# - 安装 Node/Yarn/PM2/Nginx/ffmpeg/编译依赖
# - 拉取或更新后端仓库与前端仓库
# - 构建前端并同步到后端 scripts/web
# - 构建后端 build/app.js
# - 创建 local 环境变量
# - 配置 PM2 和 Nginx
# - 部署 FastAPI 管理页 detail/main.py

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/install.config.sh" ]; then
  # 允许用户把常用变量放到同目录配置文件里，避免每次手敲一长串环境变量。
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/install.config.sh"
fi

INSTALL_ROOT="${INSTALL_ROOT:-/opt/toonflow}"
DATA_DIR="${DATA_DIR:-/data/toonflow}"
APP_DIR="${APP_DIR:-$INSTALL_ROOT/toonflow-game-app}"
WEB_DIR="${WEB_DIR:-$INSTALL_ROOT/Toonflow-game-web}"
APP_REPO="${APP_REPO:-}"
WEB_REPO="${WEB_REPO:-}"
APP_BRANCH="${APP_BRANCH:-}"
WEB_BRANCH="${WEB_BRANCH:-}"
NODE_MAJOR="${NODE_MAJOR:-20}"
APP_PORT="${APP_PORT:-60002}"
HTTP_PORT="${HTTP_PORT:-80}"
PM2_NAME="${PM2_NAME:-toonflow-game}"
SERVER_NAME="${SERVER_NAME:-_}"
PUBLIC_URL="${PUBLIC_URL:-}"
TEMP_OSS="${TEMP_OSS:-}"
SKIP_FRONTEND="${SKIP_FRONTEND:-0}"
PANEL_PORT="${PANEL_PORT:-6008}"
PANEL_NAME="${PANEL_NAME:-toonflow-panel}"
PANEL_DIR="${PANEL_DIR:-$INSTALL_ROOT/panel}"
PANEL_APP_NAME="${PANEL_APP_NAME:-$PM2_NAME}"
PANEL_APP_DIR="${PANEL_APP_DIR:-$APP_DIR}"
PANEL_WEB_PORT="${PANEL_WEB_PORT:-$HTTP_PORT}"
PANEL_APP_PORT="${PANEL_APP_PORT:-$APP_PORT}"
PANEL_WEB_PUBLISH_DIR="${PANEL_WEB_PUBLISH_DIR:-/var/www/toonflow}"
WEB_BUILD_NODE_OPTIONS="${WEB_BUILD_NODE_OPTIONS:---max-old-space-size=512}"
PANEL_WEB_BUILD_NODE_OPTIONS="${PANEL_WEB_BUILD_NODE_OPTIONS:-$WEB_BUILD_NODE_OPTIONS}"
PANEL_WEB_PROJECT_DIR="${PANEL_WEB_PROJECT_DIR:-$WEB_DIR}"

if [ -z "$APP_REPO" ] && [ -f "package.json" ] && [ -f "src/app.ts" ]; then
  APP_DIR="$(pwd)"
fi

log() {
  printf '\n\033[1;36m[toonflow]\033[0m %s\n' "$*"
}

die() {
  printf '\n\033[1;31m[toonflow:error]\033[0m %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"
}

install_yarn_dependencies() {
  # 服务端构建需要 typescript/tsx 等开发依赖，但仓库同时包含 Electron 桌面依赖。
  # Ubuntu 部署不会使用 Electron，这里忽略 engines 校验，避免被桌面打包链阻塞。
  if [ -d node_modules ]; then
    rm -rf node_modules
  fi
  yarn install --frozen-lockfile --ignore-engines
}

run_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

detect_public_url() {
  if [ -n "$PUBLIC_URL" ]; then
    printf '%s' "$PUBLIC_URL"
    return
  fi

  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [ -z "$ip" ]; then
    ip="127.0.0.1"
  fi
  if [ "$HTTP_PORT" = "80" ]; then
    printf 'http://%s/' "$ip"
  else
    printf 'http://%s:%s/' "$ip" "$HTTP_PORT"
  fi
}

checkout_branch_if_needed() {
  local branch="$1"
  local current_branch
  current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [ -z "$branch" ] || [ "$branch" = "$current_branch" ]; then
    return
  fi

  # 如果仓库有未提交改动，禁止自动切换到其他分支，避免覆盖用户自己的修改。
  if [ -n "$(git status --porcelain)" ]; then
    die "仓库 $PWD 存在未提交改动，无法自动切换到分支 $branch。请先提交或清理改动。"
  fi

  git fetch --all --tags
  git checkout "$branch"
}

cleanup_legacy_env_files() {
  # 旧版部署脚本会写入被 Git 跟踪的 env/.env.prod，后续 git checkout/pull 容易冲突。
  # 这里仅在文件已被修改时恢复该历史文件，避免再次阻塞部署。
  if git ls-files --error-unmatch env/.env.prod >/dev/null 2>&1; then
    if ! git diff --quiet -- env/.env.prod 2>/dev/null; then
      git restore --worktree --staged env/.env.prod >/dev/null 2>&1 || true
    fi
  fi
}

clone_or_update_repo() {
  local dir="$1"
  local repo="$2"
  local branch="$3"
  local name="$4"

  if [ -d "$dir/.git" ]; then
    log "更新 $name：$dir"
    cd "$dir"
    cleanup_legacy_env_files
    checkout_branch_if_needed "$branch"
    git pull --ff-only
    return
  fi

  if [ -z "$repo" ]; then
    die "$name 不存在且未配置仓库地址。请设置 ${name}_REPO，或先把仓库放到：$dir"
  fi

  log "克隆 $name：$repo"
  mkdir -p "$(dirname "$dir")"
  git clone "$repo" "$dir"
  cd "$dir"
  checkout_branch_if_needed "$branch"
}

install_system_deps() {
  log "安装系统依赖"
  run_sudo apt-get update
  run_sudo apt-get install -y \
    git \
    curl \
    ca-certificates \
    rsync \
    build-essential \
    python3 \
    python3-pip \
    python3-venv \
    make \
    g++ \
    ffmpeg \
    nginx
}

install_node_yarn_pm2() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -v | sed 's/^v//' | cut -d. -f1)"
    if [ "$major" = "$NODE_MAJOR" ]; then
      log "Node.js 已安装：$(node -v)"
    else
      log "当前 Node.js $(node -v)，将安装 Node.js $NODE_MAJOR"
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | run_sudo bash -
      run_sudo apt-get install -y nodejs
    fi
  else
    log "安装 Node.js $NODE_MAJOR"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | run_sudo bash -
    run_sudo apt-get install -y nodejs
  fi

  log "安装 Yarn 和 PM2"
  run_sudo npm install -g yarn@1.22.22 pm2
  node -v
  yarn -v
  pm2 -v
}

prepare_dirs() {
  log "创建目录"
  run_sudo mkdir -p "$INSTALL_ROOT" "$DATA_DIR/uploads" "$DATA_DIR/tools" "$DATA_DIR/logs" "$PANEL_DIR"
  run_sudo chown -R "$(id -u):$(id -g)" "$INSTALL_ROOT" "$DATA_DIR" "$PANEL_DIR"
}

build_frontend() {
  # 构建 web 项目并同步到发布目录。
  # 这里统一限制 Node 构建内存峰值，降低 1G 无 swap 机器上被 OOM 杀掉的概率。
  if [ "$SKIP_FRONTEND" = "1" ]; then
    log "跳过前端构建：SKIP_FRONTEND=1"
    return
  fi

  clone_or_update_repo "$WEB_DIR" "$WEB_REPO" "$WEB_BRANCH" "WEB"

  log "安装并构建前端"
  cd "$WEB_DIR"
  install_yarn_dependencies
  NODE_OPTIONS="$WEB_BUILD_NODE_OPTIONS" yarn build

  log "同步前端 dist 到后端 scripts/web"
  mkdir -p "$APP_DIR/scripts/web"
  rsync -a --delete "$WEB_DIR/dist/" "$APP_DIR/scripts/web/"

  log "同步前端 dist 到 Nginx 发布目录"
  mkdir -p "$PANEL_WEB_PUBLISH_DIR"
  rsync -a --delete "$WEB_DIR/dist/" "$PANEL_WEB_PUBLISH_DIR/"
  run_sudo chown -R www-data:www-data "$PANEL_WEB_PUBLISH_DIR"
  run_sudo chmod -R 755 "$PANEL_WEB_PUBLISH_DIR"
}

write_backend_env() {
  local public_url="$1"
  log "写入后端环境变量：$APP_DIR/env/.env.local"
  mkdir -p "$APP_DIR/env"
  cat > "$APP_DIR/env/.env.local" <<EOF
NODE_ENV=local
PORT=$APP_PORT
OSSURL=$public_url
DB_PATH=$DATA_DIR/db.sqlite
UPLOAD_DIR=$DATA_DIR/uploads
LOCAL_TOOL_DIR=$DATA_DIR/tools
LOG_PATH=$DATA_DIR/logs
TEMP_OSS=$TEMP_OSS
AI_VIDEO_DEBUG=0
AI_VIDEO_POLL_MAX_ATTEMPTS=500
AI_VIDEO_POLL_INTERVAL_MS=2000
LOG_LEVEL=INFO
TEST_MODEL_TIMEOUT_MS=180000
DEBUG_AI_TEXT=0
DEBUG_AI_TEXT_VERBOSE=0
AI_TEXT_DEBUG_HTTP=0
AI_TEXT_DEBUG_HTTP_AUTO=1
AI_TEXT_DEBUG_HTTP_VERBOSE=0
EOF
}

build_backend() {
  clone_or_update_repo "$APP_DIR" "$APP_REPO" "$APP_BRANCH" "APP"
  local public_url
  public_url="$(detect_public_url)"
  write_backend_env "$public_url"

  log "安装并构建后端"
  cd "$APP_DIR"
  install_yarn_dependencies
  NODE_ENV=prod PREFER_PROCESS_ENV=1 yarn build
}

start_pm2() {
  log "启动 PM2 后端服务"
  cd "$APP_DIR"
  if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
    NODE_ENV=local pm2 restart "$PM2_NAME" --update-env
  else
    NODE_ENV=local pm2 start build/app.js --name "$PM2_NAME" --update-env
  fi
  pm2 save

  log "尝试配置 PM2 开机自启"
  if command -v systemctl >/dev/null 2>&1; then
    pm2 startup systemd -u "$(whoami)" --hp "$HOME" || true
    pm2 save
  fi
}

install_panel() {
  # 部署 FastAPI 管理页，方便在 Ubuntu 环境里查看服务状态和执行常用操作。
  # 同时把 web 项目目录和构建内存限制传给管理页，保证面板按钮与安装脚本的构建参数一致。
  local panel_source="$SCRIPT_DIR/detail/main.py"
  local panel_target="$PANEL_DIR/main.py"
  local panel_python="$PANEL_DIR/.venv/bin/python"
  local panel_pm2_command

  [ -f "$panel_source" ] || die "找不到管理页脚本：$panel_source"

  log "部署管理页"
  mkdir -p "$PANEL_DIR"
  cp "$panel_source" "$panel_target"

  if [ ! -x "$panel_python" ]; then
    python3 -m venv "$PANEL_DIR/.venv"
  fi

  "$panel_python" -m pip install --upgrade pip
  "$panel_python" -m pip install fastapi uvicorn

  panel_pm2_command="cd \"$PANEL_DIR\" && \
PANEL_APP_NAME=\"$PANEL_APP_NAME\" \
PANEL_APP_DIR=\"$PANEL_APP_DIR\" \
PANEL_APP_PORT=\"$PANEL_APP_PORT\" \
PANEL_WEB_PORT=\"$PANEL_WEB_PORT\" \
PANEL_WEB_PUBLISH_DIR=\"$PANEL_WEB_PUBLISH_DIR\" \
PANEL_WEB_PROJECT_DIR=\"$PANEL_WEB_PROJECT_DIR\" \
PANEL_WEB_BUILD_NODE_OPTIONS=\"$PANEL_WEB_BUILD_NODE_OPTIONS\" \
\"$panel_python\" -m uvicorn main:app --host 0.0.0.0 --port \"$PANEL_PORT\""

  if pm2 describe "$PANEL_NAME" >/dev/null 2>&1; then
    pm2 delete "$PANEL_NAME"
  fi

  # 这里使用 pm2 托管 uvicorn，避免服务器重启后管理页丢失。
  pm2 start bash --name "$PANEL_NAME" -- -lc "$panel_pm2_command"
  pm2 save
}

write_nginx_config() {
  log "写入 Nginx 配置"
  local nginx_file="/etc/nginx/sites-available/toonflow-game"
  run_sudo tee "$nginx_file" > /dev/null <<EOF
server {
    listen $HTTP_PORT;
    server_name $SERVER_NAME;

    client_max_body_size 100m;

    root $PANEL_WEB_PUBLISH_DIR;
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location ~ ^/(game|assets|voice|setting|other|user|project|prompt|index|novel|outline|script|storyboard|task|video)/ {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location ~ ^/([0-9]+|u_[0-9]+)/(assets|game|voice)/ {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

  run_sudo ln -sf "$nginx_file" /etc/nginx/sites-enabled/toonflow-game
  if [ -f /etc/nginx/sites-enabled/default ]; then
    run_sudo rm -f /etc/nginx/sites-enabled/default
  fi
  run_sudo nginx -t
  run_sudo systemctl enable nginx
  run_sudo systemctl reload nginx
}

print_result() {
  local public_url
  public_url="$(detect_public_url)"
  log "部署完成"
  cat <<EOF

访问地址：
  $public_url

后端：
  http://127.0.0.1:$APP_PORT

管理页：
  http://127.0.0.1:$PANEL_PORT
  $(printf '%s' "$public_url" | sed 's#/$##'):$PANEL_PORT/

常用命令：
  pm2 status
  pm2 logs $PM2_NAME
  pm2 logs $PANEL_NAME
  sudo nginx -t
  sudo systemctl status nginx

数据目录：
  $DATA_DIR

如果外部访问图片或音频失败，请检查：
  $APP_DIR/env/.env.local 里的 OSSURL=$public_url

EOF
}

main() {
  need_cmd awk
  need_cmd sed
  install_system_deps
  install_node_yarn_pm2
  prepare_dirs
  build_frontend   # 先构建前端，同步到后端 scripts/web
  build_backend    # 再构建后端，确保 scripts/web 已经是最新的
  start_pm2
  install_panel
  write_nginx_config
  print_result
}

main "$@"
