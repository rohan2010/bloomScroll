import { mkdirSync } from "node:fs";
import { expect, test } from "./fixtures";
import { homeFeedHtml } from "./feed";

const SHOTS = process.env.BLOOM_SHOTS; // set to a folder to save screenshots

test("home feed: tiles vanish, debug panel and drawer render with timings", async ({ context, extensionId }) => {
  // Settings: debug on, animations on, model on a closed port so rules + embeddings decide.
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  await options.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...settings, mode: "work", debug: true, animations: true, backend: { kind: "laya", url: "http://127.0.0.1:9" } } });
  });

  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.route("https://www.youtube.com/**", (route) => route.fulfill({ contentType: "text/html", body: homeFeedHtml() }));
  // The dither layer shows up while off-topic tiles are destroyed.
  const fxSeen = page.waitForSelector("bloomscroll-fx", { state: "attached", timeout: 60_000 });
  await page.goto("https://www.youtube.com/");

  // Every tile gets a verdict (the closed model port fails open for anything left over).
  await expect
    .poll(() => page.locator("ytd-rich-item-renderer[data-bloom=show], ytd-rich-item-renderer[data-bloom=hide]").count(), { timeout: 60_000 })
    .toBe(40);
  const hidden = await page.locator("ytd-rich-item-renderer[data-bloom=hide]").count();
  const wrongHides = await page.locator('ytd-rich-item-renderer[data-bloom=hide]:has(a[href*="v=n"])').count();
  console.log(`hidden ${hidden}/40, on-topic wrongly hidden ${wrongHides}`);
  expect(hidden).toBeGreaterThanOrEqual(15);
  expect(wrongHides).toBe(0);

  await fxSeen;
  // On-screen hides animate, then end as display:none, and the effect layer cleans itself up.
  await expect.poll(() => page.locator("ytd-rich-item-renderer.bloom-hidden").count(), { timeout: 5_000 }).toBe(hidden);
  await expect.poll(() => page.locator("bloomscroll-fx").count()).toBe(0);
  expect(await page.locator("[data-bloom-fx]").count()).toBe(0);

  // The panel updates values in place: the same DOM nodes survive re-renders (no flicker, scroll kept).
  await page.locator("bloomscroll-debug").evaluate((h) => {
    const r = h.shadowRoot!;
    (r.querySelector(".panel") as HTMLElement).dataset.mark = "1";
    (r.querySelector("li") as HTMLElement).dataset.mark = "1";
  });
  await page.mouse.wheel(0, 600); // scrolling triggers more scans and renders
  await page.waitForTimeout(2000);
  const survived = await page.locator("bloomscroll-debug").evaluate((h) => {
    const r = h.shadowRoot!;
    return { panel: (r.querySelector(".panel") as HTMLElement).dataset.mark, row: r.querySelector('li[data-mark="1"]') !== null };
  });
  expect(survived).toEqual({ panel: "1", row: true });

  // Debug panel bottom left, drawer bottom right.
  const debugText = await page.locator("bloomscroll-debug").evaluate((h) => h.shadowRoot!.textContent ?? "");
  expect(debugText).toContain("until the page settled");
  expect(debugText).toContain("Time to verdict");
  const box = await page.locator("bloomscroll-debug").evaluate((h) => h.shadowRoot!.querySelector(".panel")!.getBoundingClientRect().toJSON());
  expect(box.left).toBeLessThan(40);
  const drawerCount = await page.locator("bloomscroll-drawer").evaluate((h) => h.shadowRoot!.querySelector(".count")!.textContent);
  expect(Number(drawerCount)).toBe(hidden);

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/feed-debug.png` });
    await page.locator("bloomscroll-drawer").evaluate((h) => (h.shadowRoot!.querySelector(".toggle") as HTMLElement).click());
    await page.waitForTimeout(400); // let the pop-in finish
    await page.screenshot({ path: `${SHOTS}/feed-drawer.png` });
  }

  // Turning debug off removes the panel without re-classifying anything.
  const before = await page.locator("ytd-rich-item-renderer[data-bloom-stage]").count();
  await options.evaluate(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...settings, debug: false } });
  });
  await expect.poll(() => page.locator("bloomscroll-debug").count()).toBe(0);
  expect(await page.locator("ytd-rich-item-renderer[data-bloom=pending]").count()).toBe(0);
  expect(await page.locator("ytd-rich-item-renderer[data-bloom-stage]").count()).toBe(before);

  if (SHOTS) {
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 368, height: 640 });
    await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
    await popup.waitForTimeout(600);
    await popup.screenshot({ path: `${SHOTS}/popup.png`, fullPage: true });
  }
});

test("hover Hide removes a kept video and the correction survives a reload; Show undoes it", async ({ context, extensionId }) => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  await options.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...settings, mode: "work", debug: false, animations: true, backend: { kind: "laya", url: "http://127.0.0.1:9" } } });
  });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.route("https://www.youtube.com/**", (route) => route.fulfill({ contentType: "text/html", body: homeFeedHtml() }));
  const decided = () => page.locator("ytd-rich-item-renderer[data-bloom=show], ytd-rich-item-renderer[data-bloom=hide]").count();
  await page.goto("https://www.youtube.com/");
  await expect.poll(decided, { timeout: 60_000 }).toBe(40);

  // The first tile is "Rust ownership in 10 minutes", kept by the keyword rule.
  const rust = page.locator('ytd-rich-item-renderer:has(a[href="/watch?v=n0000000000"])');
  await expect(rust).toHaveAttribute("data-bloom", "show");
  await rust.hover();
  const btn = page.locator("bloomscroll-feedback").locator(".btn.on");
  await expect(btn).toBeVisible();
  await btn.click();
  await expect(rust).toHaveAttribute("data-bloom", "hide");
  await expect.poll(() => rust.evaluate((e) => e.classList.contains("bloom-hidden")), { timeout: 5_000 }).toBe(true);

  // Survives a reload: the stored label decides before rules even run.
  await page.reload();
  await expect.poll(decided, { timeout: 60_000 }).toBe(40);
  await expect(rust).toHaveAttribute("data-bloom", "hide");
  const reason = await page.locator("bloomscroll-drawer").evaluate((h) => {
    (h.shadowRoot!.querySelector(".toggle") as HTMLElement).click();
    const li = [...h.shadowRoot!.querySelectorAll("li")].find((l) => l.textContent?.includes("Rust ownership"));
    return li?.textContent ?? "";
  });
  expect(reason).toContain("you hid this");

  // Show from the drawer flips it back, and that sticks too.
  await page.locator("bloomscroll-drawer").evaluate((h) => {
    const li = [...h.shadowRoot!.querySelectorAll("li")].find((l) => l.textContent?.includes("Rust ownership"))!;
    (li.querySelector(".show") as HTMLElement).click();
  });
  await expect(rust).toHaveAttribute("data-bloom", "show");
  await page.reload();
  await expect.poll(decided, { timeout: 60_000 }).toBe(40);
  await expect(rust).toHaveAttribute("data-bloom", "show");
});

test("popup offers Learn / Relax / Off, the toolbar badge counts hidden videos, and tech can be switched off", async ({ context, extensionId }) => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  await options.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...settings, mode: "learn", topics: [], includeTech: true, backend: { kind: "laya", url: "http://127.0.0.1:9" } } });
  });
  const page = await context.newPage();
  await page.route("https://www.youtube.com/**", (r) => r.fulfill({ contentType: "text/html", body: homeFeedHtml() }));
  await page.goto("https://www.youtube.com/");
  const decided = () => page.locator("ytd-rich-item-renderer[data-bloom=show], ytd-rich-item-renderer[data-bloom=hide]").count();
  await expect.poll(decided, { timeout: 60_000 }).toBe(40);
  const hidden = await page.locator("ytd-rich-item-renderer[data-bloom=hide]").count();

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
  await expect(popup.locator("[data-mode]")).toHaveText(["Learn", "Relax", "Off"]);
  await expect(popup.locator("#nudge")).toBeVisible(); // no topics yet

  // Badge on the YouTube tab shows the hidden count.
  const badges = await options.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return Promise.all(tabs.map((t) => chrome.action.getBadgeText({ tabId: t.id! })));
  });
  expect(badges).toContain(String(hidden));

  // Only "woodworking", tech off: tech tiles are no longer protected by the tech topics.
  await options.evaluate(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...settings, topics: ["woodworking"], includeTech: false } });
  });
  await expect.poll(decided, { timeout: 60_000 }).toBe(40);
  await expect
    .poll(() => page.locator('ytd-rich-item-renderer[data-bloom=hide]:has(a[href*="v=n"])').count(), { timeout: 30_000 })
    .toBeGreaterThan(5);
  await popup.reload();
  await expect(popup.locator("#nudge")).toBeHidden();
  await expect(popup.locator("#mode-hint")).toHaveText("Only your topics. Shorts hidden.");
});

test("Hide button stays clickable over YouTube's hover preview", async ({ context, extensionId }) => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  await options.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...settings, mode: "learn", topics: [], includeTech: true, animations: false, backend: { kind: "laya", url: "http://127.0.0.1:9" } } });
  });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.route("https://www.youtube.com/**", (r) => r.fulfill({ contentType: "text/html", body: homeFeedHtml({ hoverPreview: true }) }));
  await page.goto("https://www.youtube.com/");
  await expect.poll(() => page.locator("ytd-rich-item-renderer[data-bloom=show], ytd-rich-item-renderer[data-bloom=hide]").count(), { timeout: 60_000 }).toBe(40);

  const tile = page.locator('ytd-rich-item-renderer:has(a[href="/watch?v=n0000000001"])');
  const box = (await tile.locator("#thumbnail").boundingBox())!;
  // Hover the thumbnail: the fake preview now covers it, like YouTube's inline player.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await expect(page.locator("ytd-video-preview")).toBeVisible();
  const btn = page.locator("bloomscroll-feedback").locator(".btn.on");
  await expect(btn).toBeVisible();

  // Travel slowly from the middle of the thumbnail to the button, over the preview, then click.
  const b = (await btn.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 15 });
  await expect(btn).toBeVisible();
  await page.mouse.down();
  await page.mouse.up();
  await expect(tile).toHaveAttribute("data-bloom", "hide");
});
