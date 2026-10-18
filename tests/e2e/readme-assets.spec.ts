// Captures the README's demo GIF frames and UI screenshots from the real, built extension running on
// the mock YouTube feed. Skipped unless BLOOM_README_ASSETS is set:
//   cd extension && pnpm build && BLOOM_README_ASSETS=1 npx playwright test readme-assets
//   then: node scripts/make-demo-gif.mjs   (encodes the frames into docs/assets/demo.gif)
// The model backend points at a closed port, so only rules and the built-in embeddings decide.
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { homeFeedHtml } from "./feed";

const ASSETS = join(process.cwd(), "../docs/assets");
const FRAMES = join(process.cwd(), "../docs/assets/.frames"); // gitignored scratch, removed by the encoder

test.skip(!process.env.BLOOM_README_ASSETS, "set BLOOM_README_ASSETS=1 to regenerate README assets");
test.setTimeout(180_000);

async function setSettings(context: BrowserContext, extensionId: string, patch: Record<string, unknown>): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  await page.evaluate(async (patch) => {
    const { settings = {} } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...settings, backend: { kind: "laya", url: "http://127.0.0.1:9" }, ...patch } });
  }, patch);
  return page;
}

/** Loads MiniLM with unrelated titles (needs Work or Learn mode), so destruction starts right away and nothing is cached. */
async function prewarm(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const tiles = ["Learning to juggle", "Weekend garden tour", "Compiler basics"].map((title, i) => ({ videoId: `warm${i}`, title, channel: "warm", isShort: false, surface: "home" }));
    await chrome.runtime.sendMessage({ type: "decide", tiles, stages: "fast" });
  });
}

async function feedPage(context: BrowserContext, width = 1280, height = 800): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width, height });
  await page.route("https://www.youtube.com/**", (route) => route.fulfill({ contentType: "text/html", body: homeFeedHtml() }));
  return page;
}

type Rect = { x: number; y: number; width: number; height: number };

/**
 * Crisp 2x PNG of a page region. The persistent context is fixed at 1x, so this asks DevTools to
 * re-rasterise the clip at scale 2 rather than upscaling a 1x capture.
 */
async function shot(page: Page, path: string, measure: () => Promise<Rect>): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  // Pin this session's metrics to the page's viewport: without it DevTools sees a viewport ~140 px
  // shorter than Playwright's, and bottom-fixed overlays land outside the clip.
  const vp = page.viewportSize()!;
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: 2, mobile: false });
  await page.waitForTimeout(250); // let the relayout settle, then measure in the pinned layout
  const clip = await measure();
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 }, captureBeyondViewport: false });
  await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  await cdp.detach();
  const png = Buffer.from(data, "base64");
  writeFileSync(path, png);
  // Safety net: normalise to exactly 2x the CSS size if the raster scale came out different.
  const width = png.readUInt32BE(16); // PNG IHDR width
  const target = Math.round(clip.width * 2);
  if (width !== target) {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", path, "-vf", `scale=${target}:-1:flags=lanczos`, `${path}.tmp.png`]);
    renameSync(`${path}.tmp.png`, path);
  }
}

function pad(r: { x: number; y: number; width: number; height: number }, m: number, vw: number, vh: number) {
  const x = Math.max(0, r.x - m);
  const y = Math.max(0, r.y - m);
  return { x, y, width: Math.min(vw - x, r.width + 2 * m), height: Math.min(vh - y, r.height + 2 * m) };
}

async function shadowRect(page: Page, host: string, selector: string) {
  return page.locator(host).evaluate((h, sel) => {
    const rects = [...h.shadowRoot!.querySelectorAll(sel)].map((n) => n.getBoundingClientRect());
    const x = Math.min(...rects.map((r) => r.left));
    const y = Math.min(...rects.map((r) => r.top));
    return { x, y, width: Math.max(...rects.map((r) => r.right)) - x, height: Math.max(...rects.map((r) => r.bottom)) - y };
  }, selector);
}

const settled = (page: Page) =>
  expect.poll(() => page.locator("ytd-rich-item-renderer[data-bloom=show], ytd-rich-item-renderer[data-bloom=hide]").count(), { timeout: 60_000 }).toBe(40);

