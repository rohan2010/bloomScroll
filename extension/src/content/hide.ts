import type { Decision, Settings, VideoTile } from "../shared/types";
import { effectiveHideShorts } from "../shared/settings";
import { COMMENTS_UI, ENDSCREEN_UI, SHORTS_UI } from "./selectors";

export const PENDING = "bloom-pending";
export const HIDDEN = "bloom-hidden";

const STYLE_ID = "bloomscroll-style";

function scoped(attr: string, selectors: string[]): string {
  return `${selectors.map((s) => `html[${attr}] ${s}`).join(",\n")} { display: none !important; }`;
}

export function injectStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = [
    `.${PENDING} { opacity: 0.15 !important; transition: opacity 120ms ease; }`,
    `.${HIDDEN} { display: none !important; }`,
    scoped("data-bloom-shorts", SHORTS_UI),
    scoped("data-bloom-comments", COMMENTS_UI),
    scoped("data-bloom-endscreen", ENDSCREEN_UI),
  ].join("\n");
  (doc.head ?? doc.documentElement).appendChild(style);
}

export function applyUiToggles(s: Settings, doc: Document = document): void {
  const html = doc.documentElement;
  html.toggleAttribute("data-bloom-shorts", effectiveHideShorts(s));
  html.toggleAttribute("data-bloom-comments", s.hideComments);
  html.toggleAttribute("data-bloom-endscreen", s.hideEndscreen);
}

export function markPending(el: Element): void {
  el.classList.add(PENDING);
  el.classList.remove(HIDDEN);
  el.setAttribute("data-bloom", "pending");
}

export function applyVerdict(el: Element, d: Pick<Decision, "verdict">): void {
  el.classList.remove(PENDING);
  el.classList.toggle(HIDDEN, d.verdict === "hide");
  el.setAttribute("data-bloom", d.verdict);
}

/** Return a tile to YouTube's own rendering. Never removes the node: YouTube recycles them. */
export function clearTile(el: Element): void {
  el.classList.remove(PENDING, HIDDEN);
  el.removeAttribute("data-bloom");
  el.removeAttribute("data-bloom-id");
}

export type HiddenEntry = { tile: VideoTile; decision: Decision };

const DRAWER_CSS = `
:host { all: initial; }
.wrap { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; font: 13px/1.4 system-ui, sans-serif; color: #e8e8e8; }
button { font: inherit; cursor: pointer; }
.toggle { background: #1f6f43; color: #fff; border: 0; border-radius: 999px; padding: 8px 14px; box-shadow: 0 2px 8px rgba(0,0,0,.35); }
.panel { position: absolute; right: 0; bottom: 44px; width: 360px; max-height: 60vh; overflow: auto; background: #1b1b1b; border: 1px solid #333; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.45); }
.panel[hidden] { display: none; }
.empty { padding: 14px; color: #aaa; }
ul { list-style: none; margin: 0; padding: 0; }
li { padding: 10px 12px; border-bottom: 1px solid #2a2a2a; display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; }
.title { color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { color: #9a9a9a; font-size: 12px; grid-column: 1; }
.show { grid-row: 1 / span 2; grid-column: 2; align-self: center; background: #2a2a2a; color: #e8e8e8; border: 1px solid #444; border-radius: 6px; padding: 4px 8px; }
.show:hover { background: #333; }
`;

/** Floating "Hidden (N)" button listing filtered tiles with their reason. Lives in a shadow root. */
export class HiddenDrawer {
  private host: HTMLElement;
  private toggle: HTMLButtonElement;
  private panel: HTMLElement;
  private entries: HiddenEntry[] = [];

  constructor(private onShow: (entry: HiddenEntry) => void, doc: Document = document) {
    this.host = doc.createElement("bloomscroll-drawer");
    const root = this.host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${DRAWER_CSS}</style><div class="wrap"><div class="panel" hidden></div><button class="toggle"></button></div>`;
    this.toggle = root.querySelector(".toggle")!;
    this.panel = root.querySelector(".panel")!;
    this.toggle.addEventListener("click", () => {
      this.panel.hidden = !this.panel.hidden;
      if (!this.panel.hidden) this.renderList();
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
    this.toggle.textContent = `Hidden (${entries.length})`;
    if (!this.panel.hidden) this.renderList();
  }

  private renderList(): void {
    this.panel.replaceChildren();
    if (!this.entries.length) {
      const p = document.createElement("div");
      p.className = "empty";
      p.textContent = "Nothing hidden on this page.";
      this.panel.append(p);
      return;
    }
    const ul = document.createElement("ul");
    for (const entry of this.entries) {
      const li = document.createElement("li");
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = entry.tile.title;
      title.title = entry.tile.title;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `${entry.tile.channel || "unknown channel"} · ${entry.decision.reason}`;
      const show = document.createElement("button");
      show.className = "show";
      show.textContent = "👍 Show";
      show.title = "Show this video and remember that it's on-intent";
      show.addEventListener("click", () => this.onShow(entry));
      li.append(title, meta, show);
      ul.append(li);
    }
    this.panel.append(ul);
  }
}
