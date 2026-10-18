import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, TECH_SUMMARY, TECH_TOPICS, mergeSettings, modelTopicsFor, topicsFor } from "../../extension/src/shared/settings";

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

  it("moves a saved Work mode to Learn while Work is hidden", () => {
    expect(mergeSettings({ mode: "work" } as never).mode).toBe("learn");
    expect(mergeSettings({ mode: "relax" } as never).mode).toBe("relax");
  });
});

describe("Learn topics and the built-in tech switch", () => {
  const learn = (patch: object) => ({ ...DEFAULT_SETTINGS, mode: "learn" as const, ...patch });

  it("keeps tech plus your topics by default", () => {
    const s = learn({ topics: ["woodworking"] });
    expect(topicsFor(s)).toEqual([...TECH_TOPICS, "woodworking"]);
    expect(modelTopicsFor(s)).toEqual([TECH_SUMMARY, "woodworking"]);
  });

  it("uses only your topics when tech is switched off", () => {
    const s = learn({ topics: ["woodworking"], includeTech: false });
    expect(topicsFor(s)).toEqual(["woodworking"]);
    expect(modelTopicsFor(s)).toEqual(["woodworking"]);
  });

  it("keeps tech on when it's switched off but there are no topics yet", () => {
    const s = learn({ topics: [], includeTech: false });
    expect(topicsFor(s)).toEqual(TECH_TOPICS);
  });
});
