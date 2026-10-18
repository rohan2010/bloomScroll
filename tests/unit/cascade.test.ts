import { describe, expect, it, vi } from "vitest";
import type { DecisionBackend } from "../../extension/src/background/backends";
import { cacheKey, channelListed, decideBatch, modeIdFor, ruleDecision, titleMentions, type DecisionStore, type Embedder } from "../../extension/src/background/cascade";
import { DEFAULT_SETTINGS } from "../../extension/src/shared/settings";
import type { Decision, Settings, VideoTile } from "../../extension/src/shared/types";

const tile = (videoId: string, title: string, channel = "Some Channel", extra: Partial<VideoTile> = {}): VideoTile => ({
  videoId,
  title,
  channel,
  isShort: false,
  surface: "home",
  ...extra,
});

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch });

function mockBackend(probs: Record<string, number>, name = "laya"): DecisionBackend & { calls: VideoTile[][] } {
  const calls: VideoTile[][] = [];
  return {
    name,
    maxBatch: 2,
    calls,
    async decide(_state, tiles) {
      calls.push(tiles);
      return tiles.filter((t) => t.videoId in probs).map((t) => ({ videoId: t.videoId, onIntent: probs[t.videoId] }));
    },
  };
}

function memoryStore(): DecisionStore & { map: Map<string, Decision> } {
  const map = new Map<string, Decision>();
  return {
    map,
    async getMany(keys) {
      return keys.map((k) => map.get(k));
    },
    async putMany(ds) {
      for (const d of ds) map.set(cacheKey(d.modeId, d.videoId), d);
    },
  };
}

describe("rules", () => {
  it("matches channel lists by name, handle or id, case-insensitively", () => {
    const t = tile("a", "x", "Let's Get Rusty", { channelId: "@letsgetrusty" });
    expect(channelListed(["let's get rusty"], t)).toBe("let's get rusty");
    expect(channelListed(["https://www.youtube.com/@LetsGetRusty"], t)).toBeTruthy();
    expect(channelListed(["Rusty"], t)).toBeUndefined();
  });

  it("matches whole topic words only", () => {
    expect(titleMentions("Linux kernel boot", ["linux"])).toBe("linux");
    expect(titleMentions("Pythonesque comedy", ["Python"])).toBeUndefined();
    expect(titleMentions("Why C++ is hard", ["C++"])).toBe("C++");
  });

  it("blocklist beats allowlist, and relax shows everything else", () => {
    const s = settings({ allowChannels: ["X"], blockChannels: ["X"] });
    expect(ruleDecision(tile("a", "t", "X"), s)?.verdict).toBe("hide");
    expect(ruleDecision(tile("a", "pranks"), settings({ mode: "relax" }))?.reason).toBe("relax mode");
  });

  it("hides shorts in work/learn", () => {
    expect(ruleDecision(tile("a", "Linux", "c", { isShort: true }), settings({ mode: "work" }))?.verdict).toBe("hide");
  });

  it("work mode ignores user topics; learn mode uses them", () => {
    const t = tile("a", "Woodworking for beginners");
    expect(ruleDecision(t, settings({ mode: "work", topics: ["woodworking"] }))).toBeNull();
    expect(ruleDecision(t, settings({ mode: "learn", topics: ["woodworking"] }))?.verdict).toBe("show");
  });
});

describe("decideBatch", () => {
  it("routes undecided tiles through embeddings, then the model in batches", async () => {
    const embedder: Embedder = {
      async maxSimilarity(text) {
        if (text.startsWith("near")) return { sim: 0.8, topic: "programming" };
        if (text.startsWith("far")) return { sim: 0.1, topic: "programming" };
        return { sim: 0.4, topic: "programming" };
      },
    };
    const backend = mockBackend({ m1: 0.9, m2: 0.1, m3: 0.35 }); // modelShow 0.3
    const ds = await decideBatch(
      [tile("r", "Linux tips"), tile("near", "near"), tile("far", "far"), tile("m1", "mid1"), tile("m2", "mid2"), tile("m3", "mid3")],
      { settings: settings(), embedder, backend },
    );
    expect(ds.map((d) => [d.videoId, d.verdict, d.stage])).toEqual([
      ["r", "show", "rule"],
      ["near", "show", "embedding"],
      ["far", "hide", "embedding"],
      ["m1", "show", "model"],
      ["m2", "hide", "model"],
      ["m3", "show", "model"],
    ]);
    expect(backend.calls.map((c) => c.length)).toEqual([2, 1]); // maxBatch 2
  });

  it("sends only low-confidence answers to the fallback", async () => {
    const backend = mockBackend({ sure: 0.95, unsure: 0.33 });
    const fallback = mockBackend({ unsure: 0.1 }, "jev");
    const ds = await decideBatch([tile("sure", "a"), tile("unsure", "b")], { settings: settings(), backend, fallback });
    expect(fallback.calls.flat().map((t) => t.videoId)).toEqual(["unsure"]);
    expect(ds[1]).toMatchObject({ verdict: "hide", stage: "fallback" });
  });

  it("fails open without caching when no model answers", async () => {
    const store = memoryStore();
    const backend: DecisionBackend = { name: "laya", maxBatch: 40, decide: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) };
    const ds = await decideBatch([tile("a", "mystery")], { settings: settings(), backend, store });
    expect(ds[0]).toMatchObject({ verdict: "show", stage: "fallback", confidence: 0 });
    expect(store.map.size).toBe(0);
  });

  it("serves cached decisions and invalidates them when settings change", async () => {
    const store = memoryStore();
    const backend = mockBackend({ a: 0.2 });
    const s = settings();
    await decideBatch([tile("a", "mystery")], { settings: s, backend, store });
    await decideBatch([tile("a", "mystery")], { settings: s, backend, store });
    expect(backend.calls.length).toBe(1);

    const changed = settings({ blockChannels: ["someone"] });
    expect(modeIdFor(changed)).not.toBe(modeIdFor(s));
    await decideBatch([tile("a", "mystery")], { settings: changed, backend, store });
    expect(backend.calls.length).toBe(2);
  });

  it("dedupes repeated video ids and skips the model outside work/learn", async () => {
    const backend = mockBackend({});
    const ds = await decideBatch([tile("a", "x"), tile("a", "x")], { settings: settings({ mode: "relax" }), backend });
    expect(ds).toHaveLength(1);
    expect(backend.calls).toHaveLength(0);
  });
});
