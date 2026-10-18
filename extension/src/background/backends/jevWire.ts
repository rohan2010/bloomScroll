// Client for the Jev wire API (POST /v1/systemone), shared by Laya, OpenJev-style servers and Jev.
// Shapes verified against laya-serve 0.4.11:
//   request   questions: { [id]: { type: "choice", instructions, criteria: { label: description } } }
//   response  answers:   { [id]: { type: "choice", choice, probabilities: { label: p }, confidence } }
//   batch     POST /v1/systemone/batch { states: [...], questions } → { results: [{ answers }] }
// Hosted Jev (api.typesafe.ai, model "jev-latest", Bearer key) uses the same shapes but has no batch
// route, so it gets one small request per video, sent in parallel.

import type { VideoTile } from "../../shared/types";
import type { DecisionBackend, ModelVerdict } from "./types";

export const ON = "on-intent";
const INTENT_Q = "intent";

export type ChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };
export type SystemOneRequest = { model: string; state: string; questions: Record<string, ChoiceQuestion> };
export type SystemOneBatchRequest = { model: string; states: string[]; questions: Record<string, ChoiceQuestion> };

/**
 * Common off-intent categories. Giving off-topic videos somewhere better to go than a single
 * "other" label made Laya rank every on-topic title above every off-topic one in a 40-title eval.
 * Kept under 11 options: the English checkpoint's temperatures are uncalibrated from 11 up.
 */
export const DISTRACTORS: Record<string, string> = {
  gaming: "video games and gameplay",
  music: "music and concerts",
  food: "cooking and food",
  sports: "sports and fitness",
  comedy: "comedy, pranks, memes and reactions",
  news: "news, politics and celebrities",
  lifestyle: "vlogs, travel and lifestyle",
  gadgets: "consumer gadget reviews and unboxing",
};

/** Bump when the prompt changes, so cached decisions from the old prompt are dropped. */
export const PROMPT_VERSION = 2;

/** on-intent plus every distractor that doesn't overlap a user topic (a "cooking" topic drops "food"). */
export function intentCriteria(topics: string[]): Record<string, string> {
  const words = topics.flatMap((t) => t.toLowerCase().split(/[^\p{L}\p{N}+#]+/u)).filter((w) => w.length >= 4);
  const overlaps = (label: string, desc: string) => {
    const text = `${label} ${desc}`.toLowerCase();
    return words.some((w) => text.includes(w) || w.includes(label));
  };
  const kept = Object.entries(DISTRACTORS).filter(([label, desc]) => !overlaps(label, desc));
  return { [ON]: topics.join(", "), ...Object.fromEntries(kept) };
}

export function tileState(t: VideoTile): string {
  return `YouTube video. Title: ${t.title}. Channel: ${t.channel || "unknown"}.`;
}

/**
 * One state per video and one shared question. Laya judges the state against the question, so this
 * separates on/off-intent titles far better than putting each title in its own question.
 */
function intentQuestions(topics: string[]): Record<string, ChoiceQuestion> {
  return { [INTENT_Q]: { type: "choice", instructions: "What is this YouTube video mainly about?", criteria: intentCriteria(topics) } };
}

export function buildBatchRequest(model: string, topics: string[], tiles: VideoTile[]): SystemOneBatchRequest {
  return { model, states: tiles.map(tileState), questions: intentQuestions(topics) };
}

/** Single-route form: the same framing as the batch, for one video. */
export function buildSystemOneRequest(model: string, topics: string[], tile: VideoTile): SystemOneRequest {
  return { model, state: tileState(tile), questions: intentQuestions(topics) };
}

type Json = Record<string, unknown>;

function asObj(v: unknown): Json | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;
}

/** P(on-intent) from one choice answer, normalized over all its options. */
export function onIntentProb(answer: unknown): number | undefined {
  const probs = asObj(asObj(answer)?.probabilities);
  const on = probs?.[ON];
  if (!probs || typeof on !== "number") return undefined;
  const total = Object.values(probs).reduce<number>((acc, v) => acc + (typeof v === "number" ? v : 0), 0);
  return total > 0 ? on / total : undefined;
}

export function parseSystemOneResponse(json: unknown, tile: VideoTile): ModelVerdict | undefined {
  const answers = asObj(asObj(json)?.answers);
  if (!answers) throw new Error("systemone: response has no answers object");
  const p = onIntentProb(answers[INTENT_Q]);
  return p === undefined ? undefined : { videoId: tile.videoId, onIntent: p };
}

export function parseBatchResponse(json: unknown, tiles: VideoTile[]): ModelVerdict[] {
  const results = asObj(json)?.results;
  if (!Array.isArray(results)) throw new Error("systemone/batch: response has no results array");
  if (results.length !== tiles.length) throw new Error(`systemone/batch: ${results.length} results for ${tiles.length} states`);
  const out: ModelVerdict[] = [];
  results.forEach((r, i) => {
    const p = onIntentProb(asObj(asObj(r)?.answers)?.[INTENT_Q]);
    if (p !== undefined) out.push({ videoId: tiles[i].videoId, onIntent: p });
  });
  return out;
}

export type JevWireOptions = {
  name: string;
  baseUrl: string;
  model: string;
  /** Use /v1/systemone/batch (laya-serve has it, hosted Jev doesn't). */
  batchRoute?: boolean;
  /** Parallel single-route requests per decide() when there's no batch route. */
  concurrency?: number;
  apiKey?: string;
  timeoutMs?: number;
  maxBatch?: number;
  fetchImpl?: typeof fetch;
};

export function createJevWireBackend(opts: JevWireOptions): DecisionBackend {
  const base = opts.baseUrl.replace(/\/+$/, "") + "/v1/systemone";
  const doFetch = opts.fetchImpl ?? fetch.bind(globalThis);
  return {
    name: opts.name,
    maxBatch: opts.maxBatch ?? 40,
    async decide(topics, tiles, signal) {
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
      const post = async (url: string, body: unknown): Promise<unknown> => {
        const res = await doFetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!res.ok) throw new Error(`${opts.name}: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
        return res.json();
      };

      if (opts.batchRoute) return parseBatchResponse(await post(`${base}/batch`, buildBatchRequest(opts.model, topics, tiles)), tiles);

      // One request per video, a few at a time. Partial failures leave those tiles to the cascade's
      // fail-open path; if every request fails (bad key, rate limit), surface the error.
      const results: PromiseSettledResult<ModelVerdict | undefined>[] = [];
      const limit = opts.concurrency ?? 8;
      for (let i = 0; i < tiles.length; i += limit) {
        const group = tiles.slice(i, i + limit);
        results.push(...(await Promise.allSettled(group.map(async (t) => parseSystemOneResponse(await post(base, buildSystemOneRequest(opts.model, topics, t)), t)))));
      }
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed.length === results.length && failed.length) throw failed[0].reason;
      return results.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
    },
  };
}
