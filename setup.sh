#!/usr/bin/env bash
# One-stop setup for bloomScroll: builds the browser extension and installs the local Laya model
# (its Python environment, the ~840 MB checkpoint, and a login item that starts it automatically).
# Safe to re-run: finished steps are skipped.
#
#   bash setup.sh                     everything (recommended)
#   bash setup.sh --no-server         extension only: rules + built-in model, no Laya
#   bash setup.sh --server-only       just the local Laya model
#   bash setup.sh --no-autostart      everything, but don't start Laya at login
#   bash setup.sh --remove-autostart  stop starting Laya at login
#   bash setup.sh --help
#
# Works on macOS and Linux. Windows: use WSL.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$ROOT/server"
# Where Laya runs from: its Python environment, start.sh, the Settings helper and the login item.
# Outside the bloomScroll folder on purpose: macOS blocks background programs (the login item, the
# browser's helper) from reading Desktop, Documents and Downloads, where people often unzip things.
if [[ "$(uname -s)" == Darwin ]]; then
  RUNTIME_DIR="${BLOOM_RUNTIME_DIR:-$HOME/Library/Application Support/bloomScroll}"
else
  RUNTIME_DIR="${BLOOM_RUNTIME_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/bloomScroll}"
fi
EXT_DIR="$ROOT/extension"
VENV="$RUNTIME_DIR/venv"
LAYA_REPO="convaiinnovations/laya"
LAYA_PORT="${LAYA_PORT:-8765}"
AUTOSTART_LABEL="${BLOOM_AUTOSTART_LABEL:-com.bloomscroll.laya}"

WANT_SERVER=1
WANT_EXTENSION=1
WANT_AUTOSTART=1
PYTHON_OVERRIDE="${BLOOM_PYTHON:-}"

# ---------------------------------------------------------------------------------------- output

if [[ -t 1 ]]; then
  B=$'\033[1m' DIM=$'\033[2m' G=$'\033[32m' Y=$'\033[33m' R=$'\033[31m' C=$'\033[36m' X=$'\033[0m'
else
  B="" DIM="" G="" Y="" R="" C="" X=""
