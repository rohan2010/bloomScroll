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
| `LAYA_MPS_AMP_MIN_ROWS` | `100000` (Apple Silicon only) | Keep fp32 on the GPU: as fast as fp16, ~1 GB less memory |
| `LAYA_IDLE_UNLOAD_SECONDS` | `900` (Apple Silicon only) | Free ~2 GB after 15 idle minutes; reload takes ~1.3 s |

## Test

```bash
curl -s http://127.0.0.1:8765/health
curl -s http://127.0.0.1:8765/v1/systemone -H 'content-type: application/json' -d @../tests/sample_request.json
python3 bench_laya.py --save base.json   # ms per tile at batch 1-40; --compare base.json after a change
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

## Measured on an M4 (MPS)

Apple M4 (4P+6E cores, 16 GB), Python 3.11.14, torch 2.14.1, transformers 5.20.1; `/health` says
`"device": "mps"`. Same 40 titles and the request the extension sends (on-intent described,
distractors as bare labels). Reproduce with `python3 server/bench_laya.py` against a running server.

| Tiles per request | MPS, laya defaults | MPS, start.sh (fp32) | CPU, 4 threads | CPU, 10 threads |
| --- | --- | --- | --- | --- |
| 1 | 33.5 ms/tile | 33.7 | 72.9 | 78.5 |
| 4 (what the extension sends) | 23.8 | 23.7 | 44.6 | 46.5 |
| 8 | 23.9 | 22.2 | 40.5 | 40.5 |
| 16 | 22.0 | 21.9 | 38.6 | 36.5 |
| 40 | 20.9 | 21.9 | 36.1 | 35.3 |

AUC is 1.000 in every cell. So on Apple Silicon a tile costs ~24 ms instead of ~394 ms, batching
helps up to ~4 tiles and barely after that, and the GPU is ~2x the CPU.

- **fp32 instead of fp16 on MPS.** Laya turns on fp16 autocast at 5+ tiles per request
  (`LAYA_MPS_AMP_MIN_ROWS`, default 5). On the M4 that buys nothing (table above), but the cast copy
  of the weights stays in GPU memory: 3.1 GB versus 2.07 GB in fp32, for the life of the server.
  It also makes a tile's score depend on how many tiles shared its request (max |Δp| 0.0015, no
  decision moved). `start.sh` sets `LAYA_MPS_AMP_MIN_ROWS=100000` on Apple Silicon, so every
  request runs in fp32 and gives the same score at any batch size.
- **Idle unload.** The checkpoint ships as fp16 (421 M parameters) and runs as fp32, so the loaded
  server holds ~2.1 GB of GPU memory (~3.2 GB total footprint). `start.sh` sets
  `LAYA_IDLE_UNLOAD_SECONDS=900` on Apple Silicon: after 15 idle minutes the footprint falls to
  ~1.1 GB, and the next request reloads the model in ~1.3 s, which the extension's warm-up when
  YouTube opens hides. `/health` stays up and shows `"loaded": []` meanwhile.
- **Cold start:** 2.2-3.3 s from launch to a healthy `/health`, then ~140 ms for the first request
  and 35 ms after. When the 808 MB checkpoint isn't in the file cache (first launch after a boot) it
  was 7.7 s to healthy and 1.7 s for the first request. A new batch size costs nothing extra the
  first time (first 40-tile request 843 ms, steady 836 ms), so the one-tile warm-up is enough.
- **`LAYA_THREADS` doesn't matter on MPS** (1 and 10 threads measured the same). `start.sh` still
  sets it to the physical core count, for CPU fallback.
- **Not exposed by laya-serve:** fp16 *weights* (which would halve memory) and `torch.compile`
  (`Agent(compile=True)`; Laya's docs say it rarely pays off when shapes vary, as titles do).

## CORS

No server-side CORS config is needed. When you save the backend URL in Options, the extension
requests host permission for that origin, and Chrome then lets the service worker call it directly.
