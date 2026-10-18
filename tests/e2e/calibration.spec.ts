import { expect, test } from "./fixtures";
import { homeFeedHtml } from "./feed";
import { ON_TITLES } from "../unit/titles";

const SHOTS = process.env.BLOOM_SHOTS;
const wanted = new Set(ON_TITLES.map(([t]) => t));

test("review recent videos with the keyboard, run calibration, see a before/after report", async ({ context, extensionId }) => {
  const options = await context.newPage();
  await options.emulateMedia({ colorScheme: "dark" });
  await options.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  await options.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...settings, mode: "work", backend: { kind: "laya", url: "http://127.0.0.1:9" } } });
  });

  // Browse the mock feed so decisions (with titles) land in the cache.
  const page = await context.newPage();
  await page.route("https://www.youtube.com/**", (r) => r.fulfill({ contentType: "text/html", body: homeFeedHtml() }));
  await page.goto("https://www.youtube.com/");
  await expect.poll(() => page.locator("ytd-rich-item-renderer[data-bloom=show], ytd-rich-item-renderer[data-bloom=hide]").count(), { timeout: 60_000 }).toBe(40);

  await options.reload();
  await expect(options.locator("#cal-run")).toBeDisabled();

  // Two review rounds answer every cached video (fail-open ones aren't cached, so fewer than 40).
  let answered = 0;
  for (let round = 0; round < 2; round++) {
    await options.locator("#review-start").click();
    if (await options.locator("#review").isHidden()) break; // nothing left to review
    while (await options.locator("#review").isVisible()) {
      const title = (await options.locator("#rv-title").textContent()) ?? "";
      const index = (await options.locator("#rv-index").textContent()) ?? "";
      if (SHOTS && answered === 0) await options.locator("#calibrate").screenshot({ path: `${SHOTS}/calibrate-review.png` });
      await options.keyboard.press(wanted.has(title) ? "ArrowRight" : "ArrowLeft");
      answered++;
      // Wait for the next card (or the end of the queue) before answering again.
      await expect.poll(async () => (await options.locator("#review").isHidden()) || (await options.locator("#rv-index").textContent()) !== index).toBe(true);
    }
  }
  console.log(`answered ${answered}`);
  expect(answered).toBeGreaterThanOrEqual(30);
  await expect(options.locator("#cal-count")).toContainText(`${answered}`);

  // Top up with corrections like the Hide / Show buttons make (fail-open tiles aren't cached, so
  // the 40-tile feed alone can't reach 40 review answers).
  await options.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const r = indexedDB.open("bloomscroll");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const extra = [
      ["Linux file permissions explained", "show"], ["Writing a compiler in Rust, part 1", "show"], ["Vim tips I wish I knew earlier", "show"],
      ["Postgres indexes in 12 minutes", "show"], ["Kubernetes for beginners", "show"], ["Best pizza in Naples", "hide"],
      ["Celebrity red carpet looks", "hide"], ["FIFA ultimate team pack opening", "hide"], ["Morning yoga for flexibility", "hide"], ["Funny dog compilation", "hide"],
    ];
    const tx = db.transaction("labels", "readwrite");
    extra.forEach(([title, v], i) => tx.objectStore("labels").put({ videoId: `extra${i}`, title, channel: "test", userVerdict: v, at: Date.now() }));
    await new Promise((res) => (tx.oncomplete = res));
  });
  await options.reload();

  const ready = await options.locator("#cal-run").isEnabled();
  expect(ready).toBe(true);
  {
    await options.locator("#cal-run").click();
    await expect(options.locator("#cal-report")).toBeVisible({ timeout: 60_000 });
    const text = (await options.locator("#cal-report").textContent()) ?? "";
    console.log(text.replace(/\s+/g, " ").slice(0, 400));
    expect(text).toContain("Shown videos you wanted");
    if (SHOTS) await options.locator("#calibrate").screenshot({ path: `${SHOTS}/calibrate-report.png` });
  }
});
