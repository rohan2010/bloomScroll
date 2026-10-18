import type { CalibrateRequest, CalibrationReport, CalibrationScores, ReviewItem, ReviewSampleRequest, Thresholds } from "../shared/messages";
import type { Label, Settings } from "../shared/types";
import { DEFAULT_SETTINGS } from "../shared/settings";
import type { IdbCache } from "../background/cache";

const MIN_LABELS = 40;
const MIN_PER_CLASS = 10;
const REVIEW_BATCH = 30;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const pct = (x: number) => `${Math.round(x * 100)}%`;

type Ctx = {
  cache: IdbCache;
  getSettings: () => Settings;
  /** Saves and re-fills the form with these settings. */
  setSettings: (s: Settings) => Promise<void>;
};

/** The calibration section of Settings: review queue, run, report, apply. */
export function setupCalibration(ctx: Ctx): { refresh: () => Promise<void> } {
  let queue: ReviewItem[] = [];
  let pos = 0;
  let reviewed = 0;

  async function refresh(): Promise<void> {
    const labels = await ctx.cache.listLabels();
    const wanted = labels.filter((l) => l.userVerdict === "show").length;
    const unwanted = labels.length - wanted;
    const progress = Math.min(1, Math.min(labels.length / MIN_LABELS, wanted / MIN_PER_CLASS, unwanted / MIN_PER_CLASS));
    $("cal-meter").style.width = `${Math.round(progress * 100)}%`;
    const ready = labels.length >= MIN_LABELS && wanted >= MIN_PER_CLASS && unwanted >= MIN_PER_CLASS;
    $("cal-count").textContent = ready
      ? `${labels.length} answers (${wanted} on-topic, ${unwanted} off-topic). Ready to calibrate; more answers make it more accurate.`
      : `${labels.length} of ${MIN_LABELS} answers (${wanted} on-topic, ${unwanted} off-topic; at least ${MIN_PER_CLASS} of each).`;
    $<HTMLButtonElement>("cal-run").disabled = !ready;
  }

  function status(text: string): void {
    $("cal-status").textContent = text;
  }

  // ------------------------------------------------------------------ review queue

  async function startReview(): Promise<void> {
    status("Loading recent videos…");
    const res = (await chrome.runtime.sendMessage({ type: "review-sample", n: REVIEW_BATCH } satisfies ReviewSampleRequest).catch(() => undefined)) as { items: ReviewItem[] } | undefined;
    queue = res?.items ?? [];
    pos = 0;
    reviewed = 0;
    if (!queue.length) {
      status("No recent videos to review yet. Browse YouTube for a bit with bloomScroll on, then come back.");
      return;
    }
    status("");
    $("cal-report").hidden = true;
    $("review").hidden = false;
    showCard();
    $("rv-yes").focus();
  }

  function showCard(): void {
    const it = queue[pos];
    if (!it) return endReview(`Reviewed ${reviewed} video${reviewed === 1 ? "" : "s"}. Thanks!`);
    $("rv-index").textContent = `Video ${pos + 1} of ${queue.length}`;
    $("rv-title").textContent = it.title;
    $("rv-channel").textContent = it.channel || "unknown channel";
  }

  async function answer(verdict: Label["userVerdict"] | null): Promise<void> {
    const it = queue[pos];
    if (!it) return;
    if (verdict) {
      await ctx.cache.addLabel({ videoId: it.videoId, title: it.title, channel: it.channel, userVerdict: verdict, at: Date.now() });
      reviewed++;
    }
    pos++;
    showCard();
    refresh();
  }

  function endReview(message: string): void {
    $("review").hidden = true;
    queue = [];
    status(message);
    refresh();
  }

  function onKey(e: KeyboardEvent): void {
    if ($("review").hidden || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
    const keys: Record<string, Label["userVerdict"] | null | undefined> = { ArrowRight: "show", ArrowLeft: "hide", ArrowDown: null };
    if (!(e.key in keys)) return;
    e.preventDefault();
    answer(keys[e.key] ?? null);
  }

  // ------------------------------------------------------------------ run + report

  async function run(): Promise<void> {
    $<HTMLButtonElement>("cal-run").disabled = true;
    const s = ctx.getSettings();
    status(s.backend.kind === "laya" ? "Scoring your answers (with Laya this can take a minute)…" : "Scoring your answers…");
    const report = (await chrome.runtime.sendMessage({ type: "calibrate" } satisfies CalibrateRequest).catch((e) => ({ error: String(e) }))) as CalibrationReport | { error: string };
    status("");
    await refresh();
    if ("error" in report) return status(`Calibration failed: ${report.error}`);
    renderReport(report);
  }

  function row(name: string, before: string, after: string, better: boolean | null): HTMLTableRowElement {
    const tr = document.createElement("tr");
    for (const [i, text] of [name, before, after].entries()) {
      const td = document.createElement("td");
      td.textContent = text;
      if (i === 2 && better !== null && before !== after) td.className = better ? "better" : "worse";
      tr.append(td);
    }
    return tr;
  }

  function renderReport(r: CalibrationReport): void {
    const box = $("cal-report");
    box.hidden = false;
    box.replaceChildren();
    const p = (text: string, cls = "") => {
      const el = document.createElement("p");
      el.textContent = text;
      if (cls) el.className = cls;
      box.append(el);
      return el;
    };
    if (!r.ok) {
      p(r.reason === "mode" ? "Switch to Learn mode first: calibration tunes the filtering it uses." : `Not enough answers yet: ${r.counts.labels} (${r.counts.wanted} on-topic, ${r.counts.unwanted} off-topic). Review more videos.`, "notice");
      return;
    }
    const b: CalibrationScores = r.before;
    const a: CalibrationScores = r.after;
    p(
      `${r.counts.labels} answers. ${r.heldOut ? `Tested on ${a.n} answers it didn't learn from.` : `Few answers, so tested on all ${a.n}; treat this as a rough guide.`} ${r.modelUsed ? "Laya was included." : "Laya wasn't reachable, so only the built-in model's thresholds were tuned."}`,
      "hint",
    );
    const table = document.createElement("table");
    const head = document.createElement("tr");
    for (const h of ["", "Now", "After calibration"]) {
      const th = document.createElement("th");
      th.textContent = h;
      head.append(th);
    }
    table.append(
      head,
      row("Shown videos you wanted", pct(b.precision), pct(a.precision), a.precision > b.precision),
      row("Wanted videos it would hide", pct(b.wronglyHidden), pct(a.wronglyHidden), a.wronglyHidden < b.wronglyHidden),
      row("Mistakes (hid wanted / showed unwanted)", `${b.wrongHides} / ${b.wrongShows}`, `${a.wrongHides} / ${a.wrongShows}`, a.cost < b.cost),
    );
    box.append(table);

    const t = (x: Thresholds) => `mini model show ≥ ${x.embedMarginShow.toFixed(2)}, hide ≤ ${x.embedMarginHide.toFixed(2)}; model show ≥ ${x.modelShow.toFixed(2)}`;
    p(`Now: ${t(r.current)}`, "hint");
    p(`Proposed: ${t(r.proposed)}`, "hint");

    const same = JSON.stringify(r.current) === JSON.stringify(r.proposed);
    if (same) {
      p("Your current settings already fit your answers best. Nothing to change.", "notice ok");
      return;
    }
    if (a.cost > b.cost) p("On answers it didn't learn from, the proposal does worse. Keep the current settings and add more answers.", "notice");
    else if (a.cost === b.cost) p("No measurable difference on answers it didn't learn from, so applying is optional. More answers give a clearer signal.", "hint");

    const actions = document.createElement("div");
    actions.className = "actions";
    const apply = document.createElement("button");
    apply.className = "primary";
    apply.textContent = "Apply";
    apply.addEventListener("click", async () => {
      await ctx.setSettings({ ...ctx.getSettings(), thresholds: r.proposed });
      box.hidden = true;
      status("Applied. Open YouTube tabs re-check their videos with the new settings.");
    });
    const discard = document.createElement("button");
    discard.textContent = "Discard";
    discard.addEventListener("click", () => {
      box.hidden = true;
      status("Kept the current settings.");
    });
    actions.append(apply, discard);
    box.append(actions);
  }

  async function reset(): Promise<void> {
    await ctx.setSettings({ ...ctx.getSettings(), thresholds: { ...DEFAULT_SETTINGS.thresholds } });
    $("cal-report").hidden = true;
    status("Thresholds reset to defaults.");
  }

  $("review-start").addEventListener("click", startReview);
  $("rv-yes").addEventListener("click", () => answer("show"));
  $("rv-no").addEventListener("click", () => answer("hide"));
  $("rv-skip").addEventListener("click", () => answer(null));
  $("rv-done").addEventListener("click", () => endReview(`Reviewed ${reviewed} video${reviewed === 1 ? "" : "s"}.`));
  $("cal-run").addEventListener("click", run);
  $("cal-reset").addEventListener("click", reset);
  document.addEventListener("keydown", onKey);

  return { refresh };
}
