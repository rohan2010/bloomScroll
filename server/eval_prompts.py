"""Compare intent prompts on 40 labeled YouTube titles, against local Laya or hosted Jev.

    python3 server/eval_prompts.py --backend laya
    TYPESAFE_API_KEY=... python3 server/eval_prompts.py --backend jev

Stdlib only. Prints, per prompt variant: AUC (1.0 = every on-topic title ranked above every
off-topic one), how many titles would be shown at each threshold, and the worst misses.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

TECH = ["programming", "coding", "software engineering", "web development", "computer science", "Linux",
        "open source", "machine learning", "AI research", "data science", "DevOps", "cybersecurity",
        "algorithms", "databases", "TypeScript", "JavaScript", "Python", "Rust"]

ON = [("Rust ownership in 10 minutes", "Let's Get Rusty"), ("How the Linux kernel boots", "Low Level"),
      ("TypeScript generics explained", "Matt Pocock"), ("Attention is all you need, paper walkthrough", "Yannic Kilcher"),
      ("I built a database from scratch in Go", "Tsoding"), ("Docker in 100 seconds", "Fireship"),
      ("Neural networks from scratch, part 3: backpropagation", "Andrej Karpathy"),
      ("System design interview: design a URL shortener", "ByteByteGo"), ("Arch Linux install guide 2026", "Mental Outlaw"),
      ("Why is Python so slow?", "Computerphile"), ("React Server Components, a deep dive", "Theo - t3.gg"),
      ("Kubernetes networking explained", "TechWorld with Nana"), ("Fine-tuning Llama on a single GPU", "Sam Witteveen"),
      ("Dijkstra's algorithm visualized", "Reducible"), ("Neovim config from zero", "ThePrimeagen"),
      ("SQL joins in 6 minutes", "Web Dev Simplified"), ("How hackers bypass two-factor auth", "NetworkChuck"),
      ("Building a ray tracer in C++", "The Cherno"), ("Git rebase vs merge", "Fireship"),
      ("New open-source AI model beats GPT on reasoning", "AI Explained")]
OFF = [("Top 10 EPIC pranks of the year", "PrankZone"), ("Perfect pasta at home", "Chef Mia"),
       ("I survived 100 days in Minecraft hardcore", "GamerGuy"), ("Celebrity breakup drama explained", "Tea Time"),
       ("Taylor Swift - Live at Wembley full concert", "TS Fan Uploads"), ("$1 vs $1,000,000 hotel room", "MrBeast"),
       ("Premier League highlights: Arsenal vs Chelsea", "Sky Sports"), ("My morning routine as a 25 year old", "Emma Vlogs"),
       ("Funniest cat fails compilation", "Daily Dose"), ("Elden Ring all bosses speedrun", "Distortion2"),
       ("Gordon Ramsay makes the perfect steak", "Gordon Ramsay"), ("Lofi hip hop radio, beats to relax to", "Lofi Girl"),
       ("Reacting to the worst TikToks of 2026", "Penguinz0"), ("Full body workout, 30 minutes, no equipment", "Pamela Reif"),
       ("Breaking news: storm hits the coast", "CNN"), ("Fortnite new season trailer", "Fortnite"),
       ("I tried every fast food burger", "Mythical Kitchen"), ("Learning to surf in Bali, travel vlog", "Kara and Nate"),
       ("Stand-up comedy special, full show", "Netflix Is A Joke"), ("iPhone 18 unboxing and first impressions", "Unbox Therapy")]
TILES = [(1, t, c) for t, c in ON] + [(0, t, c) for t, c in OFF]

DISTRACTORS = {"gaming": "video games and gameplay", "music": "music and concerts", "food": "cooking and food",
               "sports": "sports and fitness", "comedy": "comedy, pranks, memes and reactions",
               "news": "news, politics and celebrities", "lifestyle": "vlogs, travel and lifestyle",
               "gadgets": "consumer gadget reviews and unboxing"}
TOPICS = ", ".join(TECH)
ASK = "What is this YouTube video mainly about?"

# name -> (question, function from answer to P(on-intent))
VARIANTS = {
    "multi (current)": ({"type": "choice", "instructions": ASK, "criteria": {"on-intent": TOPICS, **DISTRACTORS}},
                        lambda a: a["probabilities"]["on-intent"] / sum(a["probabilities"].values())),
    "two-option": ({"type": "choice", "instructions": ASK,
                    "criteria": {"on-intent": TOPICS, "off-intent": "anything else: entertainment, gaming, food, sports, music, lifestyle, news"}},
                   lambda a: a["probabilities"]["on-intent"] / sum(a["probabilities"].values())),
    "short label": ({"type": "choice", "instructions": ASK,
                     "criteria": {"on-intent": "technology: programming, software, computers, AI",
                                  "off-intent": "not technology: entertainment, gaming, food, sports, music, lifestyle, news"}},
                    lambda a: a["probabilities"]["on-intent"] / sum(a["probabilities"].values())),
    "noul": ({"type": "noul", "instructions": f"Is this YouTube video mainly about one of these topics: {TOPICS}?"},
             lambda a: float(a["noul"])),
}


def state(title, channel):
    return f"YouTube video. Title: {title}. Channel: {channel}."


def post(url, body, key=None):
    headers = {"content-type": "application/json"}
    if key:
        headers["authorization"] = f"Bearer {key}"
    req = urllib.request.Request(url, json.dumps(body).encode(), headers)
    try:
        with urllib.request.urlopen(req, timeout=300) as res:
            return json.load(res)
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code} from {url}: {e.read().decode(errors='replace')[:300]}")


def run_variant(args, key, question, to_p):
    questions = {"intent": question}
    t0 = time.time()
    if args.backend == "laya":
        out = post(f"{args.url}/v1/systemone/batch",
                   {"model": "english", "states": [state(t, c) for _, t, c in TILES], "questions": questions})
        answers = [r["answers"]["intent"] for r in out["results"]]
    else:
        def one(tile):
            _, t, c = tile
            return post(f"{args.url}/v1/systemone", {"model": args.model, "state": state(t, c), "questions": questions}, key)["answers"]["intent"]
        with ThreadPoolExecutor(8) as pool:
            answers = list(pool.map(one, TILES))
    return [to_p(a) for a in answers], time.time() - t0, answers


def report(name, ps, secs):
    pos = [p for (y, *_), p in zip(TILES, ps) if y]
    neg = [p for (y, *_), p in zip(TILES, ps) if not y]
    auc = sum((a > b) + 0.5 * (a == b) for a in pos for b in neg) / (len(pos) * len(neg))
    print(f"\n== {name}   AUC {auc:.3f}   {secs:.1f}s")
    print("   show if p >=   on-topic shown   off-topic shown")
    for thr in (0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9):
        print(f"        {thr:.1f}          {sum(p >= thr for p in pos):>2}/20            {sum(p >= thr for p in neg):>2}/20")
    lo_on = sorted(zip(pos, ON))[:3]
    hi_off = sorted(zip(neg, OFF), reverse=True)[:3]
    print("   lowest on-topic:  " + "; ".join(f"{t[0][:32]} {p:.2f}" for p, t in lo_on))
    print("   highest off-topic: " + "; ".join(f"{t[0][:32]} {p:.2f}" for p, t in hi_off))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", choices=["laya", "jev"], default="laya")
    ap.add_argument("--url", help="default: http://127.0.0.1:8765 (laya) or https://api.typesafe.ai (jev)")
    ap.add_argument("--model", default="jev-latest", help="jev model id")
    ap.add_argument("--only", help="run one variant by name")
    args = ap.parse_args()
    args.url = (args.url or ("http://127.0.0.1:8765" if args.backend == "laya" else "https://api.typesafe.ai")).rstrip("/")
    key = os.environ.get("TYPESAFE_API_KEY")
    if args.backend == "jev" and not key:
        sys.exit("Set TYPESAFE_API_KEY first.")
    for name, (question, to_p) in VARIANTS.items():
        if args.only and args.only != name:
            continue
        ps, secs, answers = run_variant(args, key, question, to_p)
        report(name, ps, secs)
        if name == "multi (current)":
            print("   sample raw answer: " + json.dumps(answers[OFF.index(OFF[0]) + 20])[:300])


if __name__ == "__main__":
    main()
