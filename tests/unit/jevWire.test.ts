import { describe, expect, it } from "vitest";
import {
  buildBatchRequest,
  buildSystemOneRequest,
  createJevWireBackend,
  intentCriteria,
  onIntentProb,
  parseBatchResponse,
  parseSystemOneResponse,
} from "../../extension/src/background/backends/jevWire";
import { TECH_TOPICS } from "../../extension/src/shared/settings";
import { DISTRACTORS } from "../../extension/src/shared/intent";
import { createLayaBackend } from "../../extension/src/background/backends/laya";
import type { VideoTile } from "../../extension/src/shared/types";

const tile = (videoId: string, title: string, channel: string): VideoTile => ({ videoId, title, channel, isShort: false, surface: "home" });
const rust = tile("dQw4w9WgXcQ", "Rust ownership in 10 minutes", "Let's Get Rusty");
const prank = tile("prank000002", "Top 10 EPIC pranks of the year", "PrankZone");

// Trimmed from a real laya-serve 0.4.11 response.
const answer = (on: number) => ({
  type: "choice",
  choice: on >= 0.5 ? "on-intent" : "gaming",
  probabilities: { "on-intent": on, gaming: (1 - on) / 2, comedy: (1 - on) / 2 },
  confidence: 0.23,
  answer_confidence: Math.max(on, 1 - on),
});

describe("requests", () => {
  it("batch: one state per video, one shared question", () => {
    const req = buildBatchRequest("english", ["Linux", "AI research"], [rust, prank]);
    expect(req.states).toEqual([
      "YouTube video. Title: Rust ownership in 10 minutes. Channel: Let's Get Rusty.",
      "YouTube video. Title: Top 10 EPIC pranks of the year. Channel: PrankZone.",
    ]);
    expect(req.questions.intent).toMatchObject({ type: "choice", criteria: { "on-intent": "Linux, AI research" } });
  });

  it("single: the video is the state, same shared question", () => {
    const req = buildSystemOneRequest("jev-latest", ["Linux"], rust);
    expect(req.state).toBe("YouTube video. Title: Rust ownership in 10 minutes. Channel: Let's Get Rusty.");
    expect(Object.keys(req.questions)).toEqual(["intent"]);
  });
});

describe("criteria", () => {
  it("keeps every distractor for the built-in tech topics, as bare labels", () => {
    const crit = intentCriteria(TECH_TOPICS);
    expect(Object.keys(crit)).toEqual(["on-intent", ...Object.keys(DISTRACTORS)]);
    expect(Object.values(crit).slice(1).every((v) => v === null)).toBe(true);
  });

  it("drops distractors that overlap a user topic", () => {
    const keys = Object.keys(intentCriteria([...TECH_TOPICS, "cooking", "music theory"]));
    expect(keys).not.toContain("food");
    expect(keys).not.toContain("music");
    expect(keys).toContain("gaming");
  });

  it("normalizes P(on-intent) over all options", () => {
    expect(onIntentProb({ probabilities: { "on-intent": 0.2, gaming: 0.2, news: 0.4 } })).toBeCloseTo(0.25);
    expect(onIntentProb({ probabilities: { gaming: 1 } })).toBeUndefined();
  });
});

describe("responses", () => {
  it("parses a single-route answer", () => {
    const json = { model: "jev-1.13.0", answers: { intent: answer(0.8) }, usage: {} };
    expect(parseSystemOneResponse(json, rust)).toEqual({ videoId: rust.videoId, onIntent: 0.8 });
  });

  it("parses batch results in state order", () => {
    const json = { results: [{ answers: { intent: answer(0.9) } }, { answers: { intent: answer(0.1) } }], total_usage: {} };
    const out = parseBatchResponse(json, [rust, prank]);
    expect(out.map((v) => v.videoId)).toEqual([rust.videoId, prank.videoId]);
    expect(out[1].onIntent).toBeCloseTo(0.1);
  });

  it("rejects malformed responses", () => {
    expect(() => parseSystemOneResponse({ detail: "bad" }, rust)).toThrow();
    expect(() => parseBatchResponse({ results: [] }, [rust])).toThrow(/0 results for 1/);
  });
});

describe("transport", () => {
  it("posts to the batch route with the key", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const backend = createJevWireBackend({
      name: "test",
      baseUrl: "https://api.example.com/",
      model: "m",
      batchRoute: true,
      apiKey: "k",
      fetchImpl: async (url, init) => {
        seen = { url: String(url), init: init! };
        return new Response(JSON.stringify({ results: [{ answers: { intent: answer(1) } }] }));
      },
    });
    expect(await backend.decide(["Linux"], [rust])).toEqual([{ videoId: rust.videoId, onIntent: 1 }]);
    expect(seen?.url).toBe("https://api.example.com/v1/systemone/batch");
    expect((seen?.init.headers as Record<string, string>).authorization).toBe("Bearer k");
  });
});

describe("jev (no batch route)", () => {
  it("sends one request per video and maps answers back", async () => {
    const urls: string[] = [];
    const backend = createJevWireBackend({
      name: "jev",
      baseUrl: "https://api.typesafe.ai",
      model: "jev-latest",
      apiKey: "k",
      fetchImpl: async (url, init) => {
        urls.push(String(url));
        const on = JSON.parse(String(init!.body)).state.includes("Rust") ? 0.9 : 0.05;
        return new Response(JSON.stringify({ answers: { intent: answer(on) } }));
      },
    });
    const out = await backend.decide(["Rust"], [rust, prank]);
    expect(urls).toEqual(["https://api.typesafe.ai/v1/systemone", "https://api.typesafe.ai/v1/systemone"]);
    expect(out.map((v) => [v.videoId, v.onIntent])).toEqual([
      [rust.videoId, 0.9],
      [prank.videoId, 0.05],
    ]);
  });

  it("throws when every request fails, e.g. a bad key", async () => {
    const backend = createJevWireBackend({
      name: "jev",
      baseUrl: "https://api.typesafe.ai",
      model: "jev-latest",
      fetchImpl: async () => new Response('{"error":"invalid api key"}', { status: 401 }),
    });
    await expect(backend.decide(["Rust"], [rust, prank])).rejects.toThrow(/HTTP 401.*invalid api key/);
  });
});

// Contract test against a running server: LAYA_URL=http://127.0.0.1:8765 pnpm test jevWire
describe.skipIf(!process.env.LAYA_URL)("live laya-serve", () => {
  it("answers in the expected shape and ranks a tech title above a prank", async () => {
    const out = await createLayaBackend(process.env.LAYA_URL!).decide(["programming", "Linux", "AI research"], [rust, prank]);
    expect(out.map((v) => v.videoId)).toEqual([rust.videoId, prank.videoId]);
    expect(out[0].onIntent).toBeGreaterThan(out[1].onIntent);
  }, 60_000);
});
