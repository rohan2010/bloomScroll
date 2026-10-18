import type { LayaControlRequest, LayaControlResponse, LayaControlState } from "../shared/messages";
import type { Settings } from "../shared/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const POLL_MS = 3000;
/** The first start loads the model: give it up to two minutes before calling it stuck. */
const START_TIMEOUT_MS = 120_000;

async function send(action: LayaControlRequest["action"], enabled?: boolean): Promise<LayaControlResponse> {
  const msg: LayaControlRequest = { type: "laya-control", action, enabled };
  try {
    return (await chrome.runtime.sendMessage(msg)) as LayaControlResponse;
  } catch (err) {
    return { error: "failed", detail: String(err) };
  }
}

/** The "Local AI" box in Settings: status, Start/Stop, start at login. Shown for the Local Laya backend. */
export function setupLayaControl(getSettings: () => Settings): { refresh: () => void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  let startingSince = 0;
  let busy = false;

  function render(r: LayaControlResponse): void {
    const dot = $("laya-dot");
    const text = $("laya-text");
    const hint = $("laya-hint");
    const toggle = $<HTMLButtonElement>("laya-toggle");
    const autostartRow = $("laya-autostart-row");
    if ("error" in r) {
      dot.className = "dot";
      toggle.hidden = autostartRow.hidden = true;
      if (r.error === "not-installed" || r.error === "not-configured") {
        text.textContent = "Local AI controls aren't set up on this computer";
        hint.textContent = "Run bash setup.sh in the bloomScroll folder once (it installs Laya and these controls), then reopen Settings.";
      } else {
        text.textContent = "Couldn't reach the local AI controls";
        hint.textContent = r.detail ? `Details: ${r.detail}` : "";
      }
      return;
    }
    const s: LayaControlState = r;
    toggle.hidden = autostartRow.hidden = false;
    $<HTMLInputElement>("laya-autostart").checked = s.autostart;
    const starting = !s.running && (s.starting || (startingSince > 0 && Date.now() - startingSince < START_TIMEOUT_MS));
    if (s.running) startingSince = 0;
    dot.className = `dot ${s.running ? "on" : starting ? "busy" : ""}`;
    text.textContent = s.running ? "Local AI (Laya) is running" : starting ? "Starting the local AI…" : "Local AI (Laya) is stopped";
    toggle.textContent = s.running ? "Stop" : starting ? "Starting…" : "Start";
    toggle.disabled = busy || starting;
    hint.textContent = s.running
      ? "Stopping frees its memory. Until you start it again, bloomScroll filters with its built-in model."
      : starting
        ? "Loading the model; the first start can take up to a minute."
        : s.autostart
          ? "It will start again the next time you log in, or press Start."
          : "Press Start to use it now. Switch on start-at-login to have it ready every time.";
  }

  async function refresh(): Promise<void> {
    const visible = getSettings().backend.kind === "laya";
    $("laya-control").hidden = !visible;
    clearInterval(timer);
    if (!visible) return;
    render(await send("status"));
    timer = setInterval(async () => render(await send("status")), POLL_MS);
  }

  /** Shows the whole box in its in-between state while the helper works, not just the heading. */
  function renderBusy(stopping: boolean): void {
    $("laya-dot").className = "dot busy";
    $("laya-text").textContent = stopping ? "Stopping the local AI…" : "Starting the local AI…";
    const toggle = $<HTMLButtonElement>("laya-toggle");
    toggle.textContent = stopping ? "Stopping…" : "Starting…";
    toggle.disabled = true;
    $("laya-hint").textContent = stopping ? "Freeing its memory." : "Loading the model; the first start can take up to a minute.";
  }

  $("laya-toggle").addEventListener("click", async () => {
    const stopping = $("laya-toggle").textContent === "Stop";
    busy = true;
    if (!stopping) startingSince = Date.now();
    renderBusy(stopping);
    const r = await send(stopping ? "stop" : "start");
    busy = false;
    render(r);
  });

  $<HTMLInputElement>("laya-autostart").addEventListener("change", async (e) => {
    render(await send("set-autostart", (e.target as HTMLInputElement).checked));
  });

  return { refresh: () => void refresh() };
}
