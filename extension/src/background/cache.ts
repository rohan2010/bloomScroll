import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Decision, Label } from "../shared/types";
import { cacheKey, type DecisionStore } from "./cascade";

export const DECISION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const DECISION_CAP = 20_000;

type StoredDecision = Decision & { key: string };

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

export class IdbCache implements DecisionStore {
  constructor(private db: Promise<IDBPDatabase<BloomDB>> = openBloomDb()) {}

  async getMany(keys: string[]): Promise<(Decision | undefined)[]> {
    const tx = (await this.db).transaction("decisions");
    return Promise.all(keys.map((k) => tx.store.get(k)));
  }

  async putMany(decisions: Decision[]): Promise<void> {
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

  async clearDecisions(): Promise<void> {
    await (await this.db).clear("decisions");
  }

  async addLabel(label: Label): Promise<void> {
    await (await this.db).put("labels", label);
  }

  async listLabels(): Promise<Label[]> {
    return (await this.db).getAllFromIndex("labels", "at");
  }

  async clearLabels(): Promise<void> {
    await (await this.db).clear("labels");
  }
}
