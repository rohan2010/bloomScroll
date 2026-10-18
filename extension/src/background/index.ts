import type { BackgroundMessage, DecideResponse } from "../shared/messages";
import { loadSettings } from "../shared/settings";
import { backendFromSettings } from "./backends";
import { IdbCache } from "./cache";
import { cacheKey, decideBatch, modeIdFor } from "./cascade";
import type { Decision, Settings, VideoTile } from "../shared/types";

const cache = new IdbCache();

/** Decisions being computed, so a tile asked about twice (retries, two tabs) costs one model call. */
const inFlight = new Map<string, Promise<Decision | undefined>>();

async function decideOnce(tiles: VideoTile[], settings: Settings): Promise<Decision[]> {
  const modeId = modeIdFor(settings);
  const fresh = tiles.filter((t) => !inFlight.has(cacheKey(modeId, t.videoId)));
  const run = fresh.length
    ? decideBatch(fresh, {
        settings,
        store: cache,
        embedder: null, // weekend 2: offscreen MiniLM
        backend: backendFromSettings(settings),
        fallback: null, // weekend 3: opt-in Jev
      })
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

async function handle(msg: BackgroundMessage): Promise<unknown> {
  switch (msg.type) {
    case "decide": {
      const settings = await loadSettings();
      const decisions = await decideOnce(msg.tiles, settings);
      return { decisions } satisfies DecideResponse;
    }
    case "label":
      await cache.addLabel(msg.label);
      return { ok: true };
  }
}

chrome.runtime.onMessage.addListener((msg: BackgroundMessage, _sender, sendResponse) => {
  if (msg?.type !== "decide" && msg?.type !== "label") return;
  handle(msg).then(sendResponse, (err) => sendResponse({ error: String(err) }));
  return true; // async response
});
