import { EMBED_MODEL, type EmbedRequest, type EmbedResponse } from "../shared/messages";
import { distractorsFor } from "../shared/intent";
import type { EmbedScore, Embedder } from "./cascade";

const OFFSCREEN_URL = "src/offscreen/index.html";

let creating: Promise<void> | undefined;

async function ensureOffscreen(): Promise<void> {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  const existing = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [url] });
  if (existing.length) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: "Run the local MiniLM embedding model (WebAssembly) to pre-filter video titles.",
    })
    .finally(() => (creating = undefined));
  await creating;
}

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/** Set once this worker has seen the offscreen document, so later calls skip the getContexts round trip. */
let offscreenUp = false;

async function offscreenEmbed(texts: string[]): Promise<number[][]> {
  const msg: EmbedRequest = { target: "offscreen", type: "embed", texts };
  const assumed = offscreenUp;
  if (!assumed) await ensureOffscreen();
  offscreenUp = true;
  let res: EmbedResponse | undefined = assumed ? await chrome.runtime.sendMessage(msg).catch(() => undefined) : await chrome.runtime.sendMessage(msg);
  if (!res && assumed) {
    // Nobody answered: the document went away since we last checked. Recreate it and ask once more.
    offscreenUp = false;
    await ensureOffscreen();
    offscreenUp = true;
    res = await chrome.runtime.sendMessage(msg);
  }
  if (!res || "error" in res) throw new Error(`embed failed: ${res?.error ?? "no response"}`);
  return res.vectors;
}

/** Keeps topic and anchor vectors across worker restarts, so a woken worker doesn't re-embed them. */
export interface VectorStore {
  getVectors(key: string): Promise<number[][] | undefined>;
  /** Replaces whatever was stored: one topic list at a time is enough. */
  putVectors(key: string, texts: string[], vectors: number[][]): Promise<void>;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function closest(v: number[], labels: string[], vecs: number[][]): { label: string; sim: number } {
  let best = { label: "none", sim: 0 };
  vecs.forEach((u, i) => {
    const sim = dot(v, u);
    if (best.label === "none" || sim > best.sim) best = { label: labels[i], sim };
  });
  return best;
}

type Anchors = { topics: string[]; topicVecs: number[][]; anchors: string[]; anchorVecs: number[][] };

const SCORE_CACHE_MAX = 2000;

/**
 * MiniLM via the offscreen document (or any EmbedFn, for benchmarks). Topic and anchor vectors are
 * cached per topic list, and scores per tile text, so the model phase doesn't re-embed tiles the
 * fast phase already scored.
 */
export class OffscreenEmbedder implements Embedder {
  private anchors = new Map<string, Promise<Anchors>>();
  private scores = new Map<string, EmbedScore>();
  private scoresFor = "";

  constructor(
    private embedTexts: EmbedFn = offscreenEmbed,
    private store?: VectorStore,
  ) {}

  /** Embeds the fixed texts (topics and anchors) once, then serves them from the store. */
  private async fixedVectors(texts: string[]): Promise<number[][]> {
    const key = JSON.stringify([EMBED_MODEL, texts]);
    const stored = await this.store?.getVectors(key).catch(() => undefined);
    if (stored?.length === texts.length) return stored;
    const vecs = await this.embedTexts(texts);
    this.store?.putVectors(key, texts, vecs).catch(() => {});
    return vecs;
  }

  private anchorsFor(topics: string[]): Promise<Anchors> {
    const key = JSON.stringify(topics);
    let p = this.anchors.get(key);
    if (!p) {
      const off = distractorsFor(topics);
      const anchors = Object.keys(off);
      p = this.fixedVectors([...topics, ...Object.values(off)]).then((vecs) => ({
        topics,
        topicVecs: vecs.slice(0, topics.length),
        anchors,
        anchorVecs: vecs.slice(topics.length),
      }));
      p.catch(() => this.anchors.delete(key));
      this.anchors.clear(); // one topic list at a time is enough
      this.anchors.set(key, p);
    }
    return p;
  }

  async score(texts: string[], topics: string[]): Promise<EmbedScore[]> {
    if (!texts.length || !topics.length) return [];
    const key = JSON.stringify(topics);
    if (key !== this.scoresFor) {
      this.scores.clear();
      this.scoresFor = key;
    }
    const missing = [...new Set(texts.filter((t) => !this.scores.has(t)))];
    const fresh = new Map<string, EmbedScore>();
    if (missing.length) {
      const [a, vecs] = await Promise.all([this.anchorsFor(topics), this.embedTexts(missing)]);
      vecs.forEach((v, i) => {
        const t = closest(v, a.topics, a.topicVecs);
        const n = closest(v, a.anchors, a.anchorVecs);
        const score = { topic: t.label, topicSim: t.sim, anchor: n.label, anchorSim: n.label === "none" ? 0 : n.sim };
        fresh.set(missing[i], score);
        this.scores.set(missing[i], score);
      });
      // Insertion order is age order: drop the oldest beyond the cap.
      for (const k of this.scores.keys()) {
        if (this.scores.size <= SCORE_CACHE_MAX) break;
        this.scores.delete(k);
      }
    }
    return texts.map((t) => fresh.get(t) ?? this.scores.get(t)!);
  }
}
