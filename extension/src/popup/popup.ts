import type { StatsResponse } from "../shared/messages";
import type { Mode } from "../shared/types";
import { loadSettings, modeUsesModel, updateSettings } from "../shared/settings";

const HINTS: Record<Mode, string> = {
  work: "Tech topics and allowlisted channels only. Shorts hidden.",
  learn: "Tech plus your own topics. Shorts hidden.",
  relax: "Everything except blocklisted channels.",
  off: "No filtering, UI cleanup only.",
};

const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-mode]")];

function renderMode(mode: Mode): void {
  for (const b of buttons) b.setAttribute("aria-checked", String(b.dataset.mode === mode));
  document.getElementById("mode-hint")!.textContent = HINTS[mode];
}

async function renderStats(): Promise<void> {
  const box = document.getElementById("stats")!;
  const warning = document.getElementById("warning")!;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let stats: StatsResponse | undefined;
  try {
    if (tab?.id !== undefined) stats = await chrome.tabs.sendMessage(tab.id, { type: "stats" });
  } catch {
    // Not a YouTube tab, or the page was open before the extension loaded.
  }
  if (!stats) {
    box.innerHTML = `<div class="note">Open YouTube to see what's filtered.</div>`;
    warning.hidden = true;
    return;
  }
  if (!stats.surface || stats.mode === "off") {
    box.innerHTML = `<div class="note">${stats.mode === "off" ? "Filtering is off." : "This page isn't filtered (home, search and watch pages are)."}</div>`;
    warning.hidden = true;
    return;
  }
  box.innerHTML = `
    <div><b>${stats.found}</b><span>tiles</span></div>
    <div><b>${stats.hidden}</b><span>hidden</span></div>
    <div><b>${stats.pending}</b><span>pending</span></div>`;
  warning.hidden = stats.found > 0;
  warning.textContent = "0 tiles found on this page. YouTube may have changed its layout. Please open a \"selector broke\" issue.";
}

/** Shows whether the model backend is reachable, since without it only rules filter. */
async function renderBackend(): Promise<void> {
  const el = document.getElementById("backend")!;
  const s = await loadSettings();
  const set = (text: string, bad: boolean) => {
    el.textContent = text;
    el.classList.toggle("bad", bad);
  };
  if (!modeUsesModel(s.mode)) return set("", false);
  let origin: string;
  try {
    origin = new URL(s.backend.url).origin;
  } catch {
    return set("Model: backend URL is invalid. Fix it in Settings.", true);
  }
  if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) {
    return set("Model: not allowed yet. Open Settings and click Save, then Allow.", true);
  }
  if (s.backend.kind === "jev") return set(`Model: Jev at ${origin}`, false);
  try {
    const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(String(res.status));
    set(`Model: ${s.backend.kind} connected (${origin})`, false);
  } catch {
    set(`Model: not running at ${origin}. Start it with server/start.sh. Until then only rules filter.`, true);
  }
}

for (const b of buttons) {
  b.addEventListener("click", async () => {
    const mode = b.dataset.mode as Mode;
    renderMode(mode);
    await updateSettings({ mode });
    setTimeout(renderStats, 400);
    renderBackend();
  });
}

document.getElementById("options")!.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

loadSettings().then((s) => renderMode(s.mode));
renderStats();
renderBackend();
