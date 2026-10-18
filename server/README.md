# Local Laya server

bloomScroll calls `laya-serve` (from the `laya` package on PyPI) over the Jev wire API,
`POST /v1/systemone/batch`. Verified with `laya` 0.4.11.

## Setup

`bash setup.sh --server-only` from the repo root does all of this for you. By hand:

### Apple Silicon Mac, Linux or WSL

Python 3.10–3.12, no pins beyond `laya` itself:

```bash
cd server
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt
```

On Apple Silicon, current torch, transformers and NumPy 2 all work, and Laya picks the GPU (MPS)
by itself: `/health` reports `"device": "mps"`. Verified on an M4 with Python 3.11.14, torch
2.14.1, transformers 5.20.1 and NumPy 2.4.6.

### Intel Mac

PyTorch stopped shipping Intel-Mac builds at 2.2.2, and that release's compiler doesn't run on
Python 3.12+. So on an Intel Mac use **Python 3.11** and the pinned file (this is Laya's own
documented fix):

```bash
cd server
/usr/local/bin/python3.11 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements-intel-mac.txt
```

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

Laya re-encodes the whole question, options included, for every tile, so cost tracks tokens:
about 6.5 ms per token, with no per-request overhead and no gain from bigger batches on CPU.

| Prompt | ms per tile | AUC (40 titles) |
| --- | --- | --- |
| 30 topics + 8 described off-topic categories | 980 | 1.000 |
| Short tech summary + 8 category labels (what the extension sends) | 394 | 1.000 |
| Labels only | 323 | 0.985 |

- **Backends:** ONNX fp32 export was 385 ms/tile (11% faster than PyTorch, identical answers).
  ONNX int8 was 268 ms/tile but flipped 16 of 40 decisions, so don't use it.
- **Idle paging:** macOS pages an idle server out of RAM. The first request after a break took
  7.3 s versus 0.47 s warm, so the extension sends a one-tile warm-up when YouTube opens.
- **Whole pipeline** (`LAYA_URL=http://127.0.0.1:8765 pnpm exec vitest run pipeline` in
  `extension/`): on the 40 labeled titles, rules and embeddings decided 35 in 261 ms, Laya the
  other 5, and the feed was fully settled at 2.7 s with 0 mistakes. Before the audit: ~39 s.

## CORS

No server-side CORS config is needed. When you save the backend URL in Options, the extension
requests host permission for that origin, and Chrome then lets the service worker call it directly.
