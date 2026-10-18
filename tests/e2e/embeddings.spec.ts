import type { Decision, VideoTile } from "../../extension/src/shared/types";
import { expect, test } from "./fixtures";

const tile = (videoId: string, title: string, channel: string): VideoTile => ({ videoId, title, channel, isShort: false, surface: "home" });

// Titles chosen to dodge the keyword rule, so the embedding stage has to decide them.
const ON = [tile("on1", "SQL joins in 6 minutes", "Web Dev Simplified"), tile("on2", "React Server Components, a deep dive", "Theo - t3.gg"), tile("on3", "Dijkstra's algorithm visualized", "Reducible")];
const OFF = [tile("off1", "Funniest cat fails compilation", "Daily Dose"), tile("off2", "Premier League highlights: Arsenal vs Chelsea", "Sky Sports"), tile("off3", "Gordon Ramsay makes the perfect steak", "Gordon Ramsay")];

test("MiniLM runs in the offscreen document and decides clear tiles without a model", async ({ context, extensionId }) => {
  // An extension page can message the service worker exactly like the content script does.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  // Point the model at a closed port: only rules and embeddings can decide.
  await page.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...settings, mode: "learn", backend: { kind: "laya", url: "http://127.0.0.1:9" } } });
  });

  const decide = (tiles: VideoTile[]) =>
    page.evaluate(async (tiles) => {
      const t0 = performance.now();
      const res = await chrome.runtime.sendMessage({ type: "decide", tiles });
      return { res, ms: performance.now() - t0 };
    }, tiles) as Promise<{ res: { decisions?: Decision[]; error?: string }; ms: number }>;

  const cold = await decide([...ON, ...OFF]);
  expect(cold.res.error).toBeUndefined();
  const decisions = cold.res.decisions!;
  for (const d of decisions) console.log(`${d.videoId.padEnd(5)} ${d.verdict.padEnd(5)} ${d.stage.padEnd(10)} ${d.reason}`);
  console.log(`cold (loads model): ${cold.ms.toFixed(0)} ms`);

  const byId = Object.fromEntries(decisions.map((d) => [d.videoId, d]));
  for (const t of OFF) expect(byId[t.videoId]).toMatchObject({ verdict: "hide", stage: "embedding" });
  for (const t of ON) expect(byId[t.videoId].verdict).toBe("show");
  expect(decisions.filter((d) => d.stage === "embedding").length).toBeGreaterThanOrEqual(4);

  // Warm path: new tiles, model already loaded.
  const warmTiles = [...ON, ...OFF].map((t) => ({ ...t, videoId: `w_${t.videoId}` }));
  const warm = await decide(warmTiles);
  console.log(`warm, 6 new tiles: ${warm.ms.toFixed(0)} ms`);
  expect(warm.ms).toBeLessThan(1500);

  // Offscreen document exists and nothing was fetched from the network for the model.
  const contexts = await page.evaluate(() => chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType] }));
  expect(contexts.length).toBe(1);
  expect(errors).toEqual([]);
});
