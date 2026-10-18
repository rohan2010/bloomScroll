#!/usr/bin/env bash
# Chrome starts this when bloomScroll's Settings page talks to the local Laya helper (native
# messaging). setup.sh copies it, with laya_control.py, next to Laya's Python environment (outside
# the bloomScroll folder, which macOS may block background programs from reading).
DIR="$(cd "$(dirname "$0")" && pwd)"
for venv in "$DIR/venv" "$DIR/.venv"; do
  if [[ -x "$venv/bin/python" ]]; then exec "$venv/bin/python" "$DIR/laya_control.py"; fi
done
exec /usr/bin/python3 "$DIR/laya_control.py"
