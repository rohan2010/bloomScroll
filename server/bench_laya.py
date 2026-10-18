"""Time a running laya-serve with the request bloomScroll sends, and check its answers don't drift.

    python3 server/bench_laya.py                      # ms per tile at batch 1, 4, 8, 16, 40 + RSS
    python3 server/bench_laya.py --save base.json     # also save P(on-intent) for the 40 eval titles
    python3 server/bench_laya.py --compare base.json  # flag any title whose decision moved

Stdlib only. The request matches extension/src/background/backends/jevWire.ts (one state per video,
one shared choice question, on-intent described, distractors as bare labels). The 40 titles are the
ones in eval_prompts.py, so --compare is the accuracy check for any server setting you change:
probabilities are computed at every batch size, because precision on MPS depends on batch size.
"""
import argparse
import json
import statistics
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from eval_prompts import DISTRACTORS, TILES, state  # noqa: E402

QUESTIONS = {"intent": {"type": "choice", "instructions": "What is this YouTube video mainly about?",
                        "criteria": {"on-intent": "programming, software, computers, AI",
                                     **{k: None for k in DISTRACTORS}}}}
STATES = [state(t, c) for _, t, c in TILES]


def post(url, states):
    body = json.dumps({"model": "english", "states": states, "questions": QUESTIONS}).encode()
    req = urllib.request.Request(f"{url}/v1/systemone/batch", body, {"content-type": "application/json"})
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=600) as res:
        out = json.load(res)
        infer = float(res.headers.get("X-Inference-Time-Ms", "nan"))
    wall = (time.perf_counter() - t0) * 1000
    probs = [r["answers"]["intent"]["probabilities"] for r in out["results"]]
    return wall, infer, [p["on-intent"] / sum(p.values()) for p in probs]


def rss_mb(port):
    pids = subprocess.run(["lsof", "-t", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN"],
                          capture_output=True, text=True).stdout.split()
    if not pids:
        return float("nan")
    rss = subprocess.run(["ps", "-o", "rss=", "-p", pids[0]], capture_output=True, text=True).stdout.strip()
    return int(rss) / 1024 if rss else float("nan")


def auc(ps):
    pos = [p for (y, *_), p in zip(TILES, ps) if y]
    neg = [p for (y, *_), p in zip(TILES, ps) if not y]
    return sum((a > b) + 0.5 * (a == b) for a in pos for b in neg) / (len(pos) * len(neg))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8765")
    ap.add_argument("--sizes", default="1,4,8,16,40")
    ap.add_argument("--reps", type=int, default=3, help="timed passes over the 40 titles per size")
    ap.add_argument("--save", help="write per-size probabilities to this JSON file")
    ap.add_argument("--compare", help="compare against a file written by --save")
    args = ap.parse_args()
    port = int(args.url.rsplit(":", 1)[1].split("/")[0])
    sizes = [int(s) for s in args.sizes.split(",")]

    post(args.url, STATES[:1])  # warm-up, untimed
    print(f"RSS idle (after warm-up): {rss_mb(port):.0f} MB")
    print(" batch   ms/tile (wall)   ms/tile (server)   ms/request   AUC")
    saved, peak = {}, 0.0
    for n in sizes:
        walls, infers, ps = [], [], []
        for rep in range(args.reps + 1):  # first pass per size is a shape warm-up, not timed
            ps = []
            for i in range(0, len(STATES), n):
                w, inf, p = post(args.url, STATES[i:i + n])
                ps += p
                if rep:
                    walls.append(w / len(p))
                    infers.append(inf / len(p))
            peak = max(peak, rss_mb(port))
        saved[str(n)] = ps
        print(f"  {n:>3}   {statistics.median(walls):>10.1f}      {statistics.median(infers):>10.1f}"
              f"        {statistics.median(walls) * n:>8.0f}    {auc(ps):.3f}")
    print(f"RSS after load: {rss_mb(port):.0f} MB (peak seen {peak:.0f} MB)")

    if args.save:
        json.dump(saved, open(args.save, "w"))
    if args.compare:
        base = json.load(open(args.compare))
        ref = base.get("1") or next(iter(base.values()))
        for n, ps in saved.items():
            other = base.get(n, ref)
            d = max(abs(a - b) for a, b in zip(ps, other))
            flips = {t: sum((a >= t) != (b >= t) for a, b in zip(ps, other)) for t in (0.3, 0.5, 0.7)}
            print(f"  batch {n:>3}: max |dp| {d:.4f}, decisions moved at 0.3/0.5/0.7: "
                  f"{flips[0.3]}/{flips[0.5]}/{flips[0.7]}")


if __name__ == "__main__":
    main()
