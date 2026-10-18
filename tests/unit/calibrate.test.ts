import { describe, expect, it } from "vitest";
import { calibrate, fit, predict, score, split, type Feature } from "../../extension/src/background/calibrate";
import type { Embedder } from "../../extension/src/background/cascade";
import type { DecisionBackend } from "../../extension/src/background/backends";
import { DEFAULT_SETTINGS } from "../../extension/src/shared/settings";
import type { Label } from "../../extension/src/shared/types";

const th = DEFAULT_SETTINGS.thresholds; // show >= 0.15, hide <= -0.05, model >= 0.10

describe("predict / score", () => {
  it("follows the cascade order: rule, then embedding bands, then model, then fail open", () => {
    expect(predict({ videoId: "a", wanted: true, rule: "hide", margin: 0.9 }, th)).toBe("hide");
    expect(predict({ videoId: "a", wanted: true, margin: 0.2 }, th)).toBe("show");
    expect(predict({ videoId: "a", wanted: true, margin: -0.1 }, th)).toBe("hide");
    expect(predict({ videoId: "a", wanted: true, margin: 0.05, p: 0.05 }, th)).toBe("hide");
    expect(predict({ videoId: "a", wanted: true, margin: 0.05 }, th)).toBe("show");
  });

  it("counts precision, wrongly hidden and a cost that weighs wrong hides double", () => {
    const fs: Feature[] = [
      { videoId: "1", wanted: true, margin: 0.3 }, // shown, right
      { videoId: "2", wanted: false, margin: 0.3 }, // shown, wrong
      { videoId: "3", wanted: true, margin: -0.3 }, // hidden, wrong
      { videoId: "4", wanted: false, margin: -0.3 }, // hidden, right
    ];
    expect(score(fs, th)).toEqual({ n: 4, precision: 0.5, wronglyHidden: 0.5, wrongHides: 1, wrongShows: 1, cost: 3 });
  });
});

describe("fit", () => {
  it("moves the embedding cutoffs to where this user's answers split", () => {
    // This user's on-topic titles sit at margins 0.06-0.12, below the default show cutoff;
    // off-topic ones at -0.02..0.02, above the default hide cutoff. No model available.
    const fs: Feature[] = [
      ...[0.06, 0.08, 0.1, 0.12].map((m, i) => ({ videoId: `w${i}`, wanted: true, margin: m })),
      ...[-0.02, 0, 0.01, 0.02].map((m, i) => ({ videoId: `u${i}`, wanted: false, margin: m })),
    ];
    expect(score(fs, th).cost).toBe(4); // the unwanted ones fall through and fail open
    const fitted = fit(fs, th);
    expect(score(fs, fitted).cost).toBe(0);
    // Smallest change that fixes it: raise the hide cutoff above the unwanted titles. The wanted
    // ones are shown either way (unsure band, no model, fail open), so show stays put.
    expect(fitted.embedMarginHide).toBeGreaterThanOrEqual(0.02);
    expect(fitted.embedMarginHide).toBeLessThan(0.06);
    expect(fitted.embedMarginShow).toBe(th.embedMarginShow);
  });

  it("keeps the current thresholds when they already fit", () => {
    const fs: Feature[] = [
      { videoId: "a", wanted: true, margin: 0.4 },
      { videoId: "b", wanted: false, margin: -0.3 },
    ];
    expect(fit(fs, th)).toEqual(th);
  });

  it("tunes the model cutoff when model scores exist", () => {
    const fs: Feature[] = [
      ...[0.06, 0.07, 0.08].map((p, i) => ({ videoId: `w${i}`, wanted: true, margin: 0.05, p })),
      ...[0.01, 0.02, 0.03].map((p, i) => ({ videoId: `u${i}`, wanted: false, margin: 0.05, p })),
    ];
    const fitted = fit(fs, th);
    expect(score(fs, fitted).cost).toBe(0);
    expect(fitted.modelShow).toBeGreaterThan(0.03);
    expect(fitted.modelShow).toBeLessThanOrEqual(0.06);
  });
});

describe("split", () => {
  it("is deterministic and roughly 80/20", () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ videoId: `v${i}` }));
    const a = split(items);
    expect(split(items).test.map((x) => x.videoId)).toEqual(a.test.map((x) => x.videoId));
    expect(a.test.length).toBeGreaterThan(70);
    expect(a.test.length).toBeLessThan(130);
  });
});

describe("calibrate", () => {
  const label = (i: number, wanted: boolean): Label => ({ videoId: `v${i}`, title: wanted ? `mystery tutorial ${i}` : `mystery vlog ${i}`, channel: "c", userVerdict: wanted ? "show" : "hide", at: i });

  it("refuses with too few answers or outside Work/Learn", async () => {
    const few = await calibrate({ settings: DEFAULT_SETTINGS, labels: [label(1, true)] });
    expect(few).toMatchObject({ ok: false, reason: "not-enough-labels" });
    const labels = Array.from({ length: 40 }, (_, i) => label(i, i % 2 === 0));
    const relax = await calibrate({ settings: { ...DEFAULT_SETTINGS, mode: "relax" }, labels });
    expect(relax).toMatchObject({ ok: false, reason: "mode" });
  });

  it("scores with the embedder, survives a dead model, and reports before/after", async () => {
    const labels = Array.from({ length: 60 }, (_, i) => label(i, i % 2 === 0));
    const embedder: Embedder = {
      score: async (texts) => texts.map((t) => (t.includes("tutorial") ? { topic: "programming", topicSim: 0.4, anchor: "gaming", anchorSim: 0.3 } : { topic: "programming", topicSim: 0.3, anchor: "lifestyle", anchorSim: 0.29 })),
    };
    const backend: DecisionBackend = { name: "laya", maxBatch: 4, decide: async () => Promise.reject(new Error("down")) };
    const r = await calibrate({ settings: { ...DEFAULT_SETTINGS, mode: "work" }, labels, embedder, backend });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.modelUsed).toBe(false);
    expect(r.heldOut).toBe(true);
    // Wanted at margin 0.10 and unwanted at 0.01 both sit in the default "unsure" band and fail open.
    expect(r.before.wrongShows).toBeGreaterThan(0);
    expect(r.after.cost).toBe(0);
  });
});
