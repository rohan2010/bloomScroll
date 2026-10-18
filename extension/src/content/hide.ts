import type { Decision, Settings } from "../shared/types";
import { effectiveHideShorts } from "../shared/settings";
import { COMMENTS_UI, ENDSCREEN_UI, SHORTS_UI } from "./selectors";
import { ditherLayer } from "./dither";

export const PENDING = "bloom-pending";
export const HIDDEN = "bloom-hidden";

const STYLE_ID = "bloomscroll-style";

function scoped(attr: string, selectors: string[]): string {
  return `${selectors.map((s) => `html[${attr}] ${s}`).join(",\n")} { display: none !important; }`;
}

const STAGE_OUTLINES: Record<string, string> = {
  rule: "#7c5cff",
  embedding: "#0b8bd9",
  model: "#d97706",
  fallback: "#8a8a8a",
};

export function injectStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = [
    // Waiting tiles look untouched; off-topic ones are dithered away once decided.
    `.${HIDDEN} { display: none !important; }`,
    // Debug: outline each tile by the stage that decided it.
    ...Object.entries(STAGE_OUTLINES).map(
      ([stage, color]) => `html[data-bloom-debug] [data-bloom-stage="${stage}"] { outline: 2px solid ${color}; outline-offset: -2px; border-radius: 12px; }`,
    ),
    `html[data-bloom-debug] .${PENDING} { outline: 2px dashed #8a8a8a; outline-offset: -2px; border-radius: 12px; }`,
    scoped("data-bloom-shorts", SHORTS_UI),
    scoped("data-bloom-comments", COMMENTS_UI),
    scoped("data-bloom-endscreen", ENDSCREEN_UI),
  ].join("\n");
  (doc.head ?? doc.documentElement).appendChild(style);
}

export function reducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function animationsOn(s: Settings): boolean {
  return s.animations && !reducedMotion();
}

export function applyUiToggles(s: Settings, doc: Document = document): void {
  const html = doc.documentElement;
  html.toggleAttribute("data-bloom-shorts", effectiveHideShorts(s));
  html.toggleAttribute("data-bloom-comments", s.hideComments);
  html.toggleAttribute("data-bloom-endscreen", s.hideEndscreen);
  html.toggleAttribute("data-bloom-anim", animationsOn(s));
  html.toggleAttribute("data-bloom-debug", s.debug);
}

/** Effects in flight per tile, so a recycled or re-decided tile can cancel them. */
const running = new WeakMap<Element, () => void>();

function cancelAnimations(el: Element): void {
  running.get(el)?.();
  running.delete(el);
  const h = el as HTMLElement;
  h.style.visibility = "";
  h.style.overflow = "";
  el.removeAttribute("data-bloom-fx");
}

/** A tile's box and margins, read before any writes so a batch of verdicts costs one layout. */
type Geometry = { rect: DOMRect; margins: Pick<CSSStyleDeclaration, "marginTop" | "marginBottom" | "marginLeft" | "marginRight"> };

/** Geometry of an on-screen tile, or undefined when it's off screen (nothing to watch). */
function onScreenGeometry(el: Element): Geometry | undefined {
  const rect = el.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight)) return undefined;
  const { marginTop, marginBottom, marginLeft, marginRight } = getComputedStyle(el);
  return { rect, margins: { marginTop, marginBottom, marginLeft, marginRight } };
}

const EASE = "cubic-bezier(0.4, 0, 0.2, 1)";

/**
 * Off-topic exit: a short glitch, then the tile dissolves pixel by pixel (ordered dither, see
 * dither.ts), then its space collapses so neighbours slide in. Grid tiles (home) collapse
 * sideways, list tiles (sidebar, search) upward.
 */
