import {
  NO_MODEL_REASON,
  USER_HIDDEN,
  USER_SHOWN,
  type BackendStatus,
  type DecideRequest,
  type DecideResponse,
  type LabelRequest,
  type StatsResponse,
  type StatusRequest,
  type BadgeRequest,
  type WarmRequest,
} from "../shared/messages";
import type { Decision, Settings, VideoTile } from "../shared/types";
import { decisionKey, loadSettings, modeUsesModel, onSettingsChanged } from "../shared/settings";
import { DebugPanel } from "./debug";
import { HiddenDrawer, type HiddenEntry } from "./drawer";
import { HideButton } from "./feedback";
import { extractTiles, surfaceFor } from "./extract";
import { animationsOn, applyUiToggles, applyVerdict, clearTile, injectStyles, isHidden, markPending } from "./hide";
import { PagePerf, type Phase } from "./perf";

const DEBOUNCE_MS = 150;
/** How long to wait before re-asking about tiles shown only because no model answered. */
const RETRY_MS = 20_000;
/**
 * Tiles per model request. A local model costs ~400 ms per tile whatever the batch size, so small
 * batches only make answers land sooner; the queue is re-sorted by viewport before each one.
 */
const MODEL_CHUNK = 4;
const DEBUG_RENDER_MS = 250;
const STATUS_POLL_MS = 10_000;

type Tracked = { tile: VideoTile; decision?: Decision; seenAt: number };

let settings: Settings;
const tracked = new Map<Element, Tracked>();
let lastFound: Element[] = [];
/** Videos the user chose to show from the drawer, for the rest of this page session. */
const overrides = new Set<string>();
/** Videos whose decide request itself failed (e.g. service worker error). */
const failed = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
/** Tiles the fast stage couldn't decide, waiting for the model. Keyed by videoId. */
const modelQueue = new Map<string, VideoTile>();
let pumping = false;
/** Bumped on reset, so a model answer for an abandoned page or old settings is dropped. */
let generation = 0;

const perf = new PagePerf();
const drawer = new HiddenDrawer(showAnyway);
const debug = new DebugPanel();
const hideButton = new HideButton(hideByUser);
let backendStatus: BackendStatus | undefined;
let debugTimer: ReturnType<typeof setTimeout> | undefined;
let debugTicker: ReturnType<typeof setInterval> | undefined;
let statusPoller: ReturnType<typeof setInterval> | undefined;

let observer: MutationObserver | undefined;
let orphaned = false;
let removeListeners: (() => void) | undefined;

/**
 * Reloading or updating the extension leaves this script running in already-open tabs, cut off from
 * the extension ("Extension context invalidated"). Stop quietly instead of retrying forever; the next
 * page load gets a fresh script.
 */
function contextAlive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function shutDown(): void {
  if (orphaned) return;
  orphaned = true;
  observer?.disconnect();
  clearTimeout(timer);
  clearTimeout(retryTimer);
  clearTimeout(debugTimer);
  clearInterval(debugTicker);
  clearInterval(statusPoller);
  removeListeners?.();
  generation++;
  modelQueue.clear();
  // Leave the page usable: nothing stays faded, and hidden tiles stay hidden until the next reload.
  for (const el of tracked.keys()) if (el.getAttribute("data-bloom") === "pending") applyVerdict(el, { verdict: "show" });
  drawer.setVisible(false);
  debug.setVisible(false);
  hideButton.remove();
  console.info("[bloomScroll] extension was reloaded; reload this tab to filter again.");
}

function scheduleScan(): void {
  if (orphaned) return;
  if (!contextAlive()) return shutDown();
  clearTimeout(timer);
  timer = setTimeout(scan, DEBOUNCE_MS);
}

function resetAll(): void {
  generation++;
  modelQueue.clear();
  for (const el of tracked.keys()) clearTile(el);
  tracked.clear();
  lastFound = [];
  perf.reset();
  renderDebugSoon();
}

