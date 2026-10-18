#!/usr/bin/env bash
# Chrome starts this when bloomScroll's Settings page talks to the local Laya helper (native
# messaging). It runs laya_control.py with Laya's own Python, so nothing else needs installing.
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/.venv/bin/python" "$DIR/laya_control.py"
