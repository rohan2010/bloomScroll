import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const nodeModules = fileURLToPath(new URL("./node_modules/", import.meta.url));

// Tests live in ../tests (outside this package), so point bare imports at our node_modules.
export default defineConfig({
  resolve: { alias: [{ find: /^(fake-indexeddb|idb)(.*)$/, replacement: `${nodeModules}$1$2` }] },
  server: { fs: { allow: [".."] } },
  test: {
    dir: "..",
    include: ["tests/unit/**/*.test.ts"],
    environment: "jsdom",
  },
});
