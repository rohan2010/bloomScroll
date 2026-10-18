import { createOverlayHost } from "./overlay";

const CSS = `
.btn {
  position: fixed; z-index: 2147482998; display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--line); border-radius: 999px; padding: 5px 10px 5px 8px;
  background: var(--bg); color: var(--fg); font-weight: 600; font-size: 12px;
  box-shadow: var(--shadow); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  opacity: 0; transform: translateY(-2px) scale(0.96); pointer-events: none;
  transition: opacity 120ms ease, transform 120ms ease, border-color 120ms ease, color 120ms ease;
}
.btn.on { opacity: 1; transform: none; pointer-events: auto; }
.btn:hover { border-color: var(--hide); color: var(--hide); }
.btn svg { width: 14px; height: 14px; }
`;

const THUMB_DOWN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 14V2"/><path d="M9 18.1 10 14H4.2a2 2 0 0 1-1.9-2.5l2.3-8A2 2 0 0 1 6.5 2H17a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.8a2 2 0 0 0-1.8 1.1L9 22a3.1 3.1 0 0 1-3-3.9z"/></svg>`;

/**
 * One "Hide" button, shown at the top-left corner of whichever kept tile the pointer is over
 * (top-right is where YouTube puts its own Watch later / Add to queue hover buttons).
 * Lives in our own shadow root and is positioned with fixed coordinates, so nothing is injected
 * into YouTube's (recycled) tile elements.
 */
export class HideButton {
  private host: HTMLElement;
  private btn: HTMLButtonElement;
  private target?: Element;

  constructor(private onHide: (tile: Element) => void) {
    const { host, root } = createOverlayHost("bloomscroll-feedback", CSS, `<button class="btn" title="Not what I came for: hide this video and remember">${THUMB_DOWN}<span>Hide</span></button>`);
    this.host = host;
    this.btn = root.querySelector(".btn")!;
    this.btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const tile = this.target;
      this.hide();
      if (tile) this.onHide(tile);
    });
    // Keep page-level handlers (YouTube's preview, link navigation) from seeing the press.
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) this.btn.addEventListener(type, (e) => e.stopPropagation());
  }

  /** Whether the point is over the visible button (with a little slack for imprecise pointers). */
  contains(x: number, y: number): boolean {
    if (!this.btn.classList.contains("on")) return false;
    const r = this.btn.getBoundingClientRect();
    return x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 6 && y <= r.bottom + 6;
  }

  get current(): Element | undefined {
    return this.target;
  }

  showFor(tile: Element): void {
    if (!this.host.isConnected) document.documentElement.appendChild(this.host);
    this.target = tile;
    const r = tile.getBoundingClientRect();
    // Keep it inside the viewport (and below YouTube's 56 px masthead) when the tile is cut off.
    // Top-left corner of the tile, inset so it sits on the thumbnail.
    this.btn.style.top = `${Math.min(innerHeight - 40, Math.max(64, r.top + 8))}px`;
    this.btn.style.left = `${r.left + 8}px`;
    this.btn.classList.add("on");
  }

  hide(): void {
    this.target = undefined;
    this.btn.classList.remove("on");
  }


  remove(): void {
    this.hide();
    this.host.remove();
  }
}
