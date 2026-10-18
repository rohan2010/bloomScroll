export type Surface = "home" | "sidebar" | "search" | "endscreen";
export type Mode = "work" | "learn" | "relax" | "off";

export type VideoTile = {
  videoId: string; // from /watch?v= or /shorts/
  title: string;
  channel: string;
  channelId?: string; // "@handle" or "UC…" from the channel link
  durationSec?: number;
  isShort: boolean;
  surface: Surface;
};

export type Verdict = "show" | "hide";

export type Decision = {
  videoId: string;
  verdict: Verdict;
  confidence: number; // 0..1
  stage: "rule" | "embedding" | "model" | "fallback";
  reason: string; // e.g. "channel allowlisted", "sim 0.71 to 'Linux'"
  modeId: string;
  decidedAt: number;
};

export type Label = {
  videoId: string;
  title: string;
  channel: string;
  userVerdict: Verdict;
  at: number;
};

export type BackendKind = "laya" | "openjev" | "jev";

export type Settings = {
  topics: string[]; // plain-language intents
  allowChannels: string[];
  blockChannels: string[];
  hideShorts: boolean;
  hideComments: boolean;
  hideEndscreen: boolean;
  mode: Mode;
  /** Bottom-left technical overlay on YouTube: timings, stages, recent decisions. */
  debug: boolean;
  /** Animate off-intent tiles out instead of removing them instantly. */
  animations: boolean;
  backend: { url: string; apiKey?: string; kind: BackendKind };
  /** Bumped when thresholds change meaning; saved thresholds from another version are reset. */
  thresholdsVersion?: number;
  thresholds: {
    /** Embedding margin (sim to closest topic minus sim to closest off-topic anchor) to show at. */
    embedMarginShow: number;
    /** Embedding margin to hide at. Between the two, the tile goes to the model. */
    embedMarginHide: number;
    /** Show when the model's P(on-intent) is at least this. */
    modelShow: number;
    modelMinConf: number;
  };
};
