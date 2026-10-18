// Decision cascade: rules → embeddings → model → fallback. The cheapest confident stage wins.

import type { Decision, Settings, VideoTile } from "../shared/types";
import { NO_MODEL_REASON, type CascadeMetrics } from "../shared/messages";
import { modelTopicsFor, modeUsesModel, topicsFor } from "../shared/settings";
import type { DecisionBackend } from "./backends";
import { PROMPT_VERSION } from "./backends/jevWire";

/** Embedding pre-filter (MiniLM in the offscreen document, weekend 2). */
/** Closest topic and closest off-topic anchor for one text, by cosine similarity. */
export type EmbedScore = { topic: string; topicSim: number; anchor: string; anchorSim: number };

/** Embedding pre-filter: MiniLM in the offscreen document. One call scores a whole batch. */
export interface Embedder {
  score(texts: string[], topics: string[]): Promise<EmbedScore[]>;
}

export interface DecisionStore {
  getMany(keys: string[]): Promise<(Decision | undefined)[]>;
  putMany(decisions: Decision[]): Promise<void>;
}

export type CascadeDeps = {
  settings: Settings;
  store?: DecisionStore | null;
  embedder?: Embedder | null;
  backend?: DecisionBackend | null;
  /** Opt-in Jev, used only when the primary model is below modelMinConf. */
  fallback?: DecisionBackend | null;
  /**
   * "fast" runs cache, rules and embeddings only and leaves undecided tiles out of the result, so
   * the page can show those answers before the (slow) model stage runs. Default "all".
   */
  stages?: "fast" | "all";
  /** Filled in with per-stage counts and timings when given. */
  metrics?: CascadeMetrics;
  now?: () => number;
};

type Draft = Pick<Decision, "verdict" | "confidence" | "stage" | "reason">;

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** Identifies everything a decision depends on, so changing settings invalidates cached decisions. */
export function modeIdFor(s: Settings): string {
  const deps = [PROMPT_VERSION, topicsFor(s), modelTopicsFor(s), s.allowChannels, s.blockChannels, s.thresholds, s.backend.kind, s.backend.url];
  return `${s.mode}-${fnv1a(JSON.stringify(deps))}`;
}

export function cacheKey(modeId: string, videoId: string): string {
  return `${modeId}:${videoId}`;
}

