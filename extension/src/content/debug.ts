import type { BackendStatus } from "../shared/messages";
import type { Mode } from "../shared/types";
import { STAGE_LABEL, createOverlayHost, el, formatMs } from "./overlay";
import { percentile, type CallTiming, type PagePerf, type TileTiming } from "./perf";

export type DebugSnapshot = {
  perf: PagePerf;
  counts: { found: number; shown: number; hidden: number; pending: number; queue: number };
  mode: Mode;
  status?: BackendStatus;
};

const CSS = `
.wrap { position: fixed; left: 16px; bottom: 16px; z-index: 2147483000; }
.panel { width: 380px; max-height: 72vh; display: flex; flex-direction: column; overflow: hidden; animation: pop 160ms ease; }
.panel[hidden], .pill[hidden], [hidden] { display: none !important; }
@keyframes pop { from { opacity: 0; transform: translateY(6px); } }
.bar { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
.bar b { font-size: 12px; letter-spacing: .02em; }
.bar .tag { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; white-space: nowrap; }
.bar .spacer { flex: 1; min-width: 4px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fallback); display: inline-block; flex: none; }
.dot.connected { background: var(--show); box-shadow: 0 0 0 3px color-mix(in srgb, var(--show) 25%, transparent); }
.dot.down, .dot.no-permission, .dot.invalid-url { background: var(--hide); }
.status { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); min-width: 0; white-space: nowrap; overflow: hidden; }
.status span:last-child { overflow: hidden; text-overflow: ellipsis; }
.icon { flex: none; border: 1px solid var(--line); background: var(--chip); border-radius: 8px; padding: 2px 8px; white-space: nowrap; }
.icon:hover { border-color: var(--accent); }
.body { overflow: auto; padding: 10px 12px 12px; display: grid; gap: 10px; }
.headline { display: flex; align-items: baseline; gap: 8px; }
.headline .big { font-size: 22px; font-weight: 600; letter-spacing: -.01em; }
.headline .sub { color: var(--muted); }
.counts { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
.counts div { background: var(--chip); border-radius: 8px; padding: 5px 0; text-align: center; }
.counts b { display: block; font-size: 14px; }
.counts span { color: var(--muted); font-size: 10px; }
.label { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 4px; }
.stack { display: flex; height: 8px; border-radius: 999px; overflow: hidden; background: var(--chip); }
.stack i { display: block; height: 100%; transition: width 250ms ease; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 6px; color: var(--muted); }
.legend span::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; background: var(--c); vertical-align: -1px; }
.legend .plain::before { display: none; }
.key { margin-top: 6px; color: var(--muted); font-size: 11px; }
table { width: 100%; border-collapse: collapse; }
td { padding: 2px 0; }
td:first-child { color: var(--muted); width: 56px; }
td.num { text-align: right; }
.call { color: var(--muted); }
.call b { color: var(--fg); font-weight: 500; }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
li { display: grid; grid-template-columns: 14px 46px 56px 1fr; gap: 6px; align-items: center; padding: 3px 0; }
li .v.show { color: var(--show); }
li .v.hide { color: var(--hide); }
li .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
li .why { grid-column: 4; color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: -2px; }
.pill { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 999px; padding: 6px 12px; background: var(--bg); box-shadow: var(--shadow); backdrop-filter: blur(14px); }
.empty { color: var(--muted); }
.err { color: var(--hide); font-size: 11px; overflow-wrap: anywhere; }
`;

const STAGES = ["rule", "embedding", "model", "fallback"] as const;

const STAGE_COLORS: Record<string, string> = {
  rule: "var(--rule)",
  embedding: "var(--embedding)",
  model: "var(--model)",
  fallback: "var(--fallback)",
};

const STATUS_TEXT: Record<BackendStatus["state"], string> = {
  connected: "connected",
  down: "not running",
  "no-permission": "not allowed",
  "invalid-url": "bad URL",
  unused: "not used in this mode",
};

const RECENT_SHOWN = 15;

