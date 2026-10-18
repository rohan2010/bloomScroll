import { createJevWireBackend } from "./jevWire";
import type { DecisionBackend } from "./types";

/** Any other local server that speaks /v1/systemone (OpenJev-style, TypeSafe adapter over Ollama, …). */
export function createOpenJevBackend(baseUrl: string, apiKey?: string, model = "default"): DecisionBackend {
  return createJevWireBackend({ name: "openjev", baseUrl, model, apiKey });
}
