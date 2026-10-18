import { createJevWireBackend } from "./jevWire";
import type { DecisionBackend } from "./types";
import type { VideoTile } from "../../shared/types";

const WARM_TILE: VideoTile = { videoId: "warm", title: "warm up", channel: "bloomScroll", isShort: false, surface: "home" };

export function createLayaBackend(baseUrl: string): DecisionBackend {
  const backend = createJevWireBackend({
    name: "laya",
    baseUrl,
    model: "english",
    batchRoute: true,
    // laya-serve runs one request at a time and can't cancel one, so a client timeout only re-queues
    // the same work. Wait long enough for a queued batch on a slow CPU.
    timeoutMs: 120_000,
    // ~400 ms per tile on a 2-core CPU whatever the batch size (no per-request overhead), so small
    // batches only make answers arrive sooner.
    maxBatch: 4,
  });
  return {
    ...backend,
    // An idle laya-serve gets paged out by macOS: the first request after a break took 7.3 s
    // versus 0.47 s warm. One throwaway tile when YouTube opens hides that behind page load.
    async warm() {
      await backend.decide(["warm up"], [WARM_TILE]);
    },
  };
}
