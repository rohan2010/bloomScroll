// Runs MiniLM (Transformers.js + ONNX Runtime WebAssembly) for the service worker, which can't load
// the WASM runtime itself. Model weights and WASM ship inside the extension: nothing is downloaded.

import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { EMBED_MODEL, type EmbedRequest, type EmbedResponse } from "../shared/messages";

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = chrome.runtime.getURL("models/");
env.useBrowserCache = false;
const wasm = env.backends.onnx.wasm!;
wasm.wasmPaths = chrome.runtime.getURL("ort/");
wasm.numThreads = 1; // threads need cross-origin isolation, which an offscreen document doesn't have
wasm.proxy = false;

let extractor: Promise<FeatureExtractionPipeline> | undefined;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractor ??= pipeline("feature-extraction", EMBED_MODEL, { dtype: "q8", device: "wasm" }).catch((err) => {
    extractor = undefined; // let the next request retry
    throw err;
  }) as Promise<FeatureExtractionPipeline>;
  return extractor;
}

/**
 * One inference at a time. The page-open warm-up and the first tile batch arrive together, and
 * ONNX Runtime sessions aren't documented as safe for overlapping run() calls. Inference is
 * single-threaded here anyway (numThreads = 1), so queueing costs no throughput.
 */
let queue: Promise<unknown> = Promise.resolve();

function embed(texts: string[]): Promise<number[][]> {
  if (!texts.length) return Promise.resolve([]);
  const run = queue.then(async () => {
    const out = await (await getExtractor())(texts, { pooling: "mean", normalize: true });
    return out.tolist() as number[][];
  });
  queue = run.catch(() => undefined); // a failed run mustn't block the next one
  return run;
}

chrome.runtime.onMessage.addListener((msg: EmbedRequest, _sender, sendResponse: (r: EmbedResponse) => void) => {
  if (msg?.target !== "offscreen" || msg.type !== "embed") return;
  embed(msg.texts).then(
    (vectors) => sendResponse({ vectors }),
    (err) => sendResponse({ error: String(err?.message ?? err) }),
  );
  return true; // async response
});
