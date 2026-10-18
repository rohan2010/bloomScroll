// Calibration: re-tune the embedding and model thresholds to the user's own labels.
//
// The spec also mentions refitting a temperature on Laya's logits. laya-serve returns only
// normalized probabilities, and bloomScroll uses the model through a single cutoff (modelShow),
// so moving that cutoff is equivalent for every decision it makes; no temperature is fitted.

import type { Label, Settings, VideoTile, Verdict } from "../shared/types";
import { modelTopicsFor, topicsFor } from "../shared/settings";
import type { CalibrationReport, CalibrationScores, Thresholds } from "../shared/messages";
import type { DecisionBackend } from "./backends";
import { ruleDecision, tileText, type Embedder } from "./cascade";

/** Everything the cascade would know about one labelled video, independent of the thresholds. */
export type Feature = {
  videoId: string;
  /** What the user said: true = on-topic (should show). */
  wanted: boolean;
  /** A rule's verdict, if one fires (thresholds can't change it). */
  rule?: Verdict;
  /** Embedding margin: sim to the closest topic minus sim to the closest off-topic anchor. */
  margin?: number;
  /** Model P(on-intent), when a model was reachable. */
  p?: number;
};

export const MIN_LABELS = 40;
export const MIN_PER_CLASS = 10;
/** Hiding something the user wanted costs more than showing something they didn't. */
const WRONG_HIDE_COST = 2;

/** What the cascade would decide for this feature with these thresholds (rules > embeddings > model > show). */
export function predict(f: Feature, th: Thresholds): Verdict {
  if (f.rule) return f.rule;
  if (f.margin !== undefined) {
    if (f.margin >= th.embedMarginShow) return "show";
    if (f.margin <= th.embedMarginHide) return "hide";
  }
  if (f.p !== undefined) return f.p >= th.modelShow ? "show" : "hide";
  return "show"; // no model: fail open
}

export function score(features: Feature[], th: Thresholds): CalibrationScores {
  let shown = 0, shownWanted = 0, wanted = 0, wrongHides = 0, wrongShows = 0;
  for (const f of features) {
    const v = predict(f, th);
    if (f.wanted) wanted++;
    if (v === "show") {
      shown++;
      if (f.wanted) shownWanted++;
      else wrongShows++;
    } else if (f.wanted) wrongHides++;
  }
  return {
    n: features.length,
    precision: shown ? shownWanted / shown : 1,
    wronglyHidden: wanted ? wrongHides / wanted : 0,
    wrongHides,
    wrongShows,
    cost: wrongHides * WRONG_HIDE_COST + wrongShows,
  };
}

function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let x = from; x <= to + 1e-9; x += step) out.push(Math.round(x * 100) / 100);
  return out;
}

/**
 * Grid search for the thresholds with the lowest error cost on these features. Ties go to the
 * candidate closest to the current thresholds, so calibration doesn't wander without evidence.
 */
export function fit(features: Feature[], current: Thresholds): Thresholds {
  const hasModel = features.some((f) => f.p !== undefined);
  const shows = range(-0.1, 0.5, 0.01);
  const hides = range(-0.4, 0.2, 0.01);
  const models = hasModel ? range(0.02, 0.6, 0.02) : [current.modelShow];
  let best = current;
  let bestCost = score(features, current).cost;
  let bestDist = 0;
  for (const s of shows) {
    for (const h of hides) {
      if (h >= s) continue; // the "unsure" band must not be inverted
      for (const m of models) {
        const th = { ...current, embedMarginShow: s, embedMarginHide: h, modelShow: m };
        const cost = score(features, th).cost;
        const dist = Math.abs(s - current.embedMarginShow) + Math.abs(h - current.embedMarginHide) + Math.abs(m - current.modelShow);
        if (cost < bestCost || (cost === bestCost && dist < bestDist)) {
          best = th;
          bestCost = cost;
          bestDist = dist;
        }
      }
    }
  }
  return best;
}

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Deterministic 80/20 split by video id, so re-running on the same labels gives the same report. */
export function split<T extends { videoId: string }>(items: T[]): { train: T[]; test: T[] } {
  const train: T[] = [];
  const test: T[] = [];
  for (const it of items) (hash(it.videoId) % 5 === 0 ? test : train).push(it);
  return { train, test };
}

export type CalibrationDeps = {
  settings: Settings;
  labels: Label[];
  embedder?: Embedder | null;
  backend?: DecisionBackend | null;
  /** Called with (done, total) while the model scores titles. */
  onProgress?: (done: number, total: number) => void;
};

/** Scores every labelled title through the cascade's stages, then fits and reports. */
export async function calibrate(deps: CalibrationDeps): Promise<CalibrationReport> {
  const { settings: s, labels } = deps;
  const current: Thresholds = { ...s.thresholds };
  const wantedN = labels.filter((l) => l.userVerdict === "show").length;
  const counts = { labels: labels.length, wanted: wantedN, unwanted: labels.length - wantedN };
  if (labels.length < MIN_LABELS || wantedN < MIN_PER_CLASS || counts.unwanted < MIN_PER_CLASS) {
    return { ok: false, reason: "not-enough-labels", counts, current };
  }
  if (s.mode !== "work" && s.mode !== "learn") return { ok: false, reason: "mode", counts, current };

  const tiles: VideoTile[] = labels.map((l) => ({ videoId: l.videoId, title: l.title, channel: l.channel, isShort: false, surface: "home" }));
  const features: Feature[] = labels.map((l) => ({ videoId: l.videoId, wanted: l.userVerdict === "show" }));

  tiles.forEach((t, i) => {
    const r = ruleDecision(t, s);
    if (r) features[i].rule = r.verdict;
  });

  if (deps.embedder) {
    const scores = await deps.embedder.score(tiles.map(tileText), topicsFor(s));
    scores.forEach((sc, i) => sc && (features[i].margin = sc.topicSim - sc.anchorSim));
  }

  let modelUsed = false;
  if (deps.backend) {
    const need = tiles.filter((_, i) => !features[i].rule);
    const topics = modelTopicsFor(s);
    let done = 0;
    try {
      for (let i = 0; i < need.length; i += deps.backend.maxBatch) {
        const batch = need.slice(i, i + deps.backend.maxBatch);
        for (const v of await deps.backend.decide(topics, batch)) {
          const f = features.find((x) => x.videoId === v.videoId);
          if (f) f.p = v.onIntent;
        }
        done += batch.length;
        deps.onProgress?.(done, need.length);
      }
      modelUsed = true;
    } catch {
      // No model: calibrate the embedding thresholds only.
      for (const f of features) delete f.p;
    }
  }

  const { train, test } = split(features);
  const proposed = fit(train, current);
  const evalSet = test.length >= 10 ? test : features; // tiny label sets: report on everything
  return {
    ok: true,
    counts,
    current,
    proposed,
    modelUsed,
    heldOut: evalSet === test,
    before: score(evalSet, current),
    after: score(evalSet, proposed),
  };
}
