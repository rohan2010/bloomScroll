import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { DECISION_TTL_MS, IdbCache, openBloomDb } from "../../extension/src/background/cache";
import type { Decision } from "../../extension/src/shared/types";

const d = (videoId: string, decidedAt: number): Decision => ({
  videoId,
  verdict: "show",
  confidence: 1,
  stage: "rule",
  reason: "test",
  modeId: "work-x",
  decidedAt,
});

describe("IdbCache", () => {
  it("round-trips decisions by mode + video", async () => {
    const cache = new IdbCache(openBloomDb("t1"));
    await cache.putMany([d("a", 1), d("b", 2)]);
    const [a, missing] = await cache.getMany(["work-x:a", "work-x:zzz"]);
    expect(a).toMatchObject({ videoId: "a" });
    expect(missing).toBeUndefined();
  });

  it("prunes decisions past the TTL", async () => {
    const cache = new IdbCache(openBloomDb("t2"));
    const now = 10 * DECISION_TTL_MS;
    await cache.putMany([d("old", now - DECISION_TTL_MS - 1), d("new", now - 1)]);
    expect(await cache.prune(now)).toBe(1);
    expect((await cache.getMany(["work-x:old", "work-x:new"])).map(Boolean)).toEqual([false, true]);
  });

  it("stores labels ordered by time", async () => {
    const cache = new IdbCache(openBloomDb("t3"));
    await cache.addLabel({ videoId: "b", title: "B", channel: "c", userVerdict: "show", at: 2 });
    await cache.addLabel({ videoId: "a", title: "A", channel: "c", userVerdict: "hide", at: 1 });
    expect((await cache.listLabels()).map((l) => l.videoId)).toEqual(["a", "b"]);
  });
});
