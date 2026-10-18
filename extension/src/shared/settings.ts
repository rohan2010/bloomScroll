import type { Mode, Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  topics: [],
  allowChannels: [],
  blockChannels: [],
  hideShorts: true,
  hideComments: false,
  hideEndscreen: true,
  includeTech: true,
  mode: "learn",
  debug: false,
  animations: true,
  backend: { url: "http://127.0.0.1:8765", kind: "laya" },
  // Embedding thresholds are margins (topic sim minus off-topic sim); modelShow is for the
  // label-only prompt, where on-topic titles scored >= 0.14 and off-topic <= 0.04 (40-title eval).
  thresholdsVersion: 2,
  thresholds: { embedMarginShow: 0.15, embedMarginHide: -0.05, modelShow: 0.1, modelMinConf: 0.65 },
};

/** Built-in intents used by Work mode, and merged with the user's topics in Learn mode. */
export const TECH_TOPICS = [
  "programming",
  "coding",
  "software engineering",
  "web development",
  "computer science",
  "Linux",
  "open source",
  "machine learning",
  "AI research",
  "data science",
  "DevOps",
  "cybersecurity",
  "algorithms",
  "databases",
  "TypeScript",
  "JavaScript",
  "Python",
  "Rust",
  "Docker",
  "Kubernetes",
  "Git",
  "Vim and Neovim",
  "C and C++",
  "Go programming",
  "large language models",
  "neural networks",
  "system design",
  "computer graphics",
  "hacking",
  "cloud computing",
];

const KEY = "settings";

const THRESHOLD_KEYS = Object.keys(DEFAULT_SETTINGS.thresholds) as (keyof Settings["thresholds"])[];

/** Only known keys, so retired thresholds (the raw-similarity embedShow/embedHide) can't leak back in. */
function pick<T extends object>(obj: Partial<T> | undefined, keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k];
  return out;
}

/**
 * Work mode is hidden from the UI for now (it comes back once the rest of the UX settles). Anyone
 * saved in Work moves to Learn, which with no topics of their own behaves the same.
 */
export const WORK_MODE_ENABLED = false;

export function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  const s = stored ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    mode: !WORK_MODE_ENABLED && s.mode === "work" ? "learn" : (s.mode ?? DEFAULT_SETTINGS.mode),
    backend: { ...DEFAULT_SETTINGS.backend, ...s.backend },
    // Thresholds saved for an older prompt or scoring mean something else now: start from defaults.
    thresholdsVersion: DEFAULT_SETTINGS.thresholdsVersion,
    thresholds:
      s.thresholdsVersion === DEFAULT_SETTINGS.thresholdsVersion
        ? { ...DEFAULT_SETTINGS.thresholds, ...pick(s.thresholds, THRESHOLD_KEYS) }
        : DEFAULT_SETTINGS.thresholds,
  };
}

export async function loadSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(KEY);
  return mergeSettings(got[KEY] as Partial<Settings> | undefined);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: settings });
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await saveSettings(next);
  return next;
}

/**
 * Everything a verdict depends on. Visual settings (debug, animations, the UI-cleanup toggles) are
 * left out, so flipping them doesn't throw away and re-run every decision on the page.
 */
export function decisionKey(s: Settings): string {
  return JSON.stringify([s.mode, s.topics, s.includeTech, s.allowChannels, s.blockChannels, s.backend, s.thresholds]);
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[KEY]) cb(mergeSettings(changes[KEY].newValue));
  });
}

/**
 * What the model is told the tech intent is. Kept short: Laya re-reads the whole question for every
 * tile, so each token here costs ~6 ms per tile on a 2-core CPU, and this separated tech titles as
 * well as the full topic list did.
 */
export const TECH_SUMMARY = "programming, software, computers, AI";

/** Intent text for the model prompt: the short tech summary, plus the user's topics in Learn. */
export function modelTopicsFor(s: Settings): string[] {
  if (s.mode === "work") return [TECH_SUMMARY];
  if (s.mode === "learn") return learnUsesTech(s) ? [TECH_SUMMARY, ...s.topics] : s.topics;
  return [];
}

/** Without tech and without topics there'd be nothing to keep, so tech stays on until topics exist. */
export function learnUsesTech(s: Settings): boolean {
  return s.includeTech || s.topics.length === 0;
}

/** Topics for keyword rules and embeddings, where a longer, specific list is free and helps. */
export function topicsFor(s: Settings): string[] {
  if (s.mode === "work") return TECH_TOPICS;
  if (s.mode === "learn") return learnUsesTech(s) ? [...new Set([...TECH_TOPICS, ...s.topics])] : s.topics;
  return [];
}

export function modeUsesModel(mode: Mode): boolean {
  return mode === "work" || mode === "learn";
}

/** Work and Learn always hide Shorts; Relax and Off follow the user's toggle. */
export function effectiveHideShorts(s: Settings): boolean {
  return modeUsesModel(s.mode) || s.hideShorts;
}
