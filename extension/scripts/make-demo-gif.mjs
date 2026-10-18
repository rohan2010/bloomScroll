// Encodes the frames captured by tests/e2e/readme-assets.spec.ts into docs/assets/demo.gif, keeping
// each frame on screen for as long as it was really painted. Needs ffmpeg on PATH.
//   node scripts/make-demo-gif.mjs [width=960] [fps=20]

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const framesDir = join(root, "docs/assets/.frames");
const out = join(root, "docs/assets/demo.gif");
const width = Number(process.argv[2] ?? 960);
const fps = Number(process.argv[3] ?? 20);

const MAX_HOLD = 1.8; // seconds: long idle stretches (waiting for the page) are cut to this
const END_HOLD = 2.6;

const { frames: raw } = JSON.parse(readFileSync(join(framesDir, "frames.json"), "utf8"));
const frames = [...raw].sort((a, b) => a.t - b.t); // screencast frames can arrive slightly out of order
const lines = [];
frames.forEach((f, i) => {
  const gap = i + 1 < frames.length ? frames[i + 1].t - f.t : END_HOLD;
  lines.push(`file '${f.file}'`, `duration ${Math.min(i + 1 < frames.length ? MAX_HOLD : END_HOLD, Math.max(0.02, gap)).toFixed(3)}`);
});
lines.push(`file '${frames.at(-1).file}'`); // concat demuxer needs the last file repeated
writeFileSync(join(framesDir, "list.txt"), lines.join("\n"));

const filter = `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(framesDir, "list.txt"), "-vf", filter, "-loop", "0", out], { stdio: "inherit" });
rmSync(framesDir, { recursive: true, force: true });
console.log(`wrote ${out} (${(statSync(out).size / 1e6).toFixed(2)} MB)`);
