// @vitest-environment node
// End-to-end timing of the real cascade: MiniLM in Node + live laya-serve, mimicking the content
// script (fast stage for every tile, then the model in batches of 4).
//   LAYA_URL=http://127.0.0.1:8765 pnpm exec vitest run pipeline
import { describe, expect, it } from "vitest";
import { pipeline } from "@huggingface/transformers";
import { createLayaBackend } from "../../extension/src/background/backends/laya";
import { decideBatch, type DecisionStore } from "../../extension/src/background/cascade";
import { OffscreenEmbedder } from "../../extension/src/background/embedder";
import { DEFAULT_SETTINGS } from "../../extension/src/shared/settings";
import type { Decision, VideoTile } from "../../extension/src/shared/types";
import { OFF_TITLES, ON_TITLES } from "./titles";

describe.skipIf(!process.env.LAYA_URL)("pipeline benchmark (live laya-serve)", () => {
  it("40-tile feed: fast answers first, then the model", async () => {
    const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" });
    const embedder = new OffscreenEmbedder(async (texts) => (await extractor(texts, { pooling: "mean", normalize: true })).tolist() as number[][]);
    const backend = createLayaBackend(process.env.LAYA_URL!);
    const map = new Map<string, Decision>();
    const store: DecisionStore = { getMany: async (ks) => ks.map((k) => map.get(k)), putMany: async (ds) => ds.forEach((d) => map.set(`${d.modeId}:${d.videoId}`, d)) };
    const settings = { ...DEFAULT_SETTINGS, mode: "work" as const };
    const tiles: VideoTile[] = [...ON_TITLES.map((t, i) => [t, `on${i}`, 1] as const), ...OFF_TITLES.map((t, i) => [t, `off${i}`, 0] as const)]
      .map(([[title, channel], videoId]) => ({ videoId, title, channel, isShort: false, surface: "home" }));
    const deps = { settings, store, embedder, backend };

    // Warm both models, as the extension does on page open.
    await Promise.all([backend.warm!(), embedder.score(["warm up"], ["programming"])]);

    const t0 = performance.now();
    const fast = await decideBatch(tiles, { ...deps, stages: "fast" });
    const tFast = performance.now() - t0;
    const rest = tiles.filter((t) => !fast.some((d) => d.videoId === t.videoId));
    let tFirstModel = 0;
    const model: Decision[] = [];
    for (let i = 0; i < rest.length; i += 4) {
      model.push(...(await decideBatch(rest.slice(i, i + 4), deps)));
      tFirstModel ||= performance.now() - t0;
    }
    const tAll = performance.now() - t0;

    const all = [...fast, ...model];
    const wrong = all.filter((d) => (d.verdict === "show") !== d.videoId.startsWith("on"));
    const stages = all.reduce<Record<string, number>>((acc, d) => ((acc[d.stage] = (acc[d.stage] ?? 0) + 1), acc), {});
    console.log(`fast stage: ${fast.length}/40 tiles decided in ${tFast.toFixed(0)} ms  (${JSON.stringify(stages)})`);
    console.log(`model stage: ${rest.length} tiles; first answer at ${tFirstModel.toFixed(0)} ms, all done at ${tAll.toFixed(0)} ms`);
    console.log(`wrong: ${wrong.length}/40 ${wrong.map((d) => `${d.videoId}=${d.verdict} (${d.stage}: ${d.reason})`).join("; ")}`);
    expect(all).toHaveLength(40);
  }, 300_000);
});
