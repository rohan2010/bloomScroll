#!/usr/bin/env bash
# Start laya-serve for bloomScroll: localhost only, English checkpoint, tuned for a 2-core Intel Mac.
set -euo pipefail
cd "$(dirname "$0")"
export LAYA_HOST="${LAYA_HOST:-127.0.0.1}"   # laya-serve defaults to 0.0.0.0; never expose it
export LAYA_PORT="${LAYA_PORT:-8765}"
export LAYA_MODELS="${LAYA_MODELS:-english}"
export LAYA_DEFAULT_MODEL="${LAYA_DEFAULT_MODEL:-english}"
export LAYA_THREADS="${LAYA_THREADS:-$(sysctl -n hw.physicalcpu 2>/dev/null || nproc)}"
if [[ ! -x .venv/bin/laya-serve ]]; then
  echo "laya-serve isn't installed yet. From the repo root, run: ./setup.sh" >&2
  exit 1
fi
exec .venv/bin/laya-serve
