#!/usr/bin/env bash
# Start laya-serve for bloomScroll: localhost only, English checkpoint, tuned for a 2-core Intel Mac.
# setup.sh registers this to run at login; you can also run it by hand.
set -euo pipefail
cd "$(dirname "$0")"
export LAYA_HOST="${LAYA_HOST:-127.0.0.1}"   # laya-serve defaults to 0.0.0.0; never expose it
export LAYA_PORT="${LAYA_PORT:-8765}"
export LAYA_MODELS="${LAYA_MODELS:-english}"
export LAYA_DEFAULT_MODEL="${LAYA_DEFAULT_MODEL:-english}"
export LAYA_THREADS="${LAYA_THREADS:-$(sysctl -n hw.physicalcpu 2>/dev/null || nproc)}"
# setup.sh installs Laya's Python environment outside the bloomScroll folder (macOS blocks background
# programs from reading Desktop, Documents and Downloads), and copies this script next to it.
RUNTIME="${BLOOM_RUNTIME_DIR:-$([[ "$(uname -s)" == Darwin ]] && echo "$HOME/Library/Application Support/bloomScroll" || echo "${XDG_DATA_HOME:-$HOME/.local/share}/bloomScroll")}"
LAYA=""
for venv in "$PWD/venv" "$RUNTIME/venv" "$PWD/.venv"; do
  if [[ -x "$venv/bin/laya-serve" ]]; then LAYA="$venv/bin/laya-serve"; break; fi
done
if [[ -z "$LAYA" ]]; then
  echo "laya-serve isn't installed yet. From the bloomScroll folder, run: bash setup.sh" >&2
  exit 1
fi
# Already running (by hand, or by the login item)? Then there's nothing to do. Exiting 0 also tells
# the login item not to retry.
if curl -fsS -m 2 "http://$LAYA_HOST:$LAYA_PORT/health" >/dev/null 2>&1; then
  echo "Laya is already running on http://$LAYA_HOST:$LAYA_PORT"
  exit 0
fi
exec "$LAYA"
