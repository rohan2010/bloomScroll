import type { Decision, VideoTile } from "../shared/types";
import { STAGE_LABEL, createOverlayHost, el } from "./overlay";

export type HiddenEntry = { tile: VideoTile; decision: Decision };

const CSS = `
.wrap { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.toggle {
  display: inline-flex; align-items: center; gap: 8px; border: 0; border-radius: 999px; padding: 8px 14px 8px 10px;
  background: var(--accent); color: var(--accent-fg); font-weight: 600; box-shadow: var(--shadow);
  transition: transform 120ms ease;
}
.toggle:hover { transform: translateY(-1px); }
.toggle svg { width: 16px; height: 16px; }
.count { min-width: 18px; text-align: center; }
.panel { width: 380px; max-height: 62vh; display: flex; flex-direction: column; overflow: hidden; transform-origin: bottom right; animation: pop 160ms ease; }
.panel[hidden] { display: none; }
@keyframes pop { from { opacity: 0; transform: scale(0.96) translateY(6px); } }
header { display: flex; justify-content: space-between; align-items: baseline; padding: 12px 14px 8px; border-bottom: 1px solid var(--line); }
header b { font-size: 13px; }
header span { color: var(--muted); }
ul { list-style: none; margin: 0; padding: 4px 0; overflow: auto; }
li { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; padding: 8px 14px; }
li + li { border-top: 1px solid var(--line); }
.title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { grid-column: 1; color: var(--muted); display: flex; gap: 6px; align-items: center; min-width: 0; }
.meta .why { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.show { grid-row: 1 / span 2; grid-column: 2; align-self: center; border: 1px solid var(--line); background: var(--chip); border-radius: 999px; padding: 4px 10px; }
.show:hover { border-color: var(--accent); color: var(--accent); }
.empty { padding: 16px 14px; color: var(--muted); }
`;

const EYE_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 5.1A9.8 9.8 0 0 1 12 5c6 0 9.5 7 9.5 7a17.6 17.6 0 0 1-3.1 4.1M6.6 6.6A17 17 0 0 0 2.5 12S6 19 12 19a9.6 9.6 0 0 0 4.4-1"/></svg>`;

/** Floating "N hidden" button, bottom right, listing filtered tiles with their reason. */
export class HiddenDrawer {
  private host: HTMLElement;
  private toggle: HTMLButtonElement;
  private count: HTMLElement;
  private panel: HTMLElement;
  private entries: HiddenEntry[] = [];

  constructor(private onShow: (entry: HiddenEntry) => void) {
    const { host, root } = createOverlayHost(
      "bloomscroll-drawer",
      CSS,
      `<div class="wrap"><div class="panel card" hidden></div><button class="toggle" aria-expanded="false">${EYE_OFF}<span class="count">0</span><span>hidden</span></button></div>`,
    );
    this.host = host;
    this.toggle = root.querySelector(".toggle")!;
    this.count = root.querySelector(".count")!;
    this.panel = root.querySelector(".panel")!;
    this.toggle.addEventListener("click", () => {
      this.panel.hidden = !this.panel.hidden;
      this.toggle.setAttribute("aria-expanded", String(!this.panel.hidden));
      if (!this.panel.hidden) this.render();
    });
  }

  mount(): void {
    if (!this.host.isConnected) document.documentElement.appendChild(this.host);
  }

  setVisible(visible: boolean): void {
    this.host.style.display = visible ? "" : "none";
  }

  update(entries: HiddenEntry[]): void {
    this.entries = entries;
    this.count.textContent = String(entries.length);
    if (!this.panel.hidden) this.render();
  }

  private render(): void {
    const header = el("header");
    header.append(el("b", "", "Hidden on this page"), el("span", "", `${this.entries.length} video${this.entries.length === 1 ? "" : "s"}`));
    if (!this.entries.length) {
      this.panel.replaceChildren(header, el("div", "empty", "Nothing hidden yet."));
      return;
    }
    const ul = el("ul");
    for (const entry of this.entries) {
      const li = el("li");
      const title = el("div", "title", entry.tile.title);
      title.title = entry.tile.title;
      const meta = el("div", "meta");
      meta.append(el("span", `stage ${entry.decision.stage}`, STAGE_LABEL[entry.decision.stage]), el("span", "why", `${entry.tile.channel || "unknown channel"} · ${entry.decision.reason}`));
      const show = el("button", "show", "Show");
      show.title = "Show this video and remember that it's on-intent";
      show.addEventListener("click", () => this.onShow(entry));
      li.append(title, meta, show);
      ul.append(li);
    }
    this.panel.replaceChildren(header, ul);
  }
}