function normChannel(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?youtube\.com\//, "")
    .replace(/^channel\//, "")
    .replace(/\/+$/, "");
}

/** Matches a list entry against the channel's display name, @handle or UC… id. */
export function channelListed(list: string[], tile: VideoTile): string | undefined {
  const names = [tile.channel, tile.channelId].filter(Boolean).map((n) => normChannel(n!));
  return list.find((entry) => {
    const e = normChannel(entry);
    return e && names.includes(e);
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A topic named outright in the title. Show-only: absence of a keyword never hides. */
export function titleMentions(title: string, topics: string[]): string | undefined {
  return topics.find((t) => t.trim() && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t.trim())}($|[^\\p{L}\\p{N}])`, "iu").test(title));
}

export function ruleDecision(tile: VideoTile, s: Settings): Draft | null {
  if (s.mode === "off") return { verdict: "show", confidence: 1, stage: "rule", reason: "filtering off" };
  const blocked = channelListed(s.blockChannels, tile);
  if (blocked) return { verdict: "hide", confidence: 1, stage: "rule", reason: `channel blocklisted (${blocked})` };
  const allowed = channelListed(s.allowChannels, tile);
  if (allowed) return { verdict: "show", confidence: 1, stage: "rule", reason: `channel allowlisted (${allowed})` };
  if (s.mode === "relax") return { verdict: "show", confidence: 1, stage: "rule", reason: "relax mode" };
  if (tile.isShort) return { verdict: "hide", confidence: 1, stage: "rule", reason: "Shorts hidden in this mode" };
  const topic = titleMentions(tile.title, topicsFor(s));
  if (topic) return { verdict: "show", confidence: 0.9, stage: "rule", reason: `title mentions '${topic}'` };
  return null;
}

export function tileText(t: VideoTile): string {
  return t.channel ? `${t.title} — ${t.channel}` : t.title;
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function askModel(backend: DecisionBackend, topics: string[], tiles: VideoTile[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const batches = await Promise.all(chunk(tiles, backend.maxBatch).map((b) => backend.decide(topics, b)));
  for (const v of batches.flat()) out.set(v.videoId, v.onIntent);
  return out;
}

function fromProb(p: number, showAt: number, stage: Draft["stage"], who: string): Draft {
  const verdict = p >= showAt ? "show" : "hide";
  return { verdict, confidence: confidenceOf(p, showAt), stage, reason: `${who} ${verdict === "show" ? "on" : "off"}-intent (p ${p.toFixed(2)})` };
}

/** 0.5 at the show threshold, rising to 1 at either end. */
function confidenceOf(p: number, showAt: number): number {
  return p >= showAt ? 0.5 + (0.5 * (p - showAt)) / (1 - showAt || 1) : 0.5 + (0.5 * (showAt - p)) / (showAt || 1);
}

export async function decideBatch(tiles: VideoTile[], deps: CascadeDeps): Promise<Decision[]> {
  const { settings: s, store, embedder, backend, fallback } = deps;
  const now = deps.now ?? Date.now;
  const modeId = modeIdFor(s);
  const decided = new Map<string, Draft>();
  const cached = new Map<string, Decision>();
  /** Fail-open results aren't cached, so they're re-decided once a model is reachable. */
  const uncacheable = new Set<string>();

  const unique = [...new Map(tiles.map((t) => [t.videoId, t])).values()];
  const m = deps.metrics;
  const t0 = performance.now();
  let mark = t0;
  /** Milliseconds since the previous lap. */
  const lap = () => {
    const t = performance.now();
    const d = t - mark;
    mark = t;
    return d;
  };

  // 0. Cache
  if (store) {
    const hits = await store.getMany(unique.map((t) => cacheKey(modeId, t.videoId))).catch(() => []);
    hits.forEach((d) => d && cached.set(d.videoId, d));
  }
  let open = unique.filter((t) => !cached.has(t.videoId));
  const msCache = lap();

  // 1. Rules
  for (const t of open) {
    const d = ruleDecision(t, s);
    if (d) decided.set(t.videoId, d);
  }
  open = open.filter((t) => !decided.has(t.videoId));

  if (!modeUsesModel(s.mode)) {
    for (const t of open) decided.set(t.videoId, { verdict: "show", confidence: 1, stage: "rule", reason: `${s.mode} mode` });
    open = [];
  }

  const topics = topicsFor(s);
  const msRules = lap();

  // 2. Embeddings
  if (embedder && open.length) {
    const { embedMarginShow, embedMarginHide } = s.thresholds;
    try {
      const scores = await embedder.score(open.map(tileText), topics);
      open.forEach((t, i) => {
        const sc = scores[i];
        if (!sc) return;
        const margin = sc.topicSim - sc.anchorSim;
        const reason = `'${sc.topic}' ${sc.topicSim.toFixed(2)} vs '${sc.anchor}' ${sc.anchorSim.toFixed(2)}`;
        const confidence = Math.min(1, 0.75 + Math.abs(margin));
        if (margin >= embedMarginShow) decided.set(t.videoId, { verdict: "show", confidence, stage: "embedding", reason });
        else if (margin <= embedMarginHide) decided.set(t.videoId, { verdict: "hide", confidence, stage: "embedding", reason });
      });
    } catch (err) {
      console.warn("[bloomScroll] embedder failed:", err); // leave the tiles for the model
      if (m) (m.errors ??= []).push(`embedder: ${String((err as Error)?.message ?? err)}`);
    }
    open = open.filter((t) => !decided.has(t.videoId));
  }
  const msEmbed = lap();

  // 3. Model, 4. optional fallback for low-confidence answers
  if (open.length && deps.stages !== "fast") {
    const modelTopics = modelTopicsFor(s);
    let probs = new Map<string, number>();
    if (backend)
      probs = await askModel(backend, modelTopics, open).catch((err) => {
        console.warn("[bloomScroll] model failed:", err);
        if (m) (m.errors ??= []).push(`model: ${String((err as Error)?.message ?? err)}`);
        return probs;
      });

    const unsure = open.filter((t) => {
      const p = probs.get(t.videoId);
      return p === undefined || confidenceOf(p, s.thresholds.modelShow) < s.thresholds.modelMinConf;
    });
    let fbProbs = new Map<string, number>();
    if (fallback && unsure.length) fbProbs = await askModel(fallback, modelTopics, unsure).catch(() => fbProbs);

    for (const t of open) {
      const fp = fbProbs.get(t.videoId);
      const p = probs.get(t.videoId);
      if (fp !== undefined) decided.set(t.videoId, fromProb(fp, s.thresholds.modelShow, "fallback", fallback!.name));
      else if (p !== undefined) decided.set(t.videoId, fromProb(p, s.thresholds.modelShow, "model", backend!.name));
      else {
        decided.set(t.videoId, { verdict: "show", confidence: 0, stage: "fallback", reason: NO_MODEL_REASON });
        uncacheable.add(t.videoId);
      }
    }
  }

  const msModel = lap();

  const fresh: Decision[] = [...decided].map(([videoId, d]) => ({ videoId, ...d, modeId, decidedAt: now() }));
  if (store) await store.putMany(fresh.filter((d) => !uncacheable.has(d.videoId))).catch(() => {});

  const byId = new Map<string, Decision>([...cached, ...fresh.map((d) => [d.videoId, d] as const)]);
  if (m) {
    m.tiles += unique.length;
    m.cached += cached.size;
    for (const d of fresh) {
      if (uncacheable.has(d.videoId)) m.failOpen++;
      else m[d.stage]++;
    }
    m.deferred += deps.stages === "fast" ? open.length : 0;
    m.ms.cache += msCache;
    m.ms.rules += msRules;
    m.ms.embed += msEmbed;
    m.ms.model += msModel;
    m.ms.total += performance.now() - t0;
    m.backend ??= backend?.name;
  }
  return unique.flatMap((t) => byId.get(t.videoId) ?? []); // "fast" leaves model-bound tiles out
}
