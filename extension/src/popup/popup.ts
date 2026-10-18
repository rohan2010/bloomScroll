import type { BackendStatus, StatsResponse, StatusRequest } from "../shared/messages";
import type { Mode, Settings } from "../shared/types";
import { learnUsesTech, loadSettings, modeUsesModel, onSettingsChanged, updateSettings } from "../shared/settings";

const HINTS: Record<Mode, string> = {
  work: "Tech topics and allowlisted channels only. Shorts hidden.",
  learn: "Tech plus your own topics. Shorts hidden.",
  relax: "Everything except blocklisted channels.",
  off: "No filtering, just the cleanup switches below.",
};

const MODE_NAME: Record<Mode, string> = { work: "Work", learn: "Learn", relax: "Relax", off: "Off" };

const BACKEND_NAME: Record<string, string> = { laya: "Local Laya", openjev: "Local server", jev: "Jev (TypeSafe)" };

const CLOCK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-mode]")];
const SWITCHES = ["hideShorts", "hideComments", "hideEndscreen", "animations", "debug"] as const;

function formatMs(ms: number | undefined): string {
  if (ms === undefined) return "–";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function renderSettings(s: Settings): void {
  for (const b of modeButtons) b.setAttribute("aria-checked", String(b.dataset.mode === s.mode));
  $("mode-hint").textContent =
    s.mode === "learn" ? (learnUsesTech(s) ? (s.topics.length ? "Tech plus your topics. Shorts hidden." : "Tech videos for now. Shorts hidden.") : "Only your topics. Shorts hidden.") : HINTS[s.mode];
  // First run: nothing personal set yet, so point at Settings.
  $("nudge").hidden = !(s.mode === "learn" && s.topics.length === 0);
  $("state-line").textContent = s.mode === "off" ? "Filtering paused" : `Filtering · ${MODE_NAME[s.mode]} mode`;

  for (const id of SWITCHES) $<HTMLInputElement>(id).checked = s[id];
  // Work and Learn always hide Shorts; the switch only applies to Relax and Off.
  const locked = modeUsesModel(s.mode);
  const shorts = $<HTMLInputElement>("hideShorts");
  shorts.disabled = locked;
  if (locked) shorts.checked = true;
  $("shorts-note").textContent = locked ? `Always hidden in ${MODE_NAME[s.mode]}` : "";

  $("privacy").textContent =
    s.backend.kind === "jev" && modeUsesModel(s.mode)
      ? "Unclear titles are sent to TypeSafe (Jev) with your key."
      : "Runs on this computer. Nothing leaves it.";
}

async function activeTabStats(): Promise<StatsResponse | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return undefined;
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: "stats" });
  } catch {
    return undefined; // not a YouTube tab, or the tab was open before the extension loaded
  }
}

/** What renderTab last drew, so the once-a-second refresh leaves the DOM alone when nothing changed. */
let lastTab = "";

async function renderTab(): Promise<void> {
  const body = $("tab-body");
  const stats = await activeTabStats();
  const key = JSON.stringify(stats ?? null);
  if (key === lastTab) return;
  lastTab = key;
  if (!stats) {
    body.innerHTML = `<div class="note">Open YouTube to see what's filtered here. If YouTube is already open, reload the tab.</div>`;
    return;
  }
  if (!stats.surface || stats.mode === "off") {
    body.innerHTML = `<div class="note">${stats.mode === "off" ? "Filtering is off." : "This page isn't filtered. Home, search and watch pages are."}</div>`;
    return;
  }
  const t = stats.timing;
  const timing = stats.pending || stats.queue
    ? `Classifying… ${stats.pending} left`
    : t.settledMs !== undefined
      ? `Settled in ${formatMs(t.settledMs)} · instant answers ${formatMs(t.fastP50)}${t.modelP50 !== undefined ? ` · model ${formatMs(t.modelP50)}` : ""}`
      : "Waiting for videos";
  body.innerHTML = `
    <div class="stats">
      <div class="stat"><b>${stats.shown}</b><span>shown</span></div>
      <div class="stat hidden"><b>${stats.hidden}</b><span>hidden</span></div>
      <div class="stat"><b>${stats.pending}</b><span>pending</span></div>
    </div>
    <div class="timing">${CLOCK}<span></span></div>
    ${stats.found === 0 ? `<div class="warning">No video tiles found on this page. YouTube may have changed its layout: please open a "selector broke" issue.</div>` : ""}`;
  body.querySelector(".timing span")!.textContent = timing;
}

async function renderModel(s: Settings): Promise<void> {
  const card = $("model-card");
  card.hidden = !modeUsesModel(s.mode);
  if (card.hidden) return;
  const name = BACKEND_NAME[s.backend.kind] ?? s.backend.kind;
  $("model-text").textContent = `${name}: checking…`;
  let st: BackendStatus | undefined;
  try {
    st = await chrome.runtime.sendMessage({ type: "status" } satisfies StatusRequest);
  } catch {
    st = undefined;
  }
  const dot = $("model-dot");
  const fix = $<HTMLButtonElement>("model-fix");
  const text: Record<BackendStatus["state"], string> = {
    connected: `${name} connected${st?.latencyMs !== undefined ? ` · ${Math.round(st.latencyMs)} ms` : ""}`,
    down: `${name} isn't running. Start it from Settings.`,
    "no-permission": `${name} not allowed yet.`,
    "invalid-url": `${name} URL is invalid.`,
    unused: "",
  };
  dot.className = `dot ${st?.state === "connected" ? "ok" : "bad"}`;
  $("model-text").textContent = st ? text[st.state] : `${name}: unknown`;
  // Rules and embeddings still work without a model, so say so rather than alarm.
  if (st && st.state !== "connected") $("model-text").textContent += " The built-in model still filters.";
  fix.hidden = !st || st.state === "connected";
}

async function main(): Promise<void> {
  let s = await loadSettings();
  renderSettings(s);
  renderTab();
  renderModel(s);

  for (const b of modeButtons) {
    b.addEventListener("click", async () => {
      s = await updateSettings({ mode: b.dataset.mode as Mode });
      renderSettings(s);
      renderModel(s);
      setTimeout(renderTab, 400);
    });
  }
  for (const id of SWITCHES) {
    $<HTMLInputElement>(id).addEventListener("change", async (e) => {
      s = await updateSettings({ [id]: (e.target as HTMLInputElement).checked });
      renderSettings(s);
    });
  }
  const openOptions = () => chrome.runtime.openOptionsPage();
  $("options").addEventListener("click", openOptions);
  $("model-fix").addEventListener("click", openOptions);
  $("nudge").addEventListener("click", openOptions);
  onSettingsChanged((next) => renderSettings((s = next)));

  // Keep the tab numbers live while the popup is open.
  setInterval(renderTab, 1000);
}

main();
