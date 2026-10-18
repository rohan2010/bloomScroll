// ALL YouTube selectors live here. When YouTube changes its markup, this is the one file to fix.
// Lists are ordered: the first selector that yields a value wins.

import type { Surface } from "../shared/types";

/** Container to scan per surface. YouTube keeps old pages in the DOM, so scope each scan. */
export const SURFACE_ROOTS: Record<Exclude<Surface, "endscreen">, string[]> = {
  home: ['ytd-browse[page-subtype="home"]'],
  search: ["ytd-search"],
  sidebar: ["ytd-watch-flexy #secondary", "ytd-watch-flexy #related"],
};

/** Video tile elements. Only the outermost match is used (rich items wrap lockups). */
export const TILE = [
  "ytd-rich-item-renderer",
  "ytd-video-renderer",
  "ytd-compact-video-renderer",
  "ytd-grid-video-renderer",
  "yt-lockup-view-model",
];

export const LINK = [
  "a#thumbnail[href]",
  "a#video-title-link[href]",
  "a#video-title[href]",
  'a[href*="/watch?v="]',
  'a[href^="/shorts/"]',
];

export const TITLE = [
  "#video-title-link",
  "a#video-title",
  "#video-title",
  ".yt-lockup-metadata-view-model__title",
  ".yt-lockup-metadata-view-model-wiz__title",
  "h3 a",
];

export const CHANNEL = [
  "ytd-channel-name a",
  "ytd-channel-name #text",
  ".yt-content-metadata-view-model__metadata-text a",
  ".yt-content-metadata-view-model-wiz__metadata-text a",
  ".yt-content-metadata-view-model__metadata-text",
  ".yt-content-metadata-view-model-wiz__metadata-text",
];

export const CHANNEL_LINK = ['ytd-channel-name a[href]', 'a[href^="/@"]', 'a[href^="/channel/"]'];

export const DURATION = [
  "ytd-thumbnail-overlay-time-status-renderer #text",
  "ytd-thumbnail-overlay-time-status-renderer .badge-shape-wiz__text",
  "yt-thumbnail-badge-view-model .badge-shape-wiz__text",
  ".yt-badge-shape__text",
  ".badge-shape-wiz__text",
];

// CSS-only hiding, no model call. Each list is prefixed with an <html> attribute in hide.ts.
export const SHORTS_UI = [
  "ytd-reel-shelf-renderer",
  "ytd-rich-shelf-renderer[is-shorts]",
  "ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])",
  'grid-shelf-view-model:has(a[href^="/shorts/"])',
  'ytd-rich-item-renderer:has(a[href^="/shorts/"])',
  'ytd-video-renderer:has(a[href^="/shorts/"])',
  'ytd-guide-entry-renderer:has(a[title="Shorts"])',
  'ytd-mini-guide-entry-renderer[aria-label="Shorts"]',
];

export const COMMENTS_UI = ["ytd-comments#comments"];

export const ENDSCREEN_UI = [".ytp-endscreen-content", ".ytp-ce-element", ".html5-endscreen"];
