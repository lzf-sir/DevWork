#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# DevWork 一键打包（生成 Windows x64 安装包）。
#   scripts/package.sh          生成安装包
#   scripts/package.sh --dir    只出免安装目录
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/package.mjs "$@"
