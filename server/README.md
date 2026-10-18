# Local Laya server

bloomScroll calls `laya-serve` (from the `laya` package on PyPI) over the Jev wire API,
`POST /v1/systemone/batch`. Verified with `laya` 0.4.11.

## Setup (Intel Mac)

PyTorch stopped shipping Intel-Mac builds at 2.2.2, and that release's compiler doesn't run on
Python 3.12+. So on an Intel Mac use **Python 3.11** and pin the stack (this is Laya's own
documented fix):

```bash
cd server
/usr/local/bin/python3.11 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install "numpy<2" "torch==2.2.2" "transformers==4.57.6" "laya[serve]==0.4.11"
```

Apple Silicon and Linux: skip the pins, `pip install "laya[serve]"` on Python 3.10+ is enough.

Use `.venv/bin/python -m pip`, not a bare `pip3`: it always installs into this venv.

## Run

```bash
./start.sh        # first run downloads the English checkpoint (~808 MB) from Hugging Face
```

`laya-serve` takes no flags; it's configured by environment variables, which `start.sh` sets:

| Variable | start.sh value | Why |
| --- | --- | --- |
| `LAYA_HOST` | `127.0.0.1` | laya-serve defaults to `0.0.0.0`, which exposes it to your network |
| `LAYA_PORT` | `8765` | Matches the extension's default backend URL |
| `LAYA_MODELS` / `LAYA_DEFAULT_MODEL` | `english` | Load only the English checkpoint |
| `LAYA_THREADS` | physical cores | More threads than physical cores is slower |

## Test

```bash
curl -s http://127.0.0.1:8765/health
curl -s http://127.0.0.1:8765/v1/systemone -H 'content-type: application/json' -d @../tests/sample_request.json
cd ../extension && LAYA_URL=http://127.0.0.1:8765 pnpm exec vitest run jevWire   # live contract test
```

## Measured on the 2017 MacBook Pro (i5-7360U, 2 cores)

- About **0.5 s per tile** on CPU (8 tiles ≈ 4 s), with no gain from thread tuning. A full home
  feed through the model alone takes ~20 s, so the embedding pre-filter and decision cache carry
  most of the load.
- Framing matters a lot. One state per video plus one shared question separates tech titles from
  off-intent ones far better (mean on/off gap 0.38) than putting the intent in the state and each
  title in a question (gap 0.06). The client uses the first framing.
- Zero-shot misses remain (a Minecraft title scored 0.76 on-intent), so calibration on your labels
  matters.

## CORS

No server-side CORS config is needed. When you save the backend URL in Options, the extension
requests host permission for that origin, and Chrome then lets the service worker call it directly.