async function scan(): Promise<void> {
  const surface = surfaceFor(location.pathname);
  if (!surface || settings.mode === "off") {
    if (tracked.size) resetAll();
    drawer.setVisible(false);
    updateBadge(0);
    renderDebugSoon();
    return;
  }
  drawer.mount();
  drawer.setVisible(true);

  const found = extractTiles(document, surface);
  lastFound = found.map((f) => f.el);
  const batch = new Map<string, VideoTile>();
  const now = performance.now();
  for (const { el, tile } of found) {
    if (el.getAttribute("data-bloom-id") === tile.videoId) continue; // already handled; YouTube recycles nodes
    el.setAttribute("data-bloom-id", tile.videoId);
    tracked.set(el, { tile, seenAt: now });
    if (overrides.has(tile.videoId)) {
      applyVerdict(el, { verdict: "show" });
      continue;
    }
    markPending(el);
    batch.set(tile.videoId, tile);
  }
  refreshDrawer();
  if (!batch.size) return checkSettled();
  perf.sawTile(now);

  // Phase 1: cache, rules and embeddings, in milliseconds, for every new tile at once.
  const gen = generation;
  const tiles = [...batch.values()];
  const fast = await requestDecisions(tiles, "fast");
  if (!fast || gen !== generation) return;
  applyDecisions(fast, "fast");
  // Phase 2: whatever is left goes to the model, nearest the viewport first.
  for (const t of tiles) if (!fast.decisions.has(t.videoId)) modelQueue.set(t.videoId, t);
  pump();
  checkSettled();
}

type Answer = { decisions: Map<string, Decision>; startedWall: number };

function applyDecisions({ decisions, startedWall }: Answer, phase: Phase): void {
  const animate = animationsOn(settings);
  for (const [el, t] of tracked) {
    const d = decisions.get(t.tile.videoId);
    if (!d || el.getAttribute("data-bloom-id") !== t.tile.videoId) continue;
    // A correction made while this answer was in flight wins over it.
    if (t.decision && (t.decision.reason === USER_HIDDEN || t.decision.reason === USER_SHOWN) && d.reason !== t.decision.reason) continue;
    const first = !t.decision;
    t.decision = d;
    applyVerdict(el, overrides.has(d.videoId) ? { verdict: "show" } : d, animate);
    if (first) perf.recordDecision(t.tile, d, t.seenAt, d.decidedAt < startedWall, phase);
  }
  refreshDrawer();
}

/** Distance of a tile from the visible area: 0 on screen, else pixels away (above counts double). */
function viewportDistance(videoId: string): number {
  let best = Infinity;
  for (const [el, t] of tracked) {
    if (t.tile.videoId !== videoId || !el.isConnected) continue;
    const r = el.getBoundingClientRect();
    const d = r.bottom < 0 ? -r.bottom * 2 : r.top > innerHeight ? r.top - innerHeight : 0;
    best = Math.min(best, d);
  }
  return best;
}

/** Works through the model queue one small batch at a time, re-prioritising as the user scrolls. */
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  const gen = generation;
  try {
    while (modelQueue.size && gen === generation) {
      const ranked = [...modelQueue.values()].map((t) => [viewportDistance(t.videoId), t] as const).sort((a, b) => a[0] - b[0]);
      for (const [dist, t] of ranked) if (dist === Infinity) modelQueue.delete(t.videoId); // tile left the page
      const next = ranked.filter(([dist]) => dist !== Infinity).slice(0, MODEL_CHUNK).map(([, t]) => t);
      if (!next.length) break;
      for (const t of next) modelQueue.delete(t.videoId);
      renderDebugSoon();
      const answer = await requestDecisions(next, "all");
      if (gen !== generation) break;
      if (answer) applyDecisions(answer, "model");
    }
  } finally {
    pumping = false;
  }
  if (gen === generation) {
    scheduleRetry();
    checkSettled();
  } else if (modelQueue.size) pump(); // a newer page queued work while the old pump was finishing
}

/** Records the moment nothing on the page is waiting for a verdict. */
function checkSettled(): void {
  if (pumping || modelQueue.size) return renderDebugSoon();
  if (lastFound.some((el) => el.getAttribute("data-bloom") === "pending")) return renderDebugSoon();
  perf.markSettled();
  renderDebugSoon();
}

