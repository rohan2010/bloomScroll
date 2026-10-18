import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "../../extension/src/shared/settings";

describe("mergeSettings", () => {
  it("resets thresholds saved for an older prompt or scoring", () => {
    const old = { thresholds: { embedShow: 0.55, embedHide: 0.2, modelShow: 0.6, modelMinConf: 0.65 } } as never;
    const s = mergeSettings(old);
    expect(s.thresholds).toEqual(DEFAULT_SETTINGS.thresholds);
    expect(s.thresholdsVersion).toBe(DEFAULT_SETTINGS.thresholdsVersion);
  });

  it("keeps a user's own values saved under the current version, dropping unknown keys", () => {
    const s = mergeSettings({
      thresholdsVersion: DEFAULT_SETTINGS.thresholdsVersion,
      thresholds: { embedMarginShow: 0.2, embedMarginHide: -0.1, modelShow: 0.25, embedShow: 0.9 },
    } as never);
    expect(s.thresholds).toEqual({ ...DEFAULT_SETTINGS.thresholds, embedMarginShow: 0.2, embedMarginHide: -0.1, modelShow: 0.25 });
  });
});
