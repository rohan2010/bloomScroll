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
    // ~400 ms per tile on a 2-core Intel CPU whatever the batch size. On an M4 GPU it's 34 ms for
    // one tile, 24 ms/tile at 4 and 22 ms/tile at 16-40, so 4 gets nearly all of the batching gain
    // while each answer still lands within ~100 ms.
    maxBatch: 4,
  });
  return {
    ...backend,
    // An idle laya-serve gets paged out by macOS (Intel: 7.3 s for the first request after a break
    // versus 0.47 s warm), and on Apple Silicon start.sh unloads it after 15 idle minutes (~1.3 s to
    // reload). One throwaway tile when YouTube opens hides either behind page load.
    async warm() {
      await backend.decide(["warm up"], [WARM_TILE]);
    },
  };
}
