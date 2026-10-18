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

/** Embedder whose margin per text is looked up by the text's first word. */
function marginEmbedder(margins: Record<string, number>, fallback: number): Embedder {
  return {
    async score(texts) {
      return texts.map((t) => {
        const m = margins[t.split(" ")[0]] ?? fallback;
        return { topic: "programming", topicSim: 0.3 + m, anchor: "gaming", anchorSim: 0.3 };
      });
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
    // margins: near +0.5 (show >= 0.15), far -0.3 (hide <= -0.05), mid +0.05 (unsure)
    const embedder = marginEmbedder({ near: 0.5, far: -0.3 }, 0.05);
    const backend = mockBackend({ m1: 0.9, m2: 0.05, m3: 0.15 }); // modelShow 0.1
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

  it("decides on the margin between topic and off-topic similarity, not raw similarity", async () => {
    const embedder: Embedder = {
      async score(texts) {
        // Both are 0.6 similar to a topic; only the margin to the off-topic anchor differs.
        return texts.map((t) =>
          t.startsWith("game")
            ? { topic: "programming", topicSim: 0.6, anchor: "gaming", anchorSim: 0.7 }
            : { topic: "programming", topicSim: 0.6, anchor: "gaming", anchorSim: 0.2 },
        );
      },
    };
    const ds = await decideBatch([tile("g", "game dev streams"), tile("c", "code review")], { settings: settings(), embedder });
    expect(ds.map((d) => [d.videoId, d.verdict, d.stage])).toEqual([
      ["g", "hide", "embedding"],
      ["c", "show", "embedding"],
    ]);
    expect(ds[1].reason).toBe("'programming' 0.60 vs 'gaming' 0.20");
  });

  it("fast stage answers rules and embeddings without calling the model", async () => {
    const backend = mockBackend({ mid: 0.9 });
    const store = memoryStore();
    const embedder = marginEmbedder({ near: 0.5 }, 0.05);
    const tiles = [tile("r", "Linux tips"), tile("near", "near"), tile("mid", "mid")];
    const fast = await decideBatch(tiles, { settings: settings(), embedder, backend, store, stages: "fast" });
    expect(fast.map((d) => [d.videoId, d.stage])).toEqual([
      ["r", "rule"],
      ["near", "embedding"],
    ]);
    expect(backend.calls).toHaveLength(0);
    // The full pass then reuses those cached answers and only asks the model about the rest.
    const all = await decideBatch(tiles, { settings: settings(), embedder, backend, store });
    expect(all.map((d) => d.stage)).toEqual(["rule", "embedding", "model"]);
    expect(backend.calls.flat().map((t) => t.videoId)).toEqual(["mid"]);
  });

  it("tells the model the short tech summary, plus the user's topics in Learn", async () => {
    const seen: string[][] = [];
    const backend: DecisionBackend = { name: "laya", maxBatch: 4, decide: async (topics) => (seen.push(topics), []) };
    await decideBatch([tile("a", "mystery")], { settings: settings({ mode: "learn", topics: ["woodworking"] }), backend });
    await decideBatch([tile("b", "mystery")], { settings: settings({ mode: "work", topics: ["woodworking"] }), backend });
    expect(seen).toEqual([["programming, software, computers, AI", "woodworking"], ["programming, software, computers, AI"]]);
  });

  it("falls through to the model when the embedder fails", async () => {
    const embedder: Embedder = { score: vi.fn().mockRejectedValue(new Error("offscreen gone")) };
    const backend = mockBackend({ a: 0.9 });
    const [d] = await decideBatch([tile("a", "mystery")], { settings: settings(), embedder, backend });
    expect(d).toMatchObject({ verdict: "show", stage: "model" });
  });

  it("sends only low-confidence answers to the fallback", async () => {
    const backend = mockBackend({ sure: 0.95, unsure: 0.12 });
    const fallback = mockBackend({ unsure: 0.02 }, "jev");
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