fi
step() { printf '\n%s==>%s %s%s%s\n' "$C" "$X" "$B" "$*" "$X"; }
ok() { printf '  %s✓%s %s\n' "$G" "$X" "$*"; }
note() { printf '  %s•%s %s\n' "$DIM" "$X" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$X" "$*"; }
die() {
  printf '\n%s✗ %s%s\n' "$R" "$1" "$X" >&2
  shift
  for line in "$@"; do printf '    %s\n' "$line" >&2; done
  exit 1
}

usage() {
  cat <<EOF
bloomScroll setup

Usage: bash setup.sh [option]

  (no option)          Everything: the extension, the built-in model and the local Laya
                       model, which then starts automatically when you log in. Recommended.
  --no-server          The extension and built-in model only (no Laya, about 50 MB).
  --server-only        Only the local Laya model (add it later, or repair it).
  --no-autostart       Install everything, but don't start Laya automatically at login.
  --remove-autostart   Stop starting Laya at login (and stop it now), then exit.
  --python PATH        Use this Python for Laya (default: picked or downloaded automatically).
  -h, --help           Show this help.

Re-running is safe: steps that are already done are skipped.
EOF
}

REMOVE_AUTOSTART=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-server) WANT_SERVER=0 ;;
    --server-only) WANT_EXTENSION=0 ;;
    --no-autostart) WANT_AUTOSTART=0 ;;
    --remove-autostart) REMOVE_AUTOSTART=1 ;;
    --python)
      [[ $# -ge 2 ]] || die "--python needs a path, e.g. --python /usr/local/bin/python3.11"
      PYTHON_OVERRIDE="$2"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "Unknown option: $1" "Run bash setup.sh --help to see the options." ;;
  esac
  shift
done
[[ $WANT_SERVER -eq 1 || $WANT_EXTENSION -eq 1 ]] || die "--no-server and --server-only together leave nothing to do."

OS="$(uname -s)"
ARCH="$(uname -m)"
intel_mac() { [[ "$OS" == Darwin && "$ARCH" == x86_64 ]]; }

# ---------------------------------------------------------------------------------------- login item

PLIST="$HOME/Library/LaunchAgents/$AUTOSTART_LABEL.plist"
UNIT_NAME="$(echo "$AUTOSTART_LABEL" | tr '.' '-').service"
UNIT="$HOME/.config/systemd/user/$UNIT_NAME"

remove_autostart() {
  if [[ "$OS" == Darwin ]]; then
    launchctl bootout "gui/$(id -u)/$AUTOSTART_LABEL" 2>/dev/null || true
    rm -f "$PLIST"
  elif command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
    rm -f "$UNIT"
    systemctl --user daemon-reload 2>/dev/null || true
  fi
}

if [[ $REMOVE_AUTOSTART -eq 1 ]]; then
  remove_autostart
  printf '%s✓%s Laya will no longer start at login (and has been stopped). Start it by hand with: %s\n' "$G" "$X" "$RUNTIME_DIR/start.sh"
  exit 0
fi

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

AUTOSTART_DIR="$RUNTIME_DIR/autostart"
PLIST_TEMPLATE="$AUTOSTART_DIR/$AUTOSTART_LABEL.plist"
UNIT_TEMPLATE="$AUTOSTART_DIR/$UNIT_NAME"
NATIVE_HOST="com.bloomscroll.laya"

# Writes the login item (macOS LaunchAgent / systemd user unit) as a template in server/autostart/,
# plus control.json for the Settings-page helper (laya_control.py), which copies the template into
# place when start-at-login is switched on. Always written, so the switch works even after
# --no-autostart.
write_service_files() {
  local start log_dir
  start="$RUNTIME_DIR/start.sh"
  mkdir -p "$AUTOSTART_DIR"
  if [[ "$OS" == Darwin ]]; then
    log_dir="$HOME/Library/Logs/bloomScroll"
    mkdir -p "$log_dir"
    cat >"$PLIST_TEMPLATE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$AUTOSTART_LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$(xml_escape "$start")</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LAYA_PORT</key><string>$LAYA_PORT</string>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$(xml_escape "$log_dir/laya.log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$log_dir/laya.log")</string>
</dict>
</plist>
EOF
  else
    cat >"$UNIT_TEMPLATE" <<EOF
[Unit]
Description=bloomScroll local Laya model

[Service]
ExecStart=/bin/bash "$start"
Environment=LAYA_PORT=$LAYA_PORT
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
EOF
  fi
  "$VENV/bin/python" - "$AUTOSTART_DIR/control.json" "$AUTOSTART_LABEL" "$LAYA_PORT" "$start" "$PLIST_TEMPLATE" "$UNIT_TEMPLATE" <<'PY'
import json, sys
out, label, port, start, plist, unit = sys.argv[1:]
json.dump({"label": label, "port": int(port), "start_sh": start, "plist_template": plist, "unit_template": unit}, open(out, "w"), indent=2)
PY
}

# Registers the login item and starts it now.
install_autostart() {
  if [[ "$OS" == Darwin ]]; then
    mkdir -p "$(dirname "$PLIST")"
    cp "$PLIST_TEMPLATE" "$PLIST"
    launchctl bootout "gui/$(id -u)/$AUTOSTART_LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    ok "Laya will start automatically when you log in (log: ~/Library/Logs/bloomScroll/laya.log)"
  elif command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    mkdir -p "$(dirname "$UNIT")"
    cp "$UNIT_TEMPLATE" "$UNIT"
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT_NAME" >/dev/null
    ok "Laya will start automatically when you log in (systemd user service $UNIT_NAME)"
  else
    warn "Couldn't set up automatic start on this system. Start Laya by hand with: $RUNTIME_DIR/start.sh"
    return 1
  fi
}

# Chrome's ID for an extension loaded with "Load unpacked": the first 32 hex digits of SHA-256 of
# the folder's absolute path, with 0-9a-f mapped to a-p.
unpacked_extension_id() { printf '%s' "$1" | (shasum -a 256 2>/dev/null || sha256sum) | cut -c1-32 | tr '0-9a-f' 'a-p'; }

# Lets bloomScroll's Settings page start and stop Laya: registers the helper with each Chromium
# browser, allowed only for this extension's ID (computed from extension/dist's path, both as
# written and with symlinks resolved, since either can end up in Chrome).
install_native_host() {
  local dist logical physical origins d n=0
  local -a dirs
  dist="$EXT_DIR/dist"
  logical="$(unpacked_extension_id "$dist")"
  physical="$(unpacked_extension_id "$(cd "$dist" 2>/dev/null && pwd -P || echo "$dist")")"
  origins="\"chrome-extension://$logical/\""
  [[ "$physical" != "$logical" ]] && origins="$origins, \"chrome-extension://$physical/\""
  if [[ -n "${BLOOM_EXTRA_EXTENSION_ID:-}" ]]; then origins="$origins, \"chrome-extension://$BLOOM_EXTRA_EXTENSION_ID/\""; fi
  if [[ "$OS" == Darwin ]]; then
    dirs=("$HOME/Library/Application Support/Google/Chrome" "$HOME/Library/Application Support/Chromium" \
      "$HOME/Library/Application Support/BraveSoftware/Brave-Browser" "$HOME/Library/Application Support/Microsoft Edge")
  else
    dirs=("$HOME/.config/google-chrome" "$HOME/.config/chromium" "$HOME/.config/BraveSoftware/Brave-Browser" "$HOME/.config/microsoft-edge")
  fi
  chmod +x "$RUNTIME_DIR/native-host.sh" "$RUNTIME_DIR/laya_control.py"
  for d in "${dirs[@]}"; do
    [[ -d "$d" ]] || continue
    mkdir -p "$d/NativeMessagingHosts"
    cat >"$d/NativeMessagingHosts/$NATIVE_HOST.json" <<EOF
{
  "name": "$NATIVE_HOST",
  "description": "bloomScroll: start and stop the local Laya model from Settings",
  "path": "$RUNTIME_DIR/native-host.sh",
  "type": "stdio",
  "allowed_origins": [$origins]
}
EOF
    n=$((n + 1))
  done
  if [[ $n -gt 0 ]]; then
    ok "Settings can start and stop Laya ($n browser profile folder(s) set up)"
  else
    warn "No Chrome, Edge, Brave or Chromium found yet, so Settings can't start or stop Laya. Run bash setup.sh --server-only again after installing one."
  fi
}

laya_up() { curl -fsS -m 2 "http://127.0.0.1:$LAYA_PORT/health" >/dev/null 2>&1; }

LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bloomscroll-setup.XXXXXX")"
START=$SECONDS
printf '%sbloomScroll setup%s  %s(%s %s)%s\n' "$B" "$X" "$DIM" "$OS" "$ARCH" "$X"

# ---------------------------------------------------------------------------------------- prerequisites

step "Checking what's installed"

if command -v git >/dev/null 2>&1; then
  ok "git $(git --version | awk '{print $3}')"
else
  warn "git not found. Not needed to build, but you'll want it to get updates: https://git-scm.com/downloads"
fi

PNPM=()
if [[ $WANT_EXTENSION -eq 1 ]]; then
  if ! command -v node >/dev/null 2>&1; then
    die "Node.js is not installed. The extension build needs Node 20 or newer." \
      "Install the LTS version from https://nodejs.org (macOS: 'brew install node@20' also works)," \
      "then open a new terminal and run bash setup.sh again."
  fi
  NODE_VERSION="$(node -v | sed 's/^v//')"
  if [[ "${NODE_VERSION%%.*}" -lt 20 ]]; then
    die "Node $NODE_VERSION is too old; bloomScroll needs Node 20 or newer." \
      "Update from https://nodejs.org (or 'nvm install 20'), then run bash setup.sh again."
  fi
  # Vite is pinned to 5.x on purpose: Vite 6+ needs Node 20.19+, and Node 20.8 is still common.
  ok "Node $NODE_VERSION"

  # pnpm: use it if installed; otherwise run it through corepack (ships with Node) or npx, so
  # nobody needs a global install. The lockfile is pnpm 9 format.
  if command -v pnpm >/dev/null 2>&1; then
    PNPM=(pnpm)
    ok "pnpm $(pnpm -v)"
  elif command -v corepack >/dev/null 2>&1; then
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    PNPM=(corepack pnpm@9)
    ok "pnpm via corepack ($("${PNPM[@]}" -v))"
  else
    PNPM=(npx --yes pnpm@9)
    ok "pnpm via npx ($("${PNPM[@]}" -v))"
  fi
fi

# ---------------------------------------------------------------------------------------- extension

if [[ $WANT_EXTENSION -eq 1 ]]; then
  step "Browser extension: dependencies"
  (cd "$EXT_DIR" && "${PNPM[@]}" install --frozen-lockfile --reporter=silent)
  ok "Node packages installed"

  step "Browser extension: build (first time also downloads the 23 MB built-in model)"
  (cd "$EXT_DIR" && "${PNPM[@]}" run --silent build >"$LOG_DIR/build.log" 2>&1) || {
    tail -20 "$LOG_DIR/build.log" >&2
    die "The extension build failed (full log: $LOG_DIR/build.log)."
  }
  [[ -f "$EXT_DIR/dist/manifest.json" ]] || die "Build finished but extension/dist/manifest.json is missing."
  ok "Built extension/dist ($(du -sh "$EXT_DIR/dist" | awk '{print $1}'))"
fi

# ---------------------------------------------------------------------------------------- local Laya

py_version() { "$1" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null; }

# Intel Macs need Python 3.10 or 3.11: the last Intel-Mac PyTorch (2.2.2) can't run on 3.12+.
py_supported() {
  case "$1" in
    3.10 | 3.11) return 0 ;;
    3.12) intel_mac && return 1 || return 0 ;;
    *) return 1 ;;
  esac
}

