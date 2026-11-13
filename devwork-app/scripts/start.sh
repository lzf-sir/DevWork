#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# DevWork 一键启动（开发态）。
#   scripts/start.sh            启动开发态（vite + 后端 + 桌面窗口）
#   scripts/start.sh --prod     生产态（用已构建的 dist）
#   scripts/start.sh --check    只做环境自检
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/start.mjs "$@"
