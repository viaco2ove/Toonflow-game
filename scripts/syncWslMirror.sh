#!/usr/bin/env bash
set -euo pipefail

# 把当前工作区同步到 WSL 专用镜像目录，保留镜像内的 Linux node_modules。
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIRROR_DIR="${1:-.wsl_mirror}"
TARGET_DIR="$ROOT_DIR/$MIRROR_DIR"

mkdir -p "$TARGET_DIR"

rsync -av --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude .idea \
  --exclude .hide \
  --exclude backup \
  --exclude build \
  --exclude dist \
  --exclude '*.log' \
  --exclude '*.sqlite' \
  --exclude '*.sqlite-*' \
  --exclude '*.db' \
  --exclude '*.db-*' \
  --exclude tmp \
  --exclude upload \
  --exclude uploads \
  --exclude Toonflow-game \
  --exclude node_modules_wsl \
  --exclude .wsl_mirror \
  "$ROOT_DIR/" "$TARGET_DIR/"