find_python() {
  local candidates c p v
  if intel_mac; then
    candidates=(python3.11 /usr/local/bin/python3.11 /usr/local/opt/python@3.11/bin/python3.11 python3.10 /usr/local/bin/python3.10 python3)
  else
    candidates=(python3.12 python3.11 python3.10 /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.11 /usr/local/bin/python3.12 /usr/local/bin/python3.11 python3)
  fi
  for c in "${candidates[@]}"; do
    p="$(command -v "$c" 2>/dev/null)" || continue
    v="$(py_version "$p")" || continue
    if py_supported "$v"; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

find_uv() {
  local c
  for c in uv "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv"; do
    command -v "$c" >/dev/null 2>&1 && { command -v "$c"; return 0; }
  done
  return 1
}

# No suitable Python? Fetch a private one with uv (a small installer from astral.sh). It lives in
# uv's own folder and doesn't touch the system Python. Prints only the Python path on stdout (the
# caller captures it); everything meant for the person goes to stderr.
python_via_uv() {
  local uv want
  want=$(intel_mac && echo 3.11 || echo 3.12)
  if ! uv="$(find_uv)"; then
    note "bloomScroll needs Python $want for Laya and will download its own copy using uv (astral.sh/uv)." >&2
    if [[ -t 0 && "${BLOOM_YES:-}" != 1 ]]; then
      printf '  Install uv and Python %s now? [Y/n] ' "$want" >&2
      read -r reply
      [[ -z "$reply" || "$reply" =~ ^[Yy] ]] || return 1
    fi
    curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh >"$LOG_DIR/uv.log" 2>&1 || {
      cat "$LOG_DIR/uv.log" >&2
      return 1
    }
    uv="$(find_uv)" || return 1
    ok "Installed uv" >&2
  fi
  note "Downloading Python $want with uv (one time, about 20 MB)..." >&2
  # --no-bin: don't add a python3.x shortcut to ~/.local/bin, which could change which Python the
  # person gets when they type python3.x. Older uv without the flag: install without it.
  { "$uv" python install --no-bin "$want" || "$uv" python install "$want"; } >"$LOG_DIR/uv-python.log" 2>&1 || {
    cat "$LOG_DIR/uv-python.log" >&2
    return 1
  }
  "$uv" python find "$want"
}

server_install() {
  local PY v REQS WANT_PY HAVE_PY VPY MARKER REQS_HASH
  step "Local Laya model: Python"
  if [[ -n "$PYTHON_OVERRIDE" ]]; then
    PY="$(command -v "$PYTHON_OVERRIDE" 2>/dev/null)" || die "Python not found at '$PYTHON_OVERRIDE'."
    v="$(py_version "$PY")" || die "'$PY' doesn't run as Python."
    py_supported "$v" || warn "Python $v is not a tested version here; continuing because you asked for it."
  elif [[ "${BLOOM_FORCE_UV:-}" != 1 ]] && PY="$(find_python)"; then
    :
  elif ! PY="$(python_via_uv)"; then
    die "Couldn't find or download a suitable Python for Laya." \
      "Install Python $(intel_mac && echo 3.11 || echo 3.12) from https://www.python.org/downloads/ and run: bash setup.sh --server-only"
  fi
  ok "Python $(py_version "$PY") at $PY"

  if intel_mac; then
    REQS="$SERVER_DIR/requirements-intel-mac.txt"
  else
    REQS="$SERVER_DIR/requirements.txt"
  fi

  step "Local Laya model: Python packages"
  note "Installing into $RUNTIME_DIR/venv"
  note "Using $(basename "$REQS")"
  WANT_PY="$(py_version "$PY")"
  if [[ -x "$VENV/bin/python" ]]; then
    HAVE_PY="$(py_version "$VENV/bin/python" || echo broken)"
    if [[ "$HAVE_PY" != "$WANT_PY" ]]; then
      warn "Laya's environment uses Python $HAVE_PY, not $WANT_PY. Recreating it."
      rm -rf "$VENV"
    fi
  fi
  if [[ ! -x "$VENV/bin/python" ]]; then
    mkdir -p "$RUNTIME_DIR"
    if ! "$PY" -m venv "$VENV" 2>"$LOG_DIR/venv.err"; then
      cat "$LOG_DIR/venv.err" >&2
      die "Couldn't create a Python virtual environment." \
        "On Debian/Ubuntu install the venv module: sudo apt install python${WANT_PY}-venv"
    fi
    ok "Created Laya's Python environment (Python $WANT_PY)"
  fi

  # Always '<venv>/bin/python -m pip', never a bare 'pip'/'pip3': those can point at another Python
  # (or at nothing, e.g. a shell alias to a deleted pip3.12), installing packages where laya-serve
  # can't see them.
  VPY="$VENV/bin/python"
  hash_file() { (shasum -a 256 "$1" 2>/dev/null || sha256sum "$1") | awk '{print $1}'; }
  MARKER="$VENV/.bloomscroll-requirements"
  REQS_HASH="$(hash_file "$REQS")"
  if [[ -f "$MARKER" && "$(cat "$MARKER")" == "$REQS_HASH" ]] && "$VPY" -c 'import laya, fastapi, uvicorn, torch' 2>/dev/null; then
    ok "Python packages already installed"
  else
    note "Installing Python packages (first time: several minutes, ~1 GB including PyTorch)..."
    "$VPY" -m pip install --quiet --upgrade pip
    if [[ "$OS" == Linux ]] && ! command -v nvidia-smi >/dev/null 2>&1; then
      # Without an NVIDIA GPU, the default Linux torch wheel drags in ~2 GB of CUDA libraries.
      note "No NVIDIA GPU found: installing the CPU-only PyTorch build"
      "$VPY" -m pip install --quiet torch --index-url https://download.pytorch.org/whl/cpu
    fi
    "$VPY" -m pip install --quiet -r "$REQS"
    "$VPY" -c 'import laya, fastapi, uvicorn, torch' || die "Packages installed but laya can't be imported." \
      "Try deleting $VENV and running bash setup.sh --server-only again."
    echo "$REQS_HASH" >"$MARKER"
    ok "Installed $("$VPY" -m pip show laya 2>/dev/null | awk '/^Version/{print "laya " $2}'), torch $("$VPY" -c 'import torch; print(torch.__version__)')"
  fi

  step "Local Laya model: checkpoint (~840 MB, one time)"
  # Fetch exactly what laya's Agent downloads for the English model (laya/agent.py: the same repo,
  # file patterns and revision rule), so the first server start doesn't sit on a silent download.
  "$VPY" - "$LAYA_REPO" <<'PY'
import os, sys
from huggingface_hub import snapshot_download
from laya.revisions import resolve_revision

repo = sys.argv[1]
kw = {"allow_patterns": ["rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*"]}
revision = resolve_revision(repo)
if revision:
    kw["revision"] = revision
path = snapshot_download(repo, **kw)
size = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(path) for f in fs)
print(f"  ✓ Checkpoint ready: {size / 1e6:.0f} MB in {path}")
PY
  install_runtime_scripts
}

