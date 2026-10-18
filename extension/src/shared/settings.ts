import type { Mode, Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  topics: [],
  allowChannels: [],
  blockChannels: [],
  hideShorts: true,
  hideComments: false,
  hideEndscreen: true,
  mode: "learn",
  backend: { url: "http://127.0.0.1:8765", kind: "laya" },
  thresholds: { embedShow: 0.55, embedHide: 0.2, modelShow: 0.3, modelMinConf: 0.65 },
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
];

const KEY = "settings";

export function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  const s = stored ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    backend: { ...DEFAULT_SETTINGS.backend, ...s.backend },
    thresholds: { ...DEFAULT_SETTINGS.thresholds, ...s.thresholds },
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

export function onSettingsChanged(cb: (s: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[KEY]) cb(mergeSettings(changes[KEY].newValue));
  });
}

export function topicsFor(s: Settings): string[] {
  if (s.mode === "work") return TECH_TOPICS;
  if (s.mode === "learn") return [...new Set([...TECH_TOPICS, ...s.topics])];
  return [];
}

export function modeUsesModel(mode: Mode): boolean {
  return mode === "work" || mode === "learn";
}

/** Work and Learn always hide Shorts; Relax and Off follow the user's toggle. */
export function effectiveHideShorts(s: Settings): boolean {
  return modeUsesModel(s.mode) || s.hideShorts;
}