/** Sets text only when it changed, so unchanged nodes are never touched. */
function setText(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/**
 * Technical overlay, bottom left, shown when Debug is on in the toolbar popup. The DOM is built
 * once; updates only rewrite the values that changed, so scroll position and hover survive.
 */
export class DebugPanel {
  private host: HTMLElement;
  private last?: DebugSnapshot;
  private collapsed = false;

  // Built once in build(); updated in place by render().
  private panel!: HTMLElement;
  private pill!: HTMLButtonElement;
  private pillDot!: HTMLElement;
  private pillText!: HTMLElement;
  private tag!: HTMLElement;
  private statusDot!: HTMLElement;
  private statusText!: HTMLElement;
  private big!: HTMLElement;
  private sub!: HTMLElement;
  private countCells: Record<string, HTMLElement> = {};
  private segments: Record<string, HTMLElement> = {};
  private legendItems: Record<string, HTMLElement> = {};
  private cachedItem!: HTMLElement;
  private timingCells: Record<string, HTMLElement[]> = {};
  private callFast!: HTMLElement;
  private callModel!: HTMLElement;
  private callTotal!: HTMLElement;
  private errorsBox!: HTMLElement;
  private errorsList!: HTMLElement;
  private recentList!: HTMLElement;
  private recentEmpty!: HTMLElement;
  /** Row per decision, keyed by videoId + phase, reused across renders. */
  private rows = new Map<string, HTMLElement>();

  constructor() {
    const { host, root } = createOverlayHost("bloomscroll-debug", CSS, `<div class="wrap"></div>`);
    this.host = host;
    root.querySelector(".wrap")!.append(...this.build());
  }

  setVisible(visible: boolean): void {
    if (visible && !this.host.isConnected) document.documentElement.appendChild(this.host);
    if (!visible) this.host.remove();
  }

  get visible(): boolean {
    return this.host.isConnected;
  }

  private build(): HTMLElement[] {
    // Collapsed pill.
    this.pill = el("button", "pill mono");
    this.pill.hidden = true;
    this.pill.title = "Expand bloomScroll debug";
    this.pillDot = el("span", "dot");
    this.pillText = el("span");
    this.pill.append(this.pillDot, this.pillText);
    this.pill.addEventListener("click", () => this.setCollapsed(false));

    // Header bar.
    this.panel = el("div", "panel card");
    const bar = el("div", "bar");
    this.tag = el("span", "tag");
    const status = el("span", "status");
    this.statusDot = el("span", "dot");
    this.statusText = el("span", "", "checking…");
    status.append(this.statusDot, this.statusText);
    const copy = el("button", "icon", "Copy");
    copy.title = "Copy these numbers as JSON, to paste into a bug report";
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(JSON.stringify(this.report(), null, 2)).catch(() => {});
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1200);
    });
    const min = el("button", "icon", "–");
    min.title = "Collapse";
    min.addEventListener("click", () => this.setCollapsed(true));
    bar.append(el("b", "", "bloomScroll"), this.tag, el("span", "spacer"), status, copy, min);

    const body = el("div", "body");

    // Headline + counts.
    const head = el("div", "headline");
    this.big = el("span", "big mono");
    this.sub = el("span", "sub");
    head.append(this.big, this.sub);
    const grid = el("div", "counts");
    for (const key of ["found", "shown", "hidden", "pending", "queue"]) {
      const cell = el("div");
      const n = el("b", "mono", "0");
      cell.append(n, el("span", "", key === "found" ? "tiles" : key));
      this.countCells[key] = n;
      grid.append(cell);
    }

    // Decided by: stacked bar, legend and the colour key for tile outlines.
    const stages = el("div");
    const stack = el("div", "stack");
    const legend = el("div", "legend");
    for (const k of STAGES) {
      const seg = el("i");
      seg.style.background = STAGE_COLORS[k];
      seg.style.width = "0%";
      this.segments[k] = seg;
      stack.append(seg);
      const item = el("span", "mono");
      item.style.setProperty("--c", STAGE_COLORS[k]);
      this.legendItems[k] = item;
      legend.append(item);
    }
    // Cached answers keep the stage that first decided them, so they're a subset of the counts above.
    this.cachedItem = el("span", "mono plain");
    legend.append(this.cachedItem);
    const key = el("div", "key", "Tile outlines on the page use these colours: the stage that decided the tile. They say nothing about the video itself.");
    stages.append(el("div", "label", "Decided by"), stack, legend, key);

    // Time to verdict.
    const timings = el("div");
    const table = el("table", "mono");
    for (const phase of ["fast", "model"]) {
      const tr = el("tr");
      tr.append(el("td", "", phase));
      const cells = [el("td", "num"), el("td", "num"), el("td", "num"), el("td", "num")];
      tr.append(...cells);
      this.timingCells[phase] = cells;
      table.append(tr);
    }
    timings.append(el("div", "label", "Time to verdict, per tile"), table);

    // Service worker calls.
    const calls = el("div");
    this.callFast = el("div", "call mono");
    this.callModel = el("div", "call mono");
    this.callTotal = el("div", "call mono");
    calls.append(el("div", "label", "Service worker calls"), this.callFast, this.callModel, this.callTotal);

    // Errors (hidden when there are none).
    this.errorsBox = el("div");
    this.errorsBox.hidden = true;
    this.errorsList = el("div");
    this.errorsBox.append(el("div", "label", "Recovered errors (tiles were shown)"), this.errorsList);

    // Recent decisions.
    const recent = el("div");
    this.recentEmpty = el("div", "empty", "None yet.");
    this.recentList = el("ul");
    recent.append(el("div", "label", "Recent decisions"), this.recentEmpty, this.recentList);

    body.append(head, grid, stages, timings, calls, this.errorsBox, recent);
    this.panel.append(bar, body);
    return [this.pill, this.panel];
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.pill.hidden = !collapsed;
    this.panel.hidden = collapsed;
    if (this.last) this.render(this.last);
  }

  render(s: DebugSnapshot): void {
    this.last = s;
    if (!this.visible) return;
    const { perf, counts } = s;
    const elapsed = perf.elapsedMs();
    const settled = perf.settledAt !== undefined;
    const state = s.status?.state ?? "";

    // The pill is all that's visible when collapsed; skip the rest.
    if (this.collapsed) {
      this.pillDot.className = `dot ${state}`;
      setText(this.pillText, `${settled ? "settled" : "working"} ${formatMs(elapsed)} · ${counts.hidden} hidden`);
      return;
    }

    setText(this.tag, `debug · ${s.mode}`);
    this.statusDot.className = `dot ${state}`;
    const st = s.status;
    setText(this.statusText, st ? `${st.kind} ${STATUS_TEXT[st.state]}${st.latencyMs !== undefined ? ` · ${Math.round(st.latencyMs)} ms` : ""}` : "checking…");
    (this.statusText.parentElement as HTMLElement).title = this.statusText.textContent ?? "";

    setText(this.big, formatMs(elapsed));
    setText(this.sub, elapsed === undefined ? "no tiles yet" : settled ? "until the page settled" : "so far, still classifying");
    for (const [k, node] of Object.entries(this.countCells)) setText(node, String(counts[k as keyof typeof counts]));

    const total = Object.values(perf.stages).reduce((a, b) => a + b, 0);
    for (const k of STAGES) {
      const n = perf.stages[k] ?? 0;
      const width = total ? `${(100 * n) / total}%` : "0%";
      if (this.segments[k].style.width !== width) this.segments[k].style.width = width;
      setText(this.legendItems[k], `${STAGE_LABEL[k]} ${n}`);
    }
    setText(this.cachedItem, `of which cached ${perf.cached}`);

    for (const phase of ["fast", "model"] as const) {
      const xs = perf.times[phase];
      const [p50, p90, max, n] = this.timingCells[phase];
      setText(p50, `p50 ${formatMs(percentile(xs, 50))}`);
      setText(p90, `p90 ${formatMs(percentile(xs, 90))}`);
      setText(max, `max ${formatMs(xs.length ? Math.max(...xs) : undefined)}`);
      setText(n, `n=${xs.length}`);
    }

    this.renderCall(this.callFast, perf.lastCall.fast, "last fast");
    this.renderCall(this.callModel, perf.lastCall.model, "last model");
    const t = perf.totals.model;
    setText(this.callTotal, `model total: ${t.calls} calls · ${t.tiles} tiles · ${formatMs(t.ms)}`);

    this.errorsBox.hidden = !perf.errors.length;
    const errText = perf.errors.join("\n");
    if (this.errorsList.dataset.text !== errText) {
      this.errorsList.dataset.text = errText;
      this.errorsList.replaceChildren(...perf.errors.map((e) => el("div", "err mono", e)));
    }

    this.renderRecent(perf.recent.slice(0, RECENT_SHOWN));
  }

  private renderCall(node: HTMLElement, c: CallTiming | undefined, name: string): void {
    // Two text lines; rebuilt only when the call itself changed (a new call object).
    if ((node as HTMLElement & { _call?: CallTiming })._call === c && node.childNodes.length) return;
    (node as HTMLElement & { _call?: CallTiming })._call = c;
    if (!c) {
      node.textContent = `${name}: none yet`;
      return;
    }
    const m = c.metrics;
    const perTile = c.tiles ? c.roundTripMs / c.tiles : 0;
    node.replaceChildren(el("b", "", `${name}: ${c.tiles} tiles in ${formatMs(c.roundTripMs)}`), document.createTextNode(` (${formatMs(perTile)}/tile)`));
    if (m) node.append(el("div", "", `cache ${formatMs(m.ms.cache)} · rules ${formatMs(m.ms.rules)} · embed ${formatMs(m.ms.embed)} · model ${formatMs(m.ms.model)}${m.backend ? ` (${m.backend})` : ""}`));
  }

  /** Keyed list: new decisions are inserted at the top, existing rows are left alone, old ones dropped. */
  private renderRecent(recent: TileTiming[]): void {
    this.recentEmpty.hidden = recent.length > 0;
    const keep = new Set<string>();
    recent.forEach((r, i) => {
      const key = `${r.videoId}:${r.phase}`;
      keep.add(key);
      let row = this.rows.get(key);
      if (!row) {
        row = this.makeRow(r);
        this.rows.set(key, row);
      }
      // Only moves a node when it's out of place: in the common case nothing is touched.
      const at = this.recentList.children[i] ?? null;
      if (at !== row) this.recentList.insertBefore(row, at);
    });
    for (const [key, row] of this.rows) {
      if (keep.has(key)) continue;
      row.remove();
      this.rows.delete(key);
    }
  }

  private makeRow(r: TileTiming): HTMLElement {
    const li = el("li");
    li.append(
      el("span", `v ${r.verdict}`, r.verdict === "show" ? "✓" : "✕"),
      el("span", `stage ${r.cached ? "cache" : r.stage}`, r.cached ? "cache" : STAGE_LABEL[r.stage]),
      el("span", "mono", formatMs(r.ms)),
      el("span", "t", r.title),
      el("span", "why", r.reason),
    );
    li.title = `${r.title}\n${r.channel}\n${r.reason}\n${r.phase} phase${r.cached ? ", cached" : ""}`;
    return li;
  }

  private report() {
    const s = this.last!;
    const p = s.perf;
    return {
      at: new Date().toISOString(),
      page: location.pathname,
      mode: s.mode,
      backend: s.status,
      counts: s.counts,
      elapsedMs: p.elapsedMs(),
      settled: p.settledAt !== undefined,
      decidedBy: { cache: p.cached, ...p.stages },
      timeToVerdict: Object.fromEntries(
        (["fast", "model"] as const).map((k) => [k, { n: p.times[k].length, p50: percentile(p.times[k], 50), p90: percentile(p.times[k], 90), max: p.times[k].length ? Math.max(...p.times[k]) : undefined }]),
      ),
      calls: { totals: p.totals, last: p.lastCall },
      errors: p.errors,
      recent: p.recent.slice(0, 25).map(({ title, channel, verdict, stage, reason, cached, ms }) => ({ title, channel, verdict, stage: cached ? "cache" : stage, reason, ms: Math.round(ms) })),
    };
  }
}