test("demo gif frames", async ({ context, extensionId }) => {
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });
  // Load MiniLM in Work mode (in Off mode rules decide everything and the model never loads), then
  // switch filtering off so the GIF opens on the untouched feed.
  const options = await setSettings(context, extensionId, { mode: "work", debug: false, animations: true });
  await prewarm(options);
  await options.evaluate(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...settings, mode: "off" } });
  });

  const page = await feedPage(context, 1280, 720);
  await page.goto("https://www.youtube.com/");
  await page.waitForTimeout(800);
  await page.bringToFront();

  const cdp = await context.newCDPSession(page);
  const frames: { t: number; file: string }[] = [];
  cdp.on("Page.screencastFrame", (f) => {
    // Ack first: Chrome holds the next frame until the previous one is acknowledged.
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    const file = `f${String(frames.length).padStart(4, "0")}.jpg`;
    frames.push({ t: f.metadata.timestamp ?? performance.now() / 1000, file });
    writeFileSync(join(FRAMES, file), Buffer.from(f.data, "base64"));
  });
  // Without an explicit override on this session the screencast crops the bottom ~140 px.
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: 1000, maxHeight: 625, everyNthFrame: 1 });
  // Nudge one paint so the "before" frame is captured, then hold on it.
  await page.mouse.move(640, 400);
  await page.waitForTimeout(1600);

  // Switch to Work mode: the page re-classifies and the off-topic tiles are destroyed.
  await options.evaluate(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...settings, mode: "work" } });
  });
  await settled(page);
  await expect.poll(() => page.locator("bloomscroll-fx").count(), { timeout: 10_000 }).toBe(0);
  await page.waitForTimeout(1400);

  // Finish on the Hidden drawer.
  await page.locator("bloomscroll-drawer").evaluate((h) => (h.shadowRoot!.querySelector(".toggle") as HTMLElement).click());
  await page.waitForTimeout(2200);
  await page.mouse.move(641, 401); // a last paint so the hold is recorded
  await page.waitForTimeout(300);
  await cdp.send("Page.stopScreencast");
  writeFileSync(join(FRAMES, "frames.json"), JSON.stringify({ frames, end: performance.now() / 1000 }));
  console.log(`captured ${frames.length} frames`);
  expect(frames.length).toBeGreaterThan(10);
});

test("screenshots: drawer, debug, popup, options", async ({ context, extensionId }) => {
  mkdirSync(ASSETS, { recursive: true });
  const options = await setSettings(context, extensionId, { mode: "work", debug: true, animations: true });
  await prewarm(options);

  // Feed with debug overlay + drawer.
  const page = await feedPage(context);
  await page.goto("https://www.youtube.com/");
  await settled(page);
  await expect.poll(() => page.locator("bloomscroll-fx").count(), { timeout: 10_000 }).toBe(0);
  await page.waitForTimeout(1500); // backend status poll + final debug render

  await shot(page, join(ASSETS, "debug.png"), async () => pad(await shadowRect(page, "bloomscroll-debug", ".panel"), 16, 1280, 800));

  await page.locator("bloomscroll-drawer").evaluate((h) => (h.shadowRoot!.querySelector(".toggle") as HTMLElement).click());
  await page.waitForTimeout(500);
  await shot(page, join(ASSETS, "drawer.png"), async () => pad(await shadowRect(page, "bloomscroll-drawer", ".panel, .toggle"), 16, 1280, 800));

  // Popup with live numbers: opened as a background tab while the feed tab is active, so its
  // "active tab" query finds the feed, exactly as the toolbar popup would.
  for (const [scheme, file] of [["dark", "popup.png"], ["light", "popup-light.png"]] as const) {
    const popup = await context.newPage();
    await popup.emulateMedia({ colorScheme: scheme });
    await popup.setViewportSize({ width: 368, height: 760 });
    await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
    await page.bringToFront();
    await expect.poll(() => popup.locator("#tab-body .stat").count(), { timeout: 10_000 }).toBe(3);
    await popup.waitForTimeout(1200);
    await shot(popup, join(ASSETS, file), () =>
      popup.evaluate(() => {
        const r = document.body.getBoundingClientRect();
        return { x: 0, y: 0, width: r.width, height: Math.ceil(r.height) };
      }),
    );
    await popup.close();
  }

  // Settings page, top part.
  const settingsPage = await context.newPage();
  await settingsPage.emulateMedia({ colorScheme: "dark" });
  await settingsPage.setViewportSize({ width: 760, height: 1100 });
  await settingsPage.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  await settingsPage.evaluate(async () => {
    // Example intent and lists so the page isn't empty.
    (document.getElementById("topics") as HTMLTextAreaElement).value = "Linux\nAI research\nhome espresso";
    (document.getElementById("allow") as HTMLTextAreaElement).value = "@Fireship\n3Blue1Brown";
    (document.getElementById("block") as HTMLTextAreaElement).value = "PrankZone";
    // The test points the backend at a closed port; show the real default a new user sees.
    (document.getElementById("url") as HTMLInputElement).value = "http://127.0.0.1:8765";
  });
  await settingsPage.waitForTimeout(300);
  // Top of the page: intent, channel lists, cleanup switches and the model backend.
  await shot(settingsPage, join(ASSETS, "options.png"), async () => {
    const bottom = await settingsPage.evaluate(() => {
      const backend = [...document.querySelectorAll("section")].find((s) => s.querySelector("#kind"))!;
      return Math.ceil(backend.getBoundingClientRect().bottom) + 16;
    });
    return { x: 0, y: 0, width: 760, height: Math.min(1100, bottom) };
  });
});