# Copies the scripts that run in the background next to Laya's environment, every run, so updates
# to the bloomScroll folder reach them.
install_runtime_scripts() {
  mkdir -p "$RUNTIME_DIR"
  cp "$SERVER_DIR/start.sh" "$SERVER_DIR/laya_control.py" "$SERVER_DIR/native-host.sh" "$RUNTIME_DIR/"
  chmod +x "$RUNTIME_DIR/start.sh" "$RUNTIME_DIR/laya_control.py" "$RUNTIME_DIR/native-host.sh"
}

SERVER_STATE="skipped"   # skipped | failed | installed | autostart | running
OLD_VENV="$SERVER_DIR/.venv"
if [[ $WANT_SERVER -eq 1 ]]; then
  # In a subshell so a Laya problem can't undo the extension that's already built: the person still
  # gets a working extension and a clear way to retry.
  set +e
  (set -e; server_install)
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    SERVER_STATE="failed"
    warn "Laya couldn't be set up (see above). The extension still works with its built-in model."
  else
    SERVER_STATE="installed"
    write_service_files || warn "Couldn't write the login item files; start-at-login can't be switched from Settings."
    install_native_host || warn "Couldn't register the Settings helper; Start and Stop in Settings won't work."
    if [[ $WANT_AUTOSTART -eq 1 ]]; then
      step "Local Laya model: start automatically"
      set +e
      (set -e; install_autostart)
      [[ $? -eq 0 ]] && SERVER_STATE="autostart"
      set -e
    fi
    if [[ $SERVER_STATE == autostart ]] || laya_up; then
      note "Waiting for Laya to load its model (up to a minute the first time)..."
      for _ in $(seq 1 90); do
        laya_up && break
        sleep 2
      done
      if laya_up; then
        ok "Laya is running on http://127.0.0.1:$LAYA_PORT"
        [[ $SERVER_STATE == autostart ]] && SERVER_STATE="running+autostart" || SERVER_STATE="running"
      else
        warn "Laya hasn't answered yet. It may still be loading; check ~/Library/Logs/bloomScroll/laya.log"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------------------- next steps

