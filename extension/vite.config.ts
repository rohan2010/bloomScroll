import { defineConfig, type Plugin } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";

/**
 * onnxruntime-web references its .wasm via import.meta.url, so Vite emits a 21 MB copy into assets/.
 * The offscreen document loads the copy in public/ort/ instead (env wasmPaths), so drop this one.
 */
function dropDuplicateOrtWasm(): Plugin {
  return {
    name: "bloomscroll:drop-duplicate-ort-wasm",
    generateBundle(_options, bundle) {
      for (const name of Object.keys(bundle)) if (/^assets\/ort-wasm.*\.wasm$/.test(name)) delete bundle[name];
    },
  };
}

export default defineConfig({
  plugins: [crx({ manifest }), dropDuplicateOrtWasm()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The offscreen document isn't referenced by the manifest, so list it as an entry.
    rollupOptions: { input: { offscreen: "src/offscreen/index.html" } },
  },
  server: { port: 5173, strictPort: true, hmr: { port: 5173 } },
});
