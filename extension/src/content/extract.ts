import type { Surface, VideoTile } from "../shared/types";
import * as S from "./selectors";

export type TileSurface = Exclude<Surface, "endscreen">;

/** Which filtered surface a page is, or null if bloomScroll leaves the page's tiles alone. */
export function surfaceFor(pathname: string): TileSurface | null {
  if (pathname === "/") return "home";
  if (pathname === "/results") return "search";
  if (pathname === "/watch") return "sidebar";
  return null;
}

export function videoIdFromHref(href: string | null | undefined): { videoId: string; isShort: boolean } | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href, "https://www.youtube.com");
  } catch {
    return null;
  }
  const short = url.pathname.match(/^\/shorts\/([\w-]{6,})/);
  if (short) return { videoId: short[1], isShort: true };
  if (url.pathname === "/watch") {
    const v = url.searchParams.get("v");
    if (v) return { videoId: v, isShort: false };
  }
  return null;
}

/** "1:02:03" → 3723. Returns undefined for anything that isn't a clock time ("LIVE", "SHORTS"). */
export function parseDuration(text: string | null | undefined): number | undefined {
  const m = text?.trim().match(/^(\d+)(?::(\d{1,2}))?(?::(\d{1,2}))?$/);
  if (!m || m[2] === undefined) return undefined;
  const parts = m.slice(1).filter((p) => p !== undefined).map(Number);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function first(el: Element, selectors: string[]): Element | null {
  for (const sel of selectors) {
    const found = el.querySelector(sel);
    if (found) return found;
  }
  return null;
}

function firstText(el: Element, selectors: string[]): string {
  for (const sel of selectors) {
    for (const found of el.querySelectorAll(sel)) {
      const text = clean(found.textContent) || clean(found.getAttribute("title")) || clean(found.getAttribute("aria-label"));
      if (text) return text;
    }
  }
  return "";
}

function clean(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function channelIdFromHref(href: string | null): string | undefined {
  const m = href?.match(/^(?:https:\/\/www\.youtube\.com)?\/(@[^/?#]+|channel\/([\w-]+))/);
  if (!m) return undefined;
  return m[2] ?? decodeURIComponent(m[1]);
}

export function extractTile(el: Element, surface: TileSurface): VideoTile | null {
  const link = first(el, S.LINK);
  const id = videoIdFromHref(link?.getAttribute("href"));
  if (!id) return null;
  const title = firstText(el, S.TITLE);
  if (!title) return null; // YouTube fills titles lazily; retry on the next mutation
  const channelLink = first(el, S.CHANNEL_LINK);
  let durationSec: number | undefined;
  for (const sel of S.DURATION) {
    durationSec = parseDuration(el.querySelector(sel)?.textContent);
    if (durationSec !== undefined) break;
  }
  return {
    videoId: id.videoId,
    title,
    channel: firstText(el, S.CHANNEL),
    channelId: channelIdFromHref(channelLink?.getAttribute("href") ?? null),
    durationSec,
    isShort: id.isShort,
    surface,
  };
}

const TILE_SELECTOR = S.TILE.join(",");

export function surfaceRoots(doc: ParentNode, surface: TileSurface): ParentNode[] {
  const roots = S.SURFACE_ROOTS[surface].flatMap((sel) => [...doc.querySelectorAll(sel)]);
  return roots.length ? roots : [doc];
}

/** Outermost tile elements under the surface's roots. */
export function findTileElements(doc: ParentNode, surface: TileSurface): Element[] {
  const seen = new Set<Element>();
  for (const root of surfaceRoots(doc, surface)) {
    for (const el of root.querySelectorAll(TILE_SELECTOR)) {
      if (!el.parentElement?.closest(TILE_SELECTOR)) seen.add(el);
    }
  }
  return [...seen];
}

export function extractTiles(doc: ParentNode, surface: TileSurface): { el: Element; tile: VideoTile }[] {
  const out: { el: Element; tile: VideoTile }[] = [];
  for (const el of findTileElements(doc, surface)) {
    const tile = extractTile(el, surface);
    if (tile) out.push({ el, tile });
  }
  return out;
}
