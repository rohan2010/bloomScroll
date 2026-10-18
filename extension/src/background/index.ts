import { emptyMetrics, type BackendStatus, type BackgroundMessage, type CascadeMetrics, type DecideResponse } from "../shared/messages";
import { loadSettings, modeUsesModel, topicsFor } from "../shared/settings";
import { backendFromSettings } from "./backends";
import { IdbCache } from "./cache";
import { OffscreenEmbedder } from "./embedder";
import { cacheKey, decideBatch, modeIdFor } from "./cascade";
import type { Decision, Settings, VideoTile } from "../shared/types";

const cache = new IdbCache();
const embedder = new OffscreenEmbedder();

/** Decisions being computed, so a tile asked about twice (retries, two tabs) costs one model call. */
const inFlight = new Map<string, Promise<Decision | undefined>>();

function depsFor(settings: Settings) {
  return { settings, store: cache, embedder, backend: backendFromSettings(settings), fallback: null }; // fallback: opt-in Jev, weekend 3
}

async function decideOnce(tiles: VideoTile[], settings: Settings, metrics?: CascadeMetrics): Promise<Decision[]> {
  const modeId = modeIdFor(settings);
  const fresh = tiles.filter((t) => !inFlight.has(cacheKey(modeId, t.videoId)));
  const run = fresh.length
    ? decideBatch(fresh, { ...depsFor(settings), metrics })
    : Promise.resolve([]);
  for (const t of fresh) {
    const key = cacheKey(modeId, t.videoId);
    const p = run.then((ds) => ds.find((d) => d.videoId === t.videoId)).finally(() => inFlight.delete(key));
    inFlight.set(key, p.catch(() => undefined));
  }
  const all = await Promise.all(tiles.map((t) => inFlight.get(cacheKey(modeId, t.videoId)) ?? run.then((ds) => ds.find((d) => d.videoId === t.videoId))));
  return all.filter((d): d is Decision => !!d);
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});

cache.prune().catch((err) => console.warn("[bloomScroll] prune failed:", err));

const WARM_EVERY_MS = 30_000;
let lastWarm = 0;

/** Throttled: page opens and SPA navigations both ask, and one wake-up covers a burst of them. */
async function warm(settings: Settings): Promise<void> {
  if (Date.now() - lastWarm < WARM_EVERY_MS || !modeUsesModel(settings.mode)) return;
  lastWarm = Date.now();
  // Load MiniLM too, so the first fast-stage call doesn't pay for it.
  await Promise.allSettled([backendFromSettings(settings)?.warm?.(), embedder.score(["warm up"], topicsFor(settings))]);
}

async function backendStatus(s: Settings): Promise<BackendStatus> {
  const kind = s.backend.kind;
  if (!modeUsesModel(s.mode)) return { kind, origin: "", state: "unused" };
  let origin: string;
  try {
    origin = new URL(s.backend.url).origin;
  } catch {
    return { kind, origin: s.backend.url, state: "invalid-url" };
  }
  if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) return { kind, origin, state: "no-permission" };
  if (kind === "jev") return { kind, origin, state: "connected" }; // no free health probe; a decide call would cost tokens
  const t0 = performance.now();
  try {
    const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2000) });
    return { kind, origin, state: res.ok ? "connected" : "down", latencyMs: performance.now() - t0 };
  } catch {
    return { kind, origin, state: "down" };
  }
}

async function handle(msg: BackgroundMessage): Promise<unknown> {
  switch (msg.type) {
    case "decide": {
      const settings = await loadSettings();
      // Fast-stage calls are cheap and never wait on the model, so they skip the in-flight dedupe
      // (which would hand back a model-stage promise and make them slow).
      const metrics = emptyMetrics();
      const decisions =
        msg.stages === "fast"
          ? await decideBatch(msg.tiles, { ...depsFor(settings), stages: "fast", metrics })
          : await decideOnce(msg.tiles, settings, metrics);
      return { decisions, metrics } satisfies DecideResponse;
    }
    case "warm":
      void warm(await loadSettings());
      return { ok: true };
    case "status":
      return backendStatus(await loadSettings());
    case "label":
      await cache.addLabel(msg.label);
      return { ok: true };
  }
}

chrome.runtime.onMessage.addListener((msg: BackgroundMessage, _sender, sendResponse) => {
  if (!["decide", "label", "warm", "status"].includes(msg?.type)) return;
  handle(msg).then(sendResponse, (err) => sendResponse({ error: String(err) }));
  return true; // async response
});
