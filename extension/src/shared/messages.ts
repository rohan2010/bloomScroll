import type { Decision, Label, Mode, Settings, Surface, VideoTile } from "./types";

/** Reason on fail-open decisions; the content script retries tiles that carry it. */
export const NO_MODEL_REASON = "no model available, shown by default";
/** Reasons on decisions that come from the user's own corrections. */
export const USER_SHOWN = "you chose to show this";
export const USER_HIDDEN = "you hid this";

/**
 * stages "fast": cache, rules and embeddings only, answering in milliseconds and leaving
 * model-bound tiles out. stages "all" (default): the full cascade, including the model.
 */
export type DecideRequest = { type: "decide"; tiles: VideoTile[]; stages?: "fast" | "all" };
/** What one cascade run did, for the debug overlay. Times are milliseconds in the service worker. */
export type CascadeMetrics = {
  tiles: number;
  cached: number;
  rule: number;
  embedding: number;
  model: number;
  fallback: number;
  /** Shown only because no model answered. */
  failOpen: number;
  /** Tiles left for the model by a "fast" run. */
  deferred: number;
  ms: { cache: number; rules: number; embed: number; model: number; total: number };
  backend?: string;
  /** Stage failures the cascade recovered from (it fails open), for the debug overlay. */
  errors?: string[];
};

export function emptyMetrics(): CascadeMetrics {
  return { tiles: 0, cached: 0, rule: 0, embedding: 0, model: 0, fallback: 0, failOpen: 0, deferred: 0, ms: { cache: 0, rules: 0, embed: 0, model: 0, total: 0 } };
}

export type DecideResponse = { decisions: Decision[]; metrics?: CascadeMetrics } | { error: string };

export type LabelRequest = { type: "label"; label: Label };

export type StatsRequest = { type: "stats" };
export type StatsResponse = {
  surface: Surface | null;
  found: number;
  shown: number;
  hidden: number;
  pending: number;
  queue: number;
  mode: Mode;
  /** Per-tile time to verdict on this page, and how long until nothing was pending. */
  timing: { fastP50?: number; modelP50?: number; settledMs?: number; decided: number };
};

/** Sent when a YouTube page opens: wakes a paged-out local model before tiles need it. */
export type WarmRequest = { type: "warm" };

/** Model backend reachability, for the popup and the debug overlay. */
export type StatusRequest = { type: "status" };
export type BackendStatus = {
  kind: string;
  origin: string;
  state: "connected" | "down" | "no-permission" | "invalid-url" | "unused";
  latencyMs?: number;
};

export type Thresholds = Settings["thresholds"];

/** How a set of thresholds does on labelled videos. */
export type CalibrationScores = {
  n: number;
  /** Of the videos it would show, the share the user wanted. */
  precision: number;
  /** Of the videos the user wanted, the share it would hide. */
  wronglyHidden: number;
  wrongHides: number;
  wrongShows: number;
  cost: number;
};

export type CalibrationReport =
  | {
      ok: true;
      counts: { labels: number; wanted: number; unwanted: number };
      current: Thresholds;
      proposed: Thresholds;
      modelUsed: boolean;
      /** True when before/after were measured on held-out labels the fit never saw. */
      heldOut: boolean;
      before: CalibrationScores;
      after: CalibrationScores;
    }
  | { ok: false; reason: "not-enough-labels" | "mode"; counts: { labels: number; wanted: number; unwanted: number }; current: Thresholds };

export type CalibrateRequest = { type: "calibrate" };

/** A recently decided video for the review queue in Settings. */
export type ReviewItem = { videoId: string; title: string; channel: string; verdict: "show" | "hide"; reason: string };
export type ReviewSampleRequest = { type: "review-sample"; n: number };

export type BackgroundMessage = DecideRequest | LabelRequest | WarmRequest | StatusRequest | CalibrateRequest | ReviewSampleRequest;

/** Service worker → offscreen document. Vectors come back L2-normalized, so dot product = cosine. */
export type EmbedRequest = { target: "offscreen"; type: "embed"; texts: string[] };
export type EmbedResponse = { vectors: number[][] } | { error: string };

/** Bundled into the extension by scripts/prepare-assets.mjs; never fetched at runtime. */
export const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