ELAPSED=$((SECONDS - START))
if [[ $SERVER_STATE == failed && $WANT_EXTENSION -eq 1 ]]; then
  printf '\n%s%sAlmost done%s in %dm%02ds: the extension is ready, Laya needs another try.\n' "$Y" "$B" "$X" $((ELAPSED / 60)) $((ELAPSED % 60))
elif [[ $SERVER_STATE == failed ]]; then
  printf '\n%s%sLaya needs another try%s (%dm%02ds).\n' "$Y" "$B" "$X" $((ELAPSED / 60)) $((ELAPSED % 60))
else
  printf '\n%s%sAll set%s in %dm%02ds.\n' "$G" "$B" "$X" $((ELAPSED / 60)) $((ELAPSED % 60))
fi
printf '\n%sNext steps%s\n' "$B" "$X"
n=1
if [[ $WANT_EXTENSION -eq 1 ]]; then
  printf '  %d. Open Chrome (or Edge/Brave) and go to %schrome://extensions%s\n' $n "$B" "$X"
  printf '     Turn on %sDeveloper mode%s (top right), click %sLoad unpacked%s and pick:\n' "$B" "$X" "$B" "$X"
  printf '     %s%s/dist%s\n' "$C" "$EXT_DIR" "$X"
  n=$((n + 1))
  printf '  %d. The bloomScroll settings page opens by itself. Add what you come to YouTube for, then click %sSave%s.\n' $n "$B" "$X"
  n=$((n + 1))
  printf '  %d. Open YouTube. Off-topic videos dissolve away; the green button lists what was hidden.\n' $n