/** Tiles shown only because no model answered get re-asked later, so starting the server fixes the page. */
function scheduleRetry(): void {
  if (retryTimer || orphaned) return;
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

/** null when the request itself failed; those tiles are shown (fail open) and retried later. */
async function requestDecisions(tiles: VideoTile[], stages: "fast" | "all"): Promise<Answer | null> {
  const msg: DecideRequest = { type: "decide", tiles, stages };
  const startedWall = Date.now();
  const t0 = performance.now();
  let res: DecideResponse | undefined;
  try {
    res = await chrome.runtime.sendMessage(msg);
  } catch (err) {
    res = { error: String(err) }; // e.g. extension reloaded under an open tab
  }
  if (!res || "error" in res) {
    if (!contextAlive() || /context invalidated/i.test(res?.error ?? "")) {
      shutDown();
      return null;
    }
    console.warn("[bloomScroll] decide failed, showing tiles:", res?.error);
    for (const tile of tiles) failed.add(tile.videoId);
    // Fail open: never leave the feed stuck faded.
    for (const tile of tiles) for (const [el, t] of tracked) if (t.tile.videoId === tile.videoId) applyVerdict(el, { verdict: "show" });
    scheduleRetry();
    return null;
  }
  perf.recordCall({ phase: stages === "fast" ? "fast" : "model", tiles: tiles.length, roundTripMs: performance.now() - t0, metrics: res.metrics });
  return { decisions: new Map(res.decisions.map((d) => [d.videoId, d])), startedWall };
}

function hiddenEntries(): HiddenEntry[] {
  const out: HiddenEntry[] = [];
  for (const el of lastFound) {
    const t = tracked.get(el);
    if (t?.decision && isHidden(el)) out.push({ tile: t.tile, decision: t.decision });
  }
  return out;
}

function counts() {
  let pending = 0;
  let hidden = 0;
  for (const el of lastFound) {
    const state = el.getAttribute("data-bloom");
    if (state === "pending") pending++;
    else if (state === "hide") hidden++;
  }
  return { found: lastFound.length, shown: lastFound.length - pending - hidden, hidden, pending, queue: modelQueue.size };
}

let lastBadge = -1;

function refreshDrawer(): void {
  for (const el of tracked.keys()) if (!el.isConnected) tracked.delete(el);
  const hidden = hiddenEntries();
  drawer.update(hidden);
  updateBadge(hidden.length);
  renderDebugSoon();
}

/** Hidden count on the toolbar icon for this tab; only sent when it changes. */
function updateBadge(count: number): void {
  if (count === lastBadge || orphaned || !contextAlive()) return;
  lastBadge = count;
  chrome.runtime.sendMessage({ type: "badge", count } satisfies BadgeRequest).catch(() => {});
}

/** Applies and stores a correction. Stored labels win over every stage on later visits too. */
function correct(tile: VideoTile, verdict: Decision["verdict"]): void {
  const d: Decision = {
    videoId: tile.videoId,
    verdict,
    confidence: 1,
    stage: "rule",
    reason: verdict === "show" ? USER_SHOWN : USER_HIDDEN,
    modeId: "",
    decidedAt: Date.now(),
  };
  if (verdict === "show") overrides.add(tile.videoId);
  else overrides.delete(tile.videoId);
  for (const [el, t] of tracked) {
    if (t.tile.videoId !== tile.videoId) continue;
    t.decision = d;
    applyVerdict(el, d, animationsOn(settings));
  }
  refreshDrawer();
  const msg: LabelRequest = {
    type: "label",
    label: { videoId: tile.videoId, title: tile.title, channel: tile.channel, userVerdict: verdict, at: Date.now() },
  };
  if (!contextAlive()) return shutDown();
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function showAnyway({ tile }: HiddenEntry): void {
  correct(tile, "show");
}

function hideByUser(el: Element): void {
  const t = tracked.get(el);
  if (t) correct(t.tile, "hide");
}

// Hover tracking for the Hide button works by position, not by which element is under the pointer:
// YouTube's inline preview player sits on top of a hovered thumbnail but lives elsewhere in the
// DOM, so element-based hover lost the tile (and hid the button) as soon as the preview appeared.

let pointer: { x: number; y: number } | undefined;
let hoverFrame = 0;

function inside(r: DOMRect, x: number, y: number): boolean {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** The kept tile whose box contains the point, preferring the current one. */
function keptTileAt(x: number, y: number): Element | undefined {
  const current = hideButton.current;
  if (current?.isConnected && current.getAttribute("data-bloom") === "show" && inside(current.getBoundingClientRect(), x, y)) return current;
  for (const el of lastFound) {
    if (el.getAttribute("data-bloom") !== "show" || !el.isConnected) continue;
    if (inside(el.getBoundingClientRect(), x, y)) return el;
  }
  return undefined;
}

function updateHover(): void {
  hoverFrame = 0;
  if (orphaned || !pointer) return;
  const filtering = surfaceFor(location.pathname) !== null && settings.mode !== "off";
  if (!filtering) return hideButton.hide();
  // On the button itself: keep it, even if a scroll moved the tile out from under it.
  if (hideButton.current && hideButton.contains(pointer.x, pointer.y)) return;
  const tile = keptTileAt(pointer.x, pointer.y);
  if (tile) hideButton.showFor(tile); // also repositions after a scroll
  else hideButton.hide();
}

function scheduleHover(): void {
  if (!hoverFrame) hoverFrame = requestAnimationFrame(updateHover);
}

function onPointerMove(e: PointerEvent): void {
  if (e.pointerType === "touch") return;
  pointer = { x: e.clientX, y: e.clientY };
  scheduleHover();
}

function onPointerLeavePage(): void {
  pointer = undefined;
  hideButton.hide();
}

// ---------------------------------------------------------------------------------------- debug overlay

function renderDebugSoon(): void {
  if (!settings?.debug || debugTimer) return;
  debugTimer = setTimeout(() => {
    debugTimer = undefined;
    debug.render({ perf, counts: counts(), mode: settings.mode, status: backendStatus });
  }, DEBUG_RENDER_MS);
}

async function pollStatus(): Promise<void> {
  if (!contextAlive()) return shutDown();
  try {
    backendStatus = await chrome.runtime.sendMessage({ type: "status" } satisfies StatusRequest);
  } catch {
    backendStatus = undefined;
  }
  renderDebugSoon();
}

function syncDebug(): void {
  debug.setVisible(settings.debug);
  clearInterval(debugTicker);
  clearInterval(statusPoller);
  if (!settings.debug) return;
  // Keep the elapsed clock moving while the page is still classifying.
  debugTicker = setInterval(() => perf.settledAt === undefined && perf.firstSeenAt !== undefined && renderDebugSoon(), 500);
  statusPoller = setInterval(pollStatus, STATUS_POLL_MS);
  pollStatus();
  renderDebugSoon();
}

// ---------------------------------------------------------------------------------------- wiring

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "stats") return;
  const c = counts();
  const stats: StatsResponse = { surface: surfaceFor(location.pathname), ...c, mode: settings.mode, timing: perf.summary() };
  sendResponse(stats);
});

