import pw from "@playwright/test"; // CommonJS package, ESM project

const { defineConfig } = pw as unknown as typeof import("@playwright/test");

// E2E tests load the built extension (pnpm build first) into Playwright's Chromium.
export default defineConfig({
  testDir: "../tests/e2e",
  timeout: 120_000,
  workers: 1,
  reporter: "list",
});
