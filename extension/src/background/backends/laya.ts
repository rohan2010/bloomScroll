import { createJevWireBackend } from "./jevWire";
import type { DecisionBackend } from "./types";

export function createLayaBackend(baseUrl: string): DecisionBackend {
  return createJevWireBackend({
    name: "laya",
    baseUrl,
    model: "english",
    batchRoute: true,
    // laya-serve runs one request at a time and can't cancel one, so a client timeout only re-queues
    // the same work. Wait long enough for a queued batch on a slow CPU (~1-2 s per tile).
    timeoutMs: 120_000,
    maxBatch: 10,
  });
}
