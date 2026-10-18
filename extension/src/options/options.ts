import type { BackendKind, Label, Settings } from "../shared/types";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../shared/settings";
import { JEV_BASE_URL } from "../background/backends/jev";
import { IdbCache } from "../background/cache";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const cache = new IdbCache();

const lines = (id: string) =>
  $<HTMLTextAreaElement>(id)
    .value.split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

function num(id: string, fallback: number): number {
  const v = Number($<HTMLInputElement>(id).value);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback;
}

function fill(s: Settings): void {
  $<HTMLTextAreaElement>("topics").value = s.topics.join("\n");
  $<HTMLTextAreaElement>("allow").value = s.allowChannels.join("\n");
  $<HTMLTextAreaElement>("block").value = s.blockChannels.join("\n");
  $<HTMLInputElement>("hideShorts").checked = s.hideShorts;
  $<HTMLInputElement>("hideComments").checked = s.hideComments;
  $<HTMLInputElement>("hideEndscreen").checked = s.hideEndscreen;
  $<HTMLSelectElement>("kind").value = s.backend.kind;
  $<HTMLInputElement>("url").value = s.backend.url;
  $<HTMLInputElement>("apiKey").value = s.backend.apiKey ?? "";
  $<HTMLInputElement>("embedShow").value = String(s.thresholds.embedShow);
  $<HTMLInputElement>("embedHide").value = String(s.thresholds.embedHide);
  $<HTMLInputElement>("modelShow").value = String(s.thresholds.modelShow);
  $<HTMLInputElement>("modelMinConf").value = String(s.thresholds.modelMinConf);
  syncBackendFields();
}

function syncBackendFields(): void {
  const kind = $<HTMLSelectElement>("kind").value as BackendKind;
  $("key-row").hidden = kind === "laya";
  $("jev-notice").hidden = kind !== "jev";
}

function read(current: Settings): Settings {
  const d = DEFAULT_SETTINGS.thresholds;
  const kind = $<HTMLSelectElement>("kind").value as BackendKind;
  const url = $<HTMLInputElement>("url").value.trim() || (kind === "jev" ? JEV_BASE_URL : DEFAULT_SETTINGS.backend.url);
  const apiKey = $<HTMLInputElement>("apiKey").value.trim();
  return {
    ...current,
    topics: lines("topics"),
    allowChannels: lines("allow"),
    blockChannels: lines("block"),
    hideShorts: $<HTMLInputElement>("hideShorts").checked,
    hideComments: $<HTMLInputElement>("hideComments").checked,
    hideEndscreen: $<HTMLInputElement>("hideEndscreen").checked,
    backend: { kind, url, ...(apiKey && kind !== "laya" ? { apiKey } : {}) },
    thresholds: {
      embedShow: num("embedShow", d.embedShow),
      embedHide: num("embedHide", d.embedHide),
      modelShow: num("modelShow", d.modelShow),
      modelMinConf: num("modelMinConf", d.modelMinConf),
    },
  };
}

/** Host pattern for the backend, so the service worker can call it without the server configuring CORS. */
function originPattern(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

function setStatus(text: string): void {
  $("status").textContent = text;
}

async function refreshLabelCount(): Promise<void> {
  const n = (await cache.listLabels()).length;
  $("label-count").textContent = `${n} label${n === 1 ? "" : "s"} saved from the Hidden drawer.`;
}

function toCsv(labels: Label[]): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const rows = labels.map((l) => [l.videoId, q(l.title), q(l.channel), l.userVerdict, new Date(l.at).toISOString()].join(","));
  return ["videoId,title,channel,userVerdict,at", ...rows].join("\n");
}

async function main(): Promise<void> {
  let current = await loadSettings();
  fill(current);
  refreshLabelCount();

  $("kind").addEventListener("change", () => {
    // Swap the URL to the new kind's default unless the user typed a custom one.
    const url = $<HTMLInputElement>("url");
    const kind = $<HTMLSelectElement>("kind").value as BackendKind;
    const defaults = [DEFAULT_SETTINGS.backend.url, JEV_BASE_URL, ""];
    if (defaults.includes(url.value.trim().replace(/\/+$/, ""))) url.value = kind === "jev" ? JEV_BASE_URL : DEFAULT_SETTINGS.backend.url;
    syncBackendFields();
  });

  $<HTMLFormElement>("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const next = read(current);
    const pattern = originPattern(next.backend.url);
    // Request inside the click so Chrome sees a user gesture.
    const granted = pattern ? chrome.permissions.request({ origins: [pattern] }).catch(() => false) : Promise.resolve(false);
    granted.then(async (ok) => {
      await saveSettings(next);
      current = next;
      setStatus(ok ? "Saved." : `Saved, but the backend at ${next.backend.url} isn't allowed, so filtering will use rules only.`);
    });
  });

  $("export").addEventListener("click", async () => {
    const blob = new Blob([toCsv(await cache.listLabels())], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `bloomscroll-labels-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("wipe").addEventListener("click", async () => {
    if (!confirm("Delete all labels and cached decisions? This can't be undone.")) return;
    await Promise.all([cache.clearLabels(), cache.clearDecisions()]);
    refreshLabelCount();
    setStatus("Data deleted.");
  });
}

main();
