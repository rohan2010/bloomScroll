import type { Decision, Label, Mode, Surface, VideoTile } from "./types";

/** Reason on fail-open decisions; the content script retries tiles that carry it. */
export const NO_MODEL_REASON = "no model available, shown by default";

export type DecideRequest = { type: "decide"; tiles: VideoTile[] };
export type DecideResponse = { decisions: Decision[] } | { error: string };

export type LabelRequest = { type: "label"; label: Label };

export type StatsRequest = { type: "stats" };
export type StatsResponse = {
  surface: Surface | null;
  found: number;
  hidden: number;
  pending: number;
  mode: Mode;
};

export type BackgroundMessage = DecideRequest | LabelRequest;