function destroy(el: HTMLElement, { rect: r, margins: cs }: Geometry): void {
  const sideways = el.tagName === "YTD-RICH-ITEM-RENDERER";
  const anims: Animation[] = [];
  const fx = ditherLayer.dissolve(el);
  let live = true;
  running.set(el, () => {
    live = false;
    fx.cancel();
    for (const a of anims) a.cancel();
  });
  el.setAttribute("data-bloom-fx", "dissolve");
  anims.push(
    el.animate(
      [
        { transform: "translate(0, 0)", filter: "saturate(1) contrast(1)" },
        { transform: "translate(-2px, 1px)", filter: "saturate(0.2) contrast(1.6)", offset: 0.25 },
        { transform: "translate(2px, -1px)", filter: "saturate(0) contrast(1.8) hue-rotate(40deg)", offset: 0.5 },
        { transform: "translate(0, 0)", filter: "saturate(0) contrast(1.4)" },
      ],
      { duration: 180, easing: "steps(4, end)", fill: "forwards" },
    ),
  );
  fx.done
    .then(() => {
      if (!live) return;
      el.style.visibility = "hidden"; // fully covered by the dither layer this frame
      el.style.overflow = "hidden";
      const from: Keyframe = { height: `${r.height}px`, marginTop: cs.marginTop, marginBottom: cs.marginBottom };
      const to: Keyframe = { height: "0px", marginTop: "0px", marginBottom: "0px" };
      if (sideways) {
        Object.assign(from, { width: `${r.width}px`, minWidth: "0px", maxWidth: `${r.width}px`, marginLeft: cs.marginLeft, marginRight: cs.marginRight });
        Object.assign(to, { width: "0px", minWidth: "0px", maxWidth: "0px", marginLeft: "0px", marginRight: "0px" });
      }
      const collapse = el.animate([from, to], { duration: 260, easing: EASE, fill: "forwards" });
      anims.push(collapse);
      return collapse.finished;
    })
    .then(() => {
      if (!live) return;
      el.classList.add(HIDDEN);
      cancelAnimations(el);
    })
    .catch(() => {
      // cancelled: the tile was recycled or re-decided; cancelAnimations already restored it
    });
}

export function markPending(el: Element): void {
  cancelAnimations(el);
  el.classList.add(PENDING);
  el.classList.remove(HIDDEN);
  el.setAttribute("data-bloom", "pending");
  el.removeAttribute("data-bloom-stage");
}

type VerdictLike = Pick<Decision, "verdict"> & Partial<Pick<Decision, "stage">>;

export function applyVerdict(el: Element, d: VerdictLike, animate = false): void {
  applyWith(el, d, animate && d.verdict === "hide" && el instanceof HTMLElement ? onScreenGeometry(el) : undefined);
}

/**
 * Many verdicts at once: every layout read happens before the first write, so hiding a screenful of
 * tiles forces one layout instead of one per tile.
 */
export function applyVerdicts(items: [Element, VerdictLike][], animate = false): void {
  const geometry = items.map(([el, d]) => (animate && d.verdict === "hide" && el instanceof HTMLElement ? onScreenGeometry(el) : undefined));
  items.forEach(([el, d], i) => applyWith(el, d, geometry[i]));
}

/** geometry is set only for an on-screen tile that should animate out. */
function applyWith(el: Element, d: VerdictLike, geometry: Geometry | undefined): void {
  cancelAnimations(el);
  el.classList.remove(PENDING);
  el.setAttribute("data-bloom", d.verdict);
  if (d.stage) el.setAttribute("data-bloom-stage", d.stage);
  else el.removeAttribute("data-bloom-stage");
  if (d.verdict === "show") {
    el.classList.remove(HIDDEN);
    return;
  }
  // Off screen there's nothing to watch, so skip straight to hidden.
  if (geometry && el instanceof HTMLElement) destroy(el, geometry);
  else el.classList.add(HIDDEN);
}

/** Return a tile to YouTube's own rendering. Never removes the node: YouTube recycles them. */
export function clearTile(el: Element): void {
  cancelAnimations(el);
  el.classList.remove(PENDING, HIDDEN);
  el.removeAttribute("data-bloom");
  el.removeAttribute("data-bloom-id");
  el.removeAttribute("data-bloom-stage");
}

/** Hidden, or on its way out. */
export function isHidden(el: Element): boolean {
  return el.getAttribute("data-bloom") === "hide";
}
