#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# DevWork 一键打包（生成 Windows x64 产物）。
#   scripts/package.sh              只出 zip 压缩包
#   scripts/package.sh --dir        只出免安装目录（自测最快）
#   scripts/package.sh --installer  NSIS 安装包
#   scripts/package.sh --portable   便携单文件
#   scripts/package.sh --all        zip + 安装包 + 便携版
#   scripts/package.sh --help       全部参数
#
# 参数会原样透传给 scripts/package.mjs，它才是唯一的实现。
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/package.mjs "$@"