async function main(): Promise<void> {
  settings = await loadSettings();
  injectStyles();
  applyUiToggles(settings);
  syncDebug();

  onSettingsChanged((next) => {
    const reclassify = decisionKey(next) !== decisionKey(settings);
    settings = next;
    applyUiToggles(settings);
    syncDebug();
    // Visual settings (debug, animations, cleanup toggles) keep the page's decisions.
    if (reclassify) {
      resetAll();
      scheduleScan();
    }
  });

  // Wake a paged-out local model while YouTube is still rendering (throttled in the worker).
  const warm = () => {
    if (!contextAlive()) return shutDown();
    if (modeUsesModel(settings.mode)) chrome.runtime.sendMessage({ type: "warm" } satisfies WarmRequest).catch(() => {});
  };
  // YouTube is a single-page app: re-scan, and restart the page timer, after each in-app navigation.
  const navigated = () => {
    perf.reset();
    scheduleScan();
  };
  warm();
  document.addEventListener("yt-navigate-start", warm);
  document.addEventListener("yt-navigate-finish", navigated);
  removeListeners = () => {
    document.removeEventListener("yt-navigate-start", warm);
    document.removeEventListener("yt-navigate-finish", navigated);
  };

  // Hide button: follows the pointer by position, and the tile when the page scrolls.
  document.addEventListener("pointermove", onPointerMove, { passive: true });
  document.documentElement.addEventListener("pointerleave", onPointerLeavePage, { passive: true });
  addEventListener("scroll", scheduleHover, { passive: true });
  const removeNav = removeListeners;
  removeListeners = () => {
    removeNav?.();
    document.removeEventListener("pointermove", onPointerMove);
    document.documentElement.removeEventListener("pointerleave", onPointerLeavePage);
    removeEventListener("scroll", scheduleHover);
    cancelAnimationFrame(hoverFrame);
  };

  observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["href"],
  });
  scheduleScan();
}

main();
