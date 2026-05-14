#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIRROR_DIR="${WSL_MIRROR_DIR:-.wsl_mirror}"
TARGET_DIR="$ROOT_DIR/$MIRROR_DIR"

if [ "$#" -eq 0 ]; then
  echo "用法: bash scripts/runWslMirror.sh <command...>" >&2
  exit 1
fi

bash "$ROOT_DIR/scripts/syncWslMirror.sh" "$MIRROR_DIR"

if [ ! -d "$TARGET_DIR/node_modules" ]; then
  echo "检测到 $TARGET_DIR 尚未安装依赖，开始执行 yarn install" >&2
  (
    cd "$TARGET_DIR"
    yarn install
  )
fi

cd "$TARGET_DIR"
exec "$@"
