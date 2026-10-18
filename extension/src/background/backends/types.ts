import type { VideoTile } from "../../shared/types";

/** The model's belief that a tile is on-intent. */
export type ModelVerdict = { videoId: string; onIntent: number /* 0..1 */ };

/** Every model backend (Laya, OpenJev-style servers, Jev) sits behind this one interface. */
export interface DecisionBackend {
  readonly name: string;
  /** Max questions per request; the cascade chunks to this. */
  readonly maxBatch: number;
  /** Each backend frames its own prompt from the user's topics. */
  decide(topics: string[], tiles: VideoTile[], signal?: AbortSignal): Promise<ModelVerdict[]>;
}
