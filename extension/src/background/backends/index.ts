import type { Settings } from "../../shared/types";
import { createJevBackend } from "./jev";
import { createLayaBackend } from "./laya";
import { createOpenJevBackend } from "./openjev";
import type { DecisionBackend } from "./types";

export type { DecisionBackend, ModelVerdict } from "./types";

export function backendFromSettings({ backend }: Settings): DecisionBackend | null {
  if (!backend.url && backend.kind !== "jev") return null;
  switch (backend.kind) {
    case "laya":
      return createLayaBackend(backend.url);
    case "openjev":
      return createOpenJevBackend(backend.url, backend.apiKey);
    case "jev":
      return backend.apiKey ? createJevBackend(backend.apiKey, backend.url || undefined) : null;
  }
}
