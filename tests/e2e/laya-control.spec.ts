// Real start/stop of Laya through Settings, via the native helper setup.sh installs.
// Opt-in (it starts a real model server): run from a checkout where setup.sh has run, with
//   BLOOM_NATIVE_TEST=1 LAYA_PORT=<port> BLOOM_AUTOSTART_LABEL=<label> \
//   BLOOM_NATIVE_HOST_MANIFEST="$HOME/Library/Application Support/Chromium/NativeMessagingHosts/com.bloomscroll.laya.json" \
//   npx playwright test laya-control
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures";

const PORT = Number(process.env.LAYA_PORT ?? 8765);
const LABEL = process.env.BLOOM_AUTOSTART_LABEL ?? "com.bloomscroll.laya";
const healthy = () => fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok, () => false);

test.skip(!process.env.BLOOM_NATIVE_TEST, "starts a real Laya; opt in with BLOOM_NATIVE_TEST=1");
test.setTimeout(300_000);

test("setup.sh's extension ID matches Chrome's for the unpacked folder", async ({ extensionId }) => {
  const expected = [...createHash("sha256").update(join(process.cwd(), "dist")).digest("hex").slice(0, 32)]
    .map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16)))
    .join("");
  expect(extensionId).toBe(expected);
});

test("Settings starts and stops the local AI, and switches start-at-login", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  await page.evaluate(async (port) => {
    const { settings = {} } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...settings, mode: "learn", backend: { kind: "laya", url: `http://127.0.0.1:${port}` } } });
  }, PORT);
  await page.reload();

  await expect(page.locator("#laya-control")).toBeVisible();
  await expect(page.locator("#laya-text")).toHaveText("Local AI (Laya) is stopped", { timeout: 15_000 });
  expect(await healthy()).toBe(false);

  await page.locator("#laya-toggle").click();
  await expect(page.locator("#laya-text")).toHaveText("Local AI (Laya) is running", { timeout: 180_000 });
  expect(await healthy()).toBe(true);

  await page.locator("#laya-toggle").click();
  await expect(page.locator("#laya-text")).toHaveText("Local AI (Laya) is stopped", { timeout: 30_000 });
  expect(await healthy()).toBe(false);

  const plist = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
  await page.locator("#laya-autostart").check();
  await expect.poll(() => existsSync(plist)).toBe(true);
  await page.locator("#laya-autostart").uncheck();
  await expect.poll(() => existsSync(plist)).toBe(false);
});
