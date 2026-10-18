#!/usr/bin/env bash
# One-stop setup for bloomScroll: builds the browser extension and (optionally) installs the local
# Laya model server with its ~840 MB checkpoint. Safe to re-run: finished steps are skipped.
#
#   ./setup.sh               everything (extension + local Laya server)
#   ./setup.sh --no-server   extension only: rules + built-in embeddings, no Python needed
#   ./setup.sh --server-only just the local Laya server
#   ./setup.sh --help
#
# Works on macOS and Linux. Windows: use WSL.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$ROOT/server"
EXT_DIR="$ROOT/extension"
VENV="$SERVER_DIR/.venv"
LAYA_REPO="convaiinnovations/laya"

WANT_SERVER=1
WANT_EXTENSION=1
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

Usage: ./setup.sh [option]

  (no option)     Build the extension and install the local Laya model server.
  --no-server     Build the extension only. Filtering uses rules and the built-in
                  embedding model; no Python or 840 MB download. Easiest start.
  --server-only   Install only the local Laya server (Python + model checkpoint).
  --python PATH   Use this Python for the server (default: picked automatically).
  -h, --help      Show this help.

Re-running is safe: steps that are already done are skipped.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-server) WANT_SERVER=0 ;;
    --server-only) WANT_EXTENSION=0 ;;
    --python)
      [[ $# -ge 2 ]] || die "--python needs a path, e.g. --python /usr/local/bin/python3.11"
      PYTHON_OVERRIDE="$2"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "Unknown option: $1" "Run ./setup.sh --help to see the options." ;;
  esac
  shift
done
[[ $WANT_SERVER -eq 1 || $WANT_EXTENSION -eq 1 ]] || die "--no-server and --server-only together leave nothing to do."

OS="$(uname -s)"
ARCH="$(uname -m)"
intel_mac() { [[ "$OS" == Darwin && "$ARCH" == x86_64 ]]; }

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
      "then open a new terminal and run ./setup.sh again."
  fi
  NODE_VERSION="$(node -v | sed 's/^v//')"
  if [[ "${NODE_VERSION%%.*}" -lt 20 ]]; then
    die "Node $NODE_VERSION is too old; bloomScroll needs Node 20 or newer." \
      "Update from https://nodejs.org (or 'nvm install 20'), then run ./setup.sh again."
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
    note "To install pnpm permanently: 'corepack enable pnpm' or 'npm i -g pnpm'"
  else
    PNPM=(npx --yes pnpm@9)
    ok "pnpm via npx ($("${PNPM[@]}" -v))"
    note "To install pnpm permanently: 'npm i -g pnpm'"
  fi
fi

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

PY=""
if [[ $WANT_SERVER -eq 1 ]]; then
  if [[ -n "$PYTHON_OVERRIDE" ]]; then
    PY="$(command -v "$PYTHON_OVERRIDE" 2>/dev/null)" || die "Python not found at '$PYTHON_OVERRIDE'."
    v="$(py_version "$PY")" || die "'$PY' doesn't run as Python."
    py_supported "$v" || warn "Python $v is not a tested version here; continuing because you asked for it."
  elif ! PY="$(find_python)"; then
    if intel_mac; then
      die "No Python 3.11 (or 3.10) found. On an Intel Mac the local model server needs one of these." \
        "Install it with 'brew install python@3.11' or from https://www.python.org/downloads/," \
        "then run ./setup.sh again. Or skip the server for now: ./setup.sh --no-server"
    else
      die "No Python 3.10, 3.11 or 3.12 found. The local model server needs one of these." \
        "Install Python 3.12 from https://www.python.org/downloads/ (or your package manager)," \
        "then run ./setup.sh again. Or skip the server for now: ./setup.sh --no-server"
    fi
  fi
  ok "Python $(py_version "$PY") at $PY"
fi

# ---------------------------------------------------------------------------------------- local Laya server

if [[ $WANT_SERVER -eq 1 ]]; then
  if intel_mac; then
    REQS="$SERVER_DIR/requirements-intel-mac.txt"
  else
    REQS="$SERVER_DIR/requirements.txt"
  fi

  step "Local Laya server: Python environment (server/.venv)"
  note "Using $(basename "$REQS")"
  WANT_PY="$(py_version "$PY")"
  if [[ -x "$VENV/bin/python" ]]; then
    HAVE_PY="$(py_version "$VENV/bin/python" || echo broken)"
    if [[ "$HAVE_PY" != "$WANT_PY" ]]; then
      warn "server/.venv uses Python $HAVE_PY, not $WANT_PY. Recreating it."
      rm -rf "$VENV"
    fi
  fi
  if [[ ! -x "$VENV/bin/python" ]]; then
    if ! "$PY" -m venv "$VENV" 2>"$LOG_DIR/venv.err"; then
      cat "$LOG_DIR/venv.err" >&2
      die "Couldn't create a Python virtual environment." \
        "On Debian/Ubuntu install the venv module: sudo apt install python${WANT_PY}-venv"
    fi
    ok "Created server/.venv (Python $WANT_PY)"
  else
    ok "server/.venv already exists (Python $WANT_PY)"
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
      "Try deleting server/.venv and running ./setup.sh again."
    echo "$REQS_HASH" >"$MARKER"
    ok "Installed $("$VPY" -m pip show laya 2>/dev/null | awk '/^Version/{print "laya " $2}'), torch $("$VPY" -c 'import torch; print(torch.__version__)')"
  fi

  step "Local Laya server: model checkpoint (~840 MB, one time)"
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
  chmod +x "$SERVER_DIR/start.sh"
fi

# ---------------------------------------------------------------------------------------- extension

if [[ $WANT_EXTENSION -eq 1 ]]; then
  step "Browser extension: dependencies"
  (cd "$EXT_DIR" && "${PNPM[@]}" install --frozen-lockfile --reporter=silent)
  ok "Node packages installed"

  step "Browser extension: build (first time also downloads the 23 MB embedding model)"
  (cd "$EXT_DIR" && "${PNPM[@]}" run --silent build >"$LOG_DIR/build.log" 2>&1) || {
    tail -20 "$LOG_DIR/build.log" >&2
    die "The extension build failed (full log: $LOG_DIR/build.log)."
  }
  [[ -f "$EXT_DIR/dist/manifest.json" ]] || die "Build finished but extension/dist/manifest.json is missing."
  ok "Built extension/dist ($(du -sh "$EXT_DIR/dist" | awk '{print $1}'))"
fi

# ---------------------------------------------------------------------------------------- next steps

ELAPSED=$((SECONDS - START))
printf '\n%s%sAll set%s in %dm%02ds.\n' "$G" "$B" "$X" $((ELAPSED / 60)) $((ELAPSED % 60))
printf '\n%sNext steps%s\n' "$B" "$X"
n=1
if [[ $WANT_EXTENSION -eq 1 ]]; then
  printf '  %d. Open Chrome (or Edge/Brave) and go to %schrome://extensions%s\n' $n "$B" "$X"
  printf '     Turn on %sDeveloper mode%s (top right), click %sLoad unpacked%s and pick:\n' "$B" "$X" "$B" "$X"
  printf '     %s%s/dist%s\n' "$C" "$EXT_DIR" "$X"
  n=$((n + 1))
fi
if [[ $WANT_SERVER -eq 1 ]]; then
  printf '  %d. Start the local model server and leave that terminal open:\n' $n
  printf '     %s%s/start.sh%s\n' "$C" "$SERVER_DIR" "$X"
  printf '     Wait for: Uvicorn running on http://127.0.0.1:8765\n'
  n=$((n + 1))
fi
if [[ $WANT_EXTENSION -eq 1 ]]; then
  printf '  %d. The bloomScroll settings page opens by itself. Add your topics, then click %sSave%s' $n "$B" "$X"
  if [[ $WANT_SERVER -eq 1 ]]; then
    printf ',\n     and click %sAllow%s when Chrome asks to reach 127.0.0.1.\n' "$B" "$X"
  else
    printf '.\n'
  fi
  n=$((n + 1))
  printf '  %d. Open YouTube. Off-topic videos dissolve away; the green button lists what was hidden.\n' $n
fi
if [[ $WANT_SERVER -eq 0 ]]; then
  printf '\n  %sNo local model installed: filtering uses rules and the built-in embedding model.\n' "$DIM"
  printf '  Add the model later with: ./setup.sh --server-only%s\n' "$X"
fi

rm -rf "$LOG_DIR" # logs are only kept when something fails
