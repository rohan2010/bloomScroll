import { createJevWireBackend } from "./jevWire";
import type { DecisionBackend } from "./types";

export const JEV_BASE_URL = "https://api.typesafe.ai";

/** Hosted Jev with the user's own key. Sends titles and channel names to TypeSafe: opt-in only. */
export function createJevBackend(apiKey: string, baseUrl = JEV_BASE_URL): DecisionBackend {
  return createJevWireBackend({ name: "jev", baseUrl, model: "jev-latest", apiKey, timeoutMs: 15_000 });
}
