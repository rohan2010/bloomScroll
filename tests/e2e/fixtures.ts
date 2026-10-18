import pw, { type BrowserContext, type Worker } from "@playwright/test"; // CommonJS package, ESM project

const { test: base, chromium } = pw as unknown as typeof import("@playwright/test");
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIST = join(process.cwd(), "dist"); // run from extension/

/** A fresh Chromium profile with the built extension loaded, plus its service worker and id. */
export const test = base.extend<{ context: BrowserContext; sw: Worker; extensionId: string }>({
  context: async ({}, use) => {
    const profile = mkdtempSync(join(tmpdir(), "bloom-e2e-"));
    // A custom profile looks for native messaging hosts inside itself, not in the per-user folder
    // setup.sh registers them in; copy one in when a test needs it.
    if (process.env.BLOOM_NATIVE_HOST_MANIFEST) {
      mkdirSync(join(profile, "NativeMessagingHosts"), { recursive: true });
      copyFileSync(process.env.BLOOM_NATIVE_HOST_MANIFEST, join(profile, "NativeMessagingHosts", "com.bloomscroll.laya.json"));
    }
    const context = await chromium.launchPersistentContext(profile, {
      headless: false,
      args: ["--headless=new", `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    });
    await use(context);
    await context.close();
  },
  sw: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    await use(sw);
  },
  extensionId: async ({ sw }, use) => {
    await use(new URL(sw.url()).host);
  },
});

export const expect = test.expect;
