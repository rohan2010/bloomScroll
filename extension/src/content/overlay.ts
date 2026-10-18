// Shared look for the on-page overlays (Hidden drawer, debug panel). Each lives in its own shadow
// root so YouTube's styles can't reach in. Follows YouTube's own theme (html[dark]), not the OS.

export const OVERLAY_TOKENS = `
:host {
  all: initial;
  --bg: rgba(255, 255, 255, 0.92);
  --bg-solid: #ffffff;
  --fg: #0f0f0f;
  --muted: #606060;
  --line: rgba(0, 0, 0, 0.1);
  --chip: rgba(0, 0, 0, 0.05);
  --accent: #1f8a53;
  --accent-fg: #ffffff;
  --shadow: 0 8px 28px rgba(0, 0, 0, 0.18), 0 1px 3px rgba(0, 0, 0, 0.12);
  --show: #1f8a53;
  --hide: #d93025;
  --rule: #7c5cff;
  --embedding: #0b8bd9;
  --model: #d97706;
  --fallback: #8a8a8a;
  font: 12px/1.45 "Roboto", "Inter", system-ui, sans-serif;
  color: var(--fg);
}
:host-context(html[dark]) {
  --bg: rgba(28, 28, 30, 0.9);
  --bg-solid: #1c1c1e;
  --fg: #f1f1f1;
  --muted: #aaaaaa;
  --line: rgba(255, 255, 255, 0.1);
  --chip: rgba(255, 255, 255, 0.08);
  --accent: #3ec27e;
  --accent-fg: #0b1f14;
  --shadow: 0 8px 28px rgba(0, 0, 0, 0.5), 0 1px 3px rgba(0, 0, 0, 0.4);
  --show: #3ec27e;
  --hide: #ff6b5e;
  --rule: #a78bfa;
  --embedding: #38bdf8;
  --model: #fbbf24;
  --fallback: #a3a3a3;
}
* { box-sizing: border-box; }
button { font: inherit; color: inherit; cursor: pointer; }
.card {
  background: var(--bg);
  backdrop-filter: blur(14px) saturate(1.4);
  -webkit-backdrop-filter: blur(14px) saturate(1.4);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--shadow);
}
.stage { display: inline-block; padding: 0 6px; border-radius: 999px; font-size: 10px; font-weight: 600; letter-spacing: .02em; line-height: 16px; color: var(--bg-solid); }
.stage.rule { background: var(--rule); }
.stage.embedding { background: var(--embedding); }
.stage.model { background: var(--model); }
.stage.fallback { background: var(--fallback); }
.stage.cache { background: transparent; color: var(--muted); border: 1px solid var(--line); line-height: 14px; }
.mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-variant-numeric: tabular-nums; }
`;

export const STAGE_LABEL: Record<string, string> = {
  rule: "rule",
  embedding: "embed",
  model: "model",
  fallback: "fallback",
  cache: "cache",
};

/** Builds a fixed-position host with an open shadow root and the shared tokens. */
export function createOverlayHost(tag: string, css: string, html: string): { host: HTMLElement; root: ShadowRoot } {
  const host = document.createElement(tag);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${OVERLAY_TOKENS}${css}</style>${html}`;
  return { host, root };
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}
