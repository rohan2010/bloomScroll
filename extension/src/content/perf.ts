import type { CascadeMetrics } from "../shared/messages";
import type { Decision, VideoTile } from "../shared/types";

export type Phase = "fast" | "model";

/** One tile's journey, from showing up on the page to getting a verdict. */
export type TileTiming = {
  videoId: string;
  title: string;
  channel: string;
  verdict: Decision["verdict"];
  stage: Decision["stage"];
  reason: string;
  /** Served from the decision cache rather than computed now. */
  cached: boolean;
  /** Milliseconds from the tile being seen to its verdict landing. */
  ms: number;
  phase: Phase;
};

export type CallTiming = { phase: Phase; tiles: number; roundTripMs: number; metrics?: CascadeMetrics };

const RECENT_MAX = 40;

export function percentile(xs: number[], p: number): number | undefined {
  if (!xs.length) return undefined;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Classification timings for the current page (reset on navigation and on decision-relevant settings changes). */
export class PagePerf {
  firstSeenAt?: number;
  settledAt?: number;
  readonly times: Record<Phase, number[]> = { fast: [], model: [] };
  readonly stages: Record<string, number> = {};
  cached = 0;
  readonly recent: TileTiming[] = [];
  /** Stage failures reported by the worker, newest first. */
  readonly errors: string[] = [];
  readonly lastCall: Partial<Record<Phase, CallTiming>> = {};
  readonly totals: Record<Phase, { calls: number; tiles: number; ms: number }> = {
    fast: { calls: 0, tiles: 0, ms: 0 },
    model: { calls: 0, tiles: 0, ms: 0 },
  };

  reset(): void {
    this.firstSeenAt = this.settledAt = undefined;
    this.times.fast.length = this.times.model.length = 0;
    for (const k of Object.keys(this.stages)) delete this.stages[k];
    this.cached = 0;
    this.recent.length = 0;
    this.errors.length = 0;
    delete this.lastCall.fast;
    delete this.lastCall.model;
    for (const t of Object.values(this.totals)) t.calls = t.tiles = t.ms = 0;
  }

  sawTile(at: number): void {
    this.firstSeenAt ??= at;
    this.settledAt = undefined; // new work arrived
  }

  recordCall(call: CallTiming): void {
    this.lastCall[call.phase] = call;
    for (const e of call.metrics?.errors ?? []) if (this.errors[0] !== e) this.errors.unshift(e);
    this.errors.length = Math.min(this.errors.length, 5);
    const t = this.totals[call.phase];
    t.calls++;
    t.tiles += call.tiles;
    t.ms += call.roundTripMs;
  }

  recordDecision(tile: VideoTile, d: Decision, seenAt: number, cached: boolean, phase: Phase): void {
    const ms = performance.now() - seenAt;
    this.times[phase].push(ms);
    this.stages[d.stage] = (this.stages[d.stage] ?? 0) + 1;
    if (cached) this.cached++;
    this.recent.unshift({ videoId: tile.videoId, title: tile.title, channel: tile.channel, verdict: d.verdict, stage: d.stage, reason: d.reason, cached, ms, phase });
    if (this.recent.length > RECENT_MAX) this.recent.length = RECENT_MAX;
  }

  markSettled(): void {
    if (this.firstSeenAt !== undefined) this.settledAt ??= performance.now();
  }

  /** Time from the first tile appearing to the last verdict landing, or so far if still working. */
  elapsedMs(): number | undefined {
    if (this.firstSeenAt === undefined) return undefined;
    return (this.settledAt ?? performance.now()) - this.firstSeenAt;
  }

  summary() {
    return {
      fastP50: percentile(this.times.fast, 50),
      modelP50: percentile(this.times.model, 50),
      settledMs: this.settledAt !== undefined ? this.elapsedMs() : undefined,
      decided: this.times.fast.length + this.times.model.length,
    };
  }
}
