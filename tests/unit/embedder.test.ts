import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { IdbCache, openBloomDb } from "../../extension/src/background/cache";
import { OffscreenEmbedder } from "../../extension/src/background/embedder";

/** Fake MiniLM: a deterministic unit-ish vector per text, recording what it was asked to embed. */
function fakeEmbed(calls: string[][]) {
  return async (texts: string[]) => {
    calls.push(texts);
    return texts.map((t) => [t.length % 7, (t.charCodeAt(0) ?? 0) % 5, 1].map((x) => x / 10));
  };
}

describe("OffscreenEmbedder", () => {
  it("keeps topic and anchor vectors in the store, so a restarted worker only embeds tile texts", async () => {
    const store = new IdbCache(openBloomDb("emb1"));
    const first: string[][] = [];
    const a = new OffscreenEmbedder(fakeEmbed(first), store);
    const before = await a.score(["some video title"], ["programming", "woodworking"]);
    expect(first.flat()).toContain("programming");

    const second: string[][] = [];
    const b = new OffscreenEmbedder(fakeEmbed(second), store); // a fresh worker, same database
    const after = await b.score(["some video title"], ["programming", "woodworking"]);
    expect(second).toEqual([["some video title"]]);
    expect(after[0].topicSim).toBeCloseTo(before[0].topicSim, 6);
    expect(after[0].anchorSim).toBeCloseTo(before[0].anchorSim, 6);
  });

  it("re-embeds when the topic list changes", async () => {
    const store = new IdbCache(openBloomDb("emb2"));
    await new OffscreenEmbedder(fakeEmbed([]), store).score(["x"], ["programming"]);
    const calls: string[][] = [];
    await new OffscreenEmbedder(fakeEmbed(calls), store).score(["x"], ["cooking"]);
    expect(calls.flat()).toContain("cooking");
  });
});
