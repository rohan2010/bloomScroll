import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Decision, Label } from "../shared/types";
import type { ReviewItem } from "../shared/messages";
import { cacheKey, type DecisionStore, type LabelStore } from "./cascade";
import type { VectorStore } from "./embedder";

export const DECISION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const DECISION_CAP = 20_000;

/** Title and channel are kept with the decision (locally) so Settings can offer it for review. */
type StoredDecision = Decision & { key: string; title?: string; channel?: string };

interface BloomDB extends DBSchema {
  decisions: { key: string; value: StoredDecision; indexes: { decidedAt: number } };
  labels: { key: string; value: Label; indexes: { at: number } };
  embeddings: { key: string; value: { hash: string; topics: string[]; vectors: Float32Array[] } };
}

export function openBloomDb(name = "bloomscroll"): Promise<IDBPDatabase<BloomDB>> {
  return openDB<BloomDB>(name, 1, {
    upgrade(db) {
      db.createObjectStore("decisions", { keyPath: "key" }).createIndex("decidedAt", "decidedAt");
      db.createObjectStore("labels", { keyPath: "videoId" }).createIndex("at", "at");
      db.createObjectStore("embeddings", { keyPath: "hash" });
    },
  });
}

export class IdbCache implements DecisionStore, LabelStore, VectorStore {
  constructor(private db: Promise<IDBPDatabase<BloomDB>> = openBloomDb()) {}

  /** Rows past the TTL count as misses, so they're re-decided even before prune() removes them. */
  async getMany(keys: string[], now = Date.now()): Promise<(Decision | undefined)[]> {
    const tx = (await this.db).transaction("decisions");
    const rows = await Promise.all(keys.map((k) => tx.store.get(k)));
    return rows.map((r) => (r && r.decidedAt > now - DECISION_TTL_MS ? r : undefined));
  }

  async putMany(decisions: (Decision & { title?: string; channel?: string })[]): Promise<void> {
    if (!decisions.length) return;
    const tx = (await this.db).transaction("decisions", "readwrite");
    await Promise.all([...decisions.map((d) => tx.store.put({ ...d, key: cacheKey(d.modeId, d.videoId) })), tx.done]);
  }

  /** Drop decisions older than the TTL, then the oldest beyond the cap. */
  async prune(now = Date.now()): Promise<number> {
    const db = await this.db;
    const tx = db.transaction("decisions", "readwrite");
    const index = tx.store.index("decidedAt");
    let removed = 0;
    for (let c = await index.openCursor(IDBKeyRange.upperBound(now - DECISION_TTL_MS)); c; c = await c.continue()) {
      await c.delete();
      removed++;
    }
    let excess = (await tx.store.count()) - DECISION_CAP;
    for (let c = excess > 0 ? await index.openCursor() : null; c && excess > 0; c = await c.continue(), excess--) {
      await c.delete();
      removed++;
    }
    await tx.done;
    return removed;
  }

  /**
   * A random sample of recently decided videos the user hasn't labelled, half shown and half
   * hidden when possible, for the calibration review queue.
   */
  async sampleForReview(n: number): Promise<ReviewItem[]> {
    const db = await this.db;
    const [rows, labels] = await Promise.all([db.getAll("decisions"), db.getAllKeys("labels")]);
    const labelled = new Set(labels);
    const byVideo = new Map<string, StoredDecision>();
    for (const r of rows) if (r.title && !labelled.has(r.videoId)) byVideo.set(r.videoId, r);
    const shuffle = <T>(xs: T[]) => {
      for (let i = xs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [xs[i], xs[j]] = [xs[j], xs[i]];
      }
      return xs;
    };
    const all = [...byVideo.values()];
    const shown = shuffle(all.filter((r) => r.verdict === "show"));
    const hidden = shuffle(all.filter((r) => r.verdict === "hide"));
    const half = Math.ceil(n / 2);
    const pick = [...hidden.slice(0, half), ...shown.slice(0, n - Math.min(half, hidden.length))].slice(0, n);
    return shuffle(pick).map((r) => ({ videoId: r.videoId, title: r.title!, channel: r.channel ?? "", verdict: r.verdict, reason: r.reason }));
  }

  async getVectors(key: string): Promise<number[][] | undefined> {
    const row = await (await this.db).get("embeddings", key);
    return row?.vectors.map((v) => Array.from(v));
  }

  async putVectors(key: string, texts: string[], vectors: number[][]): Promise<void> {
    const tx = (await this.db).transaction("embeddings", "readwrite");
    await Promise.all([tx.store.clear(), tx.store.put({ hash: key, topics: texts, vectors: vectors.map((v) => Float32Array.from(v)) }), tx.done]);
  }

  async clearDecisions(): Promise<void> {
    await (await this.db).clear("decisions");
  }

  async addLabel(label: Label): Promise<void> {
    await (await this.db).put("labels", label);
  }

  /** The user's latest correction per video (labels are keyed by videoId, so a new one replaces the old). */
  async getLabels(videoIds: string[]): Promise<(Label | undefined)[]> {
    const tx = (await this.db).transaction("labels");
    return Promise.all(videoIds.map((id) => tx.store.get(id)));
  }

  async listLabels(): Promise<Label[]> {
    return (await this.db).getAllFromIndex("labels", "at");
  }

  async clearLabels(): Promise<void> {
    await (await this.db).clear("labels");
  }
}
