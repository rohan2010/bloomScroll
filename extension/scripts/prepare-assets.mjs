// Puts the embedding model and the ONNX Runtime WebAssembly files into public/, which Vite copies
// into the build. MV3 forbids remotely hosted code, and bloomScroll promises to run offline, so
// nothing is fetched at runtime. Downloads once from Hugging Face; reruns are no-ops.
//   node scripts/prepare-assets.mjs

import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = "Xenova/all-MiniLM-L6-v2";
// Pinned so every build ships the same weights.
const REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
const MODEL_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"];
const ORT_FILES = ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"];

const exists = (p) => stat(p).then(() => true, () => false);

for (const file of ORT_FILES) {
  const dest = join(root, "public/ort", file);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(join(root, "node_modules/@huggingface/transformers/dist", file), dest);
}

for (const file of MODEL_FILES) {
  const dest = join(root, "public/models", MODEL, file);
  if (await exists(dest)) continue;
  const url = `https://huggingface.co/${MODEL}/resolve/${REVISION}/${file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`downloaded ${MODEL}/${file}`);
}
console.log("assets ready in public/");