fi

printf '\n'
case "$SERVER_STATE" in
  running+autostart) printf '  %sLocal AI (Laya): running, and starts by itself whenever you log in.%s\n' "$G" "$X"
    printf '  %sTo stop that: bash setup.sh --remove-autostart%s\n' "$DIM" "$X" ;;
  autostart) printf '  Local AI (Laya): set to start at login; it may still be loading.\n' ;;
  running) printf '  Local AI (Laya): running now. Start it again from Settings, or with: %s/start.sh\n' "$RUNTIME_DIR" ;;
  installed) printf '  Local AI (Laya): installed. Start it from Settings, or with: %s/start.sh\n' "$RUNTIME_DIR" ;;
  failed) printf '  %sLocal AI (Laya): not set up yet. Fix the problem above, then run: bash setup.sh --server-only%s\n' "$Y" "$X" ;;
  skipped) [[ $WANT_SERVER -eq 0 ]] && printf '  %sNo local AI installed: filtering uses rules and the built-in model. Add it any time with: bash setup.sh --server-only%s\n' "$DIM" "$X" ;;
esac

if [[ $WANT_SERVER -eq 1 && $SERVER_STATE != failed && -d "$OLD_VENV" ]]; then
  printf '\n  %sAn older copy of Laya'"'"'s environment is still in server/.venv (about 1 GB) and is no longer used.\n  You can delete it: rm -rf "%s"%s\n' "$DIM" "$OLD_VENV" "$X"
fi

rm -rf "$LOG_DIR" # logs are only kept when something fails
