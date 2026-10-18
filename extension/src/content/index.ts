import { NO_MODEL_REASON, type DecideRequest, type DecideResponse, type LabelRequest, type StatsResponse } from "../shared/messages";
import type { Decision, Settings, VideoTile } from "../shared/types";
import { loadSettings, onSettingsChanged } from "../shared/settings";
import { extractTiles, surfaceFor } from "./extract";
import { HIDDEN, HiddenDrawer, applyUiToggles, applyVerdict, clearTile, injectStyles, markPending, type HiddenEntry } from "./hide";

const DEBOUNCE_MS = 150;
/** How long to wait before re-asking about tiles shown only because no model answered. */
const RETRY_MS = 20_000;
/** Tiles per decide request. Small, in page order, so the top of the feed resolves first on a slow model. */
const CHUNK = 10;

type Tracked = { tile: VideoTile; decision?: Decision };

let settings: Settings;
const tracked = new Map<Element, Tracked>();
let lastFound: Element[] = [];
/** Videos the user chose to show from the drawer, for the rest of this page session. */
const overrides = new Set<string>();
/** Videos whose decide request itself failed (e.g. service worker error). */
const failed = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

const drawer = new HiddenDrawer(showAnyway);

function scheduleScan(): void {
  clearTimeout(timer);
  timer = setTimeout(scan, DEBOUNCE_MS);
}

function resetAll(): void {
  for (const el of tracked.keys()) clearTile(el);
  tracked.clear();
  lastFound = [];
}

async function scan(): Promise<void> {
  const surface = surfaceFor(location.pathname);
  if (!surface || settings.mode === "off") {
    if (tracked.size) resetAll();
    drawer.setVisible(false);
    return;
  }
  drawer.mount();
  drawer.setVisible(true);

  const found = extractTiles(document, surface);
  lastFound = found.map((f) => f.el);
  const batch = new Map<string, VideoTile>();
  for (const { el, tile } of found) {
    if (el.getAttribute("data-bloom-id") === tile.videoId) continue; // already handled; YouTube recycles nodes
    el.setAttribute("data-bloom-id", tile.videoId);
    tracked.set(el, { tile });
    if (overrides.has(tile.videoId)) {
      applyVerdict(el, { verdict: "show" });
      continue;
    }
    markPending(el);
    batch.set(tile.videoId, tile);
  }
  refreshDrawer();
  if (!batch.size) return;

  const pending = [...batch.values()];
  for (let i = 0; i < pending.length; i += CHUNK) {
    const decisions = await requestDecisions(pending.slice(i, i + CHUNK));
    for (const [el, t] of tracked) {
      const d = decisions.get(t.tile.videoId);
      if (!d || el.getAttribute("data-bloom-id") !== t.tile.videoId) continue;
      t.decision = d;
      applyVerdict(el, overrides.has(d.videoId) ? { verdict: "show" } : d);
    }
    refreshDrawer();
  }
  scheduleRetry();
}

/** Tiles shown only because no model answered get re-asked later, so starting the server fixes the page. */
function scheduleRetry(): void {
  if (retryTimer) return;
  const failedOpen = () => [...tracked].filter(([, t]) => t.decision?.reason === NO_MODEL_REASON || (!t.decision && failed.has(t.tile.videoId)));
  if (!failedOpen().length) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    for (const [el, t] of failedOpen()) {
      el.removeAttribute("data-bloom-id");
      failed.delete(t.tile.videoId);
    }
    scan();
  }, RETRY_MS);
}

async function requestDecisions(tiles: VideoTile[]): Promise<Map<string, Decision>> {
  const msg: DecideRequest = { type: "decide", tiles };
  let res: DecideResponse | undefined;
  try {
    res = await chrome.runtime.sendMessage(msg);
  } catch (err) {
    res = { error: String(err) }; // e.g. extension reloaded under an open tab
  }
  if (!res || "error" in res) {
    console.warn("[bloomScroll] decide failed, showing tiles:", res?.error);
    for (const tile of tiles) failed.add(tile.videoId);
    // Fail open: never leave the feed stuck at 15% opacity.
    for (const tile of tiles) for (const [el, t] of tracked) if (t.tile.videoId === tile.videoId) applyVerdict(el, { verdict: "show" });
    return new Map();
  }
  return new Map(res.decisions.map((d) => [d.videoId, d]));
}

function hiddenEntries(): HiddenEntry[] {
  const out: HiddenEntry[] = [];
  for (const el of lastFound) {
    const t = tracked.get(el);
    if (t?.decision && el.classList.contains(HIDDEN)) out.push({ tile: t.tile, decision: t.decision });
  }
  return out;
}

function refreshDrawer(): void {
  for (const el of tracked.keys()) if (!el.isConnected) tracked.delete(el);
  drawer.update(hiddenEntries());
}

function showAnyway({ tile }: HiddenEntry): void {
  overrides.add(tile.videoId);
  for (const [el, t] of tracked) if (t.tile.videoId === tile.videoId) applyVerdict(el, { verdict: "show" });
  refreshDrawer();
  const msg: LabelRequest = {
    type: "label",
    label: { videoId: tile.videoId, title: tile.title, channel: tile.channel, userVerdict: "show", at: Date.now() },
  };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "stats") return;
  let pending = 0;
  for (const el of lastFound) if (el.getAttribute("data-bloom") === "pending") pending++;
  const stats: StatsResponse = {
    surface: surfaceFor(location.pathname),
    found: lastFound.length,
    hidden: hiddenEntries().length,
    pending,
    mode: settings.mode,
  };
  sendResponse(stats);
});

async function main(): Promise<void> {
  settings = await loadSettings();
  injectStyles();
  applyUiToggles(settings);

  onSettingsChanged((next) => {
    settings = next;
    applyUiToggles(settings);
    resetAll();
    scheduleScan();
  });

  // YouTube is a single-page app: re-scan after each in-app navigation.
  document.addEventListener("yt-navigate-finish", scheduleScan);
  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["href"],
  });
  scheduleScan();
}

main();
